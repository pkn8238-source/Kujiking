-- ============================================================
-- 쿠지킹 v4.4.0 — P상 표기·그림을 1장 가격의 10%로 마저 맞추기
--   (크리스마스 판 990P / 갸루 판 1,550P · 포인트 카드 그림 p9900.jpg)
-- ------------------------------------------------------------
--   Supabase Dashboard → SQL Editor 에 이 파일 전체를 붙여넣고 [Run] 한 번 실행하세요.
--
--   · 여러 번 실행해도 안전합니다. (같은 값을 다시 넣을 뿐, 판매 기록·번호표·회원 포인트는 건드리지 않음)
--   · v4.3.9 오픈이벤트 SQL(kujiking_open_event_9900_10pct)을 이미 실행하셨든 안 하셨든
--     이 파일 하나만 실행하면 지금 상태에서 필요한 값이 모두 맞습니다.
--
--   이 SQL 이 하는 일
--     [1] 모든 판의 P상(tiers 안 P 등급) — points·label·desc·image 를 "1장 가격의 10%"로 통일
--           · 크리스마스 9,900원 → 990P · 그림 assets/products/point/p9900.jpg
--           · 갸루     15,500원 → 1,550P · 그림 assets/products/point/p15500.jpg
--           · 그 밖의 가격 → 10% 포인트 · 그림 assets/products/point/p.jpg (숫자 없는 기본 카드)
--     [2] 상품 설명서(manual)의 '1장 가격' 사양을 실제 가격으로 (크리스마스 15,500원 → 9,900원)
--     [3] 상품 설명서 유의사항의 P상 안내 문구 숫자를 10% 값으로 (크리스마스 1,550P → 990P,
--         갸루 1,200P → 1,550P)
--     [4] app_settings.board_events — 홈 카드·판 상세의 '오픈 이벤트' 배지 + 정가 취소선 표시
--         (없으면 배지가 아예 안 뜹니다. 크리스마스 판만 넣습니다)
--     [5] 실행 결과 확인용 SELECT
--
--   바꾸지 않는 것
--     · 번호표(tickets)·뽑기 내역(draws)·회원 포인트(profiles.points)·시드/봉인 해시
--     · 판 장수·등급 구성(count), 라스트원, 커버·라인업 이미지
--     · 굿즈샵 가격(goods_items.points) — 우사기 40만P · 하치와레 25만P · 치이카와/몽몽가 20만P
-- ============================================================

begin;

do $$
declare
  v_board      record;
  v_xmas       uuid;
  v_price      integer;
  v_reward     integer;
  v_img        text;
  v_label      text;
  v_desc       text;
  v_note       text;
  v_tiers      jsonb;
  v_manual     jsonb;
  v_specs      jsonb;
  v_notes      jsonb;
  v_count      integer := 0;
begin
  -- ---------- 대상 판: id 우선, 없으면 제목 ----------
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

  -- ---------- [1~3] 모든 판의 P상 표기·그림·설명서를 10% 규칙으로 ----------
  for v_board in
    select id, title, price, tiers, manual
      from public.boards
     where tiers is not null
  loop
    -- P상 등급이 없는 판은 건드리지 않는다
    if not exists (
      select 1
        from jsonb_array_elements(v_board.tiers) as t(tier)
       where upper(coalesce(t.tier->>'grade', '')) = 'P'
          or coalesce((t.tier->>'pointOnly')::boolean, false)
    ) then
      continue;
    end if;

    v_price  := greatest(0, coalesce(v_board.price, 0));
    v_reward := round(v_price * 0.1)::int;
    v_img    := case
                  when v_reward = 990  then 'assets/products/point/p9900.jpg'
                  when v_reward = 1550 then 'assets/products/point/p15500.jpg'
                  else 'assets/products/point/p.jpg'
                end;
    v_label  := '굿즈 포인트 ' || to_char(v_reward, 'FM999,999,999') || 'P';
    v_desc   := '실물 대신 굿즈 포인트 ' || to_char(v_reward, 'FM999,999,999')
                || 'P 바로 적립 · 굿즈샵에서 원하는 굿즈로 교환';
    v_note   := 'P상은 실물 대신 굿즈 포인트 ' || to_char(v_reward, 'FM999,999,999')
                || 'P가 즉시 적립됩니다. 모은 포인트는 굿즈샵에서 교환할 수 있어요.';

    -- P 등급만 포인트·이름·설명·그림을 새 값으로 (다른 등급은 그대로)
    select jsonb_agg(
             case
               when upper(coalesce(t.tier->>'grade', '')) = 'P'
                 or coalesce((t.tier->>'pointOnly')::boolean, false)
               then t.tier || jsonb_build_object(
                      'points', v_reward,
                      'label',  v_label,
                      'desc',   v_desc,
                      'image',  v_img)
               else t.tier
             end
             order by t.ord)
      into v_tiers
      from jsonb_array_elements(v_board.tiers) with ordinality as t(tier, ord);

    -- 상품 설명서: '1장 가격' 사양 + P상 안내 문구
    v_manual := v_board.manual;
    if v_manual is not null and jsonb_typeof(v_manual) = 'object' then
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

      if jsonb_typeof(v_manual->'notes') = 'array' then
        select coalesce(jsonb_agg(
                 case
                   -- 옛 문구('한 판 무료'·'모으면 한 번 더')는 통째로 지금 안내로
                   when n.item like '%P상%'
                     and (n.item like '%한 판 무료%'
                       or n.item like '%한 판을 한 번 더%'
                       or n.item like '%P를 모으면%')
                   then to_jsonb(v_note)
                   -- 그 밖의 P상 안내는 숫자P 만 10% 값으로
                   when n.item like '%P상%'
                   then to_jsonb(regexp_replace(n.item, '[0-9][0-9,]*[[:space:]]*P',
                                                to_char(v_reward, 'FM999,999,999') || 'P', 'g'))
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
    raise notice '[1~3] % — 1장 %원 → P상 %P (%s)', v_board.title, v_price, v_reward, v_img;
  end loop;

  raise notice '[1~3] P상 표기를 맞춘 판: %개', v_count;

  -- ---------- [4] 오픈 이벤트 배지·정가 취소선 표시 ----------
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
end
$$;

commit;


-- ============================================================
-- [5] 실행 결과 확인 — 아래 표가 그대로 보이면 정상입니다.
--     · price_krw   : 크리스마스 9900 / 갸루 15500
--     · p_points    : 크리스마스 990  / 갸루 1550
--     · p_image     : 크리스마스 .../p9900.jpg / 갸루 .../p15500.jpg
--     · spec_price  : 크리스마스 9,900원 / 갸루 15,500원
--     · note_p       : 상품 설명서 P상 안내 문구 (크리스마스 990P / 갸루 1,550P)
--     · old_1200     : 0 이어야 합니다 (옛 고정값 1,200P 가 남아 있지 않음)
-- ============================================================
select b.title,
       b.price                                    as price_krw,
       (select (t.tier->>'points')::int
          from jsonb_array_elements(b.tiers) as t(tier)
         where upper(coalesce(t.tier->>'grade','')) = 'P'
            or coalesce((t.tier->>'pointOnly')::boolean,false)
         limit 1)                                 as p_points,
       (select t.tier->>'label'
          from jsonb_array_elements(b.tiers) as t(tier)
         where upper(coalesce(t.tier->>'grade','')) = 'P'
            or coalesce((t.tier->>'pointOnly')::boolean,false)
         limit 1)                                 as p_label,
       (select t.tier->>'image'
          from jsonb_array_elements(b.tiers) as t(tier)
         where upper(coalesce(t.tier->>'grade','')) = 'P'
            or coalesce((t.tier->>'pointOnly')::boolean,false)
         limit 1)                                 as p_image,
       (select s.spec->>'v'
          from jsonb_array_elements(coalesce(b.manual->'specs','[]'::jsonb)) as s(spec)
         where trim(coalesce(s.spec->>'k','')) = '1장 가격'
         limit 1)                                 as spec_price,
       (select n.txt
          from jsonb_array_elements_text(coalesce(b.manual->'notes','[]'::jsonb)) as n(txt)
         where n.txt like '%P상%'
         limit 1)                                 as note_p,
       (select count(*)
          from jsonb_array_elements_text(coalesce(b.manual->'notes','[]'::jsonb)) as n(txt)
         where n.txt like '%1,200P%')             as old_1200,
       b.status,
       b.ticket_count
  from public.boards b
 order by b.created_at desc;

-- 오픈 이벤트 설정(배지) 확인 — board_events 안에 크리스마스 판 id 가 보이면 정상
select key, value from public.app_settings where key = 'board_events';


-- ============================================================
-- 되돌리기(원복) — 이벤트를 끝내고 정가로 돌릴 때만 실행하세요.
--   begin;
--     update public.boards
--        set price = 15500
--      where id = '2deaf258-1531-4c44-ba28-922c8a1fd1ba';
--     -- P상은 1장 가격의 10% 규칙이라, 위에서 가격을 되돌린 뒤 아래를 한 번 실행하면 1,550P 로 다시 계산됩니다.
--     do $$
--     declare v_board record; v_reward integer; v_img text;
--     begin
--       for v_board in select id, price, tiers from public.boards where tiers is not null loop
--         v_reward := round(greatest(0, coalesce(v_board.price,0)) * 0.1)::int;
--         v_img := case when v_reward = 990 then 'assets/products/point/p9900.jpg'
--                       when v_reward = 1550 then 'assets/products/point/p15500.jpg'
--                       else 'assets/products/point/p.jpg' end;
--         update public.boards b
--            set tiers = (select jsonb_agg(case when upper(coalesce(t.tier->>'grade',''))='P'
--                                                or coalesce((t.tier->>'pointOnly')::boolean,false)
--                                            then t.tier || jsonb_build_object('points',v_reward,
--                                                   'label','굿즈 포인트 '||to_char(v_reward,'FM999,999,999')||'P',
--                                                   'image',v_img) else t.tier end order by t.ord)
--                           from jsonb_array_elements(b.tiers) with ordinality as t(tier,ord))
--          where b.id = v_board.id;
--       end loop;
--     end $$;
--     -- 배지·정가 표기를 지운다
--     update public.app_settings
--        set value = (value::jsonb - '2deaf258-1531-4c44-ba28-922c8a1fd1ba')::text
--      where key = 'board_events';
--   commit;
-- ============================================================
