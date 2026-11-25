-- ============================================================
-- 쿠지킹 v4.2.7 서버 준비 SQL
--   Supabase Dashboard → SQL Editor 에 이 파일 내용을 그대로 붙여넣고 [Run] 한 번만 실행하세요.
--   (여러 번 실행해도 안전합니다. 함수는 create or replace, 크리스마스 판은 조건을 확인하고 바꿉니다.)
--
--   1) 관리자 지정/해제 RPC  — [관리자] › 회원 관리 의 [관리자 지정 / 해제] 버튼이 사용합니다.
--   2) 미판매 판 장수·등급 수정 RPC — [관리자] › 판 관리 › 수정 에서 아직 1장도 안 팔린 판의
--      전체 장수·등급 수량을 바꿀 때 사용합니다. (티켓 번호 재생성 + 봉인 해시 갱신)
--   3) 크리스마스 판 300장 → 200장 (P상만 100장 줄이기) — 아직 1장도 안 팔렸을 때만 실행됩니다.
--
--   · profiles 테이블은 컬럼 권한으로 회원의 is_admin 직접 UPDATE 를 막아 두었기 때문에
--     관리자라도 앱에서 직접 update 하면 permission denied 가 납니다. 그래서 SECURITY DEFINER
--     함수(1번)로만 바꾸도록 했습니다. RLS 정책을 느슨하게 풀 필요는 없습니다.
--   · boards 의 장수 컬럼 이름은 ticket_count 이고, 번호표는 tickets(n) 테이블입니다.
-- ============================================================


-- ============================================================
-- 1) 관리자 지정 / 해제
--    앱: Backend.setUserAdmin() → rpc('admin_set_user_admin', {p_target_user_id, p_make_admin})
--    · 관리자만 호출할 수 있고, 자기 계정의 권한은 여기서 바꿀 수 없습니다(잠금 방지).
-- ============================================================
create or replace function public.admin_set_user_admin(
  p_target_user_id uuid,
  p_make_admin boolean
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_target public.profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;
  if p_target_user_id is null then
    raise exception '대상 회원을 찾을 수 없습니다.';
  end if;
  if p_target_user_id = auth.uid() then
    raise exception '내 계정의 관리자 권한은 이 화면에서 바꿀 수 없습니다.';
  end if;

  select * into v_target from public.profiles where id = p_target_user_id;
  if not found then
    raise exception '대상 회원을 찾을 수 없습니다.';
  end if;

  update public.profiles
     set is_admin = coalesce(p_make_admin, false)
   where id = p_target_user_id;

  return jsonb_build_object(
    'ok', true,
    'id', p_target_user_id,
    'email', v_target.email,
    'nickname', v_target.nickname,
    'is_admin', coalesce(p_make_admin, false)
  );
end;
$$;

grant execute on function public.admin_set_user_admin(uuid, boolean) to authenticated;


-- ============================================================
-- 2) 미판매 판(sold = 0) 장수·등급 수정
--    앱: Backend.saveBoard() → rpc('admin_resize_board', {p_board_id, p_ticket_count, p_tiers[, p_seed]})
--    · 이미 1장이라도 팔린 판(sold > 0)은 이 함수가 거부합니다. (앱에서도 잠금)
--    · tickets 를 지우고 1..N 번을 새로 만듭니다. 등급 배치는 draw_ticket 이
--      ticket_grade(seed, ticket_count, tiers, n) 로 그때그때 계산하므로 별도 prizes 테이블은 없습니다.
--    · 시드를 새로 넘기면(관리자가 '새로 생성') seed/seed_hash 를 함께 갱신합니다.
-- ============================================================
create or replace function public.admin_resize_board(
  p_board_id uuid,
  p_ticket_count integer,
  p_tiers jsonb,
  p_seed text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_board public.boards%rowtype;
  v_sold integer;
  v_draws integer;
  v_sum integer;
  v_seed text;
  v_hash text;
begin
  if not public.is_admin() then
    raise exception '관리자만 사용할 수 있습니다.';
  end if;

  select * into v_board from public.boards where id = p_board_id for update;
  if not found then
    raise exception '판을 찾을 수 없습니다.';
  end if;

  if p_ticket_count is null or p_ticket_count < 1 or p_ticket_count > 500 then
    raise exception '전체 장수는 1~500장 사이로 입력해 주세요.';
  end if;

  if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) = 0 then
    raise exception '등급을 하나 이상 넣어 주세요.';
  end if;

  select coalesce(sum((t.tier->>'count')::int), 0) into v_sum
  from jsonb_array_elements(p_tiers) with ordinality as t(tier, ord);
  if v_sum <> p_ticket_count then
    raise exception '등급 수량 합계(%)가 전체 장수(%)와 다릅니다.', v_sum, p_ticket_count;
  end if;

  select count(*) into v_sold
  from public.tickets
  where board_id = p_board_id and status = 'sold';
  if v_sold > 0 then
    raise exception '이미 %장이 판매된 판은 장수·등급을 바꿀 수 없습니다.', v_sold;
  end if;

  select count(*) into v_draws
  from public.draws
  where board_id = p_board_id;
  if v_draws > 0 then
    raise exception '뽑기 기록이 %건 남아 있어 번호 구성을 바꿀 수 없습니다. 판매 초기화 후 다시 시도해 주세요.', v_draws;
  end if;

  v_seed := coalesce(nullif(btrim(coalesce(p_seed, '')), ''), encode(gen_random_bytes(32), 'hex'));
  v_hash := encode(digest(v_seed, 'sha256'), 'hex');

  -- 번호표 재생성 (sold = 0 이므로 기존 번호는 전부 미판매)
  delete from public.tickets where board_id = p_board_id;
  insert into public.tickets (board_id, n, status)
  select p_board_id, g.n, 'available'
  from generate_series(1, p_ticket_count) as g(n);

  update public.boards
     set ticket_count = p_ticket_count,
         tiers = p_tiers,
         seed = v_seed,
         seed_hash = v_hash,
         sealed_at = now()
   where id = p_board_id;

  return jsonb_build_object(
    'ok', true,
    'board_id', p_board_id,
    'ticket_count', p_ticket_count,
    'seed_hash', v_hash
  );
end;
$$;

grant execute on function public.admin_resize_board(uuid, integer, jsonb, text) to authenticated;


-- ============================================================
-- 3) 크리스마스 판 300장 → 200장 (P상만 100장 줄이기)
--    대상 판: 2deaf258-1531-4c44-ba28-922c8a1fd1ba  [치이카와] 크리스마스 쿠지 이벤트
--    현재: 300장 (실물 27장 + P상 273장) → 200장 (실물 27장 그대로 + P상 173장)
--    · 1장이라도 팔렸으면(sold > 0) 아무것도 바꾸지 않고 안내만 남깁니다.
--    · 이미 200장이면 아무것도 바꾸지 않습니다.
--    · 시드·봉인 해시는 그대로 두고 sealed_at 만 갱신합니다. (실물 등급 배치는 그대로)
--    · 201~300번 티켓만 지웁니다. (지우기 전에 전부 미판매인지 위에서 확인)
-- ============================================================
do $$
declare
  v_board_id uuid := '2deaf258-1531-4c44-ba28-922c8a1fd1ba';
  v_total integer;
  v_tiers jsonb;
  v_sold integer;
  v_draws integer;
  v_p jsonb;
  v_new_p integer;
  v_cut integer;
begin
  select ticket_count, tiers into v_total, v_tiers
  from public.boards where id = v_board_id;

  if v_tiers is null then
    raise notice '크리스마스 판(%) 을 찾을 수 없습니다. 판 id 를 확인해 주세요.', v_board_id;
    return;
  end if;

  select count(*) into v_sold from public.tickets
   where board_id = v_board_id and status = 'sold';
  if v_sold > 0 then
    raise notice '이미 %장이 판매되어 200장으로 줄이지 않았습니다.', v_sold;
    return;
  end if;

  select count(*) into v_draws from public.draws where board_id = v_board_id;
  if v_draws > 0 then
    raise notice '뽑기 기록이 %건 남아 있어 200장으로 줄이지 않았습니다. (판매 초기화 후 실행)', v_draws;
    return;
  end if;

  if v_total <= 200 then
    raise notice '이미 %장입니다. 변경하지 않았습니다.', v_total;
    return;
  end if;

  select t.tier into v_p
  from jsonb_array_elements(v_tiers) with ordinality as t(tier, ord)
  where upper(t.tier->>'grade') = 'P'
  order by ord limit 1;

  if v_p is null then
    raise notice 'P상이 없어 줄일 수 없습니다. 판 관리에서 직접 수정해 주세요.';
    return;
  end if;

  v_cut := v_total - 200;
  v_new_p := (v_p->>'count')::int - v_cut;
  if v_new_p < 0 then
    raise notice 'P상이 %장뿐이라 %장을 줄일 수 없습니다. 판 관리에서 직접 수정해 주세요.', (v_p->>'count')::int, v_cut;
    return;
  end if;

  select jsonb_agg(
           case when upper(t.tier->>'grade') = 'P'
                then jsonb_set(t.tier, '{count}', to_jsonb(v_new_p), true)
                else t.tier end
           order by t.ord)
    into v_tiers
  from jsonb_array_elements(v_tiers) with ordinality as t(tier, ord);

  update public.boards
     set ticket_count = 200,
         tiers = v_tiers,
         sealed_at = now()
   where id = v_board_id;

  delete from public.tickets where board_id = v_board_id and n > 200;

  insert into public.tickets (board_id, n, status)
  select v_board_id, g.n, 'available'
  from generate_series(1, 200) as g(n)
  on conflict (board_id, n) do nothing;

  raise notice '크리스마스 판을 %장 → 200장으로 줄였습니다. (P상 % → %)', v_total, (v_p->>'count')::int, v_new_p;
end;
$$;


-- ============================================================
-- 4) 확인용 (실행 결과 표로 보여 줍니다 — 바꾸는 SQL 아님)
-- ============================================================
select b.id,
       b.title,
       b.ticket_count,
       (select count(*) from public.tickets t where t.board_id = b.id) as ticket_rows,
       (select count(*) from public.tickets t where t.board_id = b.id and t.status = 'sold') as sold_rows,
       (select sum((x.tier->>'count')::int) from jsonb_array_elements(b.tiers) as x(tier)) as tier_sum,
       b.tiers
from public.boards b
where b.id = '2deaf258-1531-4c44-ba28-922c8a1fd1ba';

select p.email, p.nickname, p.is_admin
from public.profiles p
order by p.is_admin desc, p.created_at
limit 20;
