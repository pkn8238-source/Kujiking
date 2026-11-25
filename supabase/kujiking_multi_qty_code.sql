-- =========================================================
-- 쿠지킹(KujiKing) v4.2.5 — 교환 코드 "N장(뽑기권 여러 장)" 일괄 지급
-- ---------------------------------------------------------
-- 이 파일 하나만 Supabase Dashboard → SQL Editor → New query 에
-- 전체 복사해서 Run 하면 됩니다. (한 번만, 다시 실행해도 안전)
--
-- 하는 일
--   1) exchange_codes 에 qty(코드 1개당 뽑기권 장수) 컬럼 추가 — 기존 코드는 전부 1장
--   2) exchange_code_info()    : 코드의 장수·대상 판·사용 여부만 확인 (코드를 소모하지 않음)
--   3) redeem_exchange_code()  : 코드 1회 소모 → 뽑기권 N장을 한 번에 지급 (로그인 필요)
--   4) draw_ticket()           : 1장 코드 전용으로 잠금 — N장 코드가 1장 뽑기로 소모되는 사고 방지
--   5) 확인용 집계 쿼리 (맨 아래)
--
-- ※ 1장짜리 기존 코드는 지금과 똑같이 동작합니다. (qty 기본값 1)
-- ※ N장 코드는 로그인 후에만 지급됩니다. (뽑기권을 계정에 보관해야 하므로)
-- =========================================================

-- ---------------------------------------------------------
-- [1] exchange_codes.qty — 코드 1개당 뽑기권 장수
-- ---------------------------------------------------------
alter table public.exchange_codes add column if not exists qty integer not null default 1;

-- 기존 코드는 모두 1장으로 채운다 (이미 값이 있으면 그대로)
update public.exchange_codes set qty = 1 where qty is null or qty < 1;

alter table public.exchange_codes drop constraint if exists exchange_codes_qty_check;
alter table public.exchange_codes
  add constraint exchange_codes_qty_check check (qty between 1 and 100);

comment on column public.exchange_codes.qty is '코드 1개를 입력했을 때 지급할 뽑기권 장수 (기본 1장, 최대 100장)';

-- ---------------------------------------------------------
-- [2] exchange_code_info — 코드 확인 (소모 없음)
--     · 손님이 코드를 넣었을 때 "1장인지 N장인지" 먼저 알려 주기 위한 함수
--     · anon(비로그인)도 호출 가능 — N장 코드면 로그인 안내를 띄운다
-- ---------------------------------------------------------
create or replace function public.exchange_code_info(
  p_code text,
  p_board_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_row  public.exchange_codes%rowtype;
begin
  if v_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;

  select * into v_row
  from public.exchange_codes
  where upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) = v_code
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_row.used_at is not null then
    return jsonb_build_object(
      'ok', false, 'reason', 'used',
      'used_at', v_row.used_at, 'qty', coalesce(v_row.qty, 1)
    );
  end if;

  if v_row.board_id is not null and p_board_id is not null and v_row.board_id <> p_board_id then
    return jsonb_build_object('ok', false, 'reason', 'board', 'board_id', v_row.board_id);
  end if;

  return jsonb_build_object(
    'ok', true,
    'qty', coalesce(v_row.qty, 1),
    'board_id', v_row.board_id
  );
end;
$$;

grant execute on function public.exchange_code_info(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------
-- [3] redeem_exchange_code — 코드 1회 소모 + 뽑기권 N장 일괄 지급
--     · 코드에 대상 판이 있으면 그 판 전용 뽑기권 N장
--     · "모든 판" 코드면 모든 판 뽑기권 N장
--     · 같은 사람이 다시 눌렀을 때는 중복 지급 없이 already=true 만 돌려준다
-- ---------------------------------------------------------
create or replace function public.redeem_exchange_code(
  p_code text,
  p_board_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid   uuid := auth.uid();
  v_code  text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_row   public.exchange_codes%rowtype;
  v_qty   integer := 1;
  v_board uuid;
  v_title text;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;
  if v_code = '' then
    raise exception '교환 코드를 입력해 주세요.';
  end if;

  /* 코드 행을 잠그고 확인 — 동시에 두 번 지급되지 않는다 */
  select * into v_row
  from public.exchange_codes
  where upper(regexp_replace(code, '[^A-Za-z0-9]', '', 'g')) = v_code
  limit 1
  for update;

  if not found then
    raise exception '등록되지 않은 코드입니다. 코드를 다시 확인해 주세요.';
  end if;

  if v_row.used_at is not null then
    if v_row.used_by = v_uid then
      return jsonb_build_object(
        'ok', true, 'already', true,
        'qty', coalesce(v_row.qty, 1), 'board_id', v_row.board_id
      );
    end if;
    raise exception '이미 사용된 코드입니다.';
  end if;

  if v_row.board_id is not null and p_board_id is not null and v_row.board_id <> p_board_id then
    raise exception '이 코드는 다른 판 전용입니다.';
  end if;

  v_qty   := greatest(1, least(100, coalesce(v_row.qty, 1)));
  v_board := v_row.board_id;

  update public.exchange_codes
     set used_at = now(), used_by = v_uid, used_n = null
   where code = v_row.code;

  if v_board is not null then
    select title into v_title from public.boards where id = v_board;
  end if;

  insert into public.coupons (user_id, board_id, kind, label, note, granted_at)
  select v_uid,
         v_board,
         case when v_board is null then 'universal' else 'board' end,
         case when v_board is null then '모든 판 뽑기권' else coalesce(v_title, '판') || ' 전용 뽑기권' end,
         '교환 코드 ' || v_row.code || ' · ' || v_qty || '장 일괄 지급',
         now()
  from generate_series(1, v_qty);

  return jsonb_build_object('ok', true, 'already', false, 'qty', v_qty, 'board_id', v_board);
end;
$$;

grant execute on function public.redeem_exchange_code(text, uuid) to authenticated;

-- ---------------------------------------------------------
-- [4] draw_ticket — 1장 코드 전용으로 잠금 (N장 코드 보호)
--     · 시그니처와 나머지 로직(라스트원상·P상·포인트)은 기존과 동일합니다
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
-- [5] 확인
-- ---------------------------------------------------------
select
  count(*)                                      as codes_total,
  count(*) filter (where coalesce(qty, 1) = 1)  as codes_1,
  count(*) filter (where coalesce(qty, 1) > 1)  as codes_n,
  count(*) filter (where used_at is null)       as unused
from public.exchange_codes;
