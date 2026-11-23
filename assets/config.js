/* =========================================================
   쿠지킹 KUJIKING — 오픈 준비 설정
   ---------------------------------------------------------
   지금은 아래 두 값이 비어 있어 사이트가 "데모 모드"로 동작합니다.
   (모든 데이터는 방문자 브라우저의 localStorage에 저장돼요)

   Supabase 프로젝트를 만들고 아래 두 값을 채우면,
   새로고침 한 번으로 실제 회원·실시간 판매 모드로 전환됩니다.

     1) supabase.com → New project
     2) SQL Editor 에 supabase/schema.sql 전체 붙여넣고 Run
     3) Project Settings → API 에서 URL 과 anon public key 복사
     4) 아래에 붙여넣기 (anon key 는 공개되어도 되는 키입니다)
     5) 첫 관리자 계정은 회원가입 후 SQL Editor 에서
        update public.profiles set is_admin = true where email = '내 이메일';
   ========================================================= */
window.KUJI_CONFIG = {
  /* Project URL 이 아직 없어서 지금은 데모 모드로 동작합니다.
     URL(https://xxxx.supabase.co)만 받으면 아래에 넣는 순간 서버 모드로 전환됩니다. */
  SUPABASE_URL: '',
  /* 발급받은 Publishable(anon) 키 — 공개되어도 되는 키입니다. 비밀 키(service_role)는 절대 넣지 마세요. */
  SUPABASE_ANON_KEY: 'sb_publishable_Jfdd68hGlV2Sd407K1EK_w_FBENbZEG',

  /* true 로 바꾸면 Supabase 키가 있어도 데모 모드로 실행합니다. */
  FORCE_DEMO: false,

  /* 화면 표시용 */
  STORE_NAME: '쿠지통령',
  CONTACT: 'kujiking@kujiking.co.kr'
};
