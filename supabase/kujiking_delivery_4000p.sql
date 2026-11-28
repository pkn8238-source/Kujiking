-- =========================================================
-- 쿠지킹 KUJIKING — 보관함 배송 신청 4,000P 차감 + 합배송(일괄 배송)
-- v4.4.22 · 2026-11-28
-- ---------------------------------------------------------
-- 실행 방법
--   1) https://supabase.com/dashboard → 쿠지킹 프로젝트(ptqonefsjhusyuofgius) → SQL Editor
--   2) [New query] 에 이 파일 내용을 통째로 붙여넣고 [Run]
--   3) "Success. No rows returned" 가 나오면 끝 (여러 번 실행해도 안전합니다)
--
-- 바뀌는 것
--   0) public.deliveries 에 batch_draw_ids uuid[] 컬럼을 더합니다 (없을 때만).
--      · 기존 행은 null 로 남고, 앱은 select * 로 읽으므로 예전 화면도 그대로 동작합니다.
--      · 합배송은 '대표 1건'의 배송 기록에 묶인 draw id 목록을 이 컬럼에 남깁니다.
--        → 관리자 '배송 · 출고' 표에는 한 줄(한 상자)로 보이고, 회원 보관함에는 묶인 상품 모두
--          같은 수령인·주소·운송장이 표시됩니다.
--   1) public.request_delivery(...) : 단건 배송 신청 1회당 4,000P 차감 (v4.4.12 그대로)
--      · 인자 6개(p_draw_id, p_recipient, p_phone, p_postcode, p_address, p_memo)와
--        security definer / search_path = public, extensions / for update / 기록 방식은 기존과 같습니다.
--      · 회원 포인트 행(profiles)을 for update 로 잠그고, 4,000P 미만이면 신청을 막습니다.
--   2) public.request_batch_delivery(uuid[], ...) : 합배송(일괄 배송) 신청
--      · draw id 배열을 받아 ① 모두 본인 소유 + '보관중' 인지 확인(행 잠금)
--        ② 4,000P 를 '한 번만' 차감 ③ 모든 draws 를 '배송신청' 으로 바꾸고
--        대표 1건의 deliveries 기록(+ batch_draw_ids)을 남깁니다.
--      · 건수와 상관없이 차감은 4,000P 1회입니다. 최대 30건까지 한 번에 묶습니다.
--   3) public.admin_ship_delivery(...) : 합배송 기록을 출고완료로 바꿀 때
--      batch_draw_ids 에 묶인 상품들도 함께 '출고완료' 로 바꿉니다.
--      (기존 단건 함수와 인자·동작은 같고, 묶음일 때 형제 상품까지 마무리하는 부분만 더합니다)
-- =========================================================

-- ---------------------------------------------------------
-- 0) 합배송 묶음 표시용 컬럼 (nullable — 기존 행·코드와 100% 호환)
-- ---------------------------------------------------------
alter table public.deliveries add column if not exists batch_draw_ids uuid[];

comment on column public.deliveries.batch_draw_ids is
  'v4.4.21 합배송: 대표 배송 기록 1건에 묶인 draws.id 목록 (null = 단건 배송)';

-- ---------------------------------------------------------
-- 1) 단건 배송 신청 — 1회당 4,000P 차감 (v4.4.12)
-- ---------------------------------------------------------
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
  v_profile public.profiles%rowtype;
  v_id uuid := gen_random_uuid();
  v_fee integer := 4000;   -- 배송 신청 1회당 차감 포인트 (택배비 4,000원과 동일)
begin
  if v_uid is null then raise exception '로그인이 필요합니다.'; end if;
  if coalesce(btrim(p_recipient), '') = '' then raise exception '받는 사람을 입력해 주세요.'; end if;
  if coalesce(btrim(p_phone), '') = '' then raise exception '연락처를 입력해 주세요.'; end if;
  if coalesce(btrim(p_address), '') = '' then raise exception '주소를 입력해 주세요.'; end if;

  -- 1) 보관함 상품 잠금 (같은 상품을 두 번 신청하지 못하게)
  select * into v_draw from public.draws where id = p_draw_id and user_id = v_uid for update;
  if not found then raise exception '보관함에서 상품을 찾을 수 없습니다.'; end if;
  if v_draw.item_status is distinct from '보관중' then raise exception '이미 배송 신청했거나 전환된 상품입니다.'; end if;

  -- 2) 포인트 잠금 + 잔액 검증 (4,000P 미만이면 신청 불가)
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then raise exception '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.'; end if;
  if coalesce(v_profile.points, 0) < v_fee then
    raise exception '보유 포인트가 부족합니다 (4,000P 필요, 현재 %P)', coalesce(v_profile.points, 0);
  end if;

  -- 3) 배송 요청 기록 + 포인트 차감 (한 트랜잭션 — 둘 중 하나만 되지 않습니다)
  insert into public.deliveries (id, user_id, draw_id, board_id, item_label, grade, recipient, phone, postcode, address, memo, status)
  values (v_id, v_uid, p_draw_id, v_draw.board_id, v_draw.tier_label, v_draw.grade,
          btrim(p_recipient), btrim(p_phone), btrim(coalesce(p_postcode, '')), btrim(p_address), p_memo, '요청');

  update public.profiles set points = points - v_fee where id = v_uid;
  update public.draws set item_status = '배송신청' where id = p_draw_id;

  return jsonb_build_object(
    'id', v_id,
    'status', '요청',
    'points_used', v_fee,
    'points_balance', coalesce(v_profile.points, 0) - v_fee
  );
end;
$$;

-- 함수 실행 권한 (기존 schema.sql 과 동일한 범위: 비로그인은 '로그인이 필요합니다.'로 막힘)
grant execute on function public.request_delivery(uuid, text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------
-- 2) 합배송(일괄 배송) 신청 — 여러 상품을 4,000P 1회로
-- ---------------------------------------------------------
create or replace function public.request_batch_delivery(
  p_draw_ids uuid[],
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
  v_ids uuid[];
  v_n integer := 0;
  v_mine integer := 0;
  v_bad integer := 0;
  v_profile public.profiles%rowtype;
  v_first public.draws%rowtype;
  v_id uuid := gen_random_uuid();
  v_fee integer := 4000;   -- 합배송도 신청 1회 = 4,000P (건수와 무관)
  v_label text;
begin
  if v_uid is null then raise exception '로그인이 필요합니다.'; end if;
  if coalesce(btrim(p_recipient), '') = '' then raise exception '받는 사람을 입력해 주세요.'; end if;
  if coalesce(btrim(p_phone), '') = '' then raise exception '연락처를 입력해 주세요.'; end if;
  if coalesce(btrim(p_address), '') = '' then raise exception '주소를 입력해 주세요.'; end if;

  -- 0) 중복 제거 + 건수 확인
  select array_agg(distinct x order by x) into v_ids
  from unnest(coalesce(p_draw_ids, array[]::uuid[])) as x
  where x is not null;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then raise exception '합배송으로 보낼 상품을 선택해 주세요.'; end if;
  if v_n > 30 then raise exception '한 번에 최대 30건까지 합배송 신청할 수 있어요.'; end if;

  -- 1) 상품 행 잠금 (id 순서 고정 → 동시 신청끼리 교착되지 않게)
  perform 1 from public.draws
   where id = any(v_ids) and user_id = v_uid
   order by id
   for update;

  select count(*) into v_mine from public.draws where id = any(v_ids) and user_id = v_uid;
  if v_mine is distinct from v_n then raise exception '보관함에서 상품을 찾을 수 없습니다.'; end if;

  select count(*) into v_bad
    from public.draws
   where id = any(v_ids) and user_id = v_uid and item_status is distinct from '보관중';
  if v_bad > 0 then raise exception '이미 배송 신청했거나 전환된 상품이 포함되어 있어요. 새로고침 후 다시 선택해 주세요.'; end if;

  -- 대표 상품 = 가장 먼저 뽑은 상품 (관리자 표에 한 줄로 보일 기준)
  select * into v_first
    from public.draws
   where id = any(v_ids) and user_id = v_uid
   order by created_at, seq
   limit 1;

  -- 2) 포인트 잠금 + 잔액 검증 (4,000P 1회)
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found then raise exception '회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.'; end if;
  if coalesce(v_profile.points, 0) < v_fee then
    raise exception '보유 포인트가 부족합니다 (4,000P 필요, 현재 %P)', coalesce(v_profile.points, 0);
  end if;

  if v_n > 1 then
    v_label := '[합배송 ' || v_n || '건] ' || coalesce(v_first.tier_label, '당첨 상품') || ' 외 ' || (v_n - 1) || '건';
  else
    v_label := coalesce(v_first.tier_label, '당첨 상품');
  end if;

  -- 3) 대표 1건 배송 기록 + 포인트 1회 차감 + 모든 상품 상태 변경 (한 트랜잭션)
  insert into public.deliveries (id, user_id, draw_id, board_id, item_label, grade, recipient, phone, postcode, address, memo, status, batch_draw_ids)
  values (v_id, v_uid, v_first.id, v_first.board_id, v_label, v_first.grade,
          btrim(p_recipient), btrim(p_phone), btrim(coalesce(p_postcode, '')), btrim(p_address), p_memo, '요청', v_ids);

  update public.profiles set points = points - v_fee where id = v_uid;
  update public.draws set item_status = '배송신청' where id = any(v_ids) and user_id = v_uid;

  return jsonb_build_object(
    'id', v_id,
    'status', '요청',
    'count', v_n,
    'item_label', v_label,
    'points_used', v_fee,
    'points_balance', coalesce(v_profile.points, 0) - v_fee
  );
end;
$$;

grant execute on function public.request_batch_delivery(uuid[], text, text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------
-- 3) 관리자 출고 처리 — 합배송 묶음이면 형제 상품까지 출고완료
--    (기존 admin_ship_delivery 와 인자·반환은 같습니다)
-- ---------------------------------------------------------
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

  if v_del.batch_draw_ids is not null and array_length(v_del.batch_draw_ids, 1) > 0 then
    update public.draws set item_status = '출고완료' where id = any(v_del.batch_draw_ids);
  elsif v_del.draw_id is not null then
    update public.draws set item_status = '출고완료' where id = v_del.draw_id;
  end if;

  return jsonb_build_object('id', p_delivery_id, 'status', '출고완료');
end;
$$;

grant execute on function public.admin_ship_delivery(uuid, text, text) to authenticated;

-- ---------------------------------------------------------
-- 확인용 (실행해 보면 결과가 보입니다 — 쓰기 없음)
--   1) 합배송 함수 등록 확인
--      select proname, pg_get_function_arguments(oid) from pg_proc
--       where proname in ('request_delivery','request_batch_delivery','admin_ship_delivery');
--   2) 합배송 기록 확인 (최근 10건)
--      select id, item_label, batch_draw_ids, status, requested_at
--        from public.deliveries where batch_draw_ids is not null
--       order by requested_at desc limit 10;
-- ---------------------------------------------------------
