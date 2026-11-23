-- =========================================================
-- 쿠지킹 KUJIKING · 시바마루야(Shibamaru Store) 실물 상품 종류×20장 시드
-- 2026-11-24 · 상품 출처: https://shop.yujin-llc.co.jp/kuji
-- ---------------------------------------------------------
-- Supabase SQL Editor 에 그대로 붙여넣고 Run 하면 됩니다. 여러 번 실행해도 안전합니다.
--
--  1) boards 에 상품 설명서(manual)·라스트원 이미지 컬럼 추가
--  2) pgcrypto(search_path) 수정: 'function digest(text, unknown) does not exist' 해결
--     (ticket_grade / admin_create_board 를 public, extensions 경로로 재정의)
--  3) 실물 판 4개를 상품 종류 × 20장 구성으로 교체 (같은 UUID 로 다시 실행하면 초기화됩니다)
--
--  상품 구성 (등급 1종 = 뽑기 20장, 등급 수량 합계 = 전체 장수)
--   · 드래곤볼 SPIRIT OF THE SAIYAN    12,000원  A~J 10종 200장  A1 B2 C3 D4 E5 F10 G15 H25 I45 J90
--   · 헌터×헌터 키메라 앤트 ②          12,000원  A~I  9종 180장  A1 B2 C3 D4 E4 F6 G30 H55 I75
--   · 죠죠 The Gathering of RIVALS     13,000원  A~L 12종 240장  A1 B2 C2 D3 E3 F4 G6 H15 I20 J30 K60 L94
--   · 극장판 약사의 혼잣말 망비의 비보  12,000원  A~H  8종 160장  A1 B2 C4 D8 E15 F30 G45 H55
-- =========================================================

set search_path = public, extensions;

create extension if not exists pgcrypto with schema extensions;

-- 1) 상품 설명서 · 라스트원 이미지 컬럼 ---------------------------------
alter table public.boards add column if not exists last_one_image text;
alter table public.boards add column if not exists last_one_desc  text;
alter table public.boards add column if not exists manual         jsonb;

-- 1-1) 전체 장수 상한 300 → 500 (등급 12종 × 20장 = 240장까지 운용) ----
alter table public.boards drop constraint if exists boards_ticket_count_check;
alter table public.boards add constraint boards_ticket_count_check check (ticket_count between 1 and 500);

-- 2) pgcrypto search_path 수정 ------------------------------------------
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

-- 3) 실물 판 4개 교체 ----------------------------------------------------
do $$
declare
  v_id     uuid;
  v_seed   text;
  v_title  text;
  v_cat    text;
  v_cover  text;
  v_price  integer;
  v_count  integer;
  v_lo     text;
  v_lo_img text;
  v_lo_desc text;
  v_tiers  jsonb;
  v_manual jsonb;
begin

  v_id := '0d1a5e00-0001-4a00-9000-000000000001';
  v_seed := 'shibamaruya-dragonball-saiyan-200-20261124';
  v_title := '[드래곤볼] SPIRIT OF THE SAIYAN 쿠지';
  v_cat := '드래곤볼';
  v_cover := 'assets/products/dragonball-saiyan/cover.jpg';
  v_price := 12000;
  v_count := 200;
  v_lo := '라스트원상 · 손오공&손오반 MASTERLISE PLUS';
  v_lo_img := 'assets/products/dragonball-saiyan/last_one.jpg';
  v_lo_desc := '약 21cm · 근두운에 오른 부자(父子) 피규어';
  v_tiers := $json$[{"grade":"A","label":"손오공 MASTERLISE","count":1,"points":35000,"image":"assets/products/dragonball-saiyan/tier_a.jpg","desc":"약 20cm · 카메하메하 포즈의 MASTERLISE 피규어"},{"grade":"B","label":"초사이어인 손오반 MASTERLISE","count":2,"points":20000,"image":"assets/products/dragonball-saiyan/tier_b.jpg","desc":"약 19cm · 아버지와 같은 카메하메하 포즈"},{"grade":"C","label":"손오천 MASTERLISE","count":3,"points":14000,"image":"assets/products/dragonball-saiyan/tier_c.jpg","desc":"약 13cm · 어린 손오천의 경쾌한 포즈"},{"grade":"D","label":"바닥 MASTERLISE","count":4,"points":12000,"image":"assets/products/dragonball-saiyan/tier_d.jpg","desc":"약 25cm · 사이어인 정예전사 바닥"},{"grade":"E","label":"라디츠 MASTERLISE","count":5,"points":12000,"image":"assets/products/dragonball-saiyan/tier_e.jpg","desc":"약 25cm · 스카우터를 쓴 손오공의 형"},{"grade":"F","label":"피규어 마그넷","count":10,"points":6000,"image":"assets/products/dragonball-saiyan/tier_f.jpg","desc":"약 5cm · 전 3종 중 1종 랜덤"},{"grade":"G","label":"파우치","count":15,"points":5000,"image":"assets/products/dragonball-saiyan/tier_g.jpg","desc":"약 13cm · 전 7종 중 1종 랜덤"},{"grade":"H","label":"아크릴 스탠드","count":25,"points":4000,"image":"assets/products/dragonball-saiyan/tier_h.jpg","desc":"약 7~10cm · 전 9종 중 1종 랜덤"},{"grade":"I","label":"고무 어소트","count":45,"points":3000,"image":"assets/products/dragonball-saiyan/tier_i.jpg","desc":"약 5.5~6.5cm · 전 7종 중 1종 랜덤"},{"grade":"J","label":"다이컷 타월","count":90,"points":2000,"image":"assets/products/dragonball-saiyan/tier_j.jpg","desc":"약 24cm · 전 9종 중 1종 랜덤"}]$json$::jsonb;
  v_manual := $json${"summary":"손오공 일가의 카메하메하 장면을 MASTERLISE로 입체화한 이치방쿠지입니다. A~E상은 대형 피규어, F~J상은 마그넷·파우치·아크릴·고무·타월 소품으로 구성됩니다.","specs":[{"k":"시리즈","v":"드래곤볼 Z"},{"k":"제조사","v":"반다이 스피리츠"},{"k":"일본 발매","v":"2026.10.17"},{"k":"일본 판매가","v":"1회 790엔 (세금 포함)"},{"k":"세트 구성","v":"A~J상 10종 + 라스트원상 · 총 11종"},{"k":"이 판 구성","v":"10종 × 20장 = 200장"},{"k":"주요 크기","v":"MASTERLISE 약 13~25cm"}],"lineup":["A상 손오공 MASTERLISE (약 20cm)","B상 초사이어인 손오반 MASTERLISE (약 19cm)","C상 손오천 MASTERLISE (약 13cm)","D상 바닥 MASTERLISE (약 25cm)","E상 라디츠 MASTERLISE (약 25cm)","F상 피규어 마그넷 (약 5cm / 전 3종)","G상 파우치 (약 13cm / 전 7종)","H상 아크릴 스탠드 (약 7~10cm / 전 9종)","I상 고무 어소트 (약 5.5~6.5cm / 전 7종)","J상 다이컷 타월 (약 24cm / 전 9종)","라스트원상 손오공&손오반 MASTERLISE PLUS (약 21cm)"],"notes":["이 판은 실제 세트의 A~J상 10종을 등급별로 나눠 종류마다 20장씩, 총 200장으로 구성했습니다. F~J상은 각 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.","피규어는 공장 조립·도색 상태에 따라 개체 차이가 있을 수 있습니다."]}$json$::jsonb;

  delete from public.tickets where board_id = v_id;
  delete from public.boards  where id = v_id or title = v_title;

  insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                             last_one_label, last_one_image, last_one_desc, manual,
                             status, seed, seed_hash)
  values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
          v_lo, v_lo_img, v_lo_desc, v_manual,
          'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, v_count) as g(n);

  v_id := '0d1a5e00-0002-4a00-9000-000000000002';
  v_seed := 'shibamaruya-hunter-chimera-ant-180-20261124';
  v_title := '[헌터×헌터] 키메라 앤트 ② 쿠지';
  v_cat := '헌터×헌터';
  v_cover := 'assets/products/hunter-chimera-ant/cover.jpg';
  v_price := 12000;
  v_count := 180;
  v_lo := '라스트원상 · 곤 ~성장ver.~ MASTERLISE EXTRA';
  v_lo_img := 'assets/products/hunter-chimera-ant/last_one.jpg';
  v_lo_desc := '약 100cm · 성장한 곤의 초대형 피규어';
  v_tiers := $json$[{"grade":"A","label":"메르엠 MASTERLISE","count":1,"points":40000,"image":"assets/products/hunter-chimera-ant/tier_a.jpg","desc":"약 23cm · 개미의 왕, 압도적인 조형"},{"grade":"B","label":"네테로 MASTERLISE","count":2,"points":22000,"image":"assets/products/hunter-chimera-ant/tier_b.jpg","desc":"약 22cm · 감사의 정권찌르기 장면"},{"grade":"C","label":"곤 MASTERLISE","count":3,"points":14000,"image":"assets/products/hunter-chimera-ant/tier_c.jpg","desc":"약 10cm · 네페르피토와 대치한 순간"},{"grade":"D","label":"키르아 MASTERLISE","count":4,"points":16000,"image":"assets/products/hunter-chimera-ant/tier_d.jpg","desc":"약 21cm · 전격의 순간"},{"grade":"E","label":"네페르피토 MASTERLISE","count":4,"points":16000,"image":"assets/products/hunter-chimera-ant/tier_e.jpg","desc":"약 24cm · 왕의 근위대"},{"grade":"F","label":"샤우아푸프 · 몬투투유피 MASTERLISE","count":6,"points":12000,"image":"assets/products/hunter-chimera-ant/tier_f.jpg","desc":"약 6~7cm · 전 2종 중 1종 랜덤"},{"grade":"G","label":"고무 컬렉션","count":30,"points":5000,"image":"assets/products/hunter-chimera-ant/tier_g.jpg","desc":"약 8~19cm · 전 10종 중 1종 랜덤"},{"grade":"H","label":"문구 어소트","count":55,"points":4000,"image":"assets/products/hunter-chimera-ant/tier_h.jpg","desc":"A4 클리어파일·A6 노트 / 전 10종 중 1종"},{"grade":"I","label":"폰탭 · 넥스트랩 · 스티커","count":75,"points":3000,"image":"assets/products/hunter-chimera-ant/tier_i.jpg","desc":"약 5~47cm · 전 10종 중 1종 랜덤"}]$json$::jsonb;
  v_manual := $json${"summary":"키메라 앤트 편을 테마로 한 재판매 세트입니다. A~F상이 전부 MASTERLISE 피규어이고, 라스트원상은 약 1m 크기의 성장한 곤입니다.","specs":[{"k":"시리즈","v":"헌터×헌터 키메라 앤트 편"},{"k":"제조사","v":"반다이 스피리츠"},{"k":"일본 발매","v":"2026.11.14 (재판)"},{"k":"일본 판매가","v":"1회 790엔 (세금 포함)"},{"k":"세트 구성","v":"A~I상 9종 + 라스트원상 · 총 10종"},{"k":"이 판 구성","v":"9종 × 20장 = 180장"},{"k":"주요 크기","v":"MASTERLISE 약 6~24cm · 라스트원 약 100cm"}],"lineup":["A상 메르엠 MASTERLISE (약 23cm)","B상 네테로 MASTERLISE (약 22cm)","C상 곤 MASTERLISE (약 10cm)","D상 키르아 MASTERLISE (약 21cm)","E상 네페르피토 MASTERLISE (약 24cm)","F상 샤우아푸프/몬투투유피 MASTERLISE (약 6~7cm / 전 2종)","G상 고무 컬렉션 (약 8~19cm / 전 10종)","H상 문구 어소트 (A4 클리어파일·A6 노트 / 전 10종)","I상 폰탭·넥스트랩·스티커 어소트 (약 5~47cm / 전 10종)","라스트원상 곤 ~성장ver.~ MASTERLISE EXTRA (약 100cm)"],"notes":["이 판은 실제 세트의 A~I상 9종을 등급별로 나눠 종류마다 20장씩, 총 180장으로 구성했습니다. F~I상은 각 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.","라스트원상은 약 100cm 대형 피규어로, 일반 상품과 별도 박스로 발송됩니다."]}$json$::jsonb;

  delete from public.tickets where board_id = v_id;
  delete from public.boards  where id = v_id or title = v_title;

  insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                             last_one_label, last_one_image, last_one_desc, manual,
                             status, seed, seed_hash)
  values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
          v_lo, v_lo_img, v_lo_desc, v_manual,
          'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, v_count) as g(n);

  v_id := '0d1a5e00-0003-4a00-9000-000000000003';
  v_seed := 'shibamaruya-jojo-rivals-240-20261124';
  v_title := '[죠죠] The Gathering of RIVALS 쿠지';
  v_cat := '죠죠의 기묘한 모험';
  v_cover := 'assets/products/jojo-rivals/cover.jpg';
  v_price := 13000;
  v_count := 240;
  v_lo := '라스트원상 · 디에고 브란도 MASTERLISE';
  v_lo_img := 'assets/products/jojo-rivals/last_one.jpg';
  v_lo_desc := '약 15cm · 7부 스틸 볼 런의 디에고';
  v_tiers := $json$[{"grade":"A","label":"디오 브란도 MASTERLISE PLUS","count":1,"points":32000,"image":"assets/products/jojo-rivals/tier_a.jpg","desc":"약 18cm · 1부 팬텀 블러드의 디오"},{"grade":"B","label":"카즈 MASTERLISE","count":2,"points":24000,"image":"assets/products/jojo-rivals/tier_b.jpg","desc":"약 25cm · 2부 전투조류의 카즈"},{"grade":"C","label":"DIO MASTERLISE","count":2,"points":24000,"image":"assets/products/jojo-rivals/tier_c.jpg","desc":"약 26cm · 3부 스타더스트 크루세이더스의 DIO"},{"grade":"D","label":"카와지리 하지메 MASTERLISE","count":3,"points":18000,"image":"assets/products/jojo-rivals/tier_d.jpg","desc":"약 24cm · 4부 다이아몬드는 부서지지 않는다"},{"grade":"E","label":"디아볼로 MASTERLISE","count":3,"points":18000,"image":"assets/products/jojo-rivals/tier_e.jpg","desc":"약 25cm · 5부 황금의 바람"},{"grade":"F","label":"엔리코 P MASTERLISE","count":4,"points":18000,"image":"assets/products/jojo-rivals/tier_f.jpg","desc":"약 22cm · 6부 스톤 오션"},{"grade":"G","label":"스탠드의 화살 MASTERELIVE COLLECTION","count":6,"points":16000,"image":"assets/products/jojo-rivals/tier_g.jpg","desc":"약 21cm · 스탠드를 각성시키는 화살"},{"grade":"H","label":"LOGO de Collection","count":15,"points":9000,"image":"assets/products/jojo-rivals/tier_h.jpg","desc":"약 9~10cm · 전 7종 중 1종 랜덤"},{"grade":"I","label":"미니어처 참","count":20,"points":7000,"image":"assets/products/jojo-rivals/tier_i.jpg","desc":"약 2.5~4.5cm · 전 7종 중 1종 랜덤"},{"grade":"J","label":"고무 어소트","count":30,"points":5000,"image":"assets/products/jojo-rivals/tier_j.jpg","desc":"약 4~12cm · 전 7종 중 1종 랜덤"},{"grade":"K","label":"클리어 포스터","count":60,"points":4000,"image":"assets/products/jojo-rivals/tier_k.jpg","desc":"A3 · 전 8종 중 1종 랜덤"},{"grade":"L","label":"스티커 컬렉션","count":94,"points":3000,"image":"assets/products/jojo-rivals/tier_l.jpg","desc":"약 6~14cm · 전 13종 중 1종 랜덤"}]$json$::jsonb;
  v_manual := $json${"summary":"시리즈 역대 숙적들이 MASTERLISE로 모인 세트입니다. A~F상은 18~26cm 피규어, G상은 스탠드의 화살, H~L상은 로고 피규어·참·고무·포스터·스티커입니다.","specs":[{"k":"시리즈","v":"죠죠의 기묘한 모험"},{"k":"제조사","v":"반다이 스피리츠"},{"k":"일본 발매","v":"2026.11.21"},{"k":"일본 판매가","v":"1회 850엔 (세금 포함)"},{"k":"세트 구성","v":"A~L상 12종 + 라스트원상 · 총 13종"},{"k":"이 판 구성","v":"12종 × 20장 = 240장"},{"k":"주요 크기","v":"MASTERLISE 약 18~26cm"}],"lineup":["A상 디오 브란도 MASTERLISE PLUS (약 18cm)","B상 카즈 MASTERLISE (약 25cm)","C상 DIO MASTERLISE (약 26cm)","D상 카와지리 하지메 MASTERLISE (약 24cm)","E상 디아볼로 MASTERLISE (약 25cm)","F상 엔리코 P MASTERLISE (약 22cm)","G상 스탠드의 화살 MASTERELIVE COLLECTION (약 21cm)","H상 죠죠의 기묘한 모험 LOGO de Collection (약 9~10cm / 전 7종)","I상 미니어처 참 (약 2.5~4.5cm / 전 7종)","J상 고무 어소트 (약 4~12cm / 전 7종)","K상 클리어 포스터 (A3 / 전 8종)","L상 스티커 컬렉션 (약 6~14cm / 전 13종)","라스트원상 디에고 브란도 MASTERLISE (약 15cm)"],"notes":["이 판은 실제 세트의 A~L상 12종을 등급별로 나눠 종류마다 20장씩, 총 240장으로 구성했습니다. H~L상은 각 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.","클리어 포스터는 A3 크기로, 배송 시 접히지 않도록 원통 포장됩니다."]}$json$::jsonb;

  delete from public.tickets where board_id = v_id;
  delete from public.boards  where id = v_id or title = v_title;

  insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                             last_one_label, last_one_image, last_one_desc, manual,
                             status, seed, seed_hash)
  values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
          v_lo, v_lo_img, v_lo_desc, v_manual,
          'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, v_count) as g(n);

  v_id := '0d1a5e00-0004-4a00-9000-000000000004';
  v_seed := 'shibamaruya-apothecary-secret-160-20261124';
  v_title := '[약사의 혼잣말] 극장판 망비의 비보 쿠지';
  v_cat := '약사의 혼잣말';
  v_cover := 'assets/products/apothecary-secret/cover.jpg';
  v_price := 12000;
  v_count := 160;
  v_lo := '라스트원상 · 마오마오 피규어';
  v_lo_img := 'assets/products/apothecary-secret/last_one.jpg';
  v_lo_desc := '약 18cm · 꽃이 핀 받침대 위의 마오마오';
  v_tiers := $json$[{"grade":"A","label":"마오마오 Dioramiquemaster","count":1,"points":30000,"image":"assets/products/apothecary-secret/tier_a.jpg","desc":"약 15cm · 극장판 의상의 디오라마 피규어"},{"grade":"B","label":"진시 Dioramiquemaster","count":2,"points":20000,"image":"assets/products/apothecary-secret/tier_b.jpg","desc":"약 16cm · 극장판 의상의 디오라마 피규어"},{"grade":"C","label":"빅 아크릴 스탠드","count":4,"points":9000,"image":"assets/products/apothecary-secret/tier_c.jpg","desc":"약 16cm · 마오마오 & 진시 일러스트"},{"grade":"D","label":"키라라이즈 마스코트","count":8,"points":7000,"image":"assets/products/apothecary-secret/tier_d.jpg","desc":"약 10cm · 전 2종 중 1종 랜덤"},{"grade":"E","label":"메탈 참","count":15,"points":6000,"image":"assets/products/apothecary-secret/tier_e.jpg","desc":"약 5cm · 전 5종 중 1종 랜덤"},{"grade":"F","label":"고무 컬렉션","count":30,"points":4000,"image":"assets/products/apothecary-secret/tier_f.jpg","desc":"약 6~10cm · 전 5종 중 1종 랜덤"},{"grade":"G","label":"아크릴 스탠드","count":45,"points":3500,"image":"assets/products/apothecary-secret/tier_g.jpg","desc":"약 6.5~8cm · 전 5종 중 1종 랜덤"},{"grade":"H","label":"미니 색지","count":55,"points":3000,"image":"assets/products/apothecary-secret/tier_h.jpg","desc":"약 13cm · 전 5종 중 1종 랜덤"}]$json$::jsonb;
  v_manual := $json${"summary":"극장판 약사의 혼잣말 첫 이치방쿠지입니다. 신브랜드 Dioramiquemaster의 마오마오·진시 피규어와 극장판 의상 일러스트 굿즈로 구성됩니다.","specs":[{"k":"시리즈","v":"극장판 약사의 혼잣말"},{"k":"제조사","v":"반다이 스피리츠"},{"k":"일본 발매","v":"2026.12.05"},{"k":"일본 판매가","v":"1회 800엔 (세금 포함)"},{"k":"세트 구성","v":"A~H상 8종 + 라스트원상 · 총 9종"},{"k":"이 판 구성","v":"8종 × 20장 = 160장"},{"k":"주요 크기","v":"Dioramiquemaster 약 15~16cm"}],"lineup":["A상 마오마오 Dioramiquemaster (약 15cm)","B상 진시 Dioramiquemaster (약 16cm)","C상 빅 아크릴 스탠드 (약 16cm)","D상 키라라이즈 마스코트 (약 10cm / 전 2종)","E상 메탈 참 (약 5cm / 전 5종)","F상 고무 컬렉션 (약 6~10cm / 전 5종)","G상 아크릴 스탠드 (약 6.5~8cm / 전 5종)","H상 미니 색지 (약 13cm / 전 5종)","라스트원상 마오마오 피규어 (약 18cm)"],"notes":["이 판은 실제 세트의 A~H상 8종을 등급별로 나눠 종류마다 20장씩, 총 160장으로 구성했습니다. D~H상은 각 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.","일본 발매가 2026년 12월 5일인 신작으로, 이 판은 입고분에 한해 순차 발송됩니다."]}$json$::jsonb;

  delete from public.tickets where board_id = v_id;
  delete from public.boards  where id = v_id or title = v_title;

  insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                             last_one_label, last_one_image, last_one_desc, manual,
                             status, seed, seed_hash)
  values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
          v_lo, v_lo_img, v_lo_desc, v_manual,
          'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));

  insert into public.tickets (board_id, n, status)
  select v_id, g.n, 'available' from generate_series(1, v_count) as g(n);
end;
$$;

-- 3-1) 결과 확인 ---------------------------------------------------------
select b.title, b.category, b.price, b.ticket_count,
       jsonb_array_length(b.tiers) as tier_count,
       (select coalesce(sum((t.tier->>'count')::int), 0) from jsonb_array_elements(b.tiers) as t(tier)) as tier_sum,
       (select count(*) from public.tickets k where k.board_id = b.id) as tickets,
       (b.manual->'specs'->0->>'v') as series
from public.boards b
where b.id in ('0d1a5e00-0001-4a00-9000-000000000001',
               '0d1a5e00-0002-4a00-9000-000000000002',
               '0d1a5e00-0003-4a00-9000-000000000003',
               '0d1a5e00-0004-4a00-9000-000000000004')
order by b.id;

-- ---------------------------------------------------------
-- (선택) 예전 데모 판 정리 — 필요할 때만 주석을 풀고 실행하세요.
--  판매 기록이 없는 판만 삭제하고, 기록이 있으면 종료 상태로 바꿉니다.
-- ---------------------------------------------------------
-- delete from public.boards b
--  where b.title in ('[원피스] 루피 기어5 피규어 쿠지',
--                    '[산리오] 마이멜로디 & 쿠로미 스위트 쿠지',
--                    '[귀멸의 칼날] 탄지로 히노카미 피규어 쿠지')
--    and not exists (select 1 from public.tickets t where t.board_id = b.id and t.status = 'sold');
-- update public.boards set status = 'closed'
--  where title in ('[원피스] 루피 기어5 피규어 쿠지',
--                  '[산리오] 마이멜로디 & 쿠로미 스위트 쿠지',
--                  '[귀멸의 칼날] 탄지로 히노카미 피규어 쿠지');
