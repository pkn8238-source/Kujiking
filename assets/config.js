/* =========================================================
   쿠지킹 KUJIKING — 오픈 준비 설정
   ---------------------------------------------------------
   아래 URL / Publishable(anon) 키는 공개되어도 되는 값입니다.
   (service_role 같은 비밀 키는 절대 여기에 넣지 마세요)

   · Supabase 테이블이 준비되면 자동으로 "실시간 서버 모드"로 동작합니다.
   · 아직 supabase/schema.sql 을 실행하지 않았다면, 사이트는 자동으로
     데모 모드로 돌아가고 화면 위에 "SQL Editor에서 schema.sql 실행" 안내가 뜹니다.
   · 강제로 데모 모드로 쓰고 싶으면 FORCE_DEMO: true 로 바꾸세요.
   ========================================================= */
window.KUJI_CONFIG = {
  SUPABASE_URL: 'https://ptqonefsjhusyuofgius.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Jfdd68hGlV2Sd407K1EK_w_FBENbZEG',

  /* true 로 바꾸면 Supabase 키가 있어도 데모 모드로 실행합니다. */
  FORCE_DEMO: false,

  /* 화면 표시용 */
  STORE_NAME: '쿠지킹',
  STORE_URL: 'https://smartstore.naver.com/kujiking',
  STORE_PRODUCT_URL: 'https://smartstore.naver.com/kujiking/products/13893473264',
  KAKAO_CHAT_URL: 'https://pf.kakao.com/_xnxhmvX/chat',
  CONTACT: 'kujiking@kujiking.co.kr'
};
