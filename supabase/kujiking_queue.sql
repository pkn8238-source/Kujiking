-- =========================================================
-- 쿠지킹(KujiKing) v4.0.9 — 마지막 10장 순번제 + 체험 코드 제거
-- ---------------------------------------------------------
-- 사용법
--   1) Supabase Dashboard → SQL Editor → New query
--   2) 이 파일 **전체**를 붙여넣고 Run  (여러 번 실행해도 안전합니다)
--   3) 사이트는 새로고침하면 바로 순번제로 동작합니다.
--
-- 이 파일이 하는 일
--   [0] 체험 코드(DEMO-KUJI) 흔적 제거 — app_settings.demo_code 삭제
--   [1] board_queue 테이블 (판별 대기열 · 1인 60초 차례)
--   [2] board_queue_tick()      차례 만료·자동 넘김
--   [3] queue_board_status()    내 순번·차례·남은 시간 (사이트가 5초마다 확인)
--   [4] queue_join_board()      순번 줄 서기
--   [5] queue_leave_board()     순번 반납 / 뽑은 뒤 차례 넘기기
--   [6] draws 트리거            뽑기가 기록되면 자동으로 차례를 넘긴다
--   [7] 권한 정리 + 확인 쿼리
--
-- 참고
--   · 순번은 잔여 10장 이하에서만 동작합니다. 11장 이상이면 대기열을 비우고
--     기존처럼 연뽑(5·10·15·20장)을 쓸 수 있습니다.
--   · 이 SQL 을 실행하지 않아도 사이트는 죽지 않고 "1장씩 + 1인 30초 쿨타임"으로
--     자동 대체됩니다. 실행하면 진짜 순번(1인 60초)으로 바뀝니다.
-- =========================================================

-- ---------------------------------------------------------
-- [0] 체험 코드 제거 — 이 설정이 없으면 draw_ticket 이 어떤 코드도
--     'demo' 로 처리하지 않습니다(실재고 무료 뽑기 차단).
-- ---------------------------------------------------------
delete from public.app_settings where key = 'demo_code';

-- ---------------------------------------------------------
-- [1] 대기열 테이블
-- ---------------------------------------------------------
create table if not exists public.board_queue (
  id              bigserial primary key,
  board_id        uuid not null references public.boards(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  joined_at       timestamptz not null default now(),
  turn_started_at timestamptz,
  unique (board_id, user_id)
);

create index if not exists board_queue_board_idx
  on public.board_queue (board_id, joined_at);

-- 직접 읽기/쓰기는 막고 아래 SECURITY DEFINER 함수로만 다룬다.
alter table public.board_queue enable row level security;

-- ---------------------------------------------------------
-- [2] 차례 정리 — 만료된 차례를 넘기고, 비어 있으면 다음 사람을 지목
-- ---------------------------------------------------------
create or replace function public.board_queue_tick(p_board_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from public.tickets
   where board_id = p_board_id and status = 'available';

  -- 잔여 10장을 넘으면 순번제가 아니다 → 대기열 비우기
  if v_left > 10 then
    delete from public.board_queue where board_id = p_board_id;
    return;
  end if;

  -- 60초가 지난 차례는 반납하고 맨 뒤로 보낸다
  update public.board_queue
     set turn_started_at = null,
         joined_at = now()
   where board_id = p_board_id
     and turn_started_at is not null
     and now() > turn_started_at + interval '60 seconds';

  -- 차례가 비어 있으면 가장 먼저 온 사람에게 넘긴다
  if not exists (
    select 1 from public.board_queue
     where board_id = p_board_id and turn_started_at is not null
  ) then
    update public.board_queue
       set turn_started_at = now()
     where id = (
       select id from public.board_queue
        where board_id = p_board_id and turn_started_at is null
        order by joined_at, id
        limit 1
     );
  end if;
end;
$$;

-- ---------------------------------------------------------
-- [3] 순번 상태 — 사이트가 5초마다 부른다
-- ---------------------------------------------------------
create or replace function public.queue_board_status(p_board_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid          uuid := auth.uid();
  v_left         integer;
  v_waiters      integer := 0;
  v_mine         public.board_queue%rowtype;
  v_in_queue     boolean := false;
  v_turn_uid     uuid;
  v_turn_started timestamptz;
  v_position     integer;
  v_ahead        integer := 0;
  v_next         text;
begin
  select count(*) into v_left
    from public.tickets
   where board_id = p_board_id and status = 'available';

  if v_left > 10 then
    return jsonb_build_object(
      'board_id', p_board_id, 'mode', 'open', 'left', v_left,
      'in_queue', false, 'is_turn', false, 'my_position', null, 'ahead', 0,
      'waiters', 0, 'turn_seconds', 60, 'turn_ends_at', null, 'next_nickname', null
    );
  end if;

  perform public.board_queue_tick(p_board_id);

  select count(*) into v_waiters
    from public.board_queue where board_id = p_board_id;

  select turn_started_at, user_id into v_turn_started, v_turn_uid
    from public.board_queue
   where board_id = p_board_id and turn_started_at is not null
   limit 1;

  if v_uid is not null then
    select * into v_mine
      from public.board_queue
     where board_id = p_board_id and user_id = v_uid;
    v_in_queue := found;

    if v_in_queue then
      select count(*) into v_ahead
        from public.board_queue
       where board_id = p_board_id
         and (joined_at, id) < (v_mine.joined_at, v_mine.id);
      v_position := v_ahead + 1;
    end if;
  end if;

  select public.mask_name(p.nickname) into v_next
    from public.board_queue q
    join public.profiles p on p.id = q.user_id
   where q.board_id = p_board_id
   order by (q.turn_started_at is null), q.joined_at, q.id
   limit 1;

  return jsonb_build_object(
    'board_id', p_board_id,
    'mode', 'queue',
    'left', v_left,
    'in_queue', v_in_queue,
    'is_turn', (v_in_queue and v_turn_uid is not null and v_turn_uid = v_uid),
    'my_position', v_position,
    'ahead', v_ahead,
    'waiters', v_waiters,
    'turn_seconds', 60,
    'turn_ends_at', case when v_turn_started is not null then v_turn_started + interval '60 seconds' end,
    'next_nickname', v_next
  );
end;
$$;

-- ---------------------------------------------------------
-- [4] 순번 줄 서기
-- ---------------------------------------------------------
create or replace function public.queue_join_board(p_board_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid  uuid := auth.uid();
  v_left integer;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select count(*) into v_left
    from public.tickets
   where board_id = p_board_id and status = 'available';

  if v_left = 0 then
    raise exception '이 판은 전량 소진되었어요.';
  end if;
  if v_left > 10 then
    raise exception '순번제는 마지막 10장부터예요. 지금은 바로 뽑을 수 있어요.';
  end if;

  insert into public.board_queue (board_id, user_id, joined_at)
  values (p_board_id, v_uid, now())
  on conflict (board_id, user_id) do nothing;

  perform public.board_queue_tick(p_board_id);

  return public.queue_board_status(p_board_id);
end;
$$;

-- ---------------------------------------------------------
-- [5] 순번 반납 — 뽑은 뒤에도 사이트가 한 번 부른다
-- ---------------------------------------------------------
create or replace function public.queue_leave_board(p_board_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  delete from public.board_queue
   where board_id = p_board_id and user_id = v_uid;

  perform public.board_queue_tick(p_board_id);

  return public.queue_board_status(p_board_id);
end;
$$;

-- ---------------------------------------------------------
-- [6] 뽑기 기록 → 차례 자동 넘김
--     사이트가 창을 닫아도 서버가 다음 사람을 지목한다.
-- ---------------------------------------------------------
create or replace function public.board_queue_after_draw()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.board_queue
   where board_id = new.board_id and user_id = new.user_id;
  perform public.board_queue_tick(new.board_id);
  return new;
end;
$$;

drop trigger if exists board_queue_after_draw on public.draws;
create trigger board_queue_after_draw
  after insert on public.draws
  for each row execute function public.board_queue_after_draw();

-- ---------------------------------------------------------
-- [7] 권한 정리 — 내부 함수는 직접 호출하지 못하게 막는다
-- ---------------------------------------------------------
revoke all on function public.board_queue_tick(uuid) from public;
revoke all on function public.board_queue_tick(uuid) from anon;
revoke all on function public.board_queue_tick(uuid) from authenticated;

revoke all on function public.queue_board_status(uuid) from public;
grant execute on function public.queue_board_status(uuid) to anon, authenticated;

revoke all on function public.queue_join_board(uuid) from public;
grant execute on function public.queue_join_board(uuid) to authenticated;

revoke all on function public.queue_leave_board(uuid) from public;
grant execute on function public.queue_leave_board(uuid) to authenticated;

revoke all on function public.board_queue_after_draw() from public;

-- ---------------------------------------------------------
-- 확인 — 아래 결과가 나오면 정상
--   queue_items: 0 (아직 줄 선 사람 없음)
--   demo_settings: 0 (체험 코드 삭제됨)
--   queue_fns: board_queue_tick, queue_board_status, queue_join_board, queue_leave_board
-- ---------------------------------------------------------
select 'queue_items' as 항목, count(*) as 건수 from public.board_queue
union all
select 'demo_settings', count(*) from public.app_settings where key = 'demo_code';

select proname as queue_fns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and proname in ('board_queue_tick','queue_board_status','queue_join_board','queue_leave_board')
 order by 1;
