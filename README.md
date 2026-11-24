# 쿠지킹 KUJIKING — v2

온라인 쿠지(이치방쿠지) 스토어 **kujiking.co.kr** 의 정적 사이트입니다.
빌드 도구 없이 HTML/CSS/JS 만으로 동작하고, GitHub Pages 에 그대로 올라갑니다.

- **지금 상태**: Supabase Project URL 이 비어 있어 **데모 모드**로 동작합니다.
  모든 데이터는 방문자 브라우저(localStorage)에만 저장됩니다.
- **서버 모드 전환**: `assets/config.js` 에 `SUPABASE_URL` 을 넣고 새로고침하면
  회원·쿠폰·판매 현황이 Supabase 에 저장되고 기기 간에 실시간으로 공유됩니다.

---

## 1. v2 에서 새로 생긴 것

### 회원 · 로그인
- 헤더 **로그인 / 회원가입** 모달 (이메일 + 비밀번호 + 닉네임 + 휴대폰 번호)
- 로그인 후 헤더에 닉네임, **보유 쿠폰(뽑기권) 수**, **굿즈 포인트** 표시
- 판매 내역에는 닉네임이 `박*남` 처럼 마스킹되어 공개됩니다.

### 피규어 종목·금액별 다중 판
- 카테고리 칩: `전체 · 원피스 · 귀멸의 칼날 · 산리오 · 치이카와 · 자체 스페셜`
- 금액 칩: `전체 금액 · 1만 원 이하 · 1만 원대 · 프리미엄`
- 정렬: 추천순 / 낮은 가격순 / 높은 가격순 / 마감 임박순 / 신규순
- 판마다 시리즈 실물 커버 이미지가 표시됩니다(원피스·귀멸의 칼날·산리오). 관리자 판 편집에서
  커버 이미지를 목록에서 고르거나 URL을 직접 넣을 수 있고, 비우면 카테고리 색상 커버가 나옵니다.
- 샘플 판 3개가 자동 생성됩니다.
  | 판 | 카테고리 | 1장 가격 | 장수 | 커버 |
  |---|---|---|---|---|
  | 루피 기어5 피규어 쿠지 | 원피스 | 12,000원 | 80장 | `assets/board_onepiece.jpg` |
  | 마이멜로디 & 쿠로미 스위트 쿠지 | 산리오 | 9,900원 | 70장 | `assets/board_sanrio.jpg` |
  | 탄지로 히노카미 피규어 쿠지 | 귀멸의 칼날 | 15,000원 | 60장 | `assets/board_kimetsu.jpg` |

### 실시간 판매 확인
- 판마다 **판매 완료 번호**가 등급 색으로 표시되고, 그 자리에 구매자(마스킹)·시각이 기록됩니다.
- 판 상세의 **실제 판매 내역** 탭에서 전체 판매 기록(시각·번호·구매자·등급·상품)을 볼 수 있습니다.
- 홈 상단에 방금 팔린 번호가 흐르는 **실시간 판매 티커**가 있습니다.
- Supabase 연결 시 `tickets` 테이블 Realtime 구독으로 다른 기기의 판매도 즉시 반영됩니다.
  (데모 모드에서도 같은 브라우저의 두 탭은 BroadcastChannel 로 동기화됩니다.)

### 쿠폰(뽑기권)으로 뽑기
- 번호를 고르면 **보유 쿠폰 1장** 또는 **1회용 교환 코드**로 뽑을 수 있습니다.
- 쿠폰은 `모든 판 사용` / `특정 판 전용` 두 종류. 전용 쿠폰을 먼저 사용합니다.
- 체험용 코드 `DEMO-KUJI` 는 결제 없이 뽑기를 체험할 때 씁니다.

### 내 보관함 (`#/my`)
- **내 쿠폰함**: 관리자가 구매확인 후 지급한 뽑기권 목록 (사용 가능 / 사용 완료)
- **내 보관함**: 당첨 상품이 `보관중` → `배송 신청`(받는 사람·연락처·주소) → `출고 완료`(운송장) 로 이어집니다.
  배송 대신 **굿즈 포인트 전환**도 가능합니다.
- **구매확인 요청**: 스마트스토어 주문번호 또는 입금 내역을 남기면 관리자 확인 후 쿠폰이 지급됩니다.
- **뽑기 기록**: 내가 뽑은 번호·등급·수령 상태

### 관리자 (`#/admin`)
- **회원 · 쿠폰**: 회원 검색(닉네임·이메일·전화), **구매확인 요청 승인 → 뽑기권 N장 즉시 지급**, 반려, 직접 지급
- **판 관리**: 새 판 만들기/수정 (카테고리·가격·등급·수량·포인트·라스트원상·시드)
- **배송 · 출고**: 회원의 배송 요청 확인 → 택배사·운송장 입력 → `출고 완료`
- **코드 발급**: 1회용 교환 코드 발급/복사/CSV, 폐기
- **설정 · 연결**: Supabase 연결 상태와 설치 안내, **유튜브 라이브 연결**, PIN 변경, 체험 코드 변경, JSON 백업/복원
  - 유튜브 라이브: 채널 주소나 `@핸들`을 넣으면 상단 **라이브** 버튼이 그 채널의 `/live` 화면으로 연결됩니다. 저장은 `app_settings`의 `youtube_live_url`·`youtube_live_enabled` 로 들어가 앱을 다시 올리지 않아도 모든 방문자에게 적용됩니다(관리자 계정 로그인 필요, 막히면 설정 카드의 SQL 안내 사용).
  - 주소를 넣기 전에는 버튼을 눌렀을 때 "현재 라이브 방송 준비 중" 안내가 뜨고, 상단 버튼 표시는 켜고 끌 수 있습니다.

---

## 2. 바로 체험하기

| 구분 | 값 |
|---|---|
| 체험 계정 | `demo@kujiking.co.kr` / `demo1234` (닉네임 쿠지러버, 쿠폰 3장, 보관함 2건) |
| 체험용 교환 코드 | `DEMO-KUJI` |
| 관리자 PIN (데모 모드) | `0000` |

로그인 모달의 **체험 계정으로 시작** 버튼으로도 들어갈 수 있습니다.

---

## 3. 파일 구성

```
index.html                 화면 (홈 / 뽑기판 / 내 보관함 / 당첨 내역 / 공정성 검증 / 관리자)
assets/styles.css          브랜드 스타일 (노랑·빨강·굵은 검정 테두리, 모바일 대응)
assets/app.js              앱 전체 로직 (라우팅, 상태, 렌더링, Supabase 어댑터)
assets/config.js           Supabase URL / Publishable(anon) 키 설정
supabase/schema.sql        Supabase 테이블·RLS·RPC 설치 스크립트
assets/board_*.png         판 커버 이미지 (원피스 / 귀멸의 칼날 / 산리오)
manifest.webmanifest, 404.html, CNAME
```

### 데이터 구조 (데모 모드 localStorage `kujiking.state.v2`)
`boards` · `users` · `coupons` · `draws` · `claims` · `deliveries` · `codes` · `settings`
v1(`kujiking.state.v1`) 데이터가 있으면 판과 코드만 자동으로 옮겨옵니다.

---

## 4. Supabase 연결 (실시간 서버 모드)

1. [supabase.com](https://supabase.com) 에서 새 프로젝트를 만듭니다.
2. **SQL Editor** 에 `supabase/schema.sql` 전체를 붙여넣고 **Run** 합니다.
   - 테이블: `profiles` `boards` `tickets` `exchange_codes` `coupons` `draws` `purchase_claims` `deliveries` `app_settings`
   - RLS 정책, `draw_ticket()` (동시 뽑기 방지), `admin_grant_coupons()`, `admin_decide_claim()`, `request_delivery()`, `convert_to_points()`, `admin_ship_delivery()`, `admin_create_board()`, `admin_members()`
3. **Authentication → Sign In / Providers → Email** 을 켭니다.
   - **Confirm email 을 끄면** 가입 즉시 로그인되어 바로 뽑기까지 이어집니다(권장: 오픈 초기).
   - 켜 두면 가입 후 인증 메일을 눌러야 로그인되므로, 구매 전환률이 떨어집니다.
4. **Project Settings → API** 의 `Project URL` 과 `anon public` 키를 `assets/config.js` 에 넣습니다.

   ```js
   window.KUJI_CONFIG = {
     SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
     SUPABASE_ANON_KEY: 'sb_publishable_...',
     FORCE_DEMO: false
   };
   ```
5. 실서비스에서는 체험용 무료 코드를 지웁니다. (남아 있으면 로그인한 누구나 무료로 뽑을 수 있습니다)

   ```sql
   delete from public.app_settings where key = 'demo_code';
   ```

6. 회원가입 후 **SQL Editor** 에서 첫 관리자를 지정합니다.

   ```sql
   update public.profiles set is_admin = true where email = '내 이메일';
   ```

이후 새로고침하면 헤더 위의 데모 모드 안내가 사라지고 서버 모드로 동작합니다.
키가 잘못되었거나 서버에 닿지 않으면 자동으로 데모 모드로 되돌아갑니다.

> `service_role` 같은 비밀 키는 절대 `config.js` 에 넣지 마세요. 여기 들어가는 것은 공개되어도 되는 Publishable(anon) 키뿐입니다.

---

## 5. 공정성 (SHA-256 봉인)

- 판을 만들 때 시드를 만들고 `SHA-256(seed)` 해시를 판매 전에 공개합니다.
- 각 번호의 결과는 `SHA-256(seed + ":" + n)` 을 오름차순 정렬해 등급을 배치합니다.
- 판이 끝나면 시드를 공개하고 `#/fairness` 의 검증 도구로 누구나 다시 계산할 수 있습니다.
- 브라우저의 Web Crypto(`crypto.subtle`)는 HTTPS/로컬호스트에서만 제공됩니다.
  **HTTP 접속(http://kujiking.co.kr)** 에서도 화면이 멈추지 않도록 순수 JavaScript SHA-256 구현을
  함께 넣었고, 두 경로의 결과(hex)는 동일합니다.

---

## 6. 배포

GitHub Pages (`pkn8238-source/Kujiking`, `main` 브랜치 루트) → `kujiking.co.kr` (CNAME).

```bash
git add -A && git commit -m "쿠지킹 v2" && git push origin main
```

정적 파일만 있으므로 별도 빌드 단계가 없습니다.

---

## 7. 운영 전 확인할 것

- 사업자 정보·통신판매업 신고번호를 푸터에 채워 주세요.
- 청약철회 제한·확률 공시 문구는 판매 전 최종 검토가 필요합니다 (공정성 검증 페이지 하단).
- 실제 판매에서는 관리자 PIN을 바꾸고, Supabase `profiles.is_admin` 을 본인 계정에만 부여하세요.
- `delete from public.app_settings where key = 'demo_code';` 로 체험 코드를 지우세요.
- Authentication 의 **Confirm email** 을 끄거나, 켜 둘 경우 메일 인증 안내를 구매 흐름에 넣으세요.
- 개인정보(연락처·주소)는 구매확인·배송 목적으로만 사용하고, 판매 내역에는 마스킹된 닉네임만 노출됩니다.

---

## 8. 실물 상품 판 (v3 · 2026-11-24 · 상품 종류 × 20장)

시바마루 스토어(`https://shop.yujin-llc.co.jp/kuji`, Yujin LLC·이바라키)에서 실제 판매 중인
이치방쿠지 풀세트 4종을 그대로 상품 데이터로 옮겼습니다.
**규칙: 상품(등급) 1종당 뽑기 20장** — 등급 10종이면 뽑기판이 200장입니다.

| 판 | 카테고리 | 1장 | 구성 | 전체 장수 |
|---|---|---|---|---|
| 드래곤볼 SPIRIT OF THE SAIYAN | 드래곤볼 | 12,000원 | A~J 10종 · A1 B2 C3 D4 E5 F10 G15 H25 I45 J90 + 라스트원 | **200장** |
| 헌터×헌터 키메라 앤트 ② | 헌터×헌터 | 12,000원 | A~I 9종 · A1 B2 C3 D4 E4 F6 G30 H55 I75 + 라스트원 | **180장** |
| 죠죠 The Gathering of RIVALS | 죠죠의 기묘한 모험 | 13,000원 | A~L 12종 · A1 B2 C2 D3 E3 F4 G6 H15 I20 J30 K60 L94 + 라스트원 | **240장** |
| 극장판 약사의 혼잣말 망비의 비보 | 약사의 혼잣말 | 12,000원 | A~H 8종 · A1 B2 C4 D8 E15 F30 G45 H55 + 라스트원 | **160장** |

- 등급 하나 = 실제 상품 하나입니다(A상 손오공, B상 초사이어인 손오반 …). 예전처럼 하위 등급을 E상 하나로
  뭉치지 않고, 세트의 실제 라인업을 그대로 등급으로 세웠습니다.
- 1장 가격은 일본 판매가(1회 790~850엔)에 수입·통관 비용과 국내 온라인 쿠지 시세를 반영해 정했습니다.
- 상위 등급은 1~6장으로 희소하게, 하위 굿즈 등급이 판을 채우는 실제 쿠지와 같은 분포입니다.
- 전체 장수 상한은 앱·SQL 모두 500장으로 올렸습니다(`MAX_TICKETS`, `admin_create_board`, `boards.ticket_count`).

### 이미지
- 등급 카드: `assets/products/{slug}/tier_a.jpg` ~ `tier_l.jpg` (900×900, 상품 종류별 1장, 등급 배지)
- 라스트원: `assets/products/{slug}/last_one.jpg`
- 판 커버: `assets/products/{slug}/cover.jpg` (900×1125)
- 원본 상품 사진: `assets/products/{slug}/raw/*.webp` (시바마루 상품 이미지, 1000×1000)
- 생성 스크립트: `assets/products/build_assets.py` (Pillow · 흰 배경 제거 · 배지 합성)
  `python3 assets/products/build_assets.py` 로 다시 만들 수 있습니다. 폰트는 Pretendard 릴리스의 `Pretendard-Black.otf`·`Pretendard-Bold.otf` 를 `assets/fonts/` 에 두고 실행하세요(용량 때문에 저장소에는 넣지 않았습니다).
  원본 상품 사진은 `assets/products/fetch_images.sh` 로 다시 받을 수 있습니다.

### 판 상세 — 상품 구성과 뽑기판을 한 화면에
- 탭은 **[상품 구성 & 뽑기판]** / **[실제 판매 내역]** 두 개입니다. 판을 열면 바로
  1) **상품 구성** — 등급별 실물 이미지 카드 + 등급표(수량·확률·잔여) + **상품 설명서 접기/펼치기**
  2) **뽑기판** — 1~200(180·240·160)번 번호 그리드, 아래에 이용 안내
  순서로 이어집니다.
- 100장이 넘는 판은 번호 셀을 16열(모바일 6열) 소형 셀로 그려 한눈에 들어오게 했습니다.
- 상품 카드를 누르면 확대 모달, 번호를 누르면 뽑기 흐름이 열립니다.
- 당첨 결과 모달과 판매 완료 번호 모달에도 해당 등급의 실물 이미지가 표시됩니다.
- 사이드의 **등급 현황**에도 등급 썸네일이 붙고, 라스트원 카드를 누르면 크게 볼 수 있습니다.

### Supabase 시드
`supabase/seed_shibamaruya_20.sql` (= `.txt`, 파일명은 기존 링크 호환용) 하나를 SQL Editor 에 붙여넣으면
위 4개 판이 200·180·240·160장으로 다시 들어갑니다. 전체 스키마는 `supabase/schema.sql`.

### 관리자에서 편집
`#/admin` → 판 수정에서 등급마다 **이미지 경로**와 **설명**을 넣을 수 있고(입력 즉시 썸네일 미리보기),
라스트원 이미지·설명, 상품 설명서(요약 / `항목: 값` 사양 / 라인업 / 유의사항)를 편집할 수 있습니다.
이미지·설명만 바꾸면 판매 내역은 초기화되지 않습니다(장수·등급 수량이 바뀔 때만 초기화).

---

## 9. P상 — 포인트 환급형 꽝 (v3.7 · 2026-11-24)

실물 상품을 한 판에 10~12개만 두면 나머지 번호가 전부 "꽝"이 됩니다. 쿠지킹은 꽝 대신
**P상(굿즈 포인트 1,200P)** 을 넣어 마진과 재방문을 함께 잡습니다.

| 판 | 1장 | 전체 | 실물 | P상 |
|---|---|---|---|---|
| 드래곤볼 SPIRIT OF THE SAIYAN | 12,000원 | 200장 | A~J 10종 **각 1개** | **190장 × 1,200P** |
| 헌터×헌터 키메라 앤트 ② | 12,000원 | 180장 | A~I 9종 각 1개 | **171장 × 1,200P** |
| 죠죠 The Gathering of RIVALS | 12,000원 | 240장 | A~L 12종 각 1개 | **228장 × 1,200P** |
| 극장판 약사의 혼잣말 망비의 비보 | 12,000원 | 160장 | A~H 8종 각 1개 | **152장 × 1,200P** |

- 1장 12,000원 / P상 1,200P = **10% 페이백**. P상 10번 = 12,000P = **한 판 무료**.
- 뽑을 때 서버(`draw_ticket`)가 P상이면 `storage_items`(보관함)를 만들지 않고
  `profiles.points` 에 바로 적립하고 `points_awarded`·`points_balance` 를 돌려줍니다.
- 앱은 결과 카드에서 헤더 포인트를 즉시 올리고, "보유 포인트에 바로 적립됐어요! 모아서 다시 뽑기에
  사용할 수 있어요."와 한 판 무료까지의 게이지를 보여줍니다. **C상 이상 2단계 황금 봉인은 없습니다**(P는 C 아래).
- 등급 JSON 에는 `{"grade":"P","label":"굿즈 포인트 1,200P","count":190,"points":1200,"pointOnly":true}` 형태로 들어갑니다.
  서버는 `pointOnly=true` 또는 `points_awarded>0` 을 P상으로 판정합니다.
- 관리자 판 수정에서 등급 select 에 **P상 (포인트)** 이 있고, **지급 포인트(P)** 칸과 **+ P상(포인트) 추가**
  버튼으로 남은 수량을 한 번에 채울 수 있습니다.
- Supabase 반영: `supabase/upgrade_point_kkwang.sql` (= `attachments/2026-11-24/kujiking_point_kkwang.txt`)
  하나를 SQL Editor 에 붙여넣으면 함수 교체 + 4판 재시드(가격 12,000원, 실물 각 1개, P상)가 한 번에 됩니다.
  생성 스크립트는 `supabase/build_point_kkwang.py`.
- 데모 모드는 `STATE_VERSION 5` 로 올려 기존 브라우저 데이터도 새 구성으로 다시 심습니다.

## 10. 고객센터 · 배송비/합배송 안내 (v3.7.6 · 2026-11-24)

방문자가 배송 규칙과 문의 창구를 **결제·배송 신청 직전 화면에서** 바로 볼 수 있게 했습니다.

- **배송비 · 합배송 안내 문구** — 기본값
  `기본 배송비 3,500원 · 보관함에서 3건 이상 묶음(합배송) 신청 시 무료배송 (제주·도서산간 +3,000원)`
  - 노출 위치: 푸터(한 줄 요약 + 고객센터 버튼), 뽑기판 **이용 안내** 카드와 사이드 안내, **공정성 검증 → 확률 · 이용 안내 6항**,
    **내 보관함**(목록 맨 위), **배송 신청 모달**(주소 입력 아래).
  - Supabase `app_settings` 의 `shipping_fee_notice` 값으로 바꿀 수 있고, 비우면 기본 문구가 나갑니다.
- **카카오톡 1:1 오픈채팅 문의** — 노란색 말풍선 문의 버튼을 푸터·이용 안내·보관함·배송 신청 모달에 배치.
  - `app_settings.kakao_openchat_url` 이 있으면 새 창(`target=_blank`, `rel=noopener`)으로 엽니다.
  - 아직 없으면 "현재 1:1 오픈채팅을 연결 중입니다! 잠시만 기다려 주세요." 안내 모달이 뜹니다.
- **관리자 > 설정 · 연결 > 고객센터 · 배송비 설정** 카드에서 두 값을 바로 저장합니다(유튜브 라이브 카드와 같은 방식,
  저장이 막히면 같은 카드의 SQL 안내를 Supabase SQL Editor 에서 실행). 미리보기와 `오픈채팅 열어보기` 테스트 버튼이 있습니다.

```sql
insert into public.app_settings (key, value) values
  ('kakao_openchat_url', 'https://open.kakao.com/o/xxxxxxxx'),
  ('shipping_fee_notice', '기본 배송비 3,500원 · 보관함에서 3건 이상 묶음(합배송) 신청 시 무료배송 (제주·도서산간 +3,000원)')
on conflict (key) do update set value = excluded.value;
```

## 11. 가입 이메일 제한 · 관리자 판매 초기화 (v3.7.8 · 2026-11-24)

- **회원가입은 `@naver.com` · `@gmail.com` 만 허용**합니다(스팸 가입 방지).
  - 회원가입 모달의 이메일 칸 아래에 안내 문구가 있고, 다른 도메인을 넣으면 즉시 빨갛게 바뀝니다.
  - 제출하면 `네이버(@naver.com) 또는 지메일(@gmail.com) 이메일로만 회원가입할 수 있습니다.` 로 막힙니다.
  - **이미 가입한 다른 도메인 계정의 로그인은 막지 않습니다** (가입에만 적용).
- **관리자 > 판 관리 > `🔄 판매 초기화`** — 판 하나의 판매 기록만 0건으로 되돌립니다.
  - 확인창: `정말 이 판의 모든 판매 기록(티켓·보관함·배송요청)을 0건으로 초기화할까요?`
  - 지우는 것: 그 판의 `tickets` 판매 상태, `draws`(보관함), `deliveries`(배송 요청) → `boards.status = 'open'`
  - 남기는 것: 시드·봉인 해시·등급 배치, 회원 계정, 쿠폰, 구매확인 요청, 교환 코드
  - 서버 모드에서는 RPC `admin_reset_board(p_board_id)` 를 씁니다. 아직 설치 전이면 관리자 권한으로 직접 처리한 뒤
    설치용 SQL 안내창을 띄웁니다. 붙여넣을 파일: `supabase/schema.sql`(8-1절) 또는 `kujiking_admin_reset_rpc.txt`

```sql
-- 한 번만 실행 (다시 실행해도 안전)
create or replace function public.admin_reset_board(p_board_id uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_sold integer;
begin
  if not public.is_admin() then raise exception '관리자만 사용할 수 있습니다.'; end if;
  select count(*) into v_sold from public.tickets where board_id = p_board_id and status = 'sold';
  delete from public.deliveries where board_id = p_board_id;
  delete from public.draws      where board_id = p_board_id;
  update public.tickets set status = 'available', buyer_id = null, buyer_name = null, grade = null, drawn_at = null
   where board_id = p_board_id;
  update public.boards set status = 'open' where id = p_board_id;
  return jsonb_build_object('board_id', p_board_id, 'reset', v_sold);
end;
$$;
grant execute on function public.admin_reset_board(uuid) to authenticated;
```

## 12. 승격 연출 — C → B → A 대역전 (v3.8 · 2026-11-24)

C상 이상 봉인(`⚡ C상 이상 확정!`)을 깐 뒤, 결과 화면으로 바로 넘어가지 않고 **등급 배지가 승격하는 3막 연출**을 거칩니다.

| 실제 등급 | 연출 |
|---|---|
| **C** | 보라 네온 배지 `C상` → `✨ C상!` → 결과 (약 1.6초) |
| **B** | `C상` (0.65초) → 화면 흔들림·번개·`⚡ 승격! B상!` → 주홍 배지 `B상` + 2겹 폭죽 + 금빛 팡파레 → 결과 |
| **A · 라스트원** | `C상` → `⚡ 승격! B상!` → 대형 번개·강한 흔들림·`🔥 대역전!! A상!`(라스트원은 `라스트원!`) → 무지개 배지 + 3겹 폭죽·별비 + 3단 팡파레 → 결과 |

- **스포일러 없음**: 승격 단계에서는 배지·빛·폭죽만 보이고, 상품 이미지는 최종 결과 화면에서 처음 나옵니다.
- **화면을 누르면** 남은 간격이 짧아져 바로 결과로 넘어갑니다(닫기 버튼도 한 번은 빨리 감기).
- 효과음은 `assets/app.js` 의 `kujiSound` 가 합성하는 WAV 3종이 추가됐습니다.
  `promoC`(0.62초) · `promote1`(C→B, 1.05초) · `promote2`(B→A, 2.25초)
  - 아이폰 무음 모드 존중 원칙 그대로: `audioSession='playback'` 은 쓰지 않고, 뜯기/봉인 제스처 안에서만 재생합니다.
- 파일: `assets/app.js`(`drawPromoteHTML` · `runPromotion` · `promoWait`), `assets/styles.css`(`.promo-stage` 블록)
