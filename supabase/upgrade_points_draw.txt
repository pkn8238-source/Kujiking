-- =========================================================
-- 쿠지킹 v3.6 — 굿즈 포인트로 뽑기 (points draw) 업그레이드
-- ---------------------------------------------------------
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여넣고 RUN 하세요.
-- 여러 번 실행해도 안전합니다.
--   1) draw_ticket 에 p_use_points 인자 추가 (포인트 차감 뽑기)
--   2) 구버전 4인자 draw_ticket 제거 (함수 모호성 방지, 구버전 앱도 기본값으로 동작)
--   3) draws.source 에 'points' 허용
--   4) 앱은 p_use_points=true 로 호출하면 판 가격만큼 회원 굿즈 포인트가 차감됩니다.
-- =========================================================

-- 0) draws.source CHECK 제약이 있으면 'points' 를 막지 않도록 교체
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.draws'::regclass and conname = 'draws_source_check'
  ) then
    alter table public.draws drop constraint draws_source_check;
  end if;
end $$;

-- 1) 함수 교체 (구버전 4인자 시그니처 삭제 후 5인자로 생성)
drop function if exists public.draw_ticket(uuid, integer, uuid, text);

-- ---------------------------------------------------------
-- 6. 뽑기 (굿즈 포인트 · 쿠폰 또는 교환 코드) — 동시에 두 명이 같은 번호를 뽑을 수 없도록
--    한 트랜잭션 안에서 티켓 행(과 포인트 결제 시 회원 행)을 FOR UPDATE 로 잠급니다.
--    v3.6: p_use_points = true 면 판 가격만큼 회원 굿즈 포인트를 차감하고 뽑습니다.
-- ---------------------------------------------------------
drop function if exists public.draw_ticket(uuid, integer, uuid, text);

create or replace function public.draw_ticket(
  p_board_id uuid,
  p_ticket_no integer,
  p_coupon_id uuid default null,
  p_code text default null,
  p_use_points boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_board   public.boards%rowtype;
  v_ticket  public.tickets%rowtype;
  v_profile public.profiles%rowtype;
  v_grade   text;
  v_tier    jsonb;
  v_points  integer := 0;
  v_used    integer := 0;
  v_status  text;
  v_source  text;
  v_left    integer := 0;
  v_is_last boolean := false;
  v_draw_id uuid := gen_random_uuid();
  v_code    text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_demo    text;
  v_coupon  public.coupons%rowtype;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    raise exception '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.';
  end if;

  select * into v_board from public.boards where id = p_board_id;
  if not found then
    raise exception '판을 찾을 수 없습니다.';
  end if;
  if v_board.status <> 'open' then
    raise exception '종료된 판입니다.';
  end if;

  -- 1) 번호 잠금 (재고 확인)
  select * into v_ticket
  from public.tickets
  where board_id = p_board_id and n = p_ticket_no
  for update;

  if not found then
    raise exception '존재하지 않는 번호입니다.';
  end if;
  if v_ticket.status <> 'available' then
    raise exception '이미 판매된 번호입니다. 다른 번호를 골라 주세요.';
  end if;

  -- 2) 결제 수단 검증 (굿즈 포인트 → 쿠폰 → 교환 코드 → 데모 코드)
  if coalesce(p_use_points, false) then
    -- 포인트 결제: 회원 행을 잠그고 판 가격만큼 차감 (같은 잔액으로 동시에 두 번 못 뽑게)
    select * into v_profile from public.profiles where id = v_uid for update;
    if not found then
      raise exception '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.';
    end if;
    if v_board.price is null or v_board.price <= 0 then
      raise exception '이 판은 포인트로 뽑을 수 없습니다.';
    end if;
    if coalesce(v_profile.points, 0) < v_board.price then
      raise exception '굿즈 포인트가 부족합니다. (필요 %P · 보유 %P)', v_board.price, coalesce(v_profile.points, 0);
    end if;
    v_used := v_board.price;
    update public.profiles set points = points - v_used where id = v_uid;
    v_profile.points := coalesce(v_profile.points, 0) - v_used;
    v_source := 'points';
  elsif p_coupon_id is not null then
    select * into v_coupon from public.coupons
     where id = p_coupon_id and user_id = v_uid and used_at is null
     for update;
    if not found then
      raise exception '이미 사용했거나 사용할 수 없는 쿠폰입니다.';
    end if;
    if v_coupon.board_id is not null and v_coupon.board_id <> p_board_id then
      raise exception '이 쿠폰은 다른 판에서만 사용할 수 있습니다.';
    end if;
    v_source := 'coupon';
  elsif v_code <> '' then
    select value into v_demo from public.app_settings where key = 'demo_code';
    if v_demo is not null and v_code = upper(regexp_replace(v_demo, '[^A-Za-z0-9]', '', 'g')) then
      v_source := 'demo';
    else
      update public.exchange_codes
         set used_at = now(), used_by = v_uid, used_n = p_ticket_no
       where upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) = v_code
         and used_at is null
         and (board_id is null or board_id = p_board_id);
      if not found then
        raise exception '사용할 수 없는 코드입니다. 코드를 다시 확인해 주세요.';
      end if;
      v_source := 'code';
    end if;
  else
    raise exception '쿠폰 · 교환 코드 · 굿즈 포인트 중 하나가 필요합니다.';
  end if;

  -- 3) 결과 배정
  v_grade := public.ticket_grade(v_board.seed, v_board.ticket_count, v_board.tiers, p_ticket_no);
  select t.tier into v_tier
  from jsonb_array_elements(v_board.tiers) with ordinality as t(tier, ord)
  where t.tier->>'grade' = v_grade
  limit 1;

  update public.tickets
     set status = 'sold', buyer_id = v_uid,
         buyer_name = public.mask_name(v_profile.nickname),
         grade = v_grade, drawn_at = now()
   where id = v_ticket.id;

  select count(*) into v_left
  from public.tickets
  where board_id = p_board_id and status = 'available';
  v_is_last := (v_left = 0);

  if coalesce((v_tier->>'pointOnly')::boolean, false) then
    v_points := coalesce((v_tier->>'points')::int, 0);
    v_status := '포인트지급';
    update public.profiles set points = points + v_points where id = v_uid;
    v_profile.points := v_profile.points + v_points;
  else
    v_status := '보관중';
  end if;

  insert into public.draws (id, user_id, board_id, n, grade, tier_label, points, item_status, source, is_last)
  values (v_draw_id, v_uid, p_board_id, p_ticket_no, v_grade, v_tier->>'label', v_points, v_status, v_source, v_is_last);

  if v_source = 'coupon' then
    update public.coupons set used_at = now(), used_draw_id = v_draw_id where id = p_coupon_id;
  end if;

  return jsonb_build_object(
    'id', v_draw_id,
    'board_id', p_board_id,
    'n', p_ticket_no,
    'grade', v_grade,
    'tier_label', v_tier->>'label',
    'points', v_points,
    'points_used', v_used,
    'points_balance', v_profile.points,
    'item_status', v_status,
    'is_last', v_is_last,
    'remaining', v_left,
    'source', v_source,
    'buyer_name', public.mask_name(v_profile.nickname)
  );
end;
$$;

-- 2) 권한 (새 시그니처에 실행 권한 부여)
grant execute on function public.draw_ticket(uuid, integer, uuid, text, boolean) to anon, authenticated;

-- 3) 확인: 아래 결과에 (uuid, integer, uuid, text, boolean) 한 줄이 나오면 성공
select p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'draw_ticket';
