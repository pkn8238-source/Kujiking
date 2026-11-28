-- =========================================================
-- 쿠지킹 KUJIKING — 보관함 배송 신청 4,000P 차감 (v4.4.12 · 2026-11-28)
-- ---------------------------------------------------------
-- 실행 방법
--   1) https://supabase.com/dashboard → 쿠지킹 프로젝트(ptqonefsjhusyuofgius) → SQL Editor
--   2) [New query] 에 이 파일 내용을 통째로 붙여넣고 [Run]
--   3) "Success. No rows returned" 가 나오면 끝 (여러 번 실행해도 안전합니다)
--
-- 바뀌는 것
--   public.request_delivery(...) 을 "배송 신청 1건당 4,000P 차감" 버전으로 교체합니다.
--   · 인자 6개(p_draw_id, p_recipient, p_phone, p_postcode, p_address, p_memo)와
--     security definer / search_path = public, extensions / for update / deliveries·draws 기록 방식은
--     기존 함수와 같습니다. 앱(assets/app.js)은 같은 인자로 호출합니다.
--   · 회원 포인트 행(profiles)을 for update 로 잠그고, 보유 포인트가 4,000P 미만이면 신청을 막습니다.
--     → '보유 포인트가 부족합니다 (4,000P 필요, 현재 OOO P)'
--   · 성공하면 profiles.points 에서 4,000 을 원자적으로 빼고, 응답에 points_used · points_balance 를
--     함께 돌려줘 화면(내 보관함·내 정보)의 잔액이 바로 줄어듭니다.
--   · 배송 요청 기록(deliveries)과 상품 상태(draws.item_status = '배송신청')는 차감과 같은 트랜잭션에서 처리됩니다.
-- =========================================================

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
  v_fee integer := 4000;   -- 배송 신청 1건당 차감 포인트 (택배비 4,000원과 동일)
begin
  if v_uid is null then raise exception '로그인이 필요합니다.'; end if;
  if coalesce(btrim(p_recipient), '') = '' then raise exception '받는 사람을 입력해 주세요.'; end if;
  if coalesce(btrim(p_phone), '') = '' then raise exception '연락처를 입력해 주세요.'; end if;
  if coalesce(btrim(p_address), '') = '' then raise exception '주소를 입력해 주세요.'; end if;

  -- 1) 보관함 상품 잠금 (같은 상품을 두 번 신청하지 못하게)
  select * into v_draw from public.draws where id = p_draw_id and user_id = v_uid for update;
  if not found then raise exception '보관함에서 상품을 찾을 수 없습니다.'; end if;
  if v_draw.item_status <> '보관중' then raise exception '이미 배송 신청했거나 전환된 상품입니다.'; end if;

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
