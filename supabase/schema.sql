-- =========================================================
-- 쿠지킹 KUJIKING v2 — Supabase 스키마
-- ---------------------------------------------------------
-- Supabase Dashboard → SQL Editor 에 이 파일 전체를 붙여넣고 Run 하세요.
-- 다시 실행해도 안전하도록 (if not exists / create or replace) 작성했습니다.
--
-- 설치 후 할 일
--  1) assets/config.js 에 Project URL 과 anon public key 입력
--  2) 회원가입 후 첫 관리자 지정:
--     update public.profiles set is_admin = true where email = '내 이메일';
--  3) Authentication → Providers → Email 을 켜고
--     (테스트 중에는) Confirmemail 을 꺼 두면 가입 즉시 로그인됩니다.
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- 0. 공통 헬퍼
-- ---------------------------------------------------------

-- 닉네임 마스킹: 박기남 → 박*남 , 김솔 → 김* , 쿠지러버 → 쿠***버
create or replace function public.mask_name(p_name text)
returns text
language sql immutable
as $$
  select case
    when p_name is null or length(btrim(p_name)) = 0 then '익명'
    when length(p_name) = 1 then left(p_name, 1) || '*'
    when length(p_name) = 2 then left(p_name, 1) || '*'
    else left(p_name, 1) || repeat('*', length(p_name) - 2) || right(p_name, 1)
  end;
$$;

-- ---------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  nickname   text not null default '쿠지팬',
  phone      text,
  is_admin   boolean not null default false,
  points     integer not null default 0 check (points >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.boards (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  category       text not null default '자체 스페셜',
  cover          text,                              -- 커버 이미지 경로/URL (비우면 카테고리 색상 커버)
  price          integer not null check (price > 0),
  ticket_count   integer not null check (ticket_count between 1 and 500),   -- 최대 500장 (등급 25종 × 20장)
  tiers          jsonb not null,                    -- [{grade,label,count,points,pointOnly,points_awarded,image,desc}]
                                                    --   pointOnly=true 또는 points_awarded>0 이면 P상(굿즈 포인트 즉시 적립)
  last_one_label text,
  last_one_image text,                              -- 라스트원 이미지 경로
  last_one_desc  text,                              -- 라스트원 설명 (크기·특징)
  manual         jsonb,                             -- {summary, specs:[{k,v}], lineup:[..], notes:[..]} 상품 설명서
  status         text not null default 'open' check (status in ('open','closed')),
  seed           text not null,
  seed_hash      text not null,
  created_at     timestamptz not null default now(),
  sealed_at      timestamptz not null default now()
);

create table if not exists public.tickets (
  id         bigserial primary key,
  board_id   uuid not null references public.boards(id) on delete cascade,
  n          integer not null check (n >= 1),
  status     text not null default 'available' check (status in ('available','sold')),
  buyer_id   uuid references public.profiles(id) on delete set null,
  buyer_name text,
  grade      text,
  drawn_at   timestamptz,
  unique (board_id, n)
);
alter table public.boards add column if not exists cover text;
alter table public.boards add column if not exists last_one_image text;
alter table public.boards add column if not exists last_one_desc text;
alter table public.boards add column if not exists manual jsonb;
-- 기존 DB의 300장 제약을 500장으로 갱신 (등급 12종 × 20장 = 240장까지 운용)
alter table public.boards drop constraint if exists boards_ticket_count_check;
alter table public.boards add constraint boards_ticket_count_check check (ticket_count between 1 and 500);
create index if not exists tickets_board_idx on public.tickets (board_id, status);

create table if not exists public.exchange_codes (
  code       text primary key,
  board_id   uuid references public.boards(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  used_by    uuid references public.profiles(id) on delete set null,
  used_n     integer
);

create table if not exists public.coupons (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  board_id     uuid references public.boards(id) on delete set null,  -- null = 모든 판 사용 가능
  kind         text not null default 'board' check (kind in ('board','universal')),
  label        text,
  note         text,
  granted_by   uuid references public.profiles(id) on delete set null,
  granted_at   timestamptz not null default now(),
  used_at      timestamptz,
  used_draw_id uuid
);
create index if not exists coupons_user_idx on public.coupons (user_id, used_at);

create table if not exists public.draws (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete set null,
  board_id    uuid not null references public.boards(id) on delete cascade,
  n           integer not null,
  grade       text,
  tier_label  text,
  points      integer not null default 0,
  item_status text,                                  -- 보관중 / 배송신청 / 출고완료 / 포인트지급 / 포인트전환
  source      text not null default 'code',          -- points / coupon / code / demo
  is_last     boolean not null default false,
  seq         bigserial,
  created_at  timestamptz not null default now(),
  unique (board_id, n)
);
create index if not exists draws_user_idx on public.draws (user_id, created_at desc);

create table if not exists public.purchase_claims (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  board_id   uuid references public.boards(id) on delete set null,
  channel    text not null default '스마트스토어',   -- 스마트스토어 / 계좌입금
  order_no   text not null,
  qty        integer not null default 1 check (qty between 1 and 100),
  amount     integer,
  memo       text,
  status     text not null default 'pending' check (status in ('pending','approved','rejected')),
  granted    integer not null default 0,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null
);
create index if not exists claims_status_idx on public.purchase_claims (status, created_at desc);

create table if not exists public.deliveries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  draw_id      uuid references public.draws(id) on delete set null,
  board_id     uuid references public.boards(id) on delete set null,
  item_label   text,
  grade        text,
  recipient    text not null,
  phone        text not null,
  postcode     text,
  address      text not null,
  memo         text,
  carrier      text,
  tracking     text,
  status       text not null default '요청' check (status in ('요청','출고완료')),
  requested_at timestamptz not null default now(),
  shipped_at   timestamptz
);
create index if not exists deliveries_status_idx on public.deliveries (status, requested_at desc);

create table if not exists public.app_settings (
  key   text primary key,
  value text
);
-- 실제 서비스에서는 체험용 무료 코드를 두지 않습니다.
-- (데모 모드는 브라우저 localStorage 로만 동작하므로 서버 설정이 필요 없습니다)
-- 데모 코드가 남아 있으면 로그인한 누구나 무료로 뽑을 수 있으니, 이미 넣었다면 지워 주세요:
--   delete from public.app_settings where key = 'demo_code';

-- ---------------------------------------------------------
-- 2. 가입 시 프로필 자동 생성
-- ---------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public, extensions
as $$
begin
  insert into public.profiles (id, email, nickname, phone)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'nickname', ''), split_part(coalesce(new.email, 'kuji'), '@', 1)),
    new.raw_user_meta_data->>'phone'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------
-- 3. 관리자 판별 (RLS 정책보다 먼저 정의)
-- ---------------------------------------------------------
create or replace function public.is_admin(p_uid uuid default auth.uid())
returns boolean
language sql stable security definer set search_path = public, extensions
as $$
  select coalesce((select is_admin from public.profiles where id = p_uid), false);
$$;

-- ---------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.boards          enable row level security;
alter table public.tickets         enable row level security;
alter table public.exchange_codes  enable row level security;
alter table public.coupons         enable row level security;
alter table public.draws           enable row level security;
alter table public.purchase_claims enable row level security;
alter table public.deliveries      enable row level security;
alter table public.app_settings    enable row level security;

-- profiles: 본인 또는 관리자만 조회, 수정은 닉네임/전화만
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (auth.uid() = id);

-- boards: 누구나 조회, 관리자만 쓰기
drop policy if exists boards_select on public.boards;
create policy boards_select on public.boards for select using (true);
drop policy if exists boards_write on public.boards;
create policy boards_write on public.boards for all using (public.is_admin()) with check (public.is_admin());

-- tickets: 누구나 조회(실시간 판매 현황 공개), 쓰기는 RPC(security definer)만
drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets for select using (true);
drop policy if exists tickets_admin on public.tickets;
create policy tickets_admin on public.tickets for all using (public.is_admin()) with check (public.is_admin());

-- exchange codes: 관리자만 직접 조회. 사용은 RPC 로만.
drop policy if exists codes_admin on public.exchange_codes;
create policy codes_admin on public.exchange_codes for all using (public.is_admin()) with check (public.is_admin());

-- coupons: 본인 또는 관리자
drop policy if exists coupons_select on public.coupons;
create policy coupons_select on public.coupons for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists coupons_admin on public.coupons;
create policy coupons_admin on public.coupons for all using (public.is_admin()) with check (public.is_admin());

-- draws: 본인 또는 관리자 (남의 뽑기 결과는 tickets 로만 공개)
drop policy if exists draws_select on public.draws;
create policy draws_select on public.draws for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists draws_admin on public.draws;
create policy draws_admin on public.draws for all using (public.is_admin()) with check (public.is_admin());

-- purchase_claims: 본인 또는 관리자
drop policy if exists claims_select on public.purchase_claims;
create policy claims_select on public.purchase_claims for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists claims_insert on public.purchase_claims;
create policy claims_insert on public.purchase_claims for insert with check (auth.uid() = user_id);
drop policy if exists claims_admin on public.purchase_claims;
create policy claims_admin on public.purchase_claims for all using (public.is_admin()) with check (public.is_admin());

-- deliveries: 본인 또는 관리자
drop policy if exists deliveries_select on public.deliveries;
create policy deliveries_select on public.deliveries for select using (auth.uid() = user_id or public.is_admin());
drop policy if exists deliveries_insert on public.deliveries;
create policy deliveries_insert on public.deliveries for insert with check (auth.uid() = user_id);
drop policy if exists deliveries_admin on public.deliveries;
create policy deliveries_admin on public.deliveries for all using (public.is_admin()) with check (public.is_admin());

-- app_settings: 누구나 읽기(데모 코드 판별용), 관리자만 쓰기
drop policy if exists settings_select on public.app_settings;
create policy settings_select on public.app_settings for select using (true);
drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------
-- 5. 번호별 등급 계산 (JS 와 동일한 규칙)
--    h(n) = SHA-256(seed + ':' + n) 오름차순 정렬 → 등급 순서대로 배치
-- ---------------------------------------------------------
create or replace function public.ticket_grade(
  p_seed text,
  p_ticket_count integer,
  p_tiers jsonb,
  p_n integer
) returns text
language plpgsql immutable security definer set search_path = public, extensions
as $$
declare
  v_rn integer;
  v_grade text;
begin
  with hashed as (
    select g.n as n,
           encode(digest(p_seed || ':' || g.n::text, 'sha256'), 'hex') as hh
    from generate_series(1, p_ticket_count) as g(n)
  ), ranked as (
    select n, row_number() over (order by hh) as rn from hashed
  )
  select rn into v_rn from ranked where n = p_n;

  select t.tier->>'grade' into v_grade
  from jsonb_array_elements(p_tiers) with ordinality as t(tier, ord)
  where v_rn <= (
    select sum((t2.tier->>'count')::int)
    from jsonb_array_elements(p_tiers) with ordinality as t2(tier, ord2)
    where t2.ord2 <= t.ord
  )
  order by t.ord
  limit 1;

  if v_grade is null then
    select t.tier->>'grade' into v_grade
    from jsonb_array_elements(p_tiers) with ordinality as t(tier, ord)
    order by t.ord desc limit 1;
  end if;

  return v_grade;
end;
$$;

-- ---------------------------------------------------------
-- 5-1. 회원 목록 (관리자 전용 · 쿠폰/뽑기 수 집계)
-- ---------------------------------------------------------
create or replace function public.admin_members(p_search text default '')
returns setof jsonb
language plpgsql security definer set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;

  return query
  select jsonb_build_object(
    'id', p.id,
    'email', p.email,
    'nickname', p.nickname,
    'phone', p.phone,
    'points', p.points,
    'is_admin', p.is_admin,
    'created_at', p.created_at,
    'coupons', (select count(*) from public.coupons c where c.user_id = p.id and c.used_at is null),
    'draws', (select count(*) from public.draws d where d.user_id = p.id)
  )
  from public.profiles p
  where coalesce(btrim(p_search), '') = ''
     or p.email ilike '%' || p_search || '%'
     or p.nickname ilike '%' || p_search || '%'
     or (regexp_replace(p_search, '[^0-9]', '', 'g') <> ''
         and regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g')
             like '%' || regexp_replace(p_search, '[^0-9]', '', 'g') || '%')
  order by p.created_at desc
  limit 300;
end;
$$;

-- ---------------------------------------------------------
-- 5-2. 프로필 컬럼 권한 (회원이 스스로 is_admin / points 를 못 바꾸게)
-- ---------------------------------------------------------
revoke update on public.profiles from authenticated;
revoke update on public.profiles from anon;
grant update (nickname, phone) on public.profiles to authenticated;
revoke insert on public.profiles from authenticated;
revoke insert on public.profiles from anon;
grant insert (id, email, nickname, phone) on public.profiles to authenticated;

-- ---------------------------------------------------------
-- 5-3. 테이블 접근 권한 (GRANT)
--   RLS 만 켜 두면 anon/authenticated 롤이 테이블 자체에 접근하지 못해
--   "permission denied for table boards" (42501) 가 납니다. 반드시 함께 실행하세요.
-- ---------------------------------------------------------
grant usage on schema public to anon, authenticated;

-- 비로그인 방문자: 판 · 번호표 · 설정 읽기 (개인 데이터는 RLS 가 막습니다)
grant select on public.boards, public.tickets, public.draws, public.app_settings to anon;

-- 로그인 회원: 조회 + 본인 데이터 쓰기 (행 제한은 RLS 가 담당)
grant select on public.boards, public.tickets, public.app_settings,
                public.profiles, public.coupons, public.draws,
                public.purchase_claims, public.deliveries, public.exchange_codes
  to authenticated;

grant insert, update on public.purchase_claims to authenticated;
grant insert on public.deliveries to authenticated;

-- 관리자 동작 (RLS 의 is_admin() 가 실제 허용 범위를 제한)
grant select, insert, update, delete on public.boards, public.tickets,
      public.coupons, public.draws, public.exchange_codes, public.app_settings
  to authenticated;

-- 프로필은 닉네임·전화만 수정 가능 (is_admin / points 는 못 바꿈)
grant update (nickname, phone) on public.profiles to authenticated;
grant insert (id, email, nickname, phone) on public.profiles to authenticated;

grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to anon, authenticated;

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
  v_is_point boolean := false;
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

  if coalesce((v_tier->>'pointOnly')::boolean, false)
     or coalesce((v_tier->>'points_awarded')::int, 0) > 0 then
    -- P상: 실물 배송이 없으므로 보관함(보관중)을 만들지 않고 포인트만 바로 적립
    v_is_point := true;
    v_points := coalesce((v_tier->>'points_awarded')::int, 0);
    if v_points <= 0 then v_points := coalesce((v_tier->>'points')::int, 0); end if;
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
    'points_awarded', v_points,
    'points_used', v_used,
    'points_balance', v_profile.points,
    'item_status', v_status,
    'is_point', v_is_point,
    'is_last', v_is_last,
    'remaining', v_left,
    'source', v_source,
    'buyer_name', public.mask_name(v_profile.nickname)
  );
end;
$$;

-- ---------------------------------------------------------
-- 7. 관리자: 쿠폰(뽑기권) 지급 / 구매확인 승인 / 출고 처리
-- ---------------------------------------------------------
create or replace function public.admin_grant_coupons(
  p_user_id uuid,
  p_board_id uuid,
  p_qty integer,
  p_note text default null
) returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_i integer;
  v_title text;
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 100 then
    raise exception '지급 수량은 1~100장 사이입니다.';
  end if;

  select title into v_title from public.boards where id = p_board_id;

  for v_i in 1..p_qty loop
    insert into public.coupons (user_id, board_id, kind, label, note, granted_by)
    values (
      p_user_id,
      p_board_id,
      case when p_board_id is null then 'universal' else 'board' end,
      coalesce(v_title, '모든 판 뽑기권'),
      p_note,
      auth.uid()
    );
  end loop;

  return p_qty;
end;
$$;

create or replace function public.admin_decide_claim(
  p_claim_id uuid,
  p_approve boolean,
  p_qty integer default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_claim public.purchase_claims%rowtype;
  v_qty integer;
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;

  select * into v_claim from public.purchase_claims where id = p_claim_id for update;
  if not found then
    raise exception '구매확인 요청을 찾을 수 없습니다.';
  end if;
  if v_claim.status <> 'pending' then
    raise exception '이미 처리된 요청입니다.';
  end if;

  v_qty := coalesce(p_qty, v_claim.qty);
  if p_approve and (v_qty < 1 or v_qty > 100) then
    raise exception '지급 수량은 1~100장 사이입니다.';
  end if;

  update public.purchase_claims
     set status = case when p_approve then 'approved' else 'rejected' end,
         granted = case when p_approve then v_qty else 0 end,
         decided_at = now(),
         decided_by = auth.uid()
   where id = p_claim_id;

  if p_approve then
    perform public.admin_grant_coupons(
      v_claim.user_id, v_claim.board_id, v_qty,
      '구매확인 승인 · ' || v_claim.channel || ' ' || v_claim.order_no
    );
  end if;

  return jsonb_build_object('id', p_claim_id, 'status', case when p_approve then 'approved' else 'rejected' end, 'granted', case when p_approve then v_qty else 0 end);
end;
$$;

create or replace function public.request_delivery(
  p_draw_id uuid,
  p_recipient text,
  p_phone text,
  p_postcode text,
  p_address text,
  p_memo text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_draw public.draws%rowtype;
  v_board public.boards%rowtype;
  v_id uuid := gen_random_uuid();
  v_tier jsonb;
begin
  if v_uid is null then raise exception '로그인이 필요합니다.'; end if;
  if coalesce(btrim(p_recipient), '') = '' then raise exception '받는 사람을 입력해 주세요.'; end if;
  if coalesce(btrim(p_phone), '') = '' then raise exception '연락처를 입력해 주세요.'; end if;
  if coalesce(btrim(p_address), '') = '' then raise exception '주소를 입력해 주세요.'; end if;

  select * into v_draw from public.draws where id = p_draw_id and user_id = v_uid for update;
  if not found then raise exception '보관함에서 상품을 찾을 수 없습니다.'; end if;
  if v_draw.item_status <> '보관중' then raise exception '이미 배송 신청했거나 전환된 상품입니다.'; end if;

  select * into v_board from public.boards where id = v_draw.board_id;

  insert into public.deliveries (id, user_id, draw_id, board_id, item_label, grade, recipient, phone, postcode, address, memo, status)
  values (v_id, v_uid, p_draw_id, v_draw.board_id, v_draw.tier_label, v_draw.grade,
          btrim(p_recipient), btrim(p_phone), btrim(coalesce(p_postcode, '')), btrim(p_address), p_memo, '요청');

  update public.draws set item_status = '배송신청' where id = p_draw_id;

  return jsonb_build_object('id', v_id, 'status', '요청');
end;
$$;

create or replace function public.convert_to_points(p_draw_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_draw public.draws%rowtype;
  v_board public.boards%rowtype;
  v_tier jsonb;
  v_points integer := 0;
begin
  if v_uid is null then raise exception '로그인이 필요합니다.'; end if;

  select * into v_draw from public.draws where id = p_draw_id and user_id = v_uid for update;
  if not found then raise exception '보관함에서 상품을 찾을 수 없습니다.'; end if;
  if v_draw.item_status <> '보관중' then raise exception '이미 배송 신청했거나 전환된 상품입니다.'; end if;

  select * into v_board from public.boards where id = v_draw.board_id;
  select t.tier into v_tier
  from jsonb_array_elements(v_board.tiers) with ordinality as t(tier, ord)
  where t.tier->>'grade' = v_draw.grade
  limit 1;

  v_points := coalesce((v_tier->>'points')::int, 0);
  if v_points <= 0 then raise exception '이 상품은 포인트 전환 대상이 아닙니다.'; end if;

  update public.profiles set points = points + v_points where id = v_uid;
  update public.draws set item_status = '포인트전환', points = v_points where id = p_draw_id;

  return jsonb_build_object('id', p_draw_id, 'points', v_points);
end;
$$;

create or replace function public.admin_ship_delivery(
  p_delivery_id uuid,
  p_carrier text,
  p_tracking text
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_del public.deliveries%rowtype;
begin
  if not public.is_admin() then raise exception '관리자만 사용할 수 있습니다.'; end if;
  if coalesce(btrim(p_tracking), '') = '' then raise exception '운송장 번호를 입력해 주세요.'; end if;

  select * into v_del from public.deliveries where id = p_delivery_id for update;
  if not found then raise exception '배송 요청을 찾을 수 없습니다.'; end if;

  update public.deliveries
     set status = '출고완료', carrier = btrim(p_carrier), tracking = btrim(p_tracking), shipped_at = now()
   where id = p_delivery_id;

  if v_del.draw_id is not null then
    update public.draws set item_status = '출고완료' where id = v_del.draw_id;
  end if;

  return jsonb_build_object('id', p_delivery_id, 'status', '출고완료');
end;
$$;

-- ---------------------------------------------------------
-- 8. 새 판 만들기 (관리자) — 번호표 1..N 자동 생성 + 봉인 해시
--    p_seed 를 비우면 서버에서 무작위 시드를 만듭니다.
-- ---------------------------------------------------------
drop function if exists public.admin_create_board(text, text, integer, integer, jsonb, text, text, text, text);

create or replace function public.admin_create_board(
  p_title text,
  p_category text,
  p_price integer,
  p_ticket_count integer,
  p_tiers jsonb,
  p_last_one_label text default null,
  p_seed text default null,
  p_status text default 'open',
  p_cover text default null,
  p_last_one_image text default null,
  p_last_one_desc text default null,
  p_manual jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_id uuid := gen_random_uuid();
  v_seed text;
  v_sum integer;
begin
  if not public.is_admin() then raise exception '관리자만 사용할 수 있습니다.'; end if;
  if coalesce(p_title, '') = '' then raise exception '판 제목을 입력해 주세요.'; end if;
  if p_ticket_count is null or p_ticket_count < 1 or p_ticket_count > 500 then
    raise exception '전체 장수는 1~500장 사이입니다.';
  end if;

  select coalesce(sum((t.tier->>'count')::int), 0) into v_sum
  from jsonb_array_elements(p_tiers) as t(tier);
  if v_sum <> p_ticket_count then
    raise exception '등급 수량 합계(%)가 전체 장수(%)와 다릅니다.', v_sum, p_ticket_count;
  end if;

  v_seed := coalesce(nullif(btrim(coalesce(p_seed, '')), ''), encode(gen_random_bytes(32), 'hex'));

  insert into public.boards (id, title, category, price, ticket_count, tiers, last_one_label, status, seed, seed_hash, cover,
                             last_one_image, last_one_desc, manual)
  values (v_id, p_title, coalesce(nullif(p_category, ''), '자체 스페셜'), p_price, p_ticket_count,
          p_tiers, p_last_one_label, coalesce(p_status, 'open'), v_seed,
          encode(digest(v_seed, 'sha256'), 'hex'), p_cover,
          p_last_one_image, p_last_one_desc, p_manual);

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, p_ticket_count) as g(n);

  return jsonb_build_object('id', v_id, 'seed_hash', encode(digest(v_seed, 'sha256'), 'hex'));
end;
$$;

alter table public.boards drop constraint if exists boards_title_key;
create unique index if not exists boards_title_uniq on public.boards (title);

-- ---------------------------------------------------------
-- 8-1. 판매 기록 초기화 (관리자) — 티켓·보관함(draws)·배송요청을 0건으로
--      시드·등급 배치는 그대로 두므로 구매자가 봉인 해시로 검증할 수 있다.
-- ---------------------------------------------------------
create or replace function public.admin_reset_board(p_board_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_sold integer;
begin
  if not public.is_admin() then raise exception '관리자만 사용할 수 있습니다.'; end if;

  select count(*) into v_sold
  from public.tickets
  where board_id = p_board_id and status = 'sold';

  delete from public.deliveries where board_id = p_board_id;
  delete from public.draws      where board_id = p_board_id;
  update public.tickets
     set status = 'available', buyer_id = null, buyer_name = null, grade = null, drawn_at = null
   where board_id = p_board_id;
  update public.boards set status = 'open' where id = p_board_id;

  return jsonb_build_object('board_id', p_board_id, 'reset', v_sold);
end;
$$;

grant execute on function public.admin_reset_board(uuid) to authenticated;

-- ---------------------------------------------------------
-- 9. 실시간(Realtime) 발행
-- ---------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['tickets','draws','coupons','deliveries','purchase_claims','boards'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when others then
      null; -- 이미 추가되었거나 realtime 미사용 프로젝트
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------
-- 10. 샘플 판 3개 (원할 때만 실행하세요. 이미 있으면 건너뜁니다.)
-- ---------------------------------------------------------
do $$
declare
  v_id uuid;
  v_seed text;
begin
  if exists (select 1 from public.boards) then
    return;
  end if;

  -- 원피스 · 12,000원 · 80장 = 실물 4종 각 1개 + P상 76장
  v_seed := encode(gen_random_bytes(32), 'hex');
  v_id := gen_random_uuid();
  insert into public.boards (id, title, category, price, ticket_count, tiers, last_one_label, status, seed, seed_hash, cover)
  values (v_id, '[원피스] 루피 기어5 피규어 쿠지', '원피스', 12000, 80,
    '[{"grade":"A","label":"루피 기어5 대형 피규어","count":1,"points":20000},
      {"grade":"B","label":"루피 · 조로 피규어","count":1,"points":8000},
      {"grade":"C","label":"아크릴 스탠드","count":1,"points":3000},
      {"grade":"D","label":"캔배지 3종 세트","count":1,"points":1200},
      {"grade":"P","label":"굿즈 포인트 1,200P","count":76,"points":1200,"pointOnly":true,
       "desc":"실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료"}]'::jsonb,
    '라스트원상 · 메탈릭 루피 피규어', 'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'),
    'assets/board_onepiece.jpg');
  insert into public.tickets (board_id, n) select v_id, g.n from generate_series(1, 80) as g(n);

  -- 산리오 · 12,000원 · 70장 = 실물 3종 각 1개 + P상 67장
  v_seed := encode(gen_random_bytes(32), 'hex');
  v_id := gen_random_uuid();
  insert into public.boards (id, title, category, price, ticket_count, tiers, last_one_label, status, seed, seed_hash, cover)
  values (v_id, '[산리오] 마이멜로디 & 쿠로미 스위트 쿠지', '산리오', 12000, 70,
    '[{"grade":"A","label":"마이멜로디 봉제인형","count":1,"points":15000},
      {"grade":"B","label":"쿠로미 쿠션","count":1,"points":6000},
      {"grade":"C","label":"아크릴 키링","count":1,"points":2500},
      {"grade":"P","label":"굿즈 포인트 1,200P","count":67,"points":1200,"pointOnly":true,
       "desc":"실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료"}]'::jsonb,
    '라스트원상 · 마이멜로디 대형 인형', 'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'),
    'assets/board_sanrio.jpg');
  insert into public.tickets (board_id, n) select v_id, g.n from generate_series(1, 70) as g(n);

  -- 귀멸의 칼날 · 12,000원 · 60장 = 실물 3종 각 1개 + P상 57장
  v_seed := encode(gen_random_bytes(32), 'hex');
  v_id := gen_random_uuid();
  insert into public.boards (id, title, category, price, ticket_count, tiers, last_one_label, status, seed, seed_hash, cover)
  values (v_id, '[귀멸의 칼날] 탄지로 히노카미 피규어 쿠지', '귀멸의 칼날', 12000, 60,
    '[{"grade":"A","label":"탄지로 히노카미 피규어","count":1,"points":30000},
      {"grade":"B","label":"네즈코 피규어","count":1,"points":12000},
      {"grade":"C","label":"아크릴 스탠드","count":1,"points":4000},
      {"grade":"P","label":"굿즈 포인트 1,200P","count":57,"points":1200,"pointOnly":true,
       "desc":"실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료"}]'::jsonb,
    '라스트원상 · 탄지로 메가 피규어', 'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'),
    'assets/board_kimetsu.jpg');
  insert into public.tickets (board_id, n) select v_id, g.n from generate_series(1, 60) as g(n);
end;
$$;
