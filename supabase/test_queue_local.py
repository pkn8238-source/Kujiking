#!/usr/bin/env python3
"""로컬 PostgreSQL 에서 kujiking_queue.sql 을 그대로 실행해 순번제를 검증한다.
- 잔여 11장 이상: mode open, join 거부
- 잔여 10장 이하: mode queue, 첫 사람이 차례(60초)
- 뽑기 기록(draws insert) → 차례 자동 넘김
- 60초 만료 → 다음 사람에게 차례
- 대기열 직접 조회 차단(RLS)
"""
import os, subprocess
import pgserver

SQL = '/workspace/attachments/2026-11-25/kujiking_queue.sql'
DATA = '/tmp/kjqueue_test'
if os.path.exists(DATA):
    subprocess.run(['rm', '-rf', DATA])

srv = pgserver.get_server(DATA, cleanup_mode=None)
uri = srv.get_uri()
PSQL = '/usr/lib/postgresql/18/bin/psql'

def psql(sql, check=True):
    r = subprocess.run([PSQL, uri, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sql],
                       capture_output=True, text=True)
    if check and r.returncode != 0:
        print('SQL ERROR:', r.stderr[:4000]); raise SystemExit(1)
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
create role anon;
create role authenticated;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function public.mask_name(p_name text) returns text
language sql immutable as $$
  select case when coalesce(btrim(p_name),'') = '' then '익명'
              when length(p_name) = 1 then left(p_name,1) || '*'
              when length(p_name) = 2 then left(p_name,1) || '*'
              else left(p_name,1) || repeat('*', length(p_name)-2) || right(p_name,1) end
$$;

create table public.profiles (
  id uuid primary key,
  email text, nickname text, phone text,
  points integer not null default 0,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.boards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default '자체 스페셜',
  price integer not null check (price > 0),
  ticket_count integer not null,
  tiers jsonb not null default '[]'::jsonb,
  status text not null default 'open',
  seed text not null default 's',
  seed_hash text not null default 'h',
  created_at timestamptz not null default now()
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
  created_at timestamptz not null default now()
);

create table public.app_settings (key text primary key, value text);
insert into public.app_settings (key, value) values ('demo_code', 'DEMO-KUJI');
""")

psql_file(SQL)
print('queue sql run OK (1st)')
psql_file(SQL)
print('queue sql run OK (2nd, idempotent)')

# 데모 코드 흔적 제거 확인
out = psql("select count(*) from public.app_settings where key='demo_code'").stdout.strip()
print('demo_code rows:', out)
assert out == '0', out

psql("""
insert into public.profiles (id, email, nickname) values
 ('11111111-1111-1111-1111-111111111111','a@test','박기남'),
 ('22222222-2222-2222-2222-222222222222','b@test','김솔'),
 ('33333333-3333-3333-3333-333333333333','c@test','이순신');

insert into public.boards (id, title, price, ticket_count)
values ('aaaaaaaa-0000-0000-0000-000000000001','순번테스트',12000,20);

insert into public.tickets (board_id, n)
select 'aaaaaaaa-0000-0000-0000-000000000001', g from generate_series(1,20) g;
""")

def as_user(uid, sql):
    return psql(f"""
set local role authenticated;
set request.jwt.claim.sub = '{uid}';
{sql}
""", check=False)

# 20장 남음 → open, join 거부
out = as_user('11111111-1111-1111-1111-111111111111',
              "select public.queue_board_status('aaaaaaaa-0000-0000-0000-000000000001');")
print('left20 status:', out.stdout.strip()[:300])
assert '"mode": "open"' in out.stdout, out.stdout
out = as_user('11111111-1111-1111-1111-111111111111',
              "select public.queue_join_board('aaaaaaaa-0000-0000-0000-000000000001');")
print('left20 join blocked:', '마지막 10장' in (out.stderr or ''), out.stderr.strip()[:200])

# 10장 남기기 (10장 판매)
psql("""
update public.tickets set status='sold', drawn_at=now()
 where board_id='aaaaaaaa-0000-0000-0000-000000000001' and n <= 10;
""")

# 첫 사람 줄 서기 → 바로 차례
out = as_user('11111111-1111-1111-1111-111111111111',
              "select public.queue_join_board('aaaaaaaa-0000-0000-0000-000000000001');")
print('A join:', out.stdout.strip()[:400])
assert '"is_turn": true' in out.stdout, out.stdout

# 두 번째 사람 줄 서기 → 대기
out = as_user('22222222-2222-2222-2222-222222222222',
              "select public.queue_join_board('aaaaaaaa-0000-0000-0000-000000000001');")
print('B join:', out.stdout.strip()[:400])
assert '"is_turn": false' in out.stdout and '"ahead": 1' in out.stdout, out.stdout

# A 가 뽑으면(draws insert) 다음 사람에게 자동으로 차례
psql("""
insert into public.draws (user_id, board_id, n, grade, source)
values ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',11,'P','coupon');
update public.tickets set status='sold', drawn_at=now()
 where board_id='aaaaaaaa-0000-0000-0000-000000000001' and n = 11;
""")
out = as_user('22222222-2222-2222-2222-222222222222',
              "select public.queue_board_status('aaaaaaaa-0000-0000-0000-000000000001');")
print('after A draw, B status:', out.stdout.strip()[:400])
assert '"is_turn": true' in out.stdout, out.stdout
print('queue rows after A draw:', psql("select count(*) from public.board_queue").stdout.strip())

# 60초 만료 → B 차례가 넘어가고 C(없음)는 비어 있음
psql("update public.board_queue set turn_started_at = now() - interval '61 seconds' where turn_started_at is not null;")
out = as_user('22222222-2222-2222-2222-222222222222',
              "select public.queue_board_status('aaaaaaaa-0000-0000-0000-000000000001');")
print('after expiry:', out.stdout.strip()[:400])
assert '"is_turn": false' in out.stdout, out.stdout
print('B position after expiry:', psql("select turn_started_at is null, joined_at from public.board_queue order by joined_at limit 1").stdout.strip()[:120])

# C 가 줄 서면 차례를 받는다 (B 는 만료로 맨 뒤)
out = as_user('33333333-3333-3333-3333-333333333333',
              "select public.queue_join_board('aaaaaaaa-0000-0000-0000-000000000001');")
print('C join:', out.stdout.strip()[:400])
assert '"is_turn": true' in out.stdout, out.stdout

# 순번 반납
out = as_user('33333333-3333-3333-3333-333333333333',
              "select public.queue_leave_board('aaaaaaaa-0000-0000-0000-000000000001');")
print('C leave:', out.stdout.strip()[:300])

# RLS: 일반 회원이 테이블 직접 조회 불가
out = as_user('22222222-2222-2222-2222-222222222222',
              "select count(*) from public.board_queue;")
print('direct select blocked:', out.returncode != 0, (out.stderr or '').strip()[:160])

# anon 은 상태 조회 가능, join 은 불가
out = psql("""
set local role anon;
select public.queue_board_status('aaaaaaaa-0000-0000-0000-000000000001');
""", check=False)
print('anon status ok:', out.returncode == 0, out.stdout.strip()[:160])
out = psql("""
set local role anon;
select public.queue_join_board('aaaaaaaa-0000-0000-0000-000000000001');
""", check=False)
print('anon join blocked:', out.returncode != 0, (out.stderr or '').strip()[:160])

srv.cleanup()
print('DONE')
