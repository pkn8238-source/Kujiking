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
- **설정 · 연결**: Supabase 연결 상태와 설치 안내, PIN 변경, 체험 코드 변경, JSON 백업/복원

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

## 8. 실물 상품 판 (v2.2 · 2026-11-23)

시바마루 스토어(`https://shop.yujin-llc.co.jp/kuji`, Yujin LLC·이바라키)에서 실제 판매 중인
이치방쿠지 풀세트 4종을 그대로 상품 데이터로 옮겼습니다. 모든 판은 **20장**이고 등급 수량 합계가 20입니다.

| 판 | 카테고리 | 1장 | 구성 | 세트 실구매가(참고) |
|---|---|---|---|---|
| 드래곤볼 SPIRIT OF THE SAIYAN | 드래곤볼 | 12,000원 | A1·B2·C2·D5·E10 + 라스트원 | ¥73,920 (5% 수수료 포함) |
| 헌터×헌터 키메라 앤트 ② | 헌터×헌터 | 12,000원 | A1·B2·C2·D5·E10 + 라스트원 | ¥82,110 |
| 죠죠 The Gathering of RIVALS | 죠죠의 기묘한 모험 | 13,000원 | A1·B2·C2·D5·E10 + 라스트원 | ¥87,150 |
| 극장판 약사의 혼잣말 망비의 비보 | 약사의 혼잣말 | 12,000원 | A1·B2·C2·D5·E10 + 라스트원 | ¥74,550 |

- 1장 가격은 일본 판매가(1회 790~850엔)에 수입·통관 비용과 국내 온라인 쿠지 시세를 반영해 정했습니다.
  세트 실구매가는 시바마루 표시가(수수료 5% 포함, 국제 배송비·관세 별도)입니다.
- 실제 세트의 하위 등급(F~J상 등)은 E상으로 묶어 20장에 맞췄고, 어떤 상품이 랜덤 지급되는지는
  판 상세의 **상품 설명서**와 등급 설명에 적어 두었습니다.

### 이미지
- 등급 카드: `assets/products/{slug}/tier_a.jpg` ~ `tier_e.jpg` (900×900, A상~E상 배지)
- 라스트원: `assets/products/{slug}/last_one.jpg`
- 판 커버: `assets/products/{slug}/cover.jpg` (900×1125)
- 원본 상품 사진: `assets/products/{slug}/raw/*.webp` (시바마루 상품 이미지, 1000×1000)
- 생성 스크립트: `assets/products/build_assets.py` (Pillow · 흰 배경 제거 · 배지 합성)
  `python3 assets/products/build_assets.py` 로 다시 만들 수 있습니다. 폰트는 Pretendard 릴리스의 `Pretendard-Black.otf`·`Pretendard-Bold.otf` 를 `assets/fonts/` 에 두고 실행하세요(용량 때문에 저장소에는 넣지 않았습니다).
  원본 상품 사진은 `assets/products/fetch_images.sh` 로 다시 받을 수 있습니다.

### 판 상세에 추가된 것
- **상품 구성** 탭: 등급별 실물 썸네일 + `A상`~`E상`·`LAST ONE` 배지 + 상품명 + 크기/소재 설명 + 수량·확률·잔여.
  이미지를 누르면 확대 모달이 열립니다.
- **상품 설명서 · 안내** 섹션: 시리즈·제조사·발매일·일본 판매가·세트 구성·크기, 실제 라인업 전체,
  랜덤 지급·배송·청약철회·확률 안내.
- 당첨 결과 모달과 판매 완료 번호 모달에도 해당 등급의 실물 이미지가 표시됩니다.
- 사이드의 **등급 현황**에도 등급 썸네일이 붙고, 라스트원 카드를 누르면 크게 볼 수 있습니다.

### 관리자에서 편집
`#/admin` → 판 수정에서 등급마다 **이미지 경로**와 **설명**을 넣을 수 있고(입력 즉시 썸네일 미리보기),
라스트원 이미지·설명, 상품 설명서(요약 / `항목: 값` 사양 / 라인업 / 유의사항)를 편집할 수 있습니다.
이미지·설명만 바꾸면 판매 내역은 초기화되지 않습니다(장수·등급 수량이 바뀔 때만 초기화).

### Supabase 반영
`supabase/seed_shibamaruya_20.sql` (같은 내용 `.txt`) 을 SQL Editor 에 붙여넣고 실행하세요.
- `boards` 에 `last_one_image`·`last_one_desc`·`manual` 컬럼을 추가합니다.
- `pgcrypto` 가 `extensions` 스키마에 설치된 프로젝트에서 나던
  `function digest(text, unknown) does not exist` 오류를 고칩니다.
  (`ticket_grade`, `admin_create_board` 를 `set search_path = public, extensions` 로 재정의)
- 실물 판 4개를 고정 UUID 로 교체합니다. 다시 실행하면 같은 판이 초기화됩니다(판매 기록 포함).
- 예전 데모 판 3개를 정리하는 블록은 파일 끝에 주석으로 두었습니다. 필요할 때만 주석을 풀어 실행하세요.
