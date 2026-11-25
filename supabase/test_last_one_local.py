#!/usr/bin/env python3
"""로컬 PostgreSQL 에서 kujiking_last_one.sql 을 실제로 실행해 라스트원 지급을 검증한다."""
import os, re, subprocess, sys, getpass
import pgserver

DATA = '/tmp/kjtest_pg'
if os.path.exists(DATA):
    subprocess.run(['rm', '-rf', DATA])

srv = pgserver.get_server(DATA, cleanup_mode=None)
uri = srv.get_uri()
print('uri', uri[:30])

def psql(sql, check=True):
    r = subprocess.run(['/usr/lib/postgresql/18/bin/psql', uri, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sql],
                       capture_output=True, text=True)
    if check and r.returncode != 0:
        print('SQL ERROR:', r.stderr[:2000])
        raise SystemExit(1)
    return r

def psql_file(path):
    r = subprocess.run(['/usr/lib/postgresql/18/bin/psql', uri, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-f', path],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print('FILE ERROR:', r.stderr[:3000])
        raise SystemExit(1)
    return r

bootstrap = """
create schema if not exists auth;
create schema if not exists extensions;
create role anon;
create role authenticated;
create role service_role;

create table public.profiles (
  id uuid primary key,
  email text, nickname text, phone text,
  points integer not null default 0,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

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
"""

# auth.uid() 은 세션 GUC 로 흉내
bootstrap2 = """
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
"""

psql(bootstrap)
psql(bootstrap2)

# 최소 테이블 (마이그레이션이 alter 하는 대상 + draw_ticket 이 쓰는 것들)
psql("""
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
  user_id uuid not null, board_id uuid, kind text, label text, note text,
  granted_at timestamptz default now(), used_at timestamptz, used_draw_id uuid
);
create table public.exchange_codes (
  id bigserial primary key, code text, board_id uuid, used_at timestamptz, used_by uuid, used_n integer
);
create table public.app_settings (key text primary key, value text);
create table public.deliveries (
  id uuid primary key default gen_random_uuid(), user_id uuid, draw_id uuid, board_id uuid,
  item_label text, grade text, recipient text, phone text, postcode text, address text, memo text,
  carrier text, tracking text, status text, requested_at timestamptz default now(), shipped_at timestamptz
);
""")

# 실제 마이그레이션 파일 실행
psql_file('/workspace/work/kujiking-repo/supabase/kujiking_last_one.sql')
print('migration OK')

# 데이터 준비 — 회원 2명, 3장 판(실물 2 + P상 1), 라스트원 라벨 있음
psql("""
insert into public.profiles (id, email, nickname, points) values
 ('11111111-1111-1111-1111-111111111111','a@test','테스트남', 0),
 ('22222222-2222-2222-2222-222222222222','b@test','상대방', 0);

insert into public.boards (id, title, price, ticket_count, tiers, last_one_label, last_one_image, last_one_desc, seed, seed_hash)
values ('99999999-9999-9999-9999-999999999999','테스트판', 12000, 3,
 '[{"grade":"A","label":"A상 피규어","count":1,"points":5000},
   {"grade":"B","label":"B상 피규어","count":1,"points":3000},
   {"grade":"P","label":"P상 1,200P","count":1,"points":1200,"pointOnly":true,"points_awarded":1200}]'::jsonb,
 '라스트원상 · 특별 피규어','assets/products/kimetsu/last_one.jpg','약 27cm · 특별 사양','seed1','hash1');

insert into public.tickets (board_id, n) values
 ('99999999-9999-9999-9999-999999999999',1),
 ('99999999-9999-9999-9999-999999999999',2),
 ('99999999-9999-9999-9999-999999999999',3);
""")

def draw(user, n):
    r = subprocess.run(['/usr/lib/postgresql/18/bin/psql', uri, '-X', '-q', '-t', '-A',
                        '-v', 'ON_ERROR_STOP=1',
                        '-c', f"set local role authenticated; set request.jwt.claim.sub = '{user}'; select public.draw_ticket('99999999-9999-9999-9999-999999999999', {n}, null, 'DEMO', false);"],
                       capture_output=True, text=True)
    if r.returncode:
        print('DRAW ERROR', r.stderr[:800]); raise SystemExit(1)
    return r.stdout.strip()

print('draw 1:', draw('11111111-1111-1111-1111-111111111111', 1))
print('draw 2:', draw('22222222-2222-2222-2222-222222222222', 2))
print('draw 3:', draw('11111111-1111-1111-1111-111111111111', 3))

print(psql("select b.last_one_winner_name, b.last_one_won_at is not null as has_at from public.boards b").stdout)
print(psql("select n, grade, tier_label, item_status, is_last, is_last_one from public.draws order by seq", check=False).stdout)
print(psql("select n, is_last from public.tickets order by n").stdout)
srv.cleanup()
