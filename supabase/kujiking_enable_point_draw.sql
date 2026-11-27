-- =========================================================
-- 쿠지킹(KujiKing) v4.4.6 — 포인트로 뽑기 부활 SQL
-- ---------------------------------------------------------
-- Supabase Dashboard → SQL Editor → New query 에 이 파일 전체를
-- 붙여넣고 RUN 한 번만 누르면 됩니다. (여러 번 실행해도 안전)
--
-- 하는 일
--   1) draw_ticket() 교체 — p_use_points = true 로 들어오면
--      그 판의 1장 가격(boards.price)과 똑같은 포인트를 차감하고 뽑는다.
--        · 크리스마스 판 9,900원 → 9,900P 로 1장
--        · 갸루 판      15,500원 → 15,500P 로 1장
--        · 연뽑(N장)은 서버에 N번 호출되므로 N × 1장 가격만큼 차감된다.
--      포인트 = 뽑기 결제 + 굿즈샵 교환 두 곳에 함께 쓴다(굿즈샵 기능은 그대로).
--   2) 뽑기권(쿠폰)·교환 코드·데모 코드 경로와 P상 적립·라스트원상 로직은
--      지금 쓰는 v4.2.6~v4.4.5 그대로 유지한다. (화면 문구·문자 안내는 손대지 않음)
--   3) draws.source 에 'points' 가 들어갈 수 있게 예전 CHECK 제약만 정리한다.
--
-- ※ 판매 중인 판·쿠폰·포인트 잔액에는 영향이 없습니다.
-- ※ 이 SQL 을 실행하기 전에 포인트로 뽑으면 "포인트 뽑기 설정이 아직 DB에 없어요"
--    안내가 뜨고 실제 뽑기는 되지 않습니다(포인트도 차감되지 않음).
-- =========================================================

-- 준비 (이미 있으면 그대로)
create extension if not exists pgcrypto;

-- 0) draws.source CHECK 제약이 'points' 를 막고 있으면 정리
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.draws'::regclass and conname = 'draws_source_check'
  ) then
    alter table public.draws drop constraint draws_source_check;
  end if;
end $$;

-- 1) draw_ticket — 포인트 결제 허용 (시그니처 5개 그대로, 구버전 앱 캐시와도 충돌 없음)
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
  v_is_point boolean := false;
  v_used    integer := 0;
  v_status  text;
  v_source  text;
  v_left    integer := 0;
  v_is_last boolean := false;
  v_lo_won  boolean := false;
  v_lo_name text;
  v_lo_id   uuid;
  v_draw_id uuid := gen_random_uuid();
  v_code    text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_demo    text;
  v_coupon  public.coupons%rowtype;
  v_code_row public.exchange_codes%rowtype;   /* v4.2.5 — N장 코드(qty) 확인용 */
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

  -- 2) 결제 수단 검증 (포인트 → 쿠폰 → 교환 코드 → 데모 코드)
  --    v4.4.6 — 포인트로 뽑기 부활: 이 판의 1장 가격(boards.price)과 똑같은 포인트를 차감한다.
  --    포인트를 쓰는 동안 회원 행을 잠가, 같은 잔액으로 동시에 두 번 뽑히지 않게 한다.
  if coalesce(p_use_points, false) then
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
      /* v4.2.5 — N장 코드(qty > 1)는 1장 뽑기에서 소모하지 않는다.
         (코드 한 번으로 뽑기권 N장을 지급하는 redeem_exchange_code 전용) */
      select * into v_code_row
      from public.exchange_codes
      where upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) = v_code
        and used_at is null
        and (board_id is null or board_id = p_board_id)
      for update;
      if not found then
        raise exception '사용할 수 없는 코드입니다. 코드를 다시 확인해 주세요.';
      end if;
      if coalesce(v_code_row.qty, 1) > 1 then
        raise exception '이 코드는 뽑기권 %장 코드입니다. 뽑기 화면에서 코드를 넣으면 %장이 한 번에 지급됩니다.', v_code_row.qty, v_code_row.qty;
      end if;
      update public.exchange_codes
         set used_at = now(), used_by = v_uid, used_n = p_ticket_no
       where code = v_code_row.code;
      v_source := 'code';
    end if;
  else
    raise exception '뽑기권(쿠폰) 또는 교환 코드가 필요합니다.';
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

  -- 4) P상(포인트 꽝) 판정 — 실물 배송이 없으므로 보관함(draws 보관중)을 만들지 않는다
  v_is_point := coalesce((v_tier->>'pointOnly')::boolean, false)
                or coalesce((v_tier->>'points_awarded')::int, 0) > 0;

  if v_is_point then
    v_points := coalesce((v_tier->>'points_awarded')::int, 0);
    if v_points <= 0 then
      v_points := coalesce((v_tier->>'points')::int, 0);
    end if;
    v_status := '포인트지급';
    update public.profiles set points = points + v_points where id = v_uid;
    v_profile.points := coalesce(v_profile.points, 0) + v_points;
  else
    v_status := '보관중';
  end if;

  insert into public.draws (id, user_id, board_id, n, grade, tier_label, points, item_status, source, is_last, is_last_one)
  values (v_draw_id, v_uid, p_board_id, p_ticket_no, v_grade, v_tier->>'label', v_points, v_status, v_source, v_is_last, false);

  if v_source = 'coupon' then
    update public.coupons set used_at = now(), used_draw_id = v_draw_id where id = p_coupon_id;
  end if;

  -- 5) 라스트원상 — 이 판의 마지막 1장을 뽑은 사람에게 라스트원 상품을 '추가로' 지급
  --    · 같은 트랜잭션 안에서 실행되므로, 동시에 두 사람이 마지막 1장을 가져갈 수 없다
  --    · 이미 우승자가 기록된 판이면(중복 실행·재초기화 전 데이터) 아무 것도 하지 않는다
  if v_is_last
     and v_board.last_one_winner_id is null
     and coalesce(btrim(v_board.last_one_label), '') <> '' then

    update public.boards
       set last_one_winner_id   = v_uid,
           last_one_winner_name = public.mask_name(v_profile.nickname),
           last_one_won_at      = now()
     where id = p_board_id
       and last_one_winner_id is null
     returning id into v_lo_id;

    if v_lo_id is not null then
      v_lo_won := true;
      v_lo_name := public.mask_name(v_profile.nickname);

      update public.tickets set is_last = true where id = v_ticket.id;

      insert into public.draws (user_id, board_id, n, grade, tier_label, points, item_status, source, is_last, is_last_one)
      values (v_uid, p_board_id, 0, 'LAST', v_board.last_one_label, 0, '보관중', v_source, true, true)
      on conflict (board_id, n) do nothing;
    end if;
  end if;

  return jsonb_build_object(
    'id', v_draw_id,
    'board_id', p_board_id,
    'n', p_ticket_no,
    'grade', v_grade,
    'tier_label', v_tier->>'label',
    'points', v_points,
    'points_awarded', v_points,
    'points_used', v_used,
    'points_balance', v_profile.points,
    'item_status', v_status,
    'is_point', v_is_point,
    'is_last', v_is_last,
    'last_one_won', v_lo_won,
    'last_one_label', case when v_lo_won then v_board.last_one_label end,
    'last_one_image', case when v_lo_won then v_board.last_one_image end,
    'last_one_desc',  case when v_lo_won then v_board.last_one_desc  end,
    'last_one_winner_name', v_lo_name,
    'remaining', v_left,
    'source', v_source,
    'buyer_name', public.mask_name(v_profile.nickname)
  );
end;
$$;


grant execute on function public.draw_ticket(uuid, integer, uuid, text, boolean) to anon, authenticated;

-- 2) 확인용 (실행 결과에 한 줄이 나오면 정상)
select p.proname as function_name, pg_get_function_identity_arguments(p.oid) as arguments
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'draw_ticket';
