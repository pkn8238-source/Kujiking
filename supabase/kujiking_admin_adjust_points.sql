-- ============================================================
-- 쿠지킹 v4.4.19 서버 준비 SQL
--   관리자 › 회원 관리 의 [포인트 지급/차감] 버튼이 사용하는 서버 함수
--
--   사용법
--    1) Supabase Dashboard → SQL Editor → New query
--    2) 이 파일 전체를 붙여넣고 [Run] 한 번 실행하세요.
--       (여러 번 실행해도 안전합니다 — create or replace)
--    3) 사이트 새로고침 후 [관리자] › 회원 관리 → 회원 줄의 [포인트 지급/차감]
--
--   하는 일
--    · 관리자(profiles.is_admin = true)만 호출할 수 있습니다.
--    · 지정한 회원의 profiles.points 를 p_delta 만큼 더합니다.
--      (p_delta 가 음수면 차감)
--    · 대상 행을 for update 로 잠가 동시에 들어온 지급·차감이 서로 덮어쓰지 않게 합니다.
--    · 보유 포인트보다 많이 차감하려 하면 예외를 던지고 아무것도 바꾸지 않습니다.
--    · 포인트 외의 값(쿠폰·뽑기 기록·회원 정보)은 건드리지 않습니다.
--
--   앱 호출
--    Backend.adjustUserPoints(userId, delta, reason)
--      → rpc('admin_adjust_points', { p_user_id, p_delta, p_reason })
--      → 반환 { ok, user_id, nickname, email, delta, points, reason }
-- ============================================================

create or replace function public.admin_adjust_points(
  p_user_id uuid,
  p_delta integer,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_target public.profiles%rowtype;
  v_new_points integer;
begin
  -- 관리자만 실행 가능 (profiles.is_admin = true)
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;

  if p_user_id is null then
    raise exception '대상 회원을 찾을 수 없습니다.';
  end if;

  if p_delta is null or p_delta = 0 then
    raise exception '지급하거나 차감할 포인트를 1P 이상 입력해 주세요.';
  end if;

  -- 대상 회원 잠금 (동시 지급·차감이 서로의 잔액을 덮어쓰지 않도록)
  select * into v_target
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception '대상 회원을 찾을 수 없습니다.';
  end if;

  if coalesce(v_target.points, 0) + p_delta < 0 then
    raise exception '보유 포인트보다 많이 차감할 수 없습니다.';
  end if;

  update public.profiles
     set points = coalesce(points, 0) + p_delta
   where id = p_user_id
  returning points into v_new_points;

  return jsonb_build_object(
    'ok', true,
    'user_id', p_user_id,
    'nickname', v_target.nickname,
    'email', v_target.email,
    'delta', p_delta,
    'points', v_new_points,
    'reason', p_reason
  );
end;
$$;

-- 앱은 로그인한 회원(authenticated)으로만 호출합니다. 그 외 역할은 막습니다.
revoke all on function public.admin_adjust_points(uuid, integer, text) from public;
revoke all on function public.admin_adjust_points(uuid, integer, text) from anon;
grant execute on function public.admin_adjust_points(uuid, integer, text) to authenticated;


-- ============================================================
-- 확인용 (바꾸는 SQL 아님 — 실행하면 아래 표가 보입니다)
--   함수가 등록됐는지, 지금 관리자로 지정된 회원이 누구인지 확인합니다.
-- ============================================================
select n.nspname as schema,
       p.proname as function,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_adjust_points';

select email, nickname, points, is_admin
from public.profiles
order by is_admin desc, created_at
limit 20;
