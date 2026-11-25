-- =========================================================
-- 쿠지킹(KujiKing) v4.2.6 — 포인트 뽑기 차단 + 굿즈샵(포인트 교환)
-- ---------------------------------------------------------
-- Supabase Dashboard → SQL Editor → New query 에 이 파일 전체를
-- 붙여넣고 RUN 하면 됩니다. (한 번만, 다시 실행해도 안전)
--
-- 하는 일
--   1) draw_ticket()  — '포인트로 뽑기' 차단 (p_use_points=true 면 예외)
--                        뽑기는 뽑기권(쿠폰) 또는 교환 코드로만
--                        P상 적립·실물→포인트 전환은 그대로 유지
--   2) P상 안내 문구 — 모든 판의 P상 desc·상품 설명서에서 '한 판 무료' 삭제
--                       (포인트 = 굿즈샵 교환 전용으로 문구 통일, 라이브 두 판 포함)
--   3) goods_items    — 굿즈 목록 (사진·상품명·필요 포인트·재고·설명·노출)
--   4) goods_orders   — 포인트 교환 주문 (배송지·운송장·상태)
--   5) redeem_goods_item() — 포인트 차감 + 재고 -1 + 주문 생성(한 트랜잭션)
--   6) RLS 정책과 확인 쿼리
--
-- ※ 이미 판매 중인 판·쿠폰·포인트에는 영향이 없습니다.
-- ※ 굿즈 사진은 기존 board-images 버킷에 goods/ 폴더로 올라갑니다.
-- =========================================================

-- 준비 (이미 있으면 그대로)
create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- [1] draw_ticket — 포인트 뽑기 차단
--     · 인자 시그니처(5개)는 그대로 두어 구버전 앱 캐시와도 부딪히지 않는다
--     · p_use_points = true 로 호출되면 포인트를 건드리지 않고 바로 예외
--     · 쿠폰·교환 코드·데모 코드 경로와 라스트원상·P상 적립 로직은 v4.2.5 와 동일
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

  -- 2) 결제 수단 검증 (쿠폰 → 교환 코드 → 데모 코드)
  --    v4.2.6 — 포인트로 뽑기는 폐지. p_use_points=true 로 들어와도 포인트를 건드리지 않고 막는다.
  if coalesce(p_use_points, false) then
    raise exception '포인트로 뽑기는 종료되었습니다. 뽑기는 뽑기권(쿠폰) 또는 교환 코드로만 할 수 있습니다. 모은 포인트는 굿즈 교환에 사용해 주세요.';
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

-- ---------------------------------------------------------
-- [1-2] P상 안내 문구에서 '한 판 무료' 삭제
--   포인트는 뽑기 결제가 아니라 '굿즈샵에서 굿즈 교환'에 쓴다.
--   · 모든 판의 P상 desc 를 '실물 대신 굿즈 포인트 1,200P 바로 적립 · 굿즈샵에서 원하는 굿즈와 교환'
--   · 상품 설명서(manual.notes)의 '15,500P를 모으면 한 판을 한 번 더 뽑을 수 있어요' 문장 교체
--   (지금 라이브 두 판 — 크리스마스·갸루 — 도 이 문장으로 갱신됩니다)
-- ---------------------------------------------------------
update public.boards b
   set tiers = t.new_tiers
  from (
    select b2.id,
           jsonb_agg(
             case when x.t->>'grade' = 'P'
                  then jsonb_set(x.t, '{desc}', to_jsonb(
                        '실물 대신 굿즈 포인트 ' || coalesce(x.t->>'points', '1200') || 'P 바로 적립 · 굿즈샵에서 원하는 굿즈와 교환'))
                  else x.t end
             order by x.ord
           ) as new_tiers
      from public.boards b2,
           jsonb_array_elements(b2.tiers) with ordinality as x(t, ord)
     group by b2.id
  ) t
 where b.id = t.id
   and exists (
     select 1 from jsonb_array_elements(b.tiers) e
      where e->>'grade' = 'P'
        and coalesce(e->>'desc', '') like '%한 판 무료%'
   );

update public.boards b
   set manual = jsonb_set(b.manual, '{notes}', t.new_notes)
  from (
    select b2.id,
           jsonb_agg(
             case when n like '%한 판을 한 번 더 뽑을 수 있어요%'
                  then to_jsonb('P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 모은 포인트는 굿즈샵에서 원하는 굿즈로 교환할 수 있어요.')
                  else to_jsonb(n) end
             order by x.ord
           ) as new_notes
      from public.boards b2,
           jsonb_array_elements_text(
             case when jsonb_typeof(b2.manual->'notes') = 'array' then b2.manual->'notes' else '[]'::jsonb end
           ) with ordinality as x(n, ord)
     group by b2.id
  ) t
 where b.id = t.id
   and b.manual->>'notes' like '%한 판을 한 번 더 뽑을 수 있어요%';

-- 남아 있는 '한 판 무료' 표현이 있으면 마지막으로 한 번 더 정리 (문장이 아닌 라벨 수준)
update public.boards
   set manual = replace(replace(manual::text, '한 판 무료', '굿즈샵 교환'), '한판 무료', '굿즈샵 교환')::jsonb
 where manual::text like '%한 판 무료%' or manual::text like '%한판 무료%';

-- ---------------------------------------------------------
-- [2] goods_items — 굿즈 목록
-- ---------------------------------------------------------
create table if not exists public.goods_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  points      integer not null check (points between 1 and 1000000),   -- 필요 포인트(P)
  stock       integer not null default 0 check (stock >= 0),           -- 남은 재고
  image_url   text,                                                   -- 사진 주소(board-images/goods/...)
  description text,                                                   -- 간단 설명(선택)
  active      boolean not null default true,                          -- false = 손님 화면에서 숨김
  sort        integer not null default 0,                             -- 낮을수록 앞
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists goods_items_sort_idx on public.goods_items (active, sort, created_at desc);

comment on table public.goods_items is '쿠지킹 굿즈샵 — 포인트로 교환하는 실물 굿즈';
comment on column public.goods_items.points is '교환에 필요한 굿즈 포인트(P)';
comment on column public.goods_items.stock is '남은 재고 수량 (교환 시 1씩 차감)';

-- ---------------------------------------------------------
-- [3] goods_orders — 포인트 교환 주문 (배송·송장)
-- ---------------------------------------------------------
create table if not exists public.goods_orders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  item_id     uuid references public.goods_items(id) on delete set null,
  item_name   text not null,                       -- 주문 당시 상품명 (굿즈 삭제돼도 남긴다)
  item_image  text,                                -- 주문 당시 사진
  points      integer not null default 0 check (points >= 0),
  recipient   text not null,
  phone       text not null,
  postcode    text,
  address     text not null,
  memo        text,
  carrier     text,
  tracking    text,
  status      text not null default '요청' check (status in ('요청', '출고완료', '취소')),
  created_at  timestamptz not null default now(),
  shipped_at  timestamptz
);

create index if not exists goods_orders_user_idx on public.goods_orders (user_id, created_at desc);
create index if not exists goods_orders_status_idx on public.goods_orders (status, created_at desc);

comment on table public.goods_orders is '쿠지킹 굿즈샵 주문 — 포인트 교환 내역과 배송 상태';

-- ---------------------------------------------------------
-- [4] RLS — 손님은 목록 읽기·본인 주문 읽기만, 쓰기는 관리자/RPC만
-- ---------------------------------------------------------
alter table public.goods_items  enable row level security;
alter table public.goods_orders enable row level security;

drop policy if exists goods_items_select on public.goods_items;
create policy goods_items_select on public.goods_items
  for select using (true);

drop policy if exists goods_items_admin on public.goods_items;
create policy goods_items_admin on public.goods_items
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists goods_orders_select on public.goods_orders;
create policy goods_orders_select on public.goods_orders
  for select using (auth.uid() = user_id or public.is_admin());

drop policy if exists goods_orders_admin on public.goods_orders;
create policy goods_orders_admin on public.goods_orders
  for all using (public.is_admin()) with check (public.is_admin());

-- 주문 INSERT 정책은 두지 않는다 — 포인트 차감 없는 직접 INSERT 를 막기 위해
-- redeem_goods_item() (security definer) 로만 주문이 만들어진다.

-- ---------------------------------------------------------
-- [5] redeem_goods_item — 포인트 차감 + 재고 -1 + 주문 생성
--     한 트랜잭션 안에서 굿즈 행과 회원 행을 FOR UPDATE 로 잠가
--     동시에 두 번 눌러도 재고·포인트가 음수가 되지 않는다.
-- ---------------------------------------------------------
create or replace function public.redeem_goods_item(
  p_item_id  uuid,
  p_recipient text,
  p_phone     text,
  p_postcode  text default null,
  p_address   text default null,
  p_memo      text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_item    public.goods_items%rowtype;
  v_profile public.profiles%rowtype;
  v_order   public.goods_orders%rowtype;
begin
  if v_uid is null then
    raise exception '굿즈를 교환하려면 로그인이 필요합니다.';
  end if;

  if coalesce(btrim(p_recipient), '') = '' or coalesce(btrim(p_phone), '') = '' or coalesce(btrim(p_address), '') = '' then
    raise exception '받는 사람·연락처·주소를 모두 입력해 주세요.';
  end if;

  -- 굿즈 행 잠금 (재고 확인 ~ 차감을 한 번에)
  select * into v_item from public.goods_items where id = p_item_id for update;
  if not found then
    raise exception '굿즈를 찾을 수 없습니다.';
  end if;
  if not coalesce(v_item.active, true) then
    raise exception '판매가 끝난 굿즈입니다.';
  end if;
  if coalesce(v_item.stock, 0) <= 0 then
    raise exception '품절된 굿즈입니다.';
  end if;

  -- 회원 행 잠금 (같은 잔액으로 동시에 두 번 교환하지 못하게)
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then
    raise exception '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.';
  end if;
  if coalesce(v_profile.points, 0) < v_item.points then
    raise exception '포인트가 부족합니다. (필요 %P · 보유 %P)', v_item.points, coalesce(v_profile.points, 0);
  end if;

  -- 포인트 차감
  update public.profiles
     set points = points - v_item.points
   where id = v_uid
   returning * into v_profile;

  -- 재고 -1
  update public.goods_items
     set stock = stock - 1, updated_at = now()
   where id = v_item.id
   returning * into v_item;

  -- 주문 생성
  insert into public.goods_orders
    (user_id, item_id, item_name, item_image, points, recipient, phone, postcode, address, memo)
  values
    (v_uid, v_item.id, v_item.name, v_item.image_url, v_item.points,
     btrim(p_recipient), btrim(p_phone), nullif(btrim(coalesce(p_postcode, '')), ''), btrim(p_address),
     nullif(btrim(coalesce(p_memo, '')), ''))
  returning * into v_order;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'item_id', v_item.id,
    'item_name', v_order.item_name,
    'item_image', v_order.item_image,
    'points', v_order.points,
    'points_balance', v_profile.points,
    'stock', v_item.stock,
    'address', v_order.address,
    'status', v_order.status,
    'created_at', v_order.created_at
  );
end;
$$;

revoke all on function public.redeem_goods_item(uuid, text, text, text, text, text) from public;
grant execute on function public.redeem_goods_item(uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------
-- [6] 확인 — 표는 0건으로 시작해도 정상입니다
-- ---------------------------------------------------------
select
  (select count(*) from public.goods_items)  as goods_items,
  (select count(*) from public.goods_orders) as goods_orders,
  (select count(*) from public.goods_items where stock > 0 and active) as on_sale,
  (select count(*) from public.boards where tiers::text like '%한 판 무료%') as p_free_left;

-- 포인트 뽑기가 정말 막혔는지: 아래를 실행하면 예외 메시지가 나와야 정상
-- select public.draw_ticket(
--   (select id from public.boards limit 1), 1, null, null, true
-- );
