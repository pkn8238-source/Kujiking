#!/usr/bin/env python3
"""로컬 PostgreSQL 에서 kujiking_setup_all.txt 를 그대로 실행해 검증한다.
- [1] 라스트원 컬럼/함수
- [2] storage.buckets + storage.objects 정책
- [3] admin_clear_all_boards()
- [4] 즉시 비우기
"""
import os, subprocess, sys
import pgserver

DATA = '/tmp/kjtest_all'
if os.path.exists(DATA):
    subprocess.run(['rm', '-rf', DATA])

srv = pgserver.get_server(DATA, cleanup_mode=None)
uri = srv.get_uri()

PSQL = '/usr/lib/postgresql/18/bin/psql'

def psql(sql, check=True):
    r = subprocess.run([PSQL, uri, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sql],
                       capture_output=True, text=True)
    if check and r.returncode != 0:
        print('SQL ERROR:', r.stderr[:3000]); raise SystemExit(1)
    return r

def psql_file(path):
    r = subprocess.run([PSQL, uri, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-f', path],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print('FILE ERROR:', r.stderr[:4000]); raise SystemExit(1)
    return r

psql("""
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;
create role anon;
create role authenticated;
create role service_role;

"""
)

# Supabase storage 스텁 (실제 컬럼과 같은 최소 구성)
psql("""
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;

create table public.profiles (
  id uuid primary key,
  email text, nickname text, phone text,
  points integer not null default 0,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function public.mask_name(p_name text) returns text
language sql immutable as $$
  select case when coalesce(btrim(p_name),'') = '' then '익명'
              when length(p_name) <= 1 then p_name
              else substr(p_name,1,1) || repeat('*', greatest(1, length(p_name)-2)) || right(p_name,1) end
$$;

create or replace function public.is_admin(p_uid uuid default auth.uid()) returns boolean
language sql stable as $$ select coalesce((select is_admin from public.profiles where id = p_uid), false) $$;

create or replace function public.ticket_grade(p_seed text, p_count integer, p_tiers jsonb, p_n integer)
returns text language sql immutable as $$
  select t->>'grade'
  from jsonb_array_elements(p_tiers) with ordinality as x(t, ord)
  order by (x.t->>'grade') desc
  limit 1
$$;

create table public.boards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default '자체 스페셜',
  cover text,
  price integer not null check (price > 0),
  ticket_count integer not null,
  tiers jsonb not null,
  last_one_label text,
  last_one_image text,
  last_one_desc text,
  manual jsonb,
  status text not null default 'open',
  seed text not null,
  seed_hash text not null default '',
  created_at timestamptz not null default now(),
  sealed_at timestamptz not null default now()
);
create table public.tickets (
  id bigserial primary key,
  board_id uuid not null references public.boards(id) on delete cascade,
  n integer not null,
  status text not null default 'available',
  buyer_id uuid references public.profiles(id) on delete set null,
  buyer_name text,
  grade text,
  drawn_at timestamptz,
  unique (board_id, n)
);
create table public.draws (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  board_id uuid not null references public.boards(id) on delete cascade,
  n integer not null,
  grade text,
  tier_label text,
  points integer not null default 0,
  item_status text,
  source text not null default 'code',
  is_last boolean not null default false,
  seq bigserial,
  created_at timestamptz not null default now(),
  unique (board_id, n)
);
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  board_id uuid references public.boards(id) on delete set null,
  kind text not null default 'board',
  label text, note text, granted_at timestamptz default now(),
  used_at timestamptz, used_draw_id uuid
);
create table public.exchange_codes (
  code text primary key,
  board_id uuid references public.boards(id) on delete cascade,
  note text, created_at timestamptz default now(),
  used_at timestamptz, used_by uuid, used_n integer
);
create table public.purchase_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  board_id uuid references public.boards(id) on delete set null,
  channel text default '스마트스토어', order_no text not null,
  qty integer default 1, amount integer, memo text,
  status text default 'pending', granted integer default 0,
  created_at timestamptz default now(), decided_at timestamptz
);
create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  draw_id uuid references public.draws(id) on delete set null,
  board_id uuid references public.boards(id) on delete set null,
  item_label text, grade text, recipient text not null, phone text not null,
  postcode text, address text not null, memo text, carrier text, tracking text,
  status text default '요청', requested_at timestamptz default now(), shipped_at timestamptz
);
create table public.app_settings (key text primary key, value text);
""")

# ---- 실제 통합 SQL 실행
psql_file('/workspace/attachments/2026-11-25/kujiking_setup_all.txt')
print('setup_all run OK (1st)')

# 다시 실행해도 안전한지 (idempotent)
psql_file('/workspace/attachments/2026-11-25/kujiking_setup_all.txt')
print('setup_all run OK (2nd, idempotent)')

print(psql("select id, public, file_size_limit, allowed_mime_types from storage.buckets").stdout)
print(psql("select policyname, cmd from pg_policies where schemaname='storage' order by policyname").stdout)

# ---- 테스트 데이터: 판 2개 + 티켓 + 뽑기 + 배송 + 구매확인 + 뽑기권
psql("""
insert into public.profiles (id, email, nickname, points, is_admin) values
 ('11111111-1111-1111-1111-111111111111','admin@test','관리자',0,true),
 ('22222222-2222-2222-2222-222222222222','user@test','테스트남',5000,false);

insert into public.boards (id, title, price, ticket_count, tiers, last_one_label, seed, seed_hash) values
 ('aaaaaaaa-0000-0000-0000-000000000001','테스트판1',12000,3,
  '[{"grade":"A","label":"A상","count":1,"points":0},{"grade":"P","label":"P상 1,200P","count":2,"points":1200,"pointOnly":true}]'::jsonb,
  '라스트원상 · 특별','s1','h1'),
 ('aaaaaaaa-0000-0000-0000-000000000002','테스트판2',12000,2,
  '[{"grade":"A","label":"A상","count":1,"points":0},{"grade":"P","label":"P상","count":1,"points":1200,"pointOnly":true}]'::jsonb,
  '라스트원상 · 특별','s2','h2');

insert into public.tickets (board_id, n) values
 ('aaaaaaaa-0000-0000-0000-000000000001',1),
 ('aaaaaaaa-0000-0000-0000-000000000001',2),
 ('aaaaaaaa-0000-0000-0000-000000000001',3),
 ('aaaaaaaa-0000-0000-0000-000000000002',1),
 ('aaaaaaaa-0000-0000-0000-000000000002',2);

insert into public.coupons (user_id, board_id, kind, label) values
 ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001','board','판전용'),
 ('22222222-2222-2222-2222-222222222222',null,'universal','모든판');

insert into public.exchange_codes (code, board_id) values ('KJ-AAAA','aaaaaaaa-0000-0000-0000-000000000001'),('KJ-FREE',null);

insert into public.purchase_claims (user_id, board_id, order_no) values
 ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001','20261125-0001');
insert into public.deliveries (user_id, board_id, recipient, phone, address) values
 ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001','테스트','010-0000-0000','서울');
""")

# draw_ticket 동작 + 라스트원 (관리자 아닌 회원으로)
out = psql("""
set local role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.draw_ticket('aaaaaaaa-0000-0000-0000-000000000002', 1, null, null, true);
""", check=False)
print('draw1:', out.stdout.strip()[:300], out.stderr[:300])

print('after draw boards:', psql("select count(*) from public.boards").stdout.strip(),
      'draws:', psql("select count(*) from public.draws").stdout.strip(),
      'tickets sold:', psql("select count(*) from public.tickets where status='sold'").stdout.strip())

# ---- admin_clear_all_boards (관리자 권한으로)
out = psql("""
set local role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.admin_clear_all_boards();
""", check=False)
print('clear fn:', out.stdout.strip()[:400], out.stderr[:400])

for t in ['boards', 'tickets', 'draws', 'deliveries', 'purchase_claims']:
    print(t, psql(f"select count(*) from public.{t}").stdout.strip())
print('coupons left:', psql("select count(*), coalesce(string_agg(label,','),'-') from public.coupons").stdout.strip())
print('codes left:', psql("select count(*), coalesce(string_agg(code,','),'-') from public.exchange_codes").stdout.strip())

# ---- 권한 없는 회원이 호출하면 막히는지
out = psql("""
set local role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.admin_clear_all_boards();
""", check=False)
print('non-admin call blocked:', '관리자만' in (out.stderr or ''), out.stderr.strip()[:200])

srv.cleanup()
print('DONE')
