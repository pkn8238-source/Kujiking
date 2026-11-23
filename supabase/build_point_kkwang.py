#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
쿠지킹 P상(포인트 꽝) 업그레이드 SQL 생성기 — v3.7
· supabase/seed_shibamaruya_20.sql 의 4판 데이터를 읽어
  실물 등급 각 1개 + P상(굿즈 포인트 1,200P) 구성으로 다시 만든다.
· 결과: supabase/upgrade_point_kkwang.sql / .txt (같은 내용)
"""
import json
import re
import pathlib

BASE = pathlib.Path(__file__).resolve().parent
SRC = BASE / "seed_shibamaruya_20.sql"
OUT_SQL = BASE / "upgrade_point_kkwang.sql"
OUT_TXT = BASE / "kujiking_point_kkwang.txt"

P_POINTS = 1200
P_LABEL = "굿즈 포인트 1,200P"
P_DESC = "실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료"

src = SRC.read_text(encoding="utf-8")

def grab(name, text):
    m = re.search(r"v_%s\s*:=\s*(.+?);\n" % name, text, re.S)
    if not m:
        raise SystemExit("missing v_%s" % name)
    return m.group(1).strip()

blocks = []
for m in re.finditer(r"v_id := '([^']+)';(.*?)(?=  insert into public\.tickets \(board_id, n, status\))", src, re.S):
    body = m.group(0)
    board = {
        "id": m.group(1),
        "seed": grab("seed", body).strip("'"),
        "title": grab("title", body).strip("'"),
        "cat": grab("cat", body).strip("'"),
        "cover": grab("cover", body).strip("'"),
        "price": int(grab("price", body)),
        "count": int(grab("count", body)),
        "lo": grab("lo", body).strip("'"),
        "lo_img": grab("lo_img", body).strip("'"),
        "lo_desc": grab("lo_desc", body).strip("'"),
    }
    mt = re.search(r"v_tiers\s*:=\s*\$json\$(.*?)\$json\$::jsonb;", body, re.S)
    mm = re.search(r"v_manual\s*:=\s*\$json\$(.*?)\$json\$::jsonb;", body, re.S)
    board["tiers"] = json.loads(mt.group(1))
    board["manual"] = json.loads(mm.group(1))
    blocks.append(board)

if len(blocks) != 4:
    raise SystemExit("expected 4 boards, got %d" % len(blocks))

for b in blocks:
    phys = b["tiers"]
    for t in phys:
        t["count"] = 1
    n_phys = len(phys)
    p_count = b["count"] - n_phys
    assert p_count > 0, b["title"]
    phys.append({
        "grade": "P", "label": P_LABEL, "count": p_count,
        "points": P_POINTS, "pointOnly": True, "desc": P_DESC,
    })
    b["price"] = 12000
    # 설명서 갱신
    specs = b["manual"].get("specs", [])
    for s in specs:
        if s.get("k") == "이 판 구성":
            s["v"] = "실물 %d종 각 1개 + P상 %d장 = %d장" % (n_phys, p_count, b["count"])
    notes = b["manual"].get("notes", [])
    first = notes[0] if notes else ""
    old_note = re.sub(r"이 판은 실제 세트의 .*?구성했습니다\.", "", first).strip()
    notes = [n for n in notes]
    new_note = ("이 판은 실제 세트의 %s~%s상 %d종을 등급별로 각 1개씩(실물 %d개) 두고, 나머지 %d장을 P상(굿즈 포인트 1,200P)으로 채운 총 %d장입니다. "
                "실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다."
                % (phys[0]["grade"], phys[n_phys - 1]["grade"], n_phys, n_phys, p_count, b["count"]))
    p_note = "P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요."
    rest = [n for n in notes[1:] if "P상은" not in n]
    b["manual"]["notes"] = [new_note, p_note] + rest

def j(o):
    return json.dumps(o, ensure_ascii=False, separators=(",", ":"))

def q(s):
    return "'" + s.replace("'", "''") + "'"

header = """-- =========================================================
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
"""
for b in blocks:
    header += "--      · %-34s %5d원 %3d장 = 실물 %2d종 각 1개 + P상 %3d장\n" % (
        b["title"], b["price"], b["count"], len(b["tiers"]) - 1,
        [t for t in b["tiers"] if t["grade"] == "P"][0]["count"])
header += """-- =========================================================

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
"""

body = ""
for b in blocks:
    body += """
  -- ── %s ──────────────────────────────────────────────
  v_title   := %s;
  v_cat     := %s;
  v_cover   := %s;
  v_price   := %d;
  v_count   := %d;
  v_lo      := %s;
  v_lo_img  := %s;
  v_lo_desc := %s;
  v_tiers   := $json$%s$json$::jsonb;
  v_manual  := $json$%s$json$::jsonb;

  v_id := null;
  select id into v_id from public.boards where id = '%s' or title = v_title limit 1;
  if v_id is null then
    v_id := '%s';
    v_seed := %s;
    insert into public.boards (id, title, category, cover, price, ticket_count, tiers,
                               last_one_label, last_one_image, last_one_desc, manual,
                               status, seed, seed_hash)
    values (v_id, v_title, v_cat, v_cover, v_price, v_count, v_tiers,
            v_lo, v_lo_img, v_lo_desc, v_manual,
            'open', v_seed, encode(digest(v_seed, 'sha256'), 'hex'));
  else
    v_seed := %s;
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
""" % (b["title"], q(b["title"]), q(b["cat"]), q(b["cover"]), b["price"], b["count"],
       q(b["lo"]), q(b["lo_img"]), q(b["lo_desc"]), j(b["tiers"]), j(b["manual"]),
       b["id"], b["id"], q(b["seed"]), q(b["seed"]))

tail = """end;
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
where b.id in (%s)
order by b.price desc, b.title;
""" % ",\n               ".join(q(b["id"]) for b in blocks)

sql = header + body + tail
OUT_SQL.write_text(sql, encoding="utf-8")
OUT_TXT.write_text(sql, encoding="utf-8")
print("wrote", OUT_SQL)
print("wrote", OUT_TXT, len(sql), "bytes")
for b in blocks:
    p = [t for t in b["tiers"] if t["grade"] == "P"][0]["count"]
    print("  %-34s price=%d tickets=%d physical=%d P=%d" % (b["title"], b["price"], b["count"], len(b["tiers"]) - 1, p))
