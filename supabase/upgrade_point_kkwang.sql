-- =========================================================
-- 쿠지킹 KUJIKING v3.7 — P상(포인트 꽝) + 실물 각 1개 구성 재시드
-- ---------------------------------------------------------
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여넣고 RUN 하세요.
-- 여러 번 실행해도 안전합니다. (같은 판을 다시 만들면 기존 뽑기 기록만 정리됩니다)
--
-- 이 파일이 하는 일
--   1) draws_source_check 제약이 'points' 를 막지 않도록 정리
--   2) draw_ticket 함수를 P상(points_awarded / pointOnly) 지원 버전으로 교체
--      · P상 당첨 시 storage_items(=draws '보관중') 를 만들지 않고
--        profiles.points 에 1,200P 를 바로 적립
--      · 응답에 points_awarded · points_balance 를 함께 돌려줌
--   3) 시바마루야 4판을 아래 구성으로 다시 심는다
--      · 실물 등급(A~J/…/L)은 각 1개씩만, 나머지 티켓은 전부 P상(굿즈 포인트 1,200P)
--      · 1장 가격 12,000원(=12,000P) 통일
--      · [드래곤볼] SPIRIT OF THE SAIYAN 쿠지     12000원 200장 = 실물 10종 각 1개 + P상 190장
--      · [헌터×헌터] 키메라 앤트 ② 쿠지                12000원 180장 = 실물  9종 각 1개 + P상 171장
--      · [죠죠] The Gathering of RIVALS 쿠지    12000원 240장 = 실물 12종 각 1개 + P상 228장
--      · [약사의 혼잣말] 극장판 망비의 비보 쿠지            12000원 160장 = 실물  8종 각 1개 + P상 152장
-- =========================================================

set search_path = public, extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------
-- 1) draws.source 제약 정리 ('points' 허용)
-- ---------------------------------------------------------
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.draws'::regclass and conname = 'draws_source_check'
  ) then
    alter table public.draws drop constraint draws_source_check;
  end if;
end $$;

-- ---------------------------------------------------------
-- 2) draw_ticket 교체 — P상이면 보관함 없이 포인트 즉시 적립
--    (v3.7) tier JSON 의 pointOnly=true 또는 points_awarded>0 을 P상으로 본다
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

grant execute on function public.draw_ticket(uuid, integer, uuid, text, boolean) to anon, authenticated;

-- ---------------------------------------------------------
-- 3) 4판 재시드 — 실물 등급 각 1개 + P상(1,200P)
-- ---------------------------------------------------------

do $$
declare
  v_id      uuid;
  v_seed    text;
  v_title   text;
  v_cat     text;
  v_cover   text;
  v_price   integer;
  v_count   integer;
  v_lo      text;
  v_lo_img  text;
  v_lo_desc text;
  v_tiers   jsonb;
  v_manual  jsonb;
begin

  -- ── [드래곤볼] SPIRIT OF THE SAIYAN 쿠지 ──────────────────────────────────────────────
  v_title   := '[드래곤볼] SPIRIT OF THE SAIYAN 쿠지';
  v_cat     := '드래곤볼';
  v_cover   := 'assets/products/dragonball-saiyan/cover.jpg';
  v_price   := 12000;
  v_count   := 200;
  v_lo      := '라스트원상 · 손오공&손오반 MASTERLISE PLUS';
  v_lo_img  := 'assets/products/dragonball-saiyan/last_one.jpg';
  v_lo_desc := '약 21cm · 근두운에 오른 부자(父子) 피규어';
  v_tiers   := $json$[{"grade":"A","label":"손오공 MASTERLISE","count":1,"points":35000,"image":"assets/products/dragonball-saiyan/tier_a.jpg","desc":"약 20cm · 카메하메하 포즈의 MASTERLISE 피규어"},{"grade":"B","label":"초사이어인 손오반 MASTERLISE","count":1,"points":20000,"image":"assets/products/dragonball-saiyan/tier_b.jpg","desc":"약 19cm · 아버지와 같은 카메하메하 포즈"},{"grade":"C","label":"손오천 MASTERLISE","count":1,"points":14000,"image":"assets/products/dragonball-saiyan/tier_c.jpg","desc":"약 13cm · 어린 손오천의 경쾌한 포즈"},{"grade":"D","label":"바닥 MASTERLISE","count":1,"points":12000,"image":"assets/products/dragonball-saiyan/tier_d.jpg","desc":"약 25cm · 사이어인 정예전사 바닥"},{"grade":"E","label":"라디츠 MASTERLISE","count":1,"points":12000,"image":"assets/products/dragonball-saiyan/tier_e.jpg","desc":"약 25cm · 스카우터를 쓴 손오공의 형"},{"grade":"F","label":"피규어 마그넷","count":1,"points":6000,"image":"assets/products/dragonball-saiyan/tier_f.jpg","desc":"약 5cm · 전 3종 중 1종 랜덤"},{"grade":"G","label":"파우치","count":1,"points":5000,"image":"assets/products/dragonball-saiyan/tier_g.jpg","desc":"약 13cm · 전 7종 중 1종 랜덤"},{"grade":"H","label":"아크릴 스탠드","count":1,"points":4000,"image":"assets/products/dragonball-saiyan/tier_h.jpg","desc":"약 7~10cm · 전 9종 중 1종 랜덤"},{"grade":"I","label":"고무 어소트","count":1,"points":3000,"image":"assets/products/dragonball-saiyan/tier_i.jpg","desc":"약 5.5~6.5cm · 전 7종 중 1종 랜덤"},{"grade":"J","label":"다이컷 타월","count":1,"points":2000,"image":"assets/products/dragonball-saiyan/tier_j.jpg","desc":"약 24cm · 전 9종 중 1종 랜덤"},{"grade":"P","label":"굿즈 포인트 1,200P","count":190,"points":1200,"pointOnly":true,"desc":"실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료"}]$json$::jsonb;
  v_manual  := $json${"summary":"손오공 일가의 카메하메하 장면을 MASTERLISE로 입체화한 이치방쿠지입니다. A~E상은 대형 피규어, F~J상은 마그넷·파우치·아크릴·고무·타월 소품으로 구성됩니다.","specs":[{"k":"시리즈","v":"드래곤볼 Z"},{"k":"제조사","v":"반다이 스피리츠"},{"k":"일본 발매","v":"2026.10.17"},{"k":"일본 판매가","v":"1회 790엔 (세금 포함)"},{"k":"세트 구성","v":"A~J상 10종 + 라스트원상 · 총 11종"},{"k":"이 판 구성","v":"실물 10종 각 1개 + P상 190장 = 200장"},{"k":"주요 크기","v":"MASTERLISE 약 13~25cm"}],"lineup":["A상 손오공 MASTERLISE (약 20cm)","B상 초사이어인 손오반 MASTERLISE (약 19cm)","C상 손오천 MASTERLISE (약 13cm)","D상 바닥 MASTERLISE (약 25cm)","E상 라디츠 MASTERLISE (약 25cm)","F상 피규어 마그넷 (약 5cm / 전 3종)","G상 파우치 (약 13cm / 전 7종)","H상 아크릴 스탠드 (약 7~10cm / 전 9종)","I상 고무 어소트 (약 5.5~6.5cm / 전 7종)","J상 다이컷 타월 (약 24cm / 전 9종)","라스트원상 손오공&손오반 MASTERLISE PLUS (약 21cm)"],"notes":["이 판은 실제 세트의 A~J상 10종을 등급별로 각 1개씩(실물 10개) 두고, 나머지 190장을 P상(굿즈 포인트 1,200P)으로 채운 총 200장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.","P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.","피규어는 공장 조립·도색 상태에 따라 개체 차이가 있을 수 있습니다."]}$json$::jsonb;

  v_id := null;
  select id into v_id from public.boards where id = '0d1a5e00-0001-4a00-9000-000000000001' or title = v_title limit 1;
  if v_id is null then
    v_id := '0d1a5e00-0001-4a00-9000-000000000001';
    v_seed := 'shibamaruya-dragonball-saiyan-200-20261124';
    insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                               last_one_label, last_one_image, last_one_desc, manual,
                               status, seed, seed_hash)
    values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
            v_lo, v_lo_img, v_lo_desc, v_manual,
            'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));
  else
    v_seed := 'shibamaruya-dragonball-saiyan-200-20261124';
    -- 이 판에 쌓인 테스트 뽑기·배송 기록을 정리하고 번호표를 새로 깐다
    delete from public.deliveries where board_id = v_id;
    delete from public.draws      where board_id = v_id;
    delete from public.tickets    where board_id = v_id;
    update public.boards
       set title = v_title, category = v_cat, cover = v_cover,
           price = v_price, ticket_count = v_count, tiers = v_tiers,
           last_one_label = v_lo, last_one_image = v_lo_img, last_one_desc = v_lo_desc,
           manual = v_manual, status = 'open',
           seed = v_seed, seed_hash = encode(digest(v_seed, 'sha256'), 'hex')
     where id = v_id;
  end if;

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, v_count) as g(n);

  -- ── [헌터×헌터] 키메라 앤트 ② 쿠지 ──────────────────────────────────────────────
  v_title   := '[헌터×헌터] 키메라 앤트 ② 쿠지';
  v_cat     := '헌터×헌터';
  v_cover   := 'assets/products/hunter-chimera-ant/cover.jpg';
  v_price   := 12000;
  v_count   := 180;
  v_lo      := '라스트원상 · 곤 ~성장ver.~ MASTERLISE EXTRA';
  v_lo_img  := 'assets/products/hunter-chimera-ant/last_one.jpg';
  v_lo_desc := '약 100cm · 성장한 곤의 초대형 피규어';
  v_tiers   := $json$[{"grade":"A","label":"메르엠 MASTERLISE","count":1,"points":40000,"image":"assets/products/hunter-chimera-ant/tier_a.jpg","desc":"약 23cm · 개미의 왕, 압도적인 조형"},{"grade":"B","label":"네테로 MASTERLISE","count":1,"points":22000,"image":"assets/products/hunter-chimera-ant/tier_b.jpg","desc":"약 22cm · 감사의 정권찌르기 장면"},{"grade":"C","label":"곤 MASTERLISE","count":1,"points":14000,"image":"assets/products/hunter-chimera-ant/tier_c.jpg","desc":"약 10cm · 네페르피토와 대치한 순간"},{"grade":"D","label":"키르아 MASTERLISE","count":1,"points":16000,"image":"assets/products/hunter-chimera-ant/tier_d.jpg","desc":"약 21cm · 전격의 순간"},{"grade":"E","label":"네페르피토 MASTERLISE","count":1,"points":16000,"image":"assets/products/hunter-chimera-ant/tier_e.jpg","desc":"약 24cm · 왕의 근위대"},{"grade":"F","label":"샤우아푸프 · 몬투투유피 MASTERLISE","count":1,"points":12000,"image":"assets/products/hunter-chimera-ant/tier_f.jpg","desc":"약 6~7cm · 전 2종 중 1종 랜덤"},{"grade":"G","label":"고무 컬렉션","count":1,"points":5000,"image":"assets/products/hunter-chimera-ant/tier_g.jpg","desc":"약 8~19cm · 전 10종 중 1종 랜덤"},{"grade":"H","label":"문구 어소트","count":1,"points":4000,"image":"assets/products/hunter-chimera-ant/tier_h.jpg","desc":"A4 클리어파일·A6 노트 / 전 10종 중 1종"},{"grade":"I","label":"폰탭 · 넥스트랩 · 스티커","count":1,"points":3000,"image":"assets/products/hunter-chimera-ant/tier_i.jpg","desc":"약 5~47cm · 전 10종 중 1종 랜덤"},{"grade":"P","label":"굿즈 포인트 1,200P","count":171,"points":1200,"pointOnly":true,"desc":"실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료"}]$json$::jsonb;
  v_manual  := $json${"summary":"키메라 앤트 편을 테마로 한 재판매 세트입니다. A~F상이 전부 MASTERLISE 피규어이고, 라스트원상은 약 1m 크기의 성장한 곤입니다.","specs":[{"k":"시리즈","v":"헌터×헌터 키메라 앤트 편"},{"k":"제조사","v":"반다이 스피리츠"},{"k":"일본 발매","v":"2026.11.14 (재판)"},{"k":"일본 판매가","v":"1회 790엔 (세금 포함)"},{"k":"세트 구성","v":"A~I상 9종 + 라스트원상 · 총 10종"},{"k":"이 판 구성","v":"실물 9종 각 1개 + P상 171장 = 180장"},{"k":"주요 크기","v":"MASTERLISE 약 6~24cm · 라스트원 약 100cm"}],"lineup":["A상 메르엠 MASTERLISE (약 23cm)","B상 네테로 MASTERLISE (약 22cm)","C상 곤 MASTERLISE (약 10cm)","D상 키르아 MASTERLISE (약 21cm)","E상 네페르피토 MASTERLISE (약 24cm)","F상 샤우아푸프/몬투투유피 MASTERLISE (약 6~7cm / 전 2종)","G상 고무 컬렉션 (약 8~19cm / 전 10종)","H상 문구 어소트 (A4 클리어파일·A6 노트 / 전 10종)","I상 폰탭·넥스트랩·스티커 어소트 (약 5~47cm / 전 10종)","라스트원상 곤 ~성장ver.~ MASTERLISE EXTRA (약 100cm)"],"notes":["이 판은 실제 세트의 A~I상 9종을 등급별로 각 1개씩(실물 9개) 두고, 나머지 171장을 P상(굿즈 포인트 1,200P)으로 채운 총 180장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.","P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.","라스트원상은 약 100cm 대형 피규어로, 일반 상품과 별도 박스로 발송됩니다."]}$json$::jsonb;

  v_id := null;
  select id into v_id from public.boards where id = '0d1a5e00-0002-4a00-9000-000000000002' or title = v_title limit 1;
  if v_id is null then
    v_id := '0d1a5e00-0002-4a00-9000-000000000002';
    v_seed := 'shibamaruya-hunter-chimera-ant-180-20261124';
    insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                               last_one_label, last_one_image, last_one_desc, manual,
                               status, seed, seed_hash)
    values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
            v_lo, v_lo_img, v_lo_desc, v_manual,
            'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));
  else
    v_seed := 'shibamaruya-hunter-chimera-ant-180-20261124';
    -- 이 판에 쌓인 테스트 뽑기·배송 기록을 정리하고 번호표를 새로 깐다
    delete from public.deliveries where board_id = v_id;
    delete from public.draws      where board_id = v_id;
    delete from public.tickets    where board_id = v_id;
    update public.boards
       set title = v_title, category = v_cat, cover = v_cover,
           price = v_price, ticket_count = v_count, tiers = v_tiers,
           last_one_label = v_lo, last_one_image = v_lo_img, last_one_desc = v_lo_desc,
           manual = v_manual, status = 'open',
           seed = v_seed, seed_hash = encode(digest(v_seed, 'sha256'), 'hex')
     where id = v_id;
  end if;

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, v_count) as g(n);

  -- ── [죠죠] The Gathering of RIVALS 쿠지 ──────────────────────────────────────────────
  v_title   := '[죠죠] The Gathering of RIVALS 쿠지';
  v_cat     := '죠죠의 기묘한 모험';
  v_cover   := 'assets/products/jojo-rivals/cover.jpg';
  v_price   := 12000;
  v_count   := 240;
  v_lo      := '라스트원상 · 디에고 브란도 MASTERLISE';
  v_lo_img  := 'assets/products/jojo-rivals/last_one.jpg';
  v_lo_desc := '약 15cm · 7부 스틸 볼 런의 디에고';
  v_tiers   := $json$[{"grade":"A","label":"디오 브란도 MASTERLISE PLUS","count":1,"points":32000,"image":"assets/products/jojo-rivals/tier_a.jpg","desc":"약 18cm · 1부 팬텀 블러드의 디오"},{"grade":"B","label":"카즈 MASTERLISE","count":1,"points":24000,"image":"assets/products/jojo-rivals/tier_b.jpg","desc":"약 25cm · 2부 전투조류의 카즈"},{"grade":"C","label":"DIO MASTERLISE","count":1,"points":24000,"image":"assets/products/jojo-rivals/tier_c.jpg","desc":"약 26cm · 3부 스타더스트 크루세이더스의 DIO"},{"grade":"D","label":"카와지리 하지메 MASTERLISE","count":1,"points":18000,"image":"assets/products/jojo-rivals/tier_d.jpg","desc":"약 24cm · 4부 다이아몬드는 부서지지 않는다"},{"grade":"E","label":"디아볼로 MASTERLISE","count":1,"points":18000,"image":"assets/products/jojo-rivals/tier_e.jpg","desc":"약 25cm · 5부 황금의 바람"},{"grade":"F","label":"엔리코 P MASTERLISE","count":1,"points":18000,"image":"assets/products/jojo-rivals/tier_f.jpg","desc":"약 22cm · 6부 스톤 오션"},{"grade":"G","label":"스탠드의 화살 MASTERELIVE COLLECTION","count":1,"points":16000,"image":"assets/products/jojo-rivals/tier_g.jpg","desc":"약 21cm · 스탠드를 각성시키는 화살"},{"grade":"H","label":"LOGO de Collection","count":1,"points":9000,"image":"assets/products/jojo-rivals/tier_h.jpg","desc":"약 9~10cm · 전 7종 중 1종 랜덤"},{"grade":"I","label":"미니어처 참","count":1,"points":7000,"image":"assets/products/jojo-rivals/tier_i.jpg","desc":"약 2.5~4.5cm · 전 7종 중 1종 랜덤"},{"grade":"J","label":"고무 어소트","count":1,"points":5000,"image":"assets/products/jojo-rivals/tier_j.jpg","desc":"약 4~12cm · 전 7종 중 1종 랜덤"},{"grade":"K","label":"클리어 포스터","count":1,"points":4000,"image":"assets/products/jojo-rivals/tier_k.jpg","desc":"A3 · 전 8종 중 1종 랜덤"},{"grade":"L","label":"스티커 컬렉션","count":1,"points":3000,"image":"assets/products/jojo-rivals/tier_l.jpg","desc":"약 6~14cm · 전 13종 중 1종 랜덤"},{"grade":"P","label":"굿즈 포인트 1,200P","count":228,"points":1200,"pointOnly":true,"desc":"실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료"}]$json$::jsonb;
  v_manual  := $json${"summary":"시리즈 역대 숙적들이 MASTERLISE로 모인 세트입니다. A~F상은 18~26cm 피규어, G상은 스탠드의 화살, H~L상은 로고 피규어·참·고무·포스터·스티커입니다.","specs":[{"k":"시리즈","v":"죠죠의 기묘한 모험"},{"k":"제조사","v":"반다이 스피리츠"},{"k":"일본 발매","v":"2026.11.21"},{"k":"일본 판매가","v":"1회 850엔 (세금 포함)"},{"k":"세트 구성","v":"A~L상 12종 + 라스트원상 · 총 13종"},{"k":"이 판 구성","v":"실물 12종 각 1개 + P상 228장 = 240장"},{"k":"주요 크기","v":"MASTERLISE 약 18~26cm"}],"lineup":["A상 디오 브란도 MASTERLISE PLUS (약 18cm)","B상 카즈 MASTERLISE (약 25cm)","C상 DIO MASTERLISE (약 26cm)","D상 카와지리 하지메 MASTERLISE (약 24cm)","E상 디아볼로 MASTERLISE (약 25cm)","F상 엔리코 P MASTERLISE (약 22cm)","G상 스탠드의 화살 MASTERELIVE COLLECTION (약 21cm)","H상 죠죠의 기묘한 모험 LOGO de Collection (약 9~10cm / 전 7종)","I상 미니어처 참 (약 2.5~4.5cm / 전 7종)","J상 고무 어소트 (약 4~12cm / 전 7종)","K상 클리어 포스터 (A3 / 전 8종)","L상 스티커 컬렉션 (약 6~14cm / 전 13종)","라스트원상 디에고 브란도 MASTERLISE (약 15cm)"],"notes":["이 판은 실제 세트의 A~L상 12종을 등급별로 각 1개씩(실물 12개) 두고, 나머지 228장을 P상(굿즈 포인트 1,200P)으로 채운 총 240장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.","P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.","클리어 포스터는 A3 크기로, 배송 시 접히지 않도록 원통 포장됩니다."]}$json$::jsonb;

  v_id := null;
  select id into v_id from public.boards where id = '0d1a5e00-0003-4a00-9000-000000000003' or title = v_title limit 1;
  if v_id is null then
    v_id := '0d1a5e00-0003-4a00-9000-000000000003';
    v_seed := 'shibamaruya-jojo-rivals-240-20261124';
    insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                               last_one_label, last_one_image, last_one_desc, manual,
                               status, seed, seed_hash)
    values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
            v_lo, v_lo_img, v_lo_desc, v_manual,
            'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));
  else
    v_seed := 'shibamaruya-jojo-rivals-240-20261124';
    -- 이 판에 쌓인 테스트 뽑기·배송 기록을 정리하고 번호표를 새로 깐다
    delete from public.deliveries where board_id = v_id;
    delete from public.draws      where board_id = v_id;
    delete from public.tickets    where board_id = v_id;
    update public.boards
       set title = v_title, category = v_cat, cover = v_cover,
           price = v_price, ticket_count = v_count, tiers = v_tiers,
           last_one_label = v_lo, last_one_image = v_lo_img, last_one_desc = v_lo_desc,
           manual = v_manual, status = 'open',
           seed = v_seed, seed_hash = encode(digest(v_seed, 'sha256'), 'hex')
     where id = v_id;
  end if;

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, v_count) as g(n);

  -- ── [약사의 혼잣말] 극장판 망비의 비보 쿠지 ──────────────────────────────────────────────
  v_title   := '[약사의 혼잣말] 극장판 망비의 비보 쿠지';
  v_cat     := '약사의 혼잣말';
  v_cover   := 'assets/products/apothecary-secret/cover.jpg';
  v_price   := 12000;
  v_count   := 160;
  v_lo      := '라스트원상 · 마오마오 피규어';
  v_lo_img  := 'assets/products/apothecary-secret/last_one.jpg';
  v_lo_desc := '약 18cm · 꽃이 핀 받침대 위의 마오마오';
  v_tiers   := $json$[{"grade":"A","label":"마오마오 Dioramiquemaster","count":1,"points":30000,"image":"assets/products/apothecary-secret/tier_a.jpg","desc":"약 15cm · 극장판 의상의 디오라마 피규어"},{"grade":"B","label":"진시 Dioramiquemaster","count":1,"points":20000,"image":"assets/products/apothecary-secret/tier_b.jpg","desc":"약 16cm · 극장판 의상의 디오라마 피규어"},{"grade":"C","label":"빅 아크릴 스탠드","count":1,"points":9000,"image":"assets/products/apothecary-secret/tier_c.jpg","desc":"약 16cm · 마오마오 & 진시 일러스트"},{"grade":"D","label":"키라라이즈 마스코트","count":1,"points":7000,"image":"assets/products/apothecary-secret/tier_d.jpg","desc":"약 10cm · 전 2종 중 1종 랜덤"},{"grade":"E","label":"메탈 참","count":1,"points":6000,"image":"assets/products/apothecary-secret/tier_e.jpg","desc":"약 5cm · 전 5종 중 1종 랜덤"},{"grade":"F","label":"고무 컬렉션","count":1,"points":4000,"image":"assets/products/apothecary-secret/tier_f.jpg","desc":"약 6~10cm · 전 5종 중 1종 랜덤"},{"grade":"G","label":"아크릴 스탠드","count":1,"points":3500,"image":"assets/products/apothecary-secret/tier_g.jpg","desc":"약 6.5~8cm · 전 5종 중 1종 랜덤"},{"grade":"H","label":"미니 색지","count":1,"points":3000,"image":"assets/products/apothecary-secret/tier_h.jpg","desc":"약 13cm · 전 5종 중 1종 랜덤"},{"grade":"P","label":"굿즈 포인트 1,200P","count":152,"points":1200,"pointOnly":true,"desc":"실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료"}]$json$::jsonb;
  v_manual  := $json${"summary":"극장판 약사의 혼잣말 첫 이치방쿠지입니다. 신브랜드 Dioramiquemaster의 마오마오·진시 피규어와 극장판 의상 일러스트 굿즈로 구성됩니다.","specs":[{"k":"시리즈","v":"극장판 약사의 혼잣말"},{"k":"제조사","v":"반다이 스피리츠"},{"k":"일본 발매","v":"2026.12.05"},{"k":"일본 판매가","v":"1회 800엔 (세금 포함)"},{"k":"세트 구성","v":"A~H상 8종 + 라스트원상 · 총 9종"},{"k":"이 판 구성","v":"실물 8종 각 1개 + P상 152장 = 160장"},{"k":"주요 크기","v":"Dioramiquemaster 약 15~16cm"}],"lineup":["A상 마오마오 Dioramiquemaster (약 15cm)","B상 진시 Dioramiquemaster (약 16cm)","C상 빅 아크릴 스탠드 (약 16cm)","D상 키라라이즈 마스코트 (약 10cm / 전 2종)","E상 메탈 참 (약 5cm / 전 5종)","F상 고무 컬렉션 (약 6~10cm / 전 5종)","G상 아크릴 스탠드 (약 6.5~8cm / 전 5종)","H상 미니 색지 (약 13cm / 전 5종)","라스트원상 마오마오 피규어 (약 18cm)"],"notes":["이 판은 실제 세트의 A~H상 8종을 등급별로 각 1개씩(실물 8개) 두고, 나머지 152장을 P상(굿즈 포인트 1,200P)으로 채운 총 160장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.","P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.","일본 발매가 2026년 12월 5일인 신작으로, 이 판은 입고분에 한해 순차 발송됩니다."]}$json$::jsonb;

  v_id := null;
  select id into v_id from public.boards where id = '0d1a5e00-0004-4a00-9000-000000000004' or title = v_title limit 1;
  if v_id is null then
    v_id := '0d1a5e00-0004-4a00-9000-000000000004';
    v_seed := 'shibamaruya-apothecary-secret-160-20261124';
    insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                               last_one_label, last_one_image, last_one_desc, manual,
                               status, seed, seed_hash)
    values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
            v_lo, v_lo_img, v_lo_desc, v_manual,
            'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));
  else
    v_seed := 'shibamaruya-apothecary-secret-160-20261124';
    -- 이 판에 쌓인 테스트 뽑기·배송 기록을 정리하고 번호표를 새로 깐다
    delete from public.deliveries where board_id = v_id;
    delete from public.draws      where board_id = v_id;
    delete from public.tickets    where board_id = v_id;
    update public.boards
       set title = v_title, category = v_cat, cover = v_cover,
           price = v_price, ticket_count = v_count, tiers = v_tiers,
           last_one_label = v_lo, last_one_image = v_lo_img, last_one_desc = v_lo_desc,
           manual = v_manual, status = 'open',
           seed = v_seed, seed_hash = encode(digest(v_seed, 'sha256'), 'hex')
     where id = v_id;
  end if;

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, v_count) as g(n);
end;
$$;

-- ---------------------------------------------------------
-- 4) 결과 확인 — 아래 4줄이 나오면 성공
--    tier_sum = ticket_count, p_count = ticket_count - 실물 종수
-- ---------------------------------------------------------
select b.title,
       b.price,
       b.ticket_count,
       jsonb_array_length(b.tiers) as tier_count,
       (select coalesce(sum((t.tier->>'count')::int), 0) from jsonb_array_elements(b.tiers) as t(tier)) as tier_sum,
       (select (t.tier->>'count')::int from jsonb_array_elements(b.tiers) as t(tier)
         where t.tier->>'grade' = 'P') as p_count,
       (select coalesce(sum((t.tier->>'count')::int), 0) from jsonb_array_elements(b.tiers) as t(tier)
         where t.tier->>'grade' <> 'P') as physical_count,
       (select count(*) from public.tickets k where k.board_id = b.id and k.status = 'available') as tickets_left
from public.boards b
where b.id in ('0d1a5e00-0001-4a00-9000-000000000001',
               '0d1a5e00-0002-4a00-9000-000000000002',
               '0d1a5e00-0003-4a00-9000-000000000003',
               '0d1a5e00-0004-4a00-9000-000000000004')
order by b.price desc, b.title;
