-- ============================================================
-- 쿠지킹 v4.3.9 — 크리스마스 판 오픈 이벤트 9,900원 + P상 = 1장 가격의 10%
-- ------------------------------------------------------------
--   Supabase Dashboard → SQL Editor 에 이 파일 전체를 붙여넣고 [Run] 한 번 실행하세요.
--
--   · 여러 번 실행해도 안전합니다. (같은 값을 다시 넣을 뿐, 판매 기록·번호표는 건드리지 않음)
--   · 지금 라이브 두 판의 실제 스키마 기준입니다.
--       boards.price      integer  → 1장 가격(원)
--       boards.tiers      jsonb    → [{grade,label,count,points,pointOnly,image,desc}]  ← P상 포인트는 여기 points
--       boards.manual     jsonb    → {summary, specs:[{k,v}], lineup:[], notes:[], image}
--       app_settings      (key text primary key, value text)
--     * point_reward / board_point_reward 같은 별도 컬럼은 없습니다. P상 포인트는 tiers JSON 안의 points 하나뿐입니다.
--     * 서버 뽑기(draw_ticket)와 포인트 전환(convert_to_points)도 이 tiers.points 를 그대로 읽습니다.
--
--   이 SQL 이 하는 일
--     [1] 크리스마스 판([치이카와] 크리스마스 쿠지 이벤트) 1장 가격 15,500원 → 9,900원
--     [2] 모든 판의 P상 포인트를 "1장 가격의 10%" 로 다시 계산
--         크리스마스 9,900원 → 990P · 갸루 15,500원 → 1,550P (예전 고정값 1,200P 제거)
--     [3] 상품 설명서(manual)의 '1장 가격' 사양과 P상 안내 문구를 같은 값으로 맞춤
--     [4] app_settings.board_events — 홈 카드·판 상세의 "오픈 이벤트" 배지/정가 표시용 설정
--     [5] 실행 결과 확인용 SELECT
--
--   바꾸지 않는 것
--     · 번호표(tickets)·뽑기 내역(draws)·회원 포인트(profiles.points)·시드/봉인 해시
--     · 굿즈샵 가격(goods_items.points) — 우사기 40만P · 하치와레 25만P · 치이카와/몽몽가 20만P 그대로
-- ============================================================


-- ------------------------------------------------------------
-- [1~4] 한 트랜잭션으로 처리 (중간에 실패하면 전부 되돌립니다)
-- ------------------------------------------------------------
begin;

do $$
declare
  v_xmas       uuid;
  v_old_price  integer;
  v_board      record;
  v_price      integer;
  v_reward     integer;
  v_tiers      jsonb;
  v_manual     jsonb;
  v_specs      jsonb;
  v_notes      jsonb;
  v_point_desc text;
  v_count      integer := 0;
begin
  -- ---------- 대상 판 찾기: id 우선, 없으면 제목으로 ----------
  select id into v_xmas
    from public.boards
   where id = '2deaf258-1531-4c44-ba28-922c8a1fd1ba'
   limit 1;

  if v_xmas is null then
    select id into v_xmas
      from public.boards
     where title = '[치이카와] 크리스마스 쿠지 이벤트'
     order by created_at
     limit 1;
  end if;

  -- ---------- [1] 크리스마스 판 1장 가격 9,900원 ----------
  if v_xmas is null then
    raise notice '[1] 크리스마스 판을 찾지 못했습니다. 판 id/제목을 확인해 주세요. (P상 10%% 계산은 그대로 진행)';
  else
    select price into v_old_price from public.boards where id = v_xmas;
    update public.boards
       set price = 9900
     where id = v_xmas
       and price is distinct from 9900;
    raise notice '[1] 크리스마스 판(%) 1장 가격 %원 → 9,900원', v_xmas, v_old_price;
  end if;

  -- ---------- [2] 모든 판의 P상 포인트 = 1장 가격의 10% ----------
  for v_board in
    select id, title, price, tiers, manual
      from public.boards
     where tiers is not null
  loop
    v_price  := greatest(0, coalesce(v_board.price, 0));
    v_reward := round(v_price * 0.1)::int;          -- 9,900 → 990 · 15,500 → 1,550 · 12,000 → 1,200
    v_point_desc := '실물 대신 굿즈 포인트 ' || to_char(v_reward, 'FM999,999,999') || 'P 바로 적립 · 굿즈샵에서 원하는 굿즈로 교환';

    -- P상 등급이 없는 판은 건드리지 않는다
    if not exists (
      select 1
        from jsonb_array_elements(v_board.tiers) as t(tier)
       where upper(coalesce(t.tier->>'grade', '')) = 'P'
          or coalesce((t.tier->>'pointOnly')::boolean, false)
    ) then
      continue;
    end if;

    select jsonb_agg(
             case
               when upper(coalesce(t.tier->>'grade', '')) = 'P'
                 or coalesce((t.tier->>'pointOnly')::boolean, false)
               then t.tier || jsonb_build_object(
                      'points', v_reward,
                      'label',  '굿즈 포인트 ' || to_char(v_reward, 'FM999,999,999') || 'P',
                      'desc',   v_point_desc)
               else t.tier
             end
             order by t.ord)
      into v_tiers
      from jsonb_array_elements(v_board.tiers) with ordinality as t(tier, ord);

    -- ---------- [3] 상품 설명서의 가격·P상 문구도 같은 값으로 ----------
    v_manual := v_board.manual;
    if v_manual is not null and jsonb_typeof(v_manual) = 'object' then
      -- 사양: "1장 가격: 9,900원"
      if jsonb_typeof(v_manual->'specs') = 'array' then
        select coalesce(jsonb_agg(
                 case
                   when trim(coalesce(s.spec->>'k', '')) in ('1장 가격', '가격')
                   then jsonb_set(s.spec, '{v}', to_jsonb(to_char(v_price, 'FM999,999,999') || '원'), true)
                   else s.spec
                 end
                 order by s.ord), '[]'::jsonb)
          into v_specs
          from jsonb_array_elements(v_manual->'specs') with ordinality as s(spec, ord);
        v_manual := jsonb_set(v_manual, '{specs}', v_specs, true);
      end if;

      -- 유의사항: P상 안내 문구의 포인트 숫자만 10% 값으로 (문장은 그대로)
      if jsonb_typeof(v_manual->'notes') = 'array' then
        select coalesce(jsonb_agg(
                 case
                   when n.item like '%P상%'
                     and (n.item like '%한 판 무료%'
                       or n.item like '%한 판을 한 번 더%'
                       or n.item like '%P를 모으면%')
                   then to_jsonb('P상은 실물 대신 굿즈 포인트 ' || to_char(v_reward, 'FM999,999,999')
                                 || 'P가 즉시 적립됩니다. 모은 포인트는 굿즈샵에서 원하는 굿즈로 교환할 수 있어요.')
                   when n.item like '%P상%'
                   then to_jsonb(regexp_replace(n.item, '[0-9][0-9,]*\s*P', to_char(v_reward, 'FM999,999,999') || 'P', 'g'))
                   else to_jsonb(n.item)
                 end
                 order by n.ord), '[]'::jsonb)
          into v_notes
          from jsonb_array_elements(v_manual->'notes') with ordinality as n(item, ord);
        v_manual := jsonb_set(v_manual, '{notes}', v_notes, true);
      end if;
    end if;

    update public.boards
       set tiers  = v_tiers,
           manual = coalesce(v_manual, manual)
     where id = v_board.id;

    v_count := v_count + 1;
    raise notice '[2] % — 1장 %원 → P상 %P 로 맞췄습니다.', v_board.title, v_price, v_reward;
  end loop;

  raise notice '[2] P상 포인트를 다시 계산한 판: %개', v_count;

  -- ---------- [4] 오픈 이벤트 표시용 설정 (홈 카드·판 상세 배지) ----------
  if v_xmas is not null then
    insert into public.app_settings (key, value)
    values ('board_events',
            jsonb_build_object(
              v_xmas::text,
              jsonb_build_object(
                'label', '오픈 이벤트',
                'origPrice', 15500,
                'note', '크리스마스 한정 특가 · 1장 9,900원'
              )
            )::text)
    on conflict (key) do update
      set value = (
            case
              when public.app_settings.value ~ '^\s*\{'
              then public.app_settings.value::jsonb
              else '{}'::jsonb
            end
            || excluded.value::jsonb
          )::text;
    raise notice '[4] app_settings.board_events 에 크리스마스 판 오픈 이벤트 표기를 넣었습니다.';
  end if;
end;
$$;

commit;


-- ============================================================
-- [5] 실행 결과 확인 — 아래 표가 그대로 보이면 정상입니다.
--     · price_krw        : 크리스마스 9900 / 갸루 15500
--     · p_points         : 크리스마스 990  / 갸루 1550
--     · spec_price       : 상품 설명서 '1장 가격' (예: 9,900원)
--     · manual 에 1,200P 가 남아 있으면 notes_p1200 값이 0 이어야 합니다.
-- ============================================================
select b.title,
       b.price                                   as price_krw,
       (select (t.tier->>'points')::int
          from jsonb_array_elements(b.tiers) as t(tier)
         where upper(coalesce(t.tier->>'grade','')) = 'P'
            or coalesce((t.tier->>'pointOnly')::boolean,false)
         limit 1)                                as p_points,
       (select t.tier->>'label'
          from jsonb_array_elements(b.tiers) as t(tier)
         where upper(coalesce(t.tier->>'grade','')) = 'P'
            or coalesce((t.tier->>'pointOnly')::boolean,false)
         limit 1)                                as p_label,
       (select s.spec->>'v'
          from jsonb_array_elements(coalesce(b.manual->'specs','[]'::jsonb)) as s(spec)
         where trim(coalesce(s.spec->>'k','')) = '1장 가격'
         limit 1)                                as spec_price,
       (select count(*)
          from jsonb_array_elements_text(coalesce(b.manual->'notes','[]'::jsonb)) as n(txt)
         where n.txt like '%1,200P%')            as notes_p1200,
       b.status,
       b.ticket_count
  from public.boards b
 order by b.created_at desc;

-- 오픈 이벤트 설정(배지) 확인 — board_events 안에 크리스마스 판 id 가 보이면 정상
select key, value from public.app_settings where key = 'board_events';


-- ============================================================
-- 되돌리기(원복) — 이벤트를 끝내고 정가로 돌릴 때만 실행하세요.
--   1) 가격·P상은 사이트 관리자 [판 수정]에서 1장 가격을 15,500원으로 바꾸면
--      P상 포인트(1,550P)는 화면이 자동으로 다시 계산합니다.
--      DB 까지 한 번에 되돌리려면 아래를 실행하세요.
--
--   begin;
--     update public.boards
--        set price = 15500
--      where id = '2deaf258-1531-4c44-ba28-922c8a1fd1ba';
--
--     update public.boards b
--        set tiers = (
--              select jsonb_agg(
--                       case when upper(coalesce(t.tier->>'grade','')) = 'P'
--                                 or coalesce((t.tier->>'pointOnly')::boolean,false)
--                            then t.tier || jsonb_build_object(
--                                   'points', round(b.price*0.1)::int,
--                                   'label', '굿즈 포인트 ' || to_char(round(b.price*0.1)::int,'FM999,999,999') || 'P')
--                            else t.tier end
--                       order by t.ord)
--                from jsonb_array_elements(b.tiers) with ordinality as t(tier, ord))
--      where b.id = '2deaf258-1531-4c44-ba28-922c8a1fd1ba';
--
--     -- 배지·정가 표기를 지운다
--     update public.app_settings
--        set value = (value::jsonb - '2deaf258-1531-4c44-ba28-922c8a1fd1ba')::text
--      where key = 'board_events';
--   commit;
-- ============================================================
