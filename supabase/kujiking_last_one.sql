-- =========================================================
-- 쿠지킹(KujiKing) — 라스트원상(LAST ONE) 실제 지급
-- ---------------------------------------------------------
-- 사용법
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 전체를 붙여넣고 Run  (한 번만 실행하면 됩니다. 다시 실행해도 안전)
--   3) 실행 후 사이트에서 마지막 1장이 팔리면, 그 사람에게
--      라스트원 상품이 '내 보관함'에 자동으로 담깁니다.
--
-- 하는 일
--   · boards  : last_one_winner_id / last_one_winner_name / last_one_won_at 컬럼 추가
--   · draws   : is_last_one 컬럼 추가 (라스트원 보너스 행 표시)
--   · tickets : is_last 컬럼 추가 (마지막 1장 표시 — 방금 팔린 번호·번호판 왕관)
--   · draw_ticket(uuid, integer, uuid, text, boolean) 교체
--       - 마지막 1장을 뽑은 순간(같은 트랜잭션·같은 for update 잠금 안에서)
--         보드에 우승자를 기록하고, 라스트원 상품을 draws 에 '보관중'으로 한 행 더 넣는다.
--         · 보너스 행은 n = 0, grade = 'LAST', tier_label = last_one_label
--           (티켓 번호 1~N 과 겹치지 않게 0번을 쓴다 — draws 는 (board_id, n) 유니크)
--       - 결과 JSON 에 last_one_won / last_one_label / last_one_image / last_one_desc 를 더해 돌려준다.
--   · admin_reset_board(uuid) 교체 — 판매 초기화 때 라스트원 우승자·tickets.is_last 도 함께 비운다.
-- =========================================================

-- ---------------------------------------------------------
-- 1) 컬럼 추가 (이미 있으면 건너뜀)
-- ---------------------------------------------------------
alter table public.boards  add column if not exists last_one_winner_id   uuid;
alter table public.boards  add column if not exists last_one_winner_name text;
alter table public.boards  add column if not exists last_one_won_at      timestamptz;
alter table public.draws   add column if not exists is_last_one          boolean not null default false;
alter table public.tickets add column if not exists is_last              boolean not null default false;

create index if not exists boards_last_one_idx on public.boards (last_one_won_at desc);
create index if not exists draws_last_one_idx  on public.draws  (is_last_one) where is_last_one;

-- ---------------------------------------------------------
-- 2) draw_ticket 교체 — 라스트원상 지급 포함
-- ---------------------------------------------------------
drop function if exists public.draw_ticket(uuid, integer, uuid, text);
drop function if exists public.draw_ticket(uuid, integer, uuid, text, boolean);

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

-- ---------------------------------------------------------
-- 3) admin_reset_board 교체 — 라스트원 우승자도 함께 초기화
-- ---------------------------------------------------------
create or replace function public.admin_reset_board(p_board_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_sold integer;
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;

  select count(*) into v_sold
  from public.tickets
  where board_id = p_board_id and status = 'sold';

  delete from public.deliveries where board_id = p_board_id;
  delete from public.draws      where board_id = p_board_id;
  update public.tickets
     set status = 'available', buyer_id = null, buyer_name = null,
         grade = null, drawn_at = null, is_last = false
   where board_id = p_board_id;
  update public.boards
     set status = 'open',
         last_one_winner_id = null,
         last_one_winner_name = null,
         last_one_won_at = null
   where id = p_board_id;

  return jsonb_build_object('board_id', p_board_id, 'reset', v_sold);
end;
$$;

grant execute on function public.admin_reset_board(uuid) to authenticated;

-- ---------------------------------------------------------
-- 확인용 (필요할 때 아래 두 줄을 따로 Run)
-- ---------------------------------------------------------
-- select id, title, ticket_count, last_one_winner_name, last_one_won_at from public.boards order by created_at desc;
-- select board_id, n, grade, tier_label, item_status, is_last, is_last_one from public.draws where is_last_one order by created_at desc;
