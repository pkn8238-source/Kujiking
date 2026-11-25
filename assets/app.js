/* =========================================================
   쿠지킹 KUJIKING — app.js  (v3.9.9, vanilla · no build step)
   ---------------------------------------------------------
   · 해시 라우팅: #/  #/board/:id  #/my  #/winners  #/fairness  #/admin
   · 회원가입/로그인, 내 쿠폰함, 내 보관함(배송·포인트 전환),
     구매확인 요청 → 관리자 승인 → 쿠폰 지급, 실시간 판매 현황
   · Supabase 키가 없으면 데모 모드(localStorage)로 100% 동작
   · SHA-256 은 Web Crypto 가 없으면(HTTP 접속) 순수 JS 로 계산
   ========================================================= */
(function () {
  'use strict';

  var STATE_KEY = 'kujiking.state.v2';
  var STATE_KEY_V1 = 'kujiking.state.v1';
  var SESSION_KEY = 'kujiking.session.v2';
  var ADMIN_KEY = 'kujiking.admin.session.v2';
  var APP_TAG = 'kujiking';
  var STATE_VERSION = 5;   // v5: 실물 등급 각 1개 + P상(굿즈 포인트 1,200P) 구성으로 재시드
  var MAX_TICKETS = 500;

  /* ---------- 스토어 · 카카오톡 채널 링크 (2026-11-24 개설) ---------- */
  var STORE_URL = 'https://smartstore.naver.com/kujiking';
  var STORE_PRODUCT_URL = 'https://smartstore.naver.com/kujiking/products/13893473264';
  var KAKAO_CHAT_URL = 'https://pf.kakao.com/_xnxhmvX/chat';

  /* ---------- 회원가입 이메일 제한 ----------
     스팸 가입 방지를 위해 네이버·지메일 주소만 가입을 받는다.
     이미 가입한 다른 도메인 계정도 로그인은 그대로 된다(가입에만 적용). */
  var SIGNUP_EMAIL_DOMAINS = ['naver.com', 'gmail.com'];
  var SIGNUP_EMAIL_NOTE = '스팸 가입 방지를 위해 @naver.com 또는 @gmail.com 이메일만 가입할 수 있습니다.';
  var SIGNUP_EMAIL_ERROR = '네이버(@naver.com) 또는 지메일(@gmail.com) 이메일로만 회원가입할 수 있습니다.';

  /* ---------- 판매 초기화 서버 함수 (Supabase SQL Editor 에 한 번 설치) ---------- */
  var RESET_BOARD_SQL = [
    '-- 쿠지킹: 한 판의 판매 기록(티켓·보관함·배송요청)을 0건으로 초기화 (관리자 전용)',
    'create or replace function public.admin_reset_board(p_board_id uuid)',
    'returns jsonb',
    'language plpgsql security definer set search_path = public, extensions',
    'as $$',
    'declare',
    '  v_sold integer;',
    'begin',
    '  if not public.is_admin() then',
    "    raise exception '관리자만 사용할 수 있습니다.';",
    '  end if;',
    '',
    "  select count(*) into v_sold from public.tickets where board_id = p_board_id and status = 'sold';",
    '',
    '  delete from public.deliveries where board_id = p_board_id;',
    '  delete from public.draws      where board_id = p_board_id;',
    '  update public.tickets',
    "     set status = 'available', buyer_id = null, buyer_name = null, grade = null, drawn_at = null",
    '   where board_id = p_board_id;',
    "  update public.boards set status = 'open' where id = p_board_id;",
    '',
    "  return jsonb_build_object('board_id', p_board_id, 'reset', v_sold);",
    'end;',
    '$$;',
    '',
    'grant execute on function public.admin_reset_board(uuid) to authenticated;'
  ].join('\n');

  var CATEGORIES = ['드래곤볼', '헌터×헌터', '죠죠의 기묘한 모험', '약사의 혼잣말', '원피스', '귀멸의 칼날', '주술회전', '나의 히어로 아카데미아', '산리오', '치이카와', '자체 스페셜'];
  var PRICE_BANDS = [
    { id: 'all', label: '전체 금액' },
    { id: 'under', label: '1만 원 이하' },
    { id: 'mid', label: '1만 원대' },
    { id: 'premium', label: '프리미엄' }
  ];
  var GRADES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
  /* 관리자 판 편집에서는 P상(굿즈 포인트)도 등급으로 고를 수 있다 */
  var TIER_GRADES = GRADES.concat(['P']);

  var state = null;
  var mapCache = new Map();
  var ui = {
    view: 'home',
    boardId: null,
    boardTab: 'main',
    myTab: 'coupons',
    adminTab: 'members',
    adminUnlocked: false,
    filters: { category: '전체', price: 'all', sort: 'recommend' },
    fairnessBoardId: null,
    winnersBoardId: 'all',
    draw: null,
    pendingCode: '',
    lastGen: null,
    editingBoardId: null,
    authTab: 'login',
    memberQuery: '',
    grantUserId: null,
    revoke: null,
    adminBusy: false,
    ready: false
  };

  /* =========================================================
     1. 기본 유틸
     ========================================================= */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function fieldValue(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value : '';
  }
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* 네이버·지메일만 가입 허용 (로그인에는 쓰지 않는다) */
  function emailDomainOf(email) {
    var v = String(email == null ? '' : email).trim().toLowerCase();
    var at = v.lastIndexOf('@');
    return at === -1 ? '' : v.slice(at + 1).trim();
  }
  function isAllowedSignupEmail(email) {
    return SIGNUP_EMAIL_DOMAINS.indexOf(emailDomainOf(email)) !== -1;
  }
  var h = escapeHtml;
  /* 실물 커버 등 상품 이미지 캐시 갱신용 버전 (커버 교체 시 올린다) */
  var COVER_VER = '4.0.7';
  function coverSrc(url) {
    if (!url || !/^(\.\/)?assets\/products\//.test(url)) return url;
    return url + (url.indexOf('?') === -1 ? '?v=' : '&v=') + COVER_VER;
  }
  /* 판 상품 폴더의 세트 라인업 배너 — 등록된 값이 없으면 등급 이미지 경로에서 추론 */
  function lineupSrcOf(board) {
    if (!board) return '';
    var direct = board.lineupImage || (manualOf(board).image || '');
    if (direct) return direct;
    var imgs = (board.tiers || []).map(function (t) { return t && t.image; }).filter(Boolean);
    for (var i = 0; i < imgs.length; i++) {
      var m = /^(?:\.\/)?(assets\/products\/[A-Za-z0-9_-]+)\//.exec(imgs[i]);
      if (m) return m[1] + '/lineup.jpg';
    }
    return '';
  }
  var ICONS = {
    ticket: '<path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4V7z"/><path d="M14 7v10"/>',
    crown: '<path d="M3 8l4.5 4L12 4l4.5 8L21 8l-2 11H5L3 8z"/><path d="M5 19h14"/>',
    gift: '<rect x="3" y="8" width="18" height="13" rx="2.2"/><path d="M3 12.5h18M12 8v13"/><path d="M12 8S10 3.5 7.6 3.5 6.4 8 12 8zM12 8s2-4.5 4.4-4.5S17.6 8 12 8z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H16"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.6 2.6L16 9.6"/>',
    x: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    alert: '<path d="M12 3.2l9.2 16.3H2.8L12 3.2z"/><path d="M12 9.2v4.6M12 17h.01"/>',
    box: '<path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7z"/><path d="M3.5 8.5 12 13l8.5-4.5M12 13v7"/>',
    truck: '<path d="M2.5 6.5h11v9h-11z"/><path d="M13.5 10h4l3 3v2.5h-7z"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    ticket2: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M9 6v12M15 6v12"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>'
  };
  function icon(name, cls) {
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }
  function fmt(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function won(n) { return fmt(n) + '원'; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function waitMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowISO() { return new Date().toISOString(); }
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function randomBytes(n) {
    var arr = new Uint8Array(n);
    var c = getCrypto();
    if (c && c.getRandomValues) {
      c.getRandomValues(arr);
    } else {
      for (var i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }
  function getCrypto() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto) return globalThis.crypto;
    if (typeof window !== 'undefined' && window.crypto) return window.crypto;
    return null;
  }
  function randomSeed() {
    return Array.prototype.map.call(randomBytes(32), function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }
  function randomCode() {
    var chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    var bytes = randomBytes(8);
    var out = '';
    for (var i = 0; i < 8; i++) out += chars[bytes[i] % chars.length];
    return 'KJ-' + out.slice(0, 4) + '-' + out.slice(4);
  }
  function randInt(max) { return randomBytes(4).reduce(function (a, b) { return a + b; }, 0) % max; }

  /* ---------- SHA-256 ----------
     HTTP(비보안 컨텍스트)에서는 window.crypto.subtle 이 없어서
     Web Crypto 를 쓰면 첫 화면이 죽습니다. 그래서 순수 JS 구현을
     항상 함께 두고, crypto.subtle 이 없으면 이쪽으로 계산합니다.
     두 경로의 결과(hex)는 완전히 동일합니다. */
  var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function utf8Bytes(str) {
    var s = String(str);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(out);
  }
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256BytesHex(bytes) {
    var l = bytes.length;
    var total = ((l + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(bytes);
    buf[l] = 0x80;
    var bitHi = Math.floor((l * 8) / 4294967296);
    var bitLo = (l * 8) >>> 0;
    buf[total - 8] = (bitHi >>> 24) & 255;
    buf[total - 7] = (bitHi >>> 16) & 255;
    buf[total - 6] = (bitHi >>> 8) & 255;
    buf[total - 5] = bitHi & 255;
    buf[total - 4] = (bitLo >>> 24) & 255;
    buf[total - 3] = (bitLo >>> 16) & 255;
    buf[total - 2] = (bitLo >>> 8) & 255;
    buf[total - 1] = bitLo & 255;

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Uint32Array(64);

    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) {
        var p = off + i * 4;
        w[i] = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        var s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + hh) >>> 0;
    }
    var hex = '';
    for (i = 0; i < 8; i++) hex += ('00000000' + H[i].toString(16)).slice(-8);
    return hex;
  }
  function sha256FallbackHex(text) { return sha256BytesHex(utf8Bytes(text)); }

  function sha256Hex(text) {
    var str = String(text == null ? '' : text);
    var c = getCrypto();
    if (c && c.subtle && c.subtle.digest) {
      try {
        var data = utf8Bytes(str);
        return c.subtle.digest('SHA-256', data).then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return b.toString(16).padStart(2, '0');
          }).join('');
        }).catch(function () {
          return sha256FallbackHex(str);
        });
      } catch (e) {
        /* 아래 순수 JS 로 */
      }
    }
    return Promise.resolve(sha256FallbackHex(str));
  }

  /* ---------- 표시용 포맷 ---------- */
  var dtf;
  try {
    dtf = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch (e) { dtf = null; }
  function formatDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    if (!dtf) return d.toISOString().slice(5, 16).replace('T', ' ');
    return dtf.format(d).replace(/\s+/g, ' ').trim();
  }
  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' });
  }
  function timeAgo(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '-';
    var diff = Math.max(0, Date.now() - t);
    var m = Math.floor(diff / 60000);
    if (m < 1) return '방금 전';
    if (m < 60) return m + '분 전';
    var hh = Math.floor(m / 60);
    if (hh < 24) return hh + '시간 전';
    var dd = Math.floor(hh / 24);
    if (dd < 7) return dd + '일 전';
    return formatDate(iso);
  }
  function maskName(name) {
    var s = String(name || '').trim();
    if (!s) return '익명';
    if (s.length === 1) return s + '*';
    if (s.length === 2) return s.charAt(0) + '*';
    return s.charAt(0) + '*'.repeat(s.length - 2) + s.charAt(s.length - 1);
  }
  function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function maskCode(code) {
    var c = String(code || '');
    if (c.length <= 6) return c.slice(0, 2) + '••';
    return c.slice(0, 5) + '••••' + c.slice(-2);
  }
  function gradeColor(grade) {
    if (String(grade || '').toUpperCase() === 'LAST') return 'var(--gold)';
    return 'var(--grade-' + String(grade || 'e').toLowerCase() + ')';
  }
  /* 라스트원 보너스 행은 티켓 번호가 없다(draws.n = 0) → 번호 대신 이름을 쓴다 */
  function drawNoLabel(d) {
    return (d && String(d.grade || '').toUpperCase() === 'LAST') ? '라스트원' : ((d ? d.n : '') + '번');
  }
  function gradeLetter(g) {
    var u = String(g || '').toUpperCase();
    return u === 'LAST' ? 'L' : u;
  }
  function priceBand(p) {
    var n = Number(p) || 0;
    if (n <= 10000) return 'under';
    if (n < 15000) return 'mid';
    return 'premium';
  }
  function priceBandLabel(p) {
    return { under: '1만 원 이하', mid: '1만 원대', premium: '프리미엄' }[priceBand(p)];
  }
  function categoryClass(cat) {
    return { '원피스': 'cat-onepiece', '귀멸의 칼날': 'cat-kimetsu', '산리오': 'cat-sanrio', '치이카와': 'cat-chiikawa',
      '드래곤볼': 'cat-dragonball', '헌터×헌터': 'cat-hunter', '죠죠의 기묘한 모험': 'cat-jojo', '약사의 혼잣말': 'cat-apothecary',
      '주술회전': 'cat-jujutsu', '나의 히어로 아카데미아': 'cat-myhero' }[cat] || 'cat-special';
  }
  function errMsg(e) {
    if (!e) return '문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
    var m = e.message || e.error_description || String(e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';
    if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않습니다.';
    if (/already registered|already exists/i.test(m)) return '이미 가입된 이메일입니다. 로그인해 주세요.';
    if (/Password should be at least/i.test(m)) return '비밀번호는 6자 이상으로 정해 주세요.';
    if (/duplicate key/i.test(m)) return '이미 처리된 요청이에요. 새로고침 해 주세요.';
    return m;
  }

  /* ---------- toast / clipboard / download ---------- */
  function toast(message, kind) {
    var root = $('#toastRoot');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    root.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s ease, transform .25s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(function () { el.remove(); }, 260);
    }, 2600);
  }
  function copyText(text, okMessage) {
    var done = function () { toast(okMessage || '복사했어요', 'ok'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { toast('복사에 실패했어요', 'err'); }
      ta.remove();
    }
  }
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* =========================================================
     2. 상태 · 시드
     ========================================================= */
  function emptyState() {
    return {
      v: STATE_VERSION,
      settings: { demoCode: 'DEMO-KUJI', pinHash: '', pinChanged: false, storeName: '쿠지킹', youtubeLiveUrl: '', youtubeLiveEnabled: true, kakaoOpenchatUrl: KAKAO_CHAT_URL, shippingFeeNotice: '' },
      boards: [], users: [], coupons: [], draws: [], claims: [], deliveries: [], codes: [],
      session: null,
      me: null, myCoupons: [], myDraws: [], myClaims: [], myDeliveries: [],
      adminMembers: [], adminClaims: [], adminDeliveries: [],
      adminLoaded: false, adminError: null, loadError: '',
      updatedAt: nowISO()
    };
  }

  var SEED_SPECS = [
    {
      id: 'b-dragonball-saiyan',
      title: '[드래곤볼] SPIRIT OF THE SAIYAN 쿠지',
      category: '드래곤볼',
      cover: 'assets/products/dragonball-saiyan/cover.jpg',
      price: 12000,
      tickets: 200,
      sold: 26,
      kicker: 'SAIYAN',
      sub: '손오공 · 초사이어인 손오반 · 라디츠',
      tiers: [
        { grade: 'A', label: '손오공 MASTERLISE', count: 1, points: 35000,
          image: 'assets/products/dragonball-saiyan/tier_a.jpg',
          desc: '약 20cm · 카메하메하 포즈의 MASTERLISE 피규어' },
        { grade: 'B', label: '초사이어인 손오반 MASTERLISE', count: 1, points: 20000,
          image: 'assets/products/dragonball-saiyan/tier_b.jpg',
          desc: '약 19cm · 아버지와 같은 카메하메하 포즈' },
        { grade: 'C', label: '손오천 MASTERLISE', count: 1, points: 14000,
          image: 'assets/products/dragonball-saiyan/tier_c.jpg',
          desc: '약 13cm · 어린 손오천의 경쾌한 포즈' },
        { grade: 'D', label: '바닥 MASTERLISE', count: 1, points: 12000,
          image: 'assets/products/dragonball-saiyan/tier_d.jpg',
          desc: '약 25cm · 사이어인 정예전사 바닥' },
        { grade: 'E', label: '라디츠 MASTERLISE', count: 1, points: 12000,
          image: 'assets/products/dragonball-saiyan/tier_e.jpg',
          desc: '약 25cm · 스카우터를 쓴 손오공의 형' },
        { grade: 'F', label: '피규어 마그넷', count: 1, points: 6000,
          image: 'assets/products/dragonball-saiyan/tier_f.jpg',
          desc: '약 5cm · 전 3종 중 1종 랜덤' },
        { grade: 'G', label: '파우치', count: 1, points: 5000,
          image: 'assets/products/dragonball-saiyan/tier_g.jpg',
          desc: '약 13cm · 전 7종 중 1종 랜덤' },
        { grade: 'H', label: '아크릴 스탠드', count: 1, points: 4000,
          image: 'assets/products/dragonball-saiyan/tier_h.jpg',
          desc: '약 7~10cm · 전 9종 중 1종 랜덤' },
        { grade: 'I', label: '고무 어소트', count: 1, points: 3000,
          image: 'assets/products/dragonball-saiyan/tier_i.jpg',
          desc: '약 5.5~6.5cm · 전 7종 중 1종 랜덤' },
        { grade: 'J', label: '다이컷 타월', count: 1, points: 2000,
          image: 'assets/products/dragonball-saiyan/tier_j.jpg',
          desc: '약 24cm · 전 9종 중 1종 랜덤' },
        { grade: 'P', label: '굿즈 포인트 1,200P', count: 190, points: 1200, pointOnly: true,
          desc: '실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료' }
      ],
      lastOneLabel: '라스트원상 · 손오공&손오반 MASTERLISE PLUS',
      lastOneImage: 'assets/products/dragonball-saiyan/last_one.jpg',
      lineupImage: 'assets/products/dragonball-saiyan/lineup.jpg',
      lastOneDesc: '약 21cm · 근두운에 오른 부자(父子) 피규어',
      manual: {
        summary: '손오공 일가의 카메하메하 장면을 MASTERLISE로 입체화한 이치방쿠지입니다. A~E상은 대형 피규어, F~J상은 마그넷·파우치·아크릴·고무·타월 소품으로 구성됩니다.',
        specs: [
          { k: '시리즈', v: '드래곤볼 Z' },
          { k: '제조사', v: '반다이 스피리츠' },
          { k: '일본 발매', v: '2026.10.17' },
          { k: '일본 판매가', v: '1회 790엔 (세금 포함)' },
          { k: '세트 구성', v: 'A~J상 10종 + 라스트원상 · 총 11종' },
          { k: '이 판 구성', v: '실물 10종 각 1개 + P상 190장 = 200장' },
          { k: '주요 크기', v: 'MASTERLISE 약 13~25cm' }
        ],
        lineup: [
          'A상 손오공 MASTERLISE (약 20cm)',
          'B상 초사이어인 손오반 MASTERLISE (약 19cm)',
          'C상 손오천 MASTERLISE (약 13cm)',
          'D상 바닥 MASTERLISE (약 25cm)',
          'E상 라디츠 MASTERLISE (약 25cm)',
          'F상 피규어 마그넷 (약 5cm / 전 3종)',
          'G상 파우치 (약 13cm / 전 7종)',
          'H상 아크릴 스탠드 (약 7~10cm / 전 9종)',
          'I상 고무 어소트 (약 5.5~6.5cm / 전 7종)',
          'J상 다이컷 타월 (약 24cm / 전 9종)',
          '라스트원상 손오공&손오반 MASTERLISE PLUS (약 21cm)'
        ],
        notes: [
          '이 판은 실제 세트의 A~J상 10종을 등급별로 각 1개씩(실물 10개) 두고, 나머지 190장을 P상(굿즈 포인트 1,200P)으로 채운 총 200장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.',
          'P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.',
          '피규어는 공장 조립·도색 상태에 따라 개체 차이가 있을 수 있습니다.'
        ]
      }
    },
    {
      id: 'b-hunter-chimera',
      title: '[헌터×헌터] 키메라 앤트 ② 쿠지',
      category: '헌터×헌터',
      cover: 'assets/products/hunter-chimera-ant/cover.jpg',
      price: 12000,
      tickets: 180,
      sold: 31,
      kicker: 'CHIMERA ANT',
      sub: '메르엠 · 네테로 · 곤',
      tiers: [
        { grade: 'A', label: '메르엠 MASTERLISE', count: 1, points: 40000,
          image: 'assets/products/hunter-chimera-ant/tier_a.jpg',
          desc: '약 23cm · 개미의 왕, 압도적인 조형' },
        { grade: 'B', label: '네테로 MASTERLISE', count: 1, points: 22000,
          image: 'assets/products/hunter-chimera-ant/tier_b.jpg',
          desc: '약 22cm · 감사의 정권찌르기 장면' },
        { grade: 'C', label: '곤 MASTERLISE', count: 1, points: 14000,
          image: 'assets/products/hunter-chimera-ant/tier_c.jpg',
          desc: '약 10cm · 네페르피토와 대치한 순간' },
        { grade: 'D', label: '키르아 MASTERLISE', count: 1, points: 16000,
          image: 'assets/products/hunter-chimera-ant/tier_d.jpg',
          desc: '약 21cm · 전격의 순간' },
        { grade: 'E', label: '네페르피토 MASTERLISE', count: 1, points: 16000,
          image: 'assets/products/hunter-chimera-ant/tier_e.jpg',
          desc: '약 24cm · 왕의 근위대' },
        { grade: 'F', label: '샤우아푸프 · 몬투투유피 MASTERLISE', count: 1, points: 12000,
          image: 'assets/products/hunter-chimera-ant/tier_f.jpg',
          desc: '약 6~7cm · 전 2종 중 1종 랜덤' },
        { grade: 'G', label: '고무 컬렉션', count: 1, points: 5000,
          image: 'assets/products/hunter-chimera-ant/tier_g.jpg',
          desc: '약 8~19cm · 전 10종 중 1종 랜덤' },
        { grade: 'H', label: '문구 어소트', count: 1, points: 4000,
          image: 'assets/products/hunter-chimera-ant/tier_h.jpg',
          desc: 'A4 클리어파일·A6 노트 / 전 10종 중 1종' },
        { grade: 'I', label: '폰탭 · 넥스트랩 · 스티커', count: 1, points: 3000,
          image: 'assets/products/hunter-chimera-ant/tier_i.jpg',
          desc: '약 5~47cm · 전 10종 중 1종 랜덤' },
        { grade: 'P', label: '굿즈 포인트 1,200P', count: 171, points: 1200, pointOnly: true,
          desc: '실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료' }
      ],
      lastOneLabel: '라스트원상 · 곤 ~성장ver.~ MASTERLISE EXTRA',
      lastOneImage: 'assets/products/hunter-chimera-ant/last_one.jpg',
      lineupImage: 'assets/products/hunter-chimera-ant/lineup.jpg',
      lastOneDesc: '약 100cm · 성장한 곤의 초대형 피규어',
      manual: {
        summary: '키메라 앤트 편을 테마로 한 재판매 세트입니다. A~F상이 전부 MASTERLISE 피규어이고, 라스트원상은 약 1m 크기의 성장한 곤입니다.',
        specs: [
          { k: '시리즈', v: '헌터×헌터 키메라 앤트 편' },
          { k: '제조사', v: '반다이 스피리츠' },
          { k: '일본 발매', v: '2026.11.14 (재판)' },
          { k: '일본 판매가', v: '1회 790엔 (세금 포함)' },
          { k: '세트 구성', v: 'A~I상 9종 + 라스트원상 · 총 10종' },
          { k: '이 판 구성', v: '실물 9종 각 1개 + P상 171장 = 180장' },
          { k: '주요 크기', v: 'MASTERLISE 약 6~24cm · 라스트원 약 100cm' }
        ],
        lineup: [
          'A상 메르엠 MASTERLISE (약 23cm)',
          'B상 네테로 MASTERLISE (약 22cm)',
          'C상 곤 MASTERLISE (약 10cm)',
          'D상 키르아 MASTERLISE (약 21cm)',
          'E상 네페르피토 MASTERLISE (약 24cm)',
          'F상 샤우아푸프/몬투투유피 MASTERLISE (약 6~7cm / 전 2종)',
          'G상 고무 컬렉션 (약 8~19cm / 전 10종)',
          'H상 문구 어소트 (A4 클리어파일·A6 노트 / 전 10종)',
          'I상 폰탭·넥스트랩·스티커 어소트 (약 5~47cm / 전 10종)',
          '라스트원상 곤 ~성장ver.~ MASTERLISE EXTRA (약 100cm)'
        ],
        notes: [
          '이 판은 실제 세트의 A~I상 9종을 등급별로 각 1개씩(실물 9개) 두고, 나머지 171장을 P상(굿즈 포인트 1,200P)으로 채운 총 180장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.',
          'P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.',
          '라스트원상은 약 100cm 대형 피규어로, 일반 상품과 별도 박스로 발송됩니다.'
        ]
      }
    },
    {
      id: 'b-jojo-rivals',
      title: '[죠죠] The Gathering of RIVALS 쿠지',
      category: '죠죠의 기묘한 모험',
      cover: 'assets/products/jojo-rivals/cover.jpg',
      price: 12000,
      tickets: 240,
      sold: 18,
      kicker: 'RIVALS',
      sub: '디오 브란도 · 카즈 · DIO',
      tiers: [
        { grade: 'A', label: '디오 브란도 MASTERLISE PLUS', count: 1, points: 32000,
          image: 'assets/products/jojo-rivals/tier_a.jpg',
          desc: '약 18cm · 1부 팬텀 블러드의 디오' },
        { grade: 'B', label: '카즈 MASTERLISE', count: 1, points: 24000,
          image: 'assets/products/jojo-rivals/tier_b.jpg',
          desc: '약 25cm · 2부 전투조류의 카즈' },
        { grade: 'C', label: 'DIO MASTERLISE', count: 1, points: 24000,
          image: 'assets/products/jojo-rivals/tier_c.jpg',
          desc: '약 26cm · 3부 스타더스트 크루세이더스의 DIO' },
        { grade: 'D', label: '카와지리 하지메 MASTERLISE', count: 1, points: 18000,
          image: 'assets/products/jojo-rivals/tier_d.jpg',
          desc: '약 24cm · 4부 다이아몬드는 부서지지 않는다' },
        { grade: 'E', label: '디아볼로 MASTERLISE', count: 1, points: 18000,
          image: 'assets/products/jojo-rivals/tier_e.jpg',
          desc: '약 25cm · 5부 황금의 바람' },
        { grade: 'F', label: '엔리코 P MASTERLISE', count: 1, points: 18000,
          image: 'assets/products/jojo-rivals/tier_f.jpg',
          desc: '약 22cm · 6부 스톤 오션' },
        { grade: 'G', label: '스탠드의 화살 MASTERELIVE COLLECTION', count: 1, points: 16000,
          image: 'assets/products/jojo-rivals/tier_g.jpg',
          desc: '약 21cm · 스탠드를 각성시키는 화살' },
        { grade: 'H', label: 'LOGO de Collection', count: 1, points: 9000,
          image: 'assets/products/jojo-rivals/tier_h.jpg',
          desc: '약 9~10cm · 전 7종 중 1종 랜덤' },
        { grade: 'I', label: '미니어처 참', count: 1, points: 7000,
          image: 'assets/products/jojo-rivals/tier_i.jpg',
          desc: '약 2.5~4.5cm · 전 7종 중 1종 랜덤' },
        { grade: 'J', label: '고무 어소트', count: 1, points: 5000,
          image: 'assets/products/jojo-rivals/tier_j.jpg',
          desc: '약 4~12cm · 전 7종 중 1종 랜덤' },
        { grade: 'K', label: '클리어 포스터', count: 1, points: 4000,
          image: 'assets/products/jojo-rivals/tier_k.jpg',
          desc: 'A3 · 전 8종 중 1종 랜덤' },
        { grade: 'L', label: '스티커 컬렉션', count: 1, points: 3000,
          image: 'assets/products/jojo-rivals/tier_l.jpg',
          desc: '약 6~14cm · 전 13종 중 1종 랜덤' },
        { grade: 'P', label: '굿즈 포인트 1,200P', count: 228, points: 1200, pointOnly: true,
          desc: '실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료' }
      ],
      lastOneLabel: '라스트원상 · 디에고 브란도 MASTERLISE',
      lastOneImage: 'assets/products/jojo-rivals/last_one.jpg',
      lineupImage: 'assets/products/jojo-rivals/lineup.jpg',
      lastOneDesc: '약 15cm · 7부 스틸 볼 런의 디에고',
      manual: {
        summary: '시리즈 역대 숙적들이 MASTERLISE로 모인 세트입니다. A~F상은 18~26cm 피규어, G상은 스탠드의 화살, H~L상은 로고 피규어·참·고무·포스터·스티커입니다.',
        specs: [
          { k: '시리즈', v: '죠죠의 기묘한 모험' },
          { k: '제조사', v: '반다이 스피리츠' },
          { k: '일본 발매', v: '2026.11.21' },
          { k: '일본 판매가', v: '1회 850엔 (세금 포함)' },
          { k: '세트 구성', v: 'A~L상 12종 + 라스트원상 · 총 13종' },
          { k: '이 판 구성', v: '실물 12종 각 1개 + P상 228장 = 240장' },
          { k: '주요 크기', v: 'MASTERLISE 약 18~26cm' }
        ],
        lineup: [
          'A상 디오 브란도 MASTERLISE PLUS (약 18cm)',
          'B상 카즈 MASTERLISE (약 25cm)',
          'C상 DIO MASTERLISE (약 26cm)',
          'D상 카와지리 하지메 MASTERLISE (약 24cm)',
          'E상 디아볼로 MASTERLISE (약 25cm)',
          'F상 엔리코 P MASTERLISE (약 22cm)',
          'G상 스탠드의 화살 MASTERELIVE COLLECTION (약 21cm)',
          'H상 죠죠의 기묘한 모험 LOGO de Collection (약 9~10cm / 전 7종)',
          'I상 미니어처 참 (약 2.5~4.5cm / 전 7종)',
          'J상 고무 어소트 (약 4~12cm / 전 7종)',
          'K상 클리어 포스터 (A3 / 전 8종)',
          'L상 스티커 컬렉션 (약 6~14cm / 전 13종)',
          '라스트원상 디에고 브란도 MASTERLISE (약 15cm)'
        ],
        notes: [
          '이 판은 실제 세트의 A~L상 12종을 등급별로 각 1개씩(실물 12개) 두고, 나머지 228장을 P상(굿즈 포인트 1,200P)으로 채운 총 240장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.',
          'P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.',
          '클리어 포스터는 A3 크기로, 배송 시 접히지 않도록 원통 포장됩니다.'
        ]
      }
    },
    {
      id: 'b-apothecary-secret',
      title: '[약사의 혼잣말] 극장판 망비의 비보 쿠지',
      category: '약사의 혼잣말',
      cover: 'assets/products/apothecary-secret/cover.jpg',
      price: 12000,
      tickets: 160,
      sold: 12,
      kicker: 'THE MOVIE',
      sub: '마오마오 · 진시',
      tiers: [
        { grade: 'A', label: '마오마오 Dioramiquemaster', count: 1, points: 30000,
          image: 'assets/products/apothecary-secret/tier_a.jpg',
          desc: '약 15cm · 극장판 의상의 디오라마 피규어' },
        { grade: 'B', label: '진시 Dioramiquemaster', count: 1, points: 20000,
          image: 'assets/products/apothecary-secret/tier_b.jpg',
          desc: '약 16cm · 극장판 의상의 디오라마 피규어' },
        { grade: 'C', label: '빅 아크릴 스탠드', count: 1, points: 9000,
          image: 'assets/products/apothecary-secret/tier_c.jpg',
          desc: '약 16cm · 마오마오 & 진시 일러스트' },
        { grade: 'D', label: '키라라이즈 마스코트', count: 1, points: 7000,
          image: 'assets/products/apothecary-secret/tier_d.jpg',
          desc: '약 10cm · 전 2종 중 1종 랜덤' },
        { grade: 'E', label: '메탈 참', count: 1, points: 6000,
          image: 'assets/products/apothecary-secret/tier_e.jpg',
          desc: '약 5cm · 전 5종 중 1종 랜덤' },
        { grade: 'F', label: '고무 컬렉션', count: 1, points: 4000,
          image: 'assets/products/apothecary-secret/tier_f.jpg',
          desc: '약 6~10cm · 전 5종 중 1종 랜덤' },
        { grade: 'G', label: '아크릴 스탠드', count: 1, points: 3500,
          image: 'assets/products/apothecary-secret/tier_g.jpg',
          desc: '약 6.5~8cm · 전 5종 중 1종 랜덤' },
        { grade: 'H', label: '미니 색지', count: 1, points: 3000,
          image: 'assets/products/apothecary-secret/tier_h.jpg',
          desc: '약 13cm · 전 5종 중 1종 랜덤' },
        { grade: 'P', label: '굿즈 포인트 1,200P', count: 152, points: 1200, pointOnly: true,
          desc: '실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료' }
      ],
      lastOneLabel: '라스트원상 · 마오마오 피규어',
      lastOneImage: 'assets/products/apothecary-secret/last_one.jpg',
      lineupImage: 'assets/products/apothecary-secret/lineup.jpg',
      lastOneDesc: '약 18cm · 꽃이 핀 받침대 위의 마오마오',
      manual: {
        summary: '극장판 약사의 혼잣말 첫 이치방쿠지입니다. 신브랜드 Dioramiquemaster의 마오마오·진시 피규어와 극장판 의상 일러스트 굿즈로 구성됩니다.',
        specs: [
          { k: '시리즈', v: '극장판 약사의 혼잣말' },
          { k: '제조사', v: '반다이 스피리츠' },
          { k: '일본 발매', v: '2026.12.05' },
          { k: '일본 판매가', v: '1회 800엔 (세금 포함)' },
          { k: '세트 구성', v: 'A~H상 8종 + 라스트원상 · 총 9종' },
          { k: '이 판 구성', v: '실물 8종 각 1개 + P상 152장 = 160장' },
          { k: '주요 크기', v: 'Dioramiquemaster 약 15~16cm' }
        ],
        lineup: [
          'A상 마오마오 Dioramiquemaster (약 15cm)',
          'B상 진시 Dioramiquemaster (약 16cm)',
          'C상 빅 아크릴 스탠드 (약 16cm)',
          'D상 키라라이즈 마스코트 (약 10cm / 전 2종)',
          'E상 메탈 참 (약 5cm / 전 5종)',
          'F상 고무 컬렉션 (약 6~10cm / 전 5종)',
          'G상 아크릴 스탠드 (약 6.5~8cm / 전 5종)',
          'H상 미니 색지 (약 13cm / 전 5종)',
          '라스트원상 마오마오 피규어 (약 18cm)'
        ],
        notes: [
          '이 판은 실제 세트의 A~H상 8종을 등급별로 각 1개씩(실물 8개) 두고, 나머지 152장을 P상(굿즈 포인트 1,200P)으로 채운 총 160장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.',
          'P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.',
          '일본 발매가 2026년 12월 5일인 신작으로, 이 판은 입고분에 한해 순차 발송됩니다.'
        ]
      }
    },
    {
      id: 'b-chiikawa-onsen',
      title: '[치이카와] 포근포근 치이카와의 탕 쿠지',
      category: '치이카와',
      cover: 'assets/products/chiikawa/cover.jpg',
      price: 12000,
      tickets: 160,
      sold: 0,
      kicker: 'CHIIKAWA',
      sub: '치이카와 · 하치와레 · 우사기',
      tiers: [
        { grade: 'A', label: '포근포근 목욕탕 소품 수납 피규어', count: 1, points: 14000,
          image: 'assets/products/chiikawa/tier_a.jpg',
          desc: '약 16cm · 서랍에 소품을 넣을 수 있는 실용 피규어' },
        { grade: 'B', label: '어서 오세요★ 번대 피규어', count: 1, points: 10000,
          image: 'assets/products/chiikawa/tier_b.jpg',
          desc: '약 9cm · 영업중/휴무 표찰을 돌릴 수 있는 카운터' },
        { grade: 'C', label: '푸하~! 목욕 후 피규어', count: 1, points: 9000,
          image: 'assets/products/chiikawa/tier_c.jpg',
          desc: '약 10cm · 우사기와 쿠리만쥬의 건배 장면' },
        { grade: 'D', label: '귀여운? 세신장 피규어', count: 1, points: 9000,
          image: 'assets/products/chiikawa/tier_d.jpg',
          desc: '약 9cm · 모몽가와 후루혼야의 거울 앞 장면' },
        { grade: 'E', label: '목욕 후 글라스', count: 1, points: 6000,
          image: 'assets/products/chiikawa/tier_e.jpg',
          desc: '글라스 약 8cm · 우유병 약 14cm / 전 4종 중 1종' },
        { grade: 'F', label: '목욕탕 러버 참 컬렉션', count: 1, points: 4000,
          image: 'assets/products/chiikawa/tier_f.jpg',
          desc: '약 6cm · 사물함 열쇠 모양 포함 / 전 8종 중 1종' },
        { grade: 'G', label: '스테이셔너리', count: 1, points: 3500,
          image: 'assets/products/chiikawa/tier_g.jpg',
          desc: 'A4 클리어파일·메모·부착 메모 등 / 전 5종 중 1종' },
        { grade: 'H', label: '패브릭 컬렉션', count: 1, points: 3000,
          image: 'assets/products/chiikawa/tier_h.jpg',
          desc: '파우치 약 22cm · 타월 약 25~60cm / 전 6종 중 1종' },
        { grade: 'P', label: '굿즈 포인트 1,200P', count: 152, points: 1200, pointOnly: true,
          desc: '실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료' }
      ],
      lastOneLabel: '라스트원상 · 함께 포근포근♪ 목욕 후 쿠션',
      lastOneImage: 'assets/products/chiikawa/last_one.jpg',
      lineupImage: 'assets/products/chiikawa/lineup.jpg',
      lastOneDesc: '약 60cm · 치이카와·하치와레·우사기가 그려진 대형 쿠션',
      manual: {
        summary: '목욕탕(센토)을 테마로 한 치이카와 이치방쿠지입니다. A~D상이 전부 소품 수납 기능이 있는 피규어이고, E~H상은 목욕 후 글라스·러버 참·문구·패브릭입니다.',
        specs: [
          { k: '시리즈', v: '치이카와' },
          { k: '제조사', v: '반다이 스피리츠' },
          { k: '일본 발매', v: '2025.09.19' },
          { k: '일본 판매가', v: '1회 750엔 (세금 포함)' },
          { k: '세트 구성', v: 'A~H상 8종 + 라스트원상 · 총 9종' },
          { k: '이 판 구성', v: '실물 8종 각 1개 + P상 152장 = 160장' },
          { k: '주요 크기', v: '피규어 약 9~16cm · 라스트원 쿠션 약 60cm' }
        ],
        lineup: [
          'A상 포근포근 목욕탕 소품 수납 피규어 (약 16cm)',
          'B상 어서 오세요★ 번대 피규어 (약 9cm)',
          'C상 푸하~! 목욕 후 피규어 (약 10cm)',
          'D상 귀여운? 세신장 피규어 (약 9cm)',
          'E상 목욕 후 글라스 (글라스 약 8cm·우유병 약 14cm / 전 4종)',
          'F상 목욕탕 러버 참 컬렉션 (약 6cm / 전 8종)',
          'G상 스테이셔너리 (A4 클리어파일·메모·부착 메모 등 / 전 5종)',
          'H상 패브릭 컬렉션 (파우치·타월 / 전 6종)',
          '라스트원상 함께 포근포근♪ 목욕 후 쿠션 (약 60cm)'
        ],
        notes: [
          '이 판은 실제 세트의 A~H상 8종을 등급별로 각 1개씩(실물 8개) 두고, 나머지 152장을 P상(굿즈 포인트 1,200P)으로 채운 총 160장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.',
          'P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.',
          '2025년 9월 발매 세트로, 이 판은 확보한 입고분에 한해 순차 발송됩니다.'
        ]
      }
    },
    {
      id: 'b-kimetsu-jogen2',
      title: '[귀멸의 칼날] 상현의 2 쿠지',
      category: '귀멸의 칼날',
      cover: 'assets/products/kimetsu/cover.jpg',
      price: 12000,
      tickets: 160,
      sold: 0,
      kicker: 'UPPER RANK 2',
      sub: '시노부 · 카나오 · 도마',
      tiers: [
        { grade: 'A', label: '코초 시노부 MASTERLISE', count: 1, points: 26000,
          image: 'assets/products/kimetsu/tier_a.jpg',
          desc: '약 22.5cm · 충주(蟲柱)의 전투 자세' },
        { grade: 'B', label: '츠유리 카나오 MASTERLISE', count: 1, points: 20000,
          image: 'assets/products/kimetsu/tier_b.jpg',
          desc: '약 22.5cm · MASTERLISE 첫 등장' },
        { grade: 'C', label: '도마 MASTERLISE', count: 1, points: 22000,
          image: 'assets/products/kimetsu/tier_c.jpg',
          desc: '약 27cm · 상현의 2, 부채를 든 모습' },
        { grade: 'D', label: '탄지로와 기유의 테치테치 피규어', count: 1, points: 12000,
          image: 'assets/products/kimetsu/tier_d.jpg',
          desc: '약 7cm · 2체 세트 데포르메 피규어' },
        { grade: 'E', label: '메탈릭 비주얼 시트', count: 1, points: 4000,
          image: 'assets/products/kimetsu/tier_e.jpg',
          desc: 'B4 · 전 5종 중 1종 랜덤' },
        { grade: 'F', label: '아크릴 참', count: 1, points: 3500,
          image: 'assets/products/kimetsu/tier_f.jpg',
          desc: '약 4.5cm · 전 11종 중 1종 랜덤' },
        { grade: 'G', label: '포토풍 카드 세트', count: 1, points: 3000,
          image: 'assets/products/kimetsu/tier_g.jpg',
          desc: '약 8cm 3장 세트 · 전 10종 중 1종' },
        { grade: 'H', label: '아크릴 배지', count: 1, points: 2500,
          image: 'assets/products/kimetsu/tier_h.jpg',
          desc: '약 5.5cm · 전 22종 중 1종 랜덤' },
        { grade: 'P', label: '굿즈 포인트 1,200P', count: 152, points: 1200, pointOnly: true,
          desc: '실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료' }
      ],
      lastOneLabel: '라스트원상 · 도마 MASTERLISE 라스트원 ver.',
      lastOneImage: 'assets/products/kimetsu/last_one.jpg',
      lineupImage: 'assets/products/kimetsu/lineup.jpg',
      lastOneDesc: '약 27cm · 두 개의 부채를 든 특별 사양',
      manual: {
        summary: '상현의 2 도마와 충주·카나오가 MASTERLISE로 모인 세트입니다. A~C상이 대형 피규어, D상은 테치테치 2체 세트, E~H상은 시트·참·카드·배지입니다.',
        specs: [
          { k: '시리즈', v: '귀멸의 칼날' },
          { k: '제조사', v: '반다이 스피리츠' },
          { k: '일본 발매', v: '2026.07.30' },
          { k: '일본 판매가', v: '1회 850엔 (세금 포함)' },
          { k: '세트 구성', v: 'A~H상 8종 + 라스트원상 · 총 9종' },
          { k: '이 판 구성', v: '실물 8종 각 1개 + P상 152장 = 160장' },
          { k: '주요 크기', v: 'MASTERLISE 약 22.5~27cm' }
        ],
        lineup: [
          'A상 코초 시노부 MASTERLISE (약 22.5cm)',
          'B상 츠유리 카나오 MASTERLISE (약 22.5cm)',
          'C상 도마 MASTERLISE (약 27cm)',
          'D상 탄지로와 기유의 테치테치 피규어 (약 7cm / 2체 세트)',
          'E상 메탈릭 비주얼 시트 (B4 / 전 5종)',
          'F상 아크릴 참 (약 4.5cm / 전 11종)',
          'G상 포토풍 카드 세트 (약 8cm 3장 / 전 10종)',
          'H상 아크릴 배지 (약 5.5cm / 전 22종)',
          '라스트원상 도마 MASTERLISE 라스트원 ver. (약 27cm)'
        ],
        notes: [
          '이 판은 실제 세트의 A~H상 8종을 등급별로 각 1개씩(실물 8개) 두고, 나머지 152장을 P상(굿즈 포인트 1,200P)으로 채운 총 160장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.',
          'P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.',
          '피규어는 공장 조립·도색 상태에 따라 개체 차이가 있을 수 있습니다.'
        ]
      }
    },
    {
      id: 'b-jujutsu-5th',
      title: '[주술회전] 애니 5주년 FINAL! 쿠지',
      category: '주술회전',
      cover: 'assets/products/jujutsu/cover.jpg',
      price: 12000,
      tickets: 200,
      sold: 0,
      kicker: '5th ANNIVERSARY',
      sub: '이타도리 · 옷코츠 · 고조',
      tiers: [
        { grade: 'A', label: '이타도리 유지 MASTERLISE', count: 1, points: 16000,
          image: 'assets/products/jujutsu/tier_a.jpg',
          desc: '약 23cm · 교복 상의를 벗은 빨간 후드 차림' },
        { grade: 'B', label: '옷코츠 유타 MASTERLISE', count: 1, points: 16000,
          image: 'assets/products/jujutsu/tier_b.jpg',
          desc: '약 24cm · 극장판 0 라스트 신 재현' },
        { grade: 'C', label: '아크릴 보드', count: 1, points: 8000,
          image: 'assets/products/jujutsu/tier_c.jpg',
          desc: '약 30cm · 4개 시리즈 오리지널 일러스트' },
        { grade: 'D', label: '극장판 주술회전 0 빅 아크릴 스탠드', count: 1, points: 6000,
          image: 'assets/products/jujutsu/tier_d.jpg',
          desc: '약 17cm · 전 2종 중 1종 (옷코츠·이누마키)' },
        { grade: 'E', label: '회옥·옥절 빅 아크릴 스탠드', count: 1, points: 6000,
          image: 'assets/products/jujutsu/tier_e.jpg',
          desc: '약 17~18cm · 전 2종 중 1종 (고조·게토)' },
        { grade: 'F', label: '시부야 사변 빅 아크릴 스탠드', count: 1, points: 6000,
          image: 'assets/products/jujutsu/tier_f.jpg',
          desc: '약 18~19cm · 전 2종 중 1종 (후시구로·나나미)' },
        { grade: 'G', label: '사멸회유 빅 아크릴 스탠드', count: 1, points: 6000,
          image: 'assets/products/jujutsu/tier_g.jpg',
          desc: '약 18cm · 전 2종 중 1종 (이타도리·쵸소)' },
        { grade: 'H', label: '아크릴 배지', count: 1, points: 2500,
          image: 'assets/products/jujutsu/tier_h.jpg',
          desc: '약 5~10cm · 전 28종 중 1종 랜덤' },
        { grade: 'I', label: '클리어 포스터', count: 1, points: 3000,
          image: 'assets/products/jujutsu/tier_i.jpg',
          desc: 'A3 · 전 11종 중 1종 랜덤' },
        { grade: 'J', label: '러버 참', count: 1, points: 2500,
          image: 'assets/products/jujutsu/tier_j.jpg',
          desc: '약 6cm · 전 17종 중 1종 랜덤' },
        { grade: 'P', label: '굿즈 포인트 1,200P', count: 190, points: 1200, pointOnly: true,
          desc: '실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료' }
      ],
      lastOneLabel: '라스트원상 · 고조 사토루 MASTERLISE',
      lastOneImage: 'assets/products/jujutsu/last_one.jpg',
      lineupImage: 'assets/products/jujutsu/lineup.jpg',
      lastOneDesc: '약 17cm · "뭐 웃고 있는 거예요" … "별로♡" 장면',
      manual: {
        summary: 'TV 애니 5주년을 마무리하는 최종 세트입니다. A·B상이 이타도리·옷코츠 MASTERLISE 피규어이고, C~G상은 시리즈별 오리지널 일러스트 빅 아크릴, H~J상은 배지·포스터·러버 참입니다.',
        specs: [
          { k: '시리즈', v: '주술회전 (TV 애니메이션)' },
          { k: '제조사', v: '반다이 스피리츠' },
          { k: '일본 발매', v: '2026.09.26' },
          { k: '일본 판매가', v: '1회 800엔 (세금 포함)' },
          { k: '세트 구성', v: 'A~J상 10종 + 라스트원상 · 총 11종' },
          { k: '이 판 구성', v: '실물 10종 각 1개 + P상 190장 = 200장' },
          { k: '주요 크기', v: 'MASTERLISE 약 23~24cm · 아크릴 약 17~30cm' }
        ],
        lineup: [
          'A상 이타도리 유지 MASTERLISE (약 23cm)',
          'B상 옷코츠 유타 MASTERLISE (약 24cm)',
          'C상 아크릴 보드 (약 30cm)',
          'D상 극장판 주술회전 0 빅 아크릴 스탠드 (약 17cm / 전 2종)',
          'E상 회옥·옥절 빅 아크릴 스탠드 (약 17~18cm / 전 2종)',
          'F상 시부야 사변 빅 아크릴 스탠드 (약 18~19cm / 전 2종)',
          'G상 사멸회유 빅 아크릴 스탠드 (약 18cm / 전 2종)',
          'H상 아크릴 배지 (약 5~10cm / 전 28종)',
          'I상 클리어 포스터 (A3 / 전 11종)',
          'J상 러버 참 (약 6cm / 전 17종)',
          '라스트원상 고조 사토루 MASTERLISE (약 17cm)'
        ],
        notes: [
          '이 판은 실제 세트의 A~J상 10종을 등급별로 각 1개씩(실물 10개) 두고, 나머지 190장을 P상(굿즈 포인트 1,200P)으로 채운 총 200장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.',
          'P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.',
          '클리어 포스터는 A3 크기로, 배송 시 접히지 않도록 원통 포장됩니다.'
        ]
      }
    },
    {
      id: 'b-myhero-best',
      title: '[나의 히어로 아카데미아] 최고의 히어로가 되기까지의 이야기 쿠지',
      category: '나의 히어로 아카데미아',
      cover: 'assets/products/myhero/cover.jpg',
      price: 12000,
      tickets: 180,
      sold: 0,
      kicker: '10th ANNIVERSARY',
      sub: '데쿠 · 올마이트 · 바쿠고',
      tiers: [
        { grade: 'A', label: '미도리야 이즈쿠 & 올마이트 MASTERLISE PLUS', count: 1, points: 30000,
          image: 'assets/products/myhero/tier_a.jpg',
          desc: '올마이트 약 27cm · 이즈쿠 약 5cm 2체 세트' },
        { grade: 'B', label: '바쿠고 카츠키 MASTERLISE', count: 1, points: 22000,
          image: 'assets/products/myhero/tier_b.jpg',
          desc: '약 24cm · 유에이 입학 직후 교복 차림' },
        { grade: 'C', label: '아이자와 쇼타 MASTERLISE', count: 1, points: 18000,
          image: 'assets/products/myhero/tier_c.jpg',
          desc: '약 26cm · 1-A 담임 이레이저 헤드' },
        { grade: 'D', label: '네즈 교장 MASTERLISE', count: 1, points: 12000,
          image: 'assets/products/myhero/tier_d.jpg',
          desc: '약 12cm · 첫 입체화' },
        { grade: 'E', label: '이즈쿠: 오리진 MASTERLISE', count: 1, points: 10000,
          image: 'assets/products/myhero/tier_e.jpg',
          desc: '본체 약 7cm(의자 포함 약 17cm) · 어린 시절 데쿠' },
        { grade: 'F', label: '올마이트 인형 피규어 MASTERELIVE COLLECTION', count: 1, points: 8000,
          image: 'assets/products/myhero/tier_f.jpg',
          desc: '약 15cm · 어린 데쿠가 쥐고 있던 소프비 인형' },
        { grade: 'G', label: 'A조 집합 아크릴 스탠드', count: 1, points: 4000,
          image: 'assets/products/myhero/tier_g.jpg',
          desc: '약 7~14cm · 에필로그 비주얼 / 전 24종' },
        { grade: 'H', label: '유에이 아이템 컬렉션', count: 1, points: 3500,
          image: 'assets/products/myhero/tier_h.jpg',
          desc: '학생수첩풍 케이스 약 11cm·핀 배지 / 전 7종' },
        { grade: 'I', label: '스테이셔너리 컬렉션', count: 1, points: 3000,
          image: 'assets/products/myhero/tier_i.jpg',
          desc: '메모·엽서 3장·학생증풍 카드 5장 / 전 8종' },
        { grade: 'P', label: '굿즈 포인트 1,200P', count: 171, points: 1200, pointOnly: true,
          desc: '실물 대신 굿즈 포인트 1,200P 바로 적립 · 10번 모이면 한 판 무료' }
      ],
      lastOneLabel: '라스트원상 · 미도리야 이즈쿠 -10th ANNIVERSARY- MASTERLISE',
      lastOneImage: 'assets/products/myhero/last_one.jpg',
      lineupImage: 'assets/products/myhero/lineup.jpg',
      lastOneDesc: '약 21cm · 애니 10주년 로고를 이미지한 기념 피규어',
      manual: {
        summary: '애니 10주년을 기념해 "최고의 히어로가 되기까지의 이야기"를 따라가는 세트입니다. A~F상이 전부 피규어이고, G~I상은 아크릴 스탠드·유에이 아이템·문구입니다.',
        specs: [
          { k: '시리즈', v: '나의 히어로 아카데미아' },
          { k: '제조사', v: '반다이 스피리츠' },
          { k: '일본 발매', v: '2026.09.12' },
          { k: '일본 판매가', v: '1회 790엔 (세금 포함)' },
          { k: '세트 구성', v: 'A~I상 9종 + 라스트원상 · 총 10종' },
          { k: '이 판 구성', v: '실물 9종 각 1개 + P상 171장 = 180장' },
          { k: '주요 크기', v: 'MASTERLISE 약 12~27cm · 라스트원 약 21cm' }
        ],
        lineup: [
          'A상 미도리야 이즈쿠 & 올마이트 MASTERLISE PLUS (올마이트 약 27cm·이즈쿠 약 5cm)',
          'B상 바쿠고 카츠키 MASTERLISE (약 24cm)',
          'C상 아이자와 쇼타 MASTERLISE (약 26cm)',
          'D상 네즈 교장 MASTERLISE (약 12cm)',
          'E상 이즈쿠: 오리진 MASTERLISE (본체 약 7cm·의자 포함 약 17cm)',
          'F상 올마이트 인형 피규어 MASTERELIVE COLLECTION (약 15cm)',
          'G상 A조 집합 아크릴 스탠드 (약 7~14cm / 전 24종)',
          'H상 유에이 아이템 컬렉션 (케이스 약 11cm·핀 배지 / 전 7종)',
          'I상 스테이셔너리 컬렉션 (메모·엽서·학생증풍 카드 / 전 8종)',
          '라스트원상 미도리야 이즈쿠 -10th ANNIVERSARY- MASTERLISE (약 21cm)'
        ],
        notes: [
          '이 판은 실제 세트의 A~I상 9종을 등급별로 각 1개씩(실물 9개) 두고, 나머지 171장을 P상(굿즈 포인트 1,200P)으로 채운 총 180장입니다. 실물에 당첨되면 해당 등급의 여러 종 중 1종이 랜덤으로 지급됩니다.',
          'P상은 실물 대신 굿즈 포인트 1,200P가 즉시 적립됩니다. 12,000P를 모으면 이 판을 한 번 더 뽑을 수 있어요.',
          'A상은 올마이트와 이즈쿠 2체 세트로, 일반 상품과 별도 박스로 발송됩니다.'
        ]
      }
    }
  ];

  var COVER_PRESETS = [
    { label: '드래곤볼 SPIRIT OF THE SAIYAN', url: 'assets/products/dragonball-saiyan/cover.jpg' },
    { label: '헌터×헌터 키메라 앤트 ②', url: 'assets/products/hunter-chimera-ant/cover.jpg' },
    { label: '죠죠 The Gathering of RIVALS', url: 'assets/products/jojo-rivals/cover.jpg' },
    { label: '약사의 혼잣말 망비의 비보', url: 'assets/products/apothecary-secret/cover.jpg' },
    { label: '치이카와 포근포근 치이카와의 탕', url: 'assets/products/chiikawa/cover.jpg' },
    { label: '귀멸의 칼날 상현의 2', url: 'assets/products/kimetsu/cover.jpg' },
    { label: '주술회전 애니 5주년 FINAL!', url: 'assets/products/jujutsu/cover.jpg' },
    { label: '나의 히어로 아카데미아 최고의 히어로', url: 'assets/products/myhero/cover.jpg' }
  ];

  var SEED_BUYERS = ['박*남', '김**영', '이*우', '최*아', '정*호', '한*지', '윤*빈', '강*민', '오*서', '임**준', '서*진', '문*혁'];

  function normalizeTiers(tiers) {
    return (tiers || []).map(function (t) {
      var row = { grade: t.grade, label: t.label, count: Number(t.count) || 0, points: Number(t.points) || 0 };
      if (t.pointOnly) row.pointOnly = true;
      if (t.points_awarded) row.points_awarded = Number(t.points_awarded) || 0;
      if (t.image) row.image = String(t.image);
      if (t.desc) row.desc = String(t.desc);
      return row;
    });
  }
  function manualOf(board) {
    var m = board && board.manual;
    return (m && typeof m === 'object') ? m : {};
  }
  function tierStructureKey(tiers) {
    return (tiers || []).map(function (t) { return t.grade + ':' + Number(t.count || 0); }).join(',');
  }
  function tierOf(board, grade) {
    for (var i = 0; i < board.tiers.length; i++) if (board.tiers[i].grade === grade) return board.tiers[i];
    return null;
  }
  function hasPointTier(board) {
    return (board.tiers || []).some(function (t) {
      return !!t.pointOnly || String(t.grade).toUpperCase() === 'P' || Number(t.points_awarded || 0) > 0;
    });
  }
  function remaining(board) {
    var sold = Array.isArray(board.opens) ? board.opens.length : 0;
    return Math.max(0, board.tickets - sold);
  }
  function openedCount(board) { return Array.isArray(board.opens) ? board.opens.length : 0; }
  /* 품절임박: 열린 판인데 남은 번호가 30% 미만 */
  function isLowStock(board) {
    var left = remaining(board);
    var total = Number(board.tickets || 0);
    return board.status === 'open' && left > 0 && total > 0 && (left / total) < 0.3;
  }
  /* 라스트원 상태 — 획득자(있으면) / 마지막 5장 이하 임박 */
  function lastOneStatus(board) {
    if (!board || !board.lastOneLabel) return null;
    if (board.lastOneWinnerName) return { won: true, name: board.lastOneWinnerName, at: board.lastOneWonAt || '' };
    var left = remaining(board);
    if (board.status === 'open' && left > 0 && left <= 5) return { soon: true, left: left };
    return null;
  }
  function tierSum(board) {
    return board.tiers.reduce(function (s, t) { return s + Number(t.count || 0); }, 0);
  }
  function isRevealed(board) { return remaining(board) === 0 || board.status === 'closed'; }
  /* 품절·종료 판 — 홈 목록에서 맨 뒤로 밀고 흑백 처리한다 */
  function isFinishedBoard(board) { return remaining(board) === 0 || board.status !== 'open'; }
  function getBoard(id) {
    for (var i = 0; i < state.boards.length; i++) if (state.boards[i].id === id) return state.boards[i];
    return null;
  }
  function firstBoard() {
    var open = state.boards.filter(function (b) { return b.status === 'open'; });
    return open[0] || state.boards[0] || null;
  }
  function userById(id) {
    for (var i = 0; i < (state.users || []).length; i++) if (state.users[i].id === id) return state.users[i];
    return null;
  }
  function me() { return state.me || null; }

  /* ---------- 번호별 결과 계산 (JS / SQL 동일 규칙) ---------- */
  function computeMapping(seed, tickets, tiers) {
    var jobs = [];
    for (var n = 1; n <= tickets; n++) jobs.push(sha256Hex(seed + ':' + n));
    return Promise.all(jobs).then(function (hashes) {
      var ranks = hashes.map(function (hash, idx) { return { n: idx + 1, hash: hash }; });
      ranks.sort(function (a, b) { return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0; });
      var map = {};
      var i = 0;
      tiers.forEach(function (t) {
        for (var k = 0; k < Number(t.count || 0) && i < ranks.length; k++) { map[ranks[i].n] = t.grade; i++; }
      });
      var fallback = tiers.length ? tiers[tiers.length - 1].grade : 'E';
      for (var n2 = 1; n2 <= tickets; n2++) if (!map[n2]) map[n2] = fallback;
      return map;
    });
  }
  function getMapping(board) {
    var key = [board.id, board.seed, board.tickets, board.tiers.map(function (t) {
      return t.grade + ':' + t.count;
    }).join(',')].join('|');
    if (mapCache.has(key)) return Promise.resolve(mapCache.get(key));
    return computeMapping(board.seed, board.tickets, board.tiers).then(function (map) {
      mapCache.set(key, map);
      return map;
    });
  }

  /* ---------- 시드 데이터 ---------- */
  async function seedState() {
    var s = emptyState();
    var pinHash = await sha256Hex('0000');
    s.settings.pinHash = pinHash;

    var now = Date.now();
    var demoHash = await sha256Hex('kujiking:demo@kujiking.co.kr:demo1234');
    var marmelHash = await sha256Hex('kujiking:marmel@example.com:marmel1234');

    s.users = [
      { id: 'u-demo', email: 'demo@kujiking.co.kr', nickname: '쿠지러버', phone: '010-1234-5678', pwHash: demoHash, points: 3000, createdAt: new Date(now - 86400000 * 6).toISOString() },
      { id: 'u-marmel', email: 'marmel@example.com', nickname: '마멜좋아', phone: '010-2345-6789', pwHash: marmelHash, points: 0, createdAt: new Date(now - 86400000 * 3).toISOString() }
    ];

    var boards = [];
    for (var b = 0; b < SEED_SPECS.length; b++) {
      var spec = SEED_SPECS[b];
      var seed = randomSeed();
      var hash = await sha256Hex(seed);
      var board = {
        id: spec.id,
        title: spec.title,
        category: spec.category,
        price: spec.price,
        tickets: spec.tickets,
        tiers: spec.tiers,
        lastOneLabel: spec.lastOneLabel,
        lastOneImage: spec.lastOneImage || '',
        lastOneDesc: spec.lastOneDesc || '',
        manual: spec.manual || null,
        kicker: spec.kicker,
        sub: spec.sub,
        cover: spec.cover || '',
        status: 'open',
        seed: seed,
        seedHash: hash,
        opens: [],
        createdAt: new Date(now - 86400000 * (8 - b)).toISOString(),
        sealedAt: new Date(now - 86400000 * (8 - b)).toISOString()
      };
      var map = await computeMapping(board.seed, board.tickets, board.tiers);

      var pool = [];
      for (var n = 1; n <= board.tickets; n++) pool.push(n);
      for (var k = pool.length - 1; k > 0; k--) {
        var j = randInt(k + 1);
        var tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp;
      }
      var sold = Math.min(spec.sold, board.tickets);
      for (var i = 0; i < sold; i++) {
        var no = pool[i];
        var at = new Date(now - (sold - i) * (1000 * 60 * 47) - randInt(1000 * 60 * 30)).toISOString();
        board.opens.push({
          n: no,
          grade: map[no],
          at: at,
          name: SEED_BUYERS[(i * 3 + b) % SEED_BUYERS.length],
          userId: null,
          demo: false,
          last: false
        });
      }
      board.opens.sort(function (x, y) { return new Date(y.at) - new Date(x.at); });
      boards.push(board);
    }
    s.boards = boards;

    /* 체험 계정의 실제 보관함 (보관중 1건 + 배송요청 1건) */
    var sanrio = boards[1];
    var onePiece = boards[0];
    function firstPhysical(b) {
      var phys = (b.opens || []).filter(function (o) { return String(o.grade || '').toUpperCase() !== 'P'; })[0];
      if (phys) return phys;
      /* 판매 기록에 실물이 하나도 없으면(데모 데이터) 보관함 예시를 위해 한 장을 실물로 바꿔 둔다 */
      var o = (b.opens || [])[0];
      var t = (b.tiers || []).filter(function (x) { return !x.pointOnly && String(x.grade).toUpperCase() !== 'P'; })[0];
      if (o && t) o.grade = t.grade;
      return o || null;
    }
    var inv1 = firstPhysical(sanrio);
    if (inv1) {
      inv1.name = maskName('쿠지러버');
      inv1.userId = 'u-demo';
      var t1 = tierOf(sanrio, inv1.grade);
      s.draws.push({
        id: 'd-demo-1', boardId: sanrio.id, n: inv1.n, userId: 'u-demo',
        grade: inv1.grade, tierLabel: t1 ? t1.label : '', points: 0,
        itemStatus: '보관중', source: 'coupon', at: inv1.at, deliveryId: null, last: false
      });
    }
    var inv2 = firstPhysical(onePiece);
    if (inv2) {
      inv2.name = maskName('쿠지러버');
      inv2.userId = 'u-demo';
      var t2 = tierOf(onePiece, inv2.grade);
      s.draws.push({
        id: 'd-demo-2', boardId: onePiece.id, n: inv2.n, userId: 'u-demo',
        grade: inv2.grade, tierLabel: t2 ? t2.label : '', points: 0,
        itemStatus: '배송신청', source: 'coupon', at: inv2.at, deliveryId: 'dl-demo-1', last: false
      });
      s.deliveries.push({
        id: 'dl-demo-1', userId: 'u-demo', drawId: 'd-demo-2', boardId: onePiece.id,
        itemLabel: t2 ? t2.label : '', grade: inv2.grade,
        recipient: '쿠지러버', phone: '010-1234-5678', postcode: '05510',
        address: '서울특별시 송파구 올림픽로 300, 101동 1001호', memo: '문 앞에 놓아주세요',
        carrier: null, tracking: null, status: '요청',
        requestedAt: new Date(now - 86400000).toISOString(), shippedAt: null
      });
    }

    /* 체험 계정 쿠폰: 전체 사용 2장 + 산리오 전용 1장 */
    s.coupons.push(
      { id: 'cp-demo-1', userId: 'u-demo', boardId: null, kind: 'universal', label: '모든 판 뽑기권', note: '오픈 기념 지급', grantedAt: new Date(now - 86400000).toISOString(), usedAt: null, usedDrawId: null },
      { id: 'cp-demo-2', userId: 'u-demo', boardId: null, kind: 'universal', label: '모든 판 뽑기권', note: '오픈 기념 지급', grantedAt: new Date(now - 86400000).toISOString(), usedAt: null, usedDrawId: null },
      { id: 'cp-demo-3', userId: 'u-demo', boardId: 'b-sanrio', kind: 'board', label: '산리오 전용 뽑기권', note: '구매확인 승인 · 스마트스토어 20261118-0001', grantedAt: new Date(now - 3600000 * 5).toISOString(), usedAt: null, usedDrawId: null }
    );

    /* 관리자 화면용 대기 중 구매확인 요청 1건 */
    s.claims.push({
      id: 'cl-seed-1', userId: 'u-marmel', boardId: 'b-sanrio',
      channel: '스마트스토어', orderNo: '20261122-8842137', qty: 3, amount: 29700,
      memo: '어제 밤에 결제했어요', status: 'pending', granted: 0,
      at: new Date(now - 3600000 * 9).toISOString(), decidedAt: null
    });

    return s;
  }

  function loadLocalStateSync() {
    var raw;
    try { raw = localStorage.getItem(STATE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== STATE_VERSION || !Array.isArray(parsed.boards)) return null;
      return parsed;
    } catch (e) { return null; }
  }

  async function loadLocalState() {
    var existing = loadLocalStateSync();
    if (existing) return normalizeLocalState(existing);

    var fresh = await seedState();
    migrateV1(fresh);
    saveLocal(fresh);
    return fresh;
  }

  function normalizeLocalState(s) {
    s.settings = Object.assign({ demoCode: 'DEMO-KUJI', pinHash: '', pinChanged: false, storeName: '쿠지킹', youtubeLiveUrl: '', youtubeLiveEnabled: true, kakaoOpenchatUrl: KAKAO_CHAT_URL, shippingFeeNotice: '' }, s.settings || {});
    s.users = s.users || [];
    s.coupons = s.coupons || [];
    s.draws = s.draws || [];
    s.claims = s.claims || [];
    s.deliveries = s.deliveries || [];
    s.codes = s.codes || [];
    s.boards.forEach(function (b) {
      if (!Array.isArray(b.opens)) b.opens = [];
      if (!b.category) b.category = '자체 스페셜';
    });
    return s;
  }

  /* v1(프로토타입) 데이터가 있으면 판·코드만 살려서 옮겨옵니다. */
  function migrateV1(fresh) {
    var raw;
    try { raw = localStorage.getItem(STATE_KEY_V1); } catch (e) { return; }
    if (!raw) return;
    var old;
    try { old = JSON.parse(raw); } catch (e) { return; }
    if (!old || !Array.isArray(old.boards)) return;

    var moved = 0;
    old.boards.forEach(function (b) {
      if (!b || b.id === 'b-open-1') return; /* v1 기본 데모 판은 새 시드로 대체 */
      if (fresh.boards.some(function (x) { return x.id === b.id; })) return;
      fresh.boards.push({
        id: b.id,
        title: b.title || '이전 판',
        category: (b.tag && CATEGORIES.indexOf(b.tag) !== -1) ? b.tag : '자체 스페셜',
        price: Number(b.price) || 9900,
        tickets: Number(b.tickets) || 80,
        tiers: b.tiers || [],
        lastOneLabel: b.lastOneLabel || '라스트원상',
        status: b.status || 'open',
        seed: b.seed || randomSeed(),
        seedHash: b.seedHash || '',
        opens: (b.opens || []).map(function (o) {
          return { n: o.n, grade: o.grade, at: o.at, name: '이전 기록', userId: null, demo: !!o.demo, last: !!o.last };
        }),
        createdAt: b.createdAt || nowISO(),
        sealedAt: b.sealedAt || b.createdAt || nowISO()
      });
      moved++;
    });
    if (Array.isArray(old.codes)) {
      old.codes.forEach(function (c) {
        if (!c || !c.code) return;
        if (fresh.codes.some(function (x) { return x.code === c.code; })) return;
        fresh.codes.push({
          code: c.code, boardId: c.boardId || null, createdAt: c.createdAt || nowISO(),
          usedAt: c.usedAt || null, usedN: c.usedN || null, usedBy: null, demo: !!c.demo
        });
      });
    }
    if (moved) setTimeout(function () { toast('이전 버전의 판 ' + moved + '개를 그대로 옮겨왔어요', 'ok'); }, 900);
  }

  function saveLocal(s) {
    var src = s || state;
    if (!src) return;
    var clean = {
      v: STATE_VERSION,
      settings: src.settings,
      boards: src.boards,
      users: src.users,
      coupons: src.coupons,
      draws: src.draws,
      claims: src.claims,
      deliveries: src.deliveries,
      codes: src.codes,
      session: src.session,
      updatedAt: nowISO()
    };
    try { localStorage.setItem(STATE_KEY, JSON.stringify(clean)); }
    catch (e) { toast('저장 공간이 부족해 저장하지 못했어요', 'err'); }
  }
  function persist() {
    if (Backend.mode !== 'local') return;
    saveLocal();
    broadcast();
  }

  var channel = null;
  function broadcast() {
    try {
      if (!channel && typeof BroadcastChannel === 'function') channel = new BroadcastChannel('kujiking-v2');
      if (channel) channel.postMessage({ type: 'changed', at: Date.now() });
    } catch (e) { /* 무시 */ }
  }

  /* =========================================================
     3. 백엔드 (localStorage ↔ Supabase)
     ========================================================= */
  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message || 'timeout')); }, ms);
      Promise.resolve(promise).then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('script load failed: ' + src)); };
      document.head.appendChild(el);
    });
  }

  var Backend = {
    mode: 'local',
    classify(e) {
      var detail = (e && (e.message || e.error_description || e.details)) || String(e || '');
      var test = String((e && (e.code || '')) + ' ' + detail);
      if (/PGRST205|Could not find the table|does not exist|schema cache/i.test(test)) return 'missing_tables';
      if (/Failed to fetch|NetworkError|Load failed|script load failed|timeout/i.test(test)) return 'network';
      return 'error';
    },
    sb: null,
    config: null,
    justFellBack: false,
    fallbackReason: '',
    fallbackDetail: '',

    /* 연결 확인은 잠깐 끊긴 네트워크 때문에 바로 포기하지 않도록 한 번 더 시도한다 */
    async probeWithRetry() {
      var last = null;
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          var res = await withTimeout(this.sb.from('boards').select('id').limit(1), 7000, 'Failed to fetch: timeout');
          if (!res.error) return res;
          last = res;
          if (this.classify(res.error) === 'missing_tables') return res;
        } catch (e) {
          last = { error: e };
          if (this.classify(e) === 'missing_tables') return last;
        }
        if (attempt === 0) await new Promise(function (resolve) { setTimeout(resolve, 700); });
      }
      return last || { error: new Error('Failed to fetch: probe') };
    },

    async init() {
      var cfg = (window.KUJI_CONFIG || {});
      this.config = cfg;
      if (cfg.FORCE_DEMO) { this.fallbackReason = 'forced'; return 'local'; }
      if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) { this.fallbackReason = 'no_config'; return 'local'; }
      try {
        await withTimeout(loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'), 7000, 'script load failed: timeout');
        if (!window.supabase || !window.supabase.createClient) throw new Error('supabase-js unavailable');
        this.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
          auth: { persistSession: true, autoRefreshToken: true }
        });
        var probe = await this.probeWithRetry();
        if (probe.error) throw probe.error;
        this.mode = 'supabase';
        this.subscribe();
        return 'supabase';
      } catch (e) {
        console.warn('[쿠지킹] Supabase 연결에 실패해 데모 모드로 실행합니다.', e);
        this.mode = 'local';
        this.justFellBack = true;
        this.fallbackDetail = (e && (e.message || e.error_description || e.details)) || String(e || '');
        this.fallbackReason = this.classify(e);
        return 'local';
      }
    },

    /* ---------- 공통 ---------- */
    async refreshData() {
      if (this.mode === 'local') { buildLocalViews(); return; }
      var sb = this.sb;

      var sess = await sb.auth.getSession();
      var session = sess && sess.data ? sess.data.session : null;
      var myId = session && session.user ? session.user.id : null;

      var boardsRes = await sb.from('boards').select('*').order('created_at', { ascending: false });
      if (boardsRes.error) throw boardsRes.error;
      var boards = (boardsRes.data || []).map(function (b) {
        var tiers = Array.isArray(b.tiers) ? b.tiers : [];
        return {
          id: b.id, title: b.title, category: b.category || '자체 스페셜',
          price: b.price, tickets: b.ticket_count, tiers: tiers,
          lastOneLabel: b.last_one_label, status: b.status, cover: b.cover || '',
          lastOneImage: b.last_one_image || '', lastOneDesc: b.last_one_desc || '', manual: b.manual || null,
          lineupImage: (b.manual && b.manual.image) || '',
          lastOneWinnerId: b.last_one_winner_id || '', lastOneWinnerName: b.last_one_winner_name || '',
          lastOneWonAt: b.last_one_won_at || '',
          seed: b.seed, seedHash: b.seed_hash,
          createdAt: b.created_at, sealedAt: b.sealed_at, opens: []
        };
      });

      if (boards.length) {
        var ids = boards.map(function (b) { return b.id; });
        var tkRes = await sb.from('tickets')
          .select('board_id,n,status,buyer_name,grade,drawn_at,is_last')
          .in('board_id', ids).eq('status', 'sold');
        /* is_last 컬럼이 아직 없는 DB(마이그레이션 전)에서도 판매 내역이 보이도록 한 번 더 */
        if (tkRes.error) {
          tkRes = await sb.from('tickets')
            .select('board_id,n,status,buyer_name,grade,drawn_at')
            .in('board_id', ids).eq('status', 'sold');
        }
        if (!tkRes.error && tkRes.data) {
          var byBoard = {};
          tkRes.data.forEach(function (t) {
            (byBoard[t.board_id] = byBoard[t.board_id] || []).push({
              n: t.n, grade: t.grade, at: t.drawn_at, name: t.buyer_name || '익명',
              userId: null, demo: false, last: !!t.is_last
            });
          });
          boards.forEach(function (b) {
            b.opens = (byBoard[b.id] || []).sort(function (x, y) { return new Date(y.at) - new Date(x.at); });
          });
        }
      }
      state.boards = boards;
      state.loadError = '';

      var setRes = await sb.from('app_settings').select('key,value').in('key', ['demo_code', 'youtube_live_url', 'youtube_live_enabled', 'kakao_openchat_url', 'shipping_fee_notice']);
      if (!setRes.error && setRes.data) {
        var settingsMap = {};
        setRes.data.forEach(function (row) { settingsMap[row.key] = row.value; });
        if (settingsMap.demo_code) state.settings.demoCode = settingsMap.demo_code;
        if (typeof settingsMap.youtube_live_url === 'string') state.settings.youtubeLiveUrl = settingsMap.youtube_live_url;
        if (typeof settingsMap.youtube_live_enabled === 'string') {
          state.settings.youtubeLiveEnabled = !/^(false|0|off|no)$/i.test(settingsMap.youtube_live_enabled.trim());
        }
        if (typeof settingsMap.kakao_openchat_url === 'string' && settingsMap.kakao_openchat_url.trim()) state.settings.kakaoOpenchatUrl = settingsMap.kakao_openchat_url;
        if (typeof settingsMap.shipping_fee_notice === 'string') state.settings.shippingFeeNotice = settingsMap.shipping_fee_notice;
      }

      if (myId) {
        var profRes = await sb.from('profiles').select('*').eq('id', myId).single();
        var p = profRes.data || {};
        state.me = {
          id: myId, email: p.email || (session.user.email || ''), nickname: p.nickname || '쿠지팬',
          phone: p.phone || '', points: p.points || 0, isAdmin: !!p.is_admin,
          createdAt: p.created_at
        };

        var cRes = await sb.from('coupons').select('*').eq('user_id', myId).order('granted_at', { ascending: false });
        state.myCoupons = (cRes.data || []).map(function (c) {
          return { id: c.id, userId: c.user_id, boardId: c.board_id, kind: c.kind, label: c.label, note: c.note, grantedAt: c.granted_at, usedAt: c.used_at, usedDrawId: c.used_draw_id };
        });

        var dRes = await sb.from('draws').select('*').eq('user_id', myId).order('created_at', { ascending: false });
        state.myDraws = (dRes.data || []).map(function (d) {
          return { id: d.id, boardId: d.board_id, n: d.n, userId: d.user_id, grade: d.grade, tierLabel: d.tier_label, points: d.points, itemStatus: d.item_status, source: d.source, at: d.created_at, last: d.is_last, lastOne: !!d.is_last_one };
        });

        var clRes = await sb.from('purchase_claims').select('*').eq('user_id', myId).order('created_at', { ascending: false });
        state.myClaims = (clRes.data || []).map(mapClaim);

        var dlRes = await sb.from('deliveries').select('*').eq('user_id', myId).order('requested_at', { ascending: false });
        state.myDeliveries = (dlRes.data || []).map(mapDelivery);

        state.coupons = state.myCoupons;
        state.draws = state.myDraws;
        state.claims = state.myClaims;
        state.deliveries = state.myDeliveries;
      } else {
        state.me = null;
        state.myCoupons = []; state.myDraws = []; state.myClaims = []; state.myDeliveries = [];
        state.coupons = []; state.draws = []; state.claims = []; state.deliveries = [];
      }
    },

    async loadAdmin() {
      if (this.mode === 'local') {
        buildLocalViews();
        return;
      }
      var sb = this.sb;
      state.adminLoaded = false;
      state.adminError = null;
      var mRes = await sb.rpc('admin_members', { p_search: ui.memberQuery || '' });
      /* 서버 함수(admin_members)가 없거나 실패해도 목록이 0명으로 보이지 않도록 테이블 직접 조회로 대체합니다.
         (profiles·coupons 모두 is_admin() RLS 로 관리자는 전체를 읽을 수 있습니다) */
      if (mRes.error) {
        console.warn('[admin] admin_members RPC 실패 → 테이블 직접 조회로 대체', mRes.error);
        mRes = await this.loadAdminMembersFromTables();
      }
      state.adminError = mRes.error ? errMsg(mRes.error) : null;
      state.adminLoaded = true;
      state.adminMembers = (mRes.data || []).map(function (m) {
        return { id: m.id, nickname: m.nickname, email: m.email, phone: m.phone, points: m.points, isAdmin: m.is_admin, createdAt: m.created_at, couponCount: m.coupons, drawCount: m.draws };
      });
      var cRes = await sb.from('purchase_claims')
        .select('*, profiles:user_id(nickname,phone)')
        .order('created_at', { ascending: false }).limit(200);
      state.adminClaims = (cRes.data || []).map(function (c) {
        var row = mapClaim(c);
        row.nickname = c.profiles ? c.profiles.nickname : '';
        row.phone = c.profiles ? c.profiles.phone : '';
        return row;
      });
      var dRes = await sb.from('deliveries')
        .select('*, profiles:user_id(nickname,phone)')
        .order('requested_at', { ascending: false }).limit(200);
      state.adminDeliveries = (dRes.data || []).map(function (d) {
        var row = mapDelivery(d);
        row.nickname = d.profiles ? d.profiles.nickname : '';
        row.phone = d.profiles ? d.profiles.phone : '';
        return row;
      });
      var codeRes = await sb.from('exchange_codes').select('code,board_id,created_at,used_at,used_n').order('created_at', { ascending: false }).limit(500);
      if (!codeRes.error) {
        state.codes = (codeRes.data || []).map(function (c) {
          return { code: c.code, boardId: c.board_id, createdAt: c.created_at, usedAt: c.used_at, usedN: c.used_n, usedBy: null, demo: false };
        });
      }
      state.adminLoaded = true;
    },

    /* admin_members RPC 없이 회원 목록을 직접 만든다 (관리자 RLS 로 전체 조회). */
    async loadAdminMembersFromTables() {
      var sb = this.sb;
      var pRes = await sb.from('profiles')
        .select('id,nickname,email,phone,points,is_admin,created_at')
        .order('created_at', { ascending: false }).limit(500);
      if (pRes.error) return { data: null, error: pRes.error };
      var cRes = await sb.from('coupons').select('user_id').is('used_at', null).limit(5000);
      if (cRes.error) return { data: null, error: cRes.error };
      var dRes = await sb.from('draws').select('user_id').limit(5000);
      var coupons = {}, draws = {};
      (cRes.data || []).forEach(function (r) { coupons[r.user_id] = (coupons[r.user_id] || 0) + 1; });
      ((dRes && dRes.data) || []).forEach(function (r) { draws[r.user_id] = (draws[r.user_id] || 0) + 1; });
      var q = (ui.memberQuery || '').toLowerCase();
      var digits = q.replace(/[^0-9]/g, '');
      var rows = (pRes.data || []).filter(function (p) {
        if (!q) return true;
        return (p.nickname || '').toLowerCase().indexOf(q) !== -1 ||
          (p.email || '').toLowerCase().indexOf(q) !== -1 ||
          (digits !== '' && String(p.phone || '').replace(/[^0-9]/g, '').indexOf(digits) !== -1);
      }).map(function (p) {
        return {
          id: p.id, email: p.email, nickname: p.nickname, phone: p.phone, points: p.points,
          is_admin: p.is_admin, created_at: p.created_at,
          coupons: coupons[p.id] || 0, draws: draws[p.id] || 0
        };
      });
      return { data: rows, error: null };
    },

    /* ---------- 인증 ---------- */
    async signUp(d) {
      /* 가입 도메인 제한은 화면과 서버 호출 양쪽에서 한 번 더 막는다 */
      if (!isAllowedSignupEmail(d && d.email)) throw new Error(SIGNUP_EMAIL_ERROR);
      if (this.mode === 'local') {
        var dup = state.users.some(function (u) { return u.email.toLowerCase() === d.email.toLowerCase(); });
        if (dup) throw new Error('이미 가입된 이메일입니다. 로그인해 주세요.');
        var user = {
          id: uid('u'), email: d.email, nickname: d.nickname, phone: d.phone,
          pwHash: await sha256Hex('kujiking:' + d.email + ':' + d.password),
          points: 0, createdAt: nowISO()
        };
        state.users.push(user);
        state.session = { userId: user.id, at: nowISO() };
        persist();
        buildLocalViews();
        return user;
      }
      var res = await this.sb.auth.signUp({
        email: d.email, password: d.password,
        options: { data: { nickname: d.nickname, phone: d.phone } }
      });
      if (res.error) throw res.error;
      if (!res.data.session) {
        throw new Error('가입 확인 메일을 보냈어요. 메일함에서 인증을 마친 뒤 로그인해 주세요.');
      }
      await this.sb.from('profiles').update({ nickname: d.nickname, phone: d.phone }).eq('id', res.data.user.id);
      await this.refreshData();
      return state.me;
    },

    async signIn(email, password) {
      if (this.mode === 'local') {
        var hash = await sha256Hex('kujiking:' + email + ':' + password);
        var user = state.users.filter(function (u) { return u.email.toLowerCase() === email.toLowerCase(); })[0];
        if (!user || user.pwHash !== hash) throw new Error('이메일 또는 비밀번호가 맞지 않습니다.');
        state.session = { userId: user.id, at: nowISO() };
        persist();
        buildLocalViews();
        return user;
      }
      var res = await this.sb.auth.signInWithPassword({ email: email, password: password });
      if (res.error) throw res.error;
      await this.refreshData();
      return state.me;
    },

    async signOut() {
      if (this.mode === 'local') {
        state.session = null;
        state.me = null;
        persist();
        buildLocalViews();
        return;
      }
      await this.sb.auth.signOut();
      await this.refreshData();
    },

    /* ---------- 뽑기 ---------- */
    async draw(args) {
      if (this.mode === 'local') return localDraw(args);
      var body = {
        p_board_id: args.boardId,
        p_ticket_no: args.n,
        p_coupon_id: args.couponId || null,
        p_code: args.code || null,
        p_use_points: !!args.usePoints
      };
      var res = await this.sb.rpc('draw_ticket', body);
      /* 서버 함수가 아직 v3.5(4인자)라면: 포인트 뽑기가 아닐 땐 기존 인자로 한 번 더 시도해 뽑기가 막히지 않게 한다 */
      if (res.error && /PGRST202|p_use_points|Could not find the function/i.test(String(res.error.code || '') + ' ' + String(res.error.message || ''))) {
        if (args.usePoints) {
          throw new Error('포인트로 뽑기는 서버 준비가 필요해요. 관리자 페이지의 안내대로 supabase/upgrade_points_draw.sql 을 한 번 실행해 주세요.');
        }
        res = await this.sb.rpc('draw_ticket', {
          p_board_id: body.p_board_id,
          p_ticket_no: body.p_ticket_no,
          p_coupon_id: body.p_coupon_id,
          p_code: body.p_code
        });
      }
      if (res.error) throw new Error(res.error.message || '뽑기에 실패했어요.');
      var r = res.data || {};
      return {
        grade: r.grade, tierLabel: r.tier_label, points: r.points || 0,
        itemStatus: r.item_status, isLast: !!r.is_last, remaining: r.remaining,
        lastOneWon: !!r.last_one_won, lastOneLabel: r.last_one_label || '',
        lastOneImage: r.last_one_image || '', lastOneDesc: r.last_one_desc || '',
        lastOneWinnerName: r.last_one_winner_name || '',
        source: r.source, demo: r.source === 'demo', pointsBalance: r.points_balance
      };
    },

    /* ---------- 구매확인 / 배송 / 전환 ---------- */
    async submitClaim(d) {
      if (this.mode === 'local') {
        var claim = {
          id: uid('cl'), userId: state.me.id, boardId: d.boardId || null,
          channel: d.channel, orderNo: d.orderNo, qty: Number(d.qty) || 1,
          amount: Number(d.amount) || 0, memo: d.memo || '', status: 'pending', granted: 0,
          at: nowISO(), decidedAt: null
        };
        state.claims.unshift(claim);
        persist();
        buildLocalViews();
        return claim;
      }
      if (!state.me) throw new Error('로그인이 필요합니다.');
      var res = await this.sb.from('purchase_claims').insert({
        user_id: state.me.id, board_id: d.boardId || null, channel: d.channel,
        order_no: d.orderNo, qty: Number(d.qty) || 1, amount: Number(d.amount) || 0, memo: d.memo || ''
      });
      if (res.error) throw res.error;
      await this.refreshData();
    },

    async decideClaim(id, approve, qty) {
      if (this.mode === 'local') {
        var c = state.claims.filter(function (x) { return x.id === id; })[0];
        if (!c) throw new Error('구매확인 요청을 찾을 수 없습니다.');
        if (c.status !== 'pending') throw new Error('이미 처리된 요청입니다.');
        if (approve) {
          c.status = 'approved';
          c.granted = Number(qty) || c.qty;
          c.decidedAt = nowISO();
          grantLocalCoupons(c.userId, c.boardId, c.granted, '구매확인 승인 · ' + c.channel + ' ' + c.orderNo);
        } else {
          c.status = 'rejected';
          c.granted = 0;
          c.decidedAt = nowISO();
        }
        persist();
        buildLocalViews();
        return c;
      }
      var res = await this.sb.rpc('admin_decide_claim', { p_claim_id: id, p_approve: !!approve, p_qty: Number(qty) || null });
      if (res.error) throw res.error;
      await this.loadAdmin();
    },

    async requestDelivery(drawId, info) {
      if (this.mode === 'local') {
        var d = state.draws.filter(function (x) { return x.id === drawId; })[0];
        if (!d) throw new Error('보관함에서 상품을 찾을 수 없습니다.');
        if (d.itemStatus !== '보관중') throw new Error('이미 배송 신청했거나 전환된 상품입니다.');
        var delivery = {
          id: uid('dl'), userId: d.userId, drawId: d.id, boardId: d.boardId,
          itemLabel: d.tierLabel, grade: d.grade,
          recipient: info.recipient, phone: info.phone, postcode: info.postcode || '',
          address: info.address, memo: info.memo || '', carrier: null, tracking: null,
          status: '요청', requestedAt: nowISO(), shippedAt: null
        };
        state.deliveries.unshift(delivery);
        d.itemStatus = '배송신청';
        d.deliveryId = delivery.id;
        persist();
        buildLocalViews();
        return delivery;
      }
      var res = await this.sb.rpc('request_delivery', {
        p_draw_id: drawId, p_recipient: info.recipient, p_phone: info.phone,
        p_postcode: info.postcode || '', p_address: info.address, p_memo: info.memo || null
      });
      if (res.error) throw res.error;
      await this.refreshData();
    },

    async convertPoints(drawId) {
      if (this.mode === 'local') {
        var d = state.draws.filter(function (x) { return x.id === drawId; })[0];
        if (!d) throw new Error('보관함에서 상품을 찾을 수 없습니다.');
        if (d.itemStatus !== '보관중') throw new Error('이미 배송 신청했거나 전환된 상품입니다.');
        var board = getBoard(d.boardId);
        var tier = board ? tierOf(board, d.grade) : null;
        var points = tier ? Number(tier.points || 0) : 0;
        if (points <= 0) throw new Error('이 상품은 포인트 전환 대상이 아닙니다.');
        var user = userById(d.userId);
        if (user) user.points = (Number(user.points) || 0) + points;
        d.itemStatus = '포인트전환';
        d.points = points;
        persist();
        buildLocalViews();
        return points;
      }
      var res = await this.sb.rpc('convert_to_points', { p_draw_id: drawId });
      if (res.error) throw res.error;
      await this.refreshData();
      return res.data && res.data.points;
    },

    /* ---------- 관리자 ---------- */
    async grantCoupons(userId, boardId, qty, note) {
      if (this.mode === 'local') {
        grantLocalCoupons(userId, boardId, qty, note);
        persist();
        buildLocalViews();
        return;
      }
      var res = await this.sb.rpc('admin_grant_coupons', {
        p_user_id: userId, p_board_id: boardId || null, p_qty: Number(qty), p_note: note || null
      });
      if (res.error) throw res.error;
      await this.loadAdmin();
    },

    /* 관리자: 회원의 미사용 쿠폰 목록 (쿠폰 회수 모달) — 최근 지급분부터 */
    async fetchUserCoupons(userId) {
      if (this.mode === 'local') {
        return state.coupons.filter(function (c) { return c.userId === userId && !c.usedAt; })
          .sort(function (a, b) { return new Date(b.grantedAt) - new Date(a.grantedAt); })
          .map(function (c) {
            return { id: c.id, boardId: c.boardId, kind: c.kind, label: c.label, note: c.note, grantedAt: c.grantedAt };
          });
      }
      var res = await this.sb.from('coupons')
        .select('id,board_id,kind,label,note,granted_at,used_at')
        .eq('user_id', userId).is('used_at', null)
        .order('granted_at', { ascending: false });
      if (res.error) throw res.error;
      return (res.data || []).map(function (c) {
        return { id: c.id, boardId: c.board_id, kind: c.kind, label: c.label, note: c.note, grantedAt: c.granted_at };
      });
    },

    /* 관리자: 미사용 쿠폰 회수(삭제). 그 사이 사용된 쿠폰은 조건(used_at is null)에서 다시 걸러진다. */
    async revokeCoupons(userId, ids) {
      var list = (ids || []).filter(Boolean);
      if (!list.length) throw new Error('회수할 쿠폰을 선택해 주세요.');
      if (this.mode === 'local') {
        var kill = {};
        list.forEach(function (id) { kill[id] = true; });
        var before = state.coupons.length;
        state.coupons = state.coupons.filter(function (c) {
          return !(kill[c.id] && c.userId === userId && !c.usedAt);
        });
        var removed = before - state.coupons.length;
        persist();
        buildLocalViews();
        return removed;
      }
      var res = await this.sb.from('coupons').delete()
        .eq('user_id', userId).in('id', list).is('used_at', null)
        .select('id');
      if (res.error) throw res.error;
      var n = Array.isArray(res.data) ? res.data.length : list.length;
      await this.loadAdmin();
      return n;
    },

    async shipDelivery(id, carrier, tracking) {
      if (this.mode === 'local') {
        var dl = state.deliveries.filter(function (x) { return x.id === id; })[0];
        if (!dl) throw new Error('배송 요청을 찾을 수 없습니다.');
        dl.carrier = carrier;
        dl.tracking = tracking;
        dl.status = '출고완료';
        dl.shippedAt = nowISO();
        var d = state.draws.filter(function (x) { return x.id === dl.drawId; })[0];
        if (d) d.itemStatus = '출고완료';
        persist();
        buildLocalViews();
        return;
      }
      var res = await this.sb.rpc('admin_ship_delivery', {
        p_delivery_id: id, p_carrier: carrier, p_tracking: tracking
      });
      if (res.error) throw res.error;
      await this.loadAdmin();
    },

    async saveBoard(payload) {
      var tiersNorm = normalizeTiers(payload.tiers);
      if (this.mode === 'local') {
        var existing = payload.id ? getBoard(payload.id) : null;
        var seed = payload.seed || (existing ? existing.seed : '') || randomSeed();
        var hash = await sha256Hex(seed);
        var opens = existing ? existing.opens : [];
        var structureChanged = !existing || existing.tickets !== payload.tickets ||
          tierStructureKey(existing.tiers) !== tierStructureKey(tiersNorm) ||
          (!!payload.seed && payload.seed !== existing.seed);
        if (existing && structureChanged) opens = [];
        var board = {
          id: existing ? existing.id : uid('board'),
          title: payload.title, category: payload.category, price: payload.price,
          tickets: payload.tickets, tiers: tiersNorm, lastOneLabel: payload.lastOneLabel,
          lastOneImage: payload.lastOneImage || '', lastOneDesc: payload.lastOneDesc || '',
          manual: payload.manual || null,
          cover: payload.cover || '',
          kicker: payload.kicker || (existing ? existing.kicker : ''),
          sub: payload.sub || (existing ? existing.sub : ''),
          status: payload.status, seed: seed, seedHash: hash, opens: opens,
          createdAt: existing ? existing.createdAt : nowISO(),
          sealedAt: existing ? (structureChanged ? nowISO() : existing.sealedAt) : nowISO()
        };
        if (existing) {
          var idx = state.boards.indexOf(existing);
          state.boards[idx] = board;
        } else {
          state.boards.unshift(board);
        }
        /* 구조가 바뀌면 연결된 뽑기 기록도 정리 */
        if (existing && structureChanged) {
          state.draws = state.draws.filter(function (d) { return d.boardId !== board.id; });
        }
        persist();
        mapCache.clear();
        return board;
      }
      if (payload.id) {
        var up = await this.sb.from('boards').update({
          title: payload.title, category: payload.category, price: payload.price,
          last_one_label: payload.lastOneLabel, status: payload.status, cover: payload.cover || null,
          tiers: tiersNorm,
          last_one_image: payload.lastOneImage || null, last_one_desc: payload.lastOneDesc || null,
          manual: payload.manual || null
        }).eq('id', payload.id);
        if (up.error) throw up.error;
        await this.refreshData();
        return getBoard(payload.id);
      }
      var res = await this.sb.rpc('admin_create_board', {
        p_title: payload.title, p_category: payload.category, p_price: payload.price,
        p_ticket_count: payload.tickets, p_tiers: payload.tiers,
        p_last_one_label: payload.lastOneLabel, p_seed: payload.seed || null, p_status: payload.status,
        p_cover: payload.cover || null,
        p_last_one_image: payload.lastOneImage || null, p_last_one_desc: payload.lastOneDesc || null,
        p_manual: payload.manual || null
      });
      if (res.error) throw res.error;
      await this.refreshData();
      return getBoard(res.data && res.data.id);
    },

    async deleteBoard(id) {
      if (this.mode === 'local') {
        state.boards = state.boards.filter(function (b) { return b.id !== id; });
        state.draws = state.draws.filter(function (d) { return d.boardId !== id; });
        state.codes = state.codes.filter(function (c) { return c.boardId !== id; });
        state.coupons = state.coupons.filter(function (c) { return c.boardId !== id; });
        persist();
        return;
      }
      var cpRes = await this.sb.from('coupons').delete().eq('board_id', id).is('used_at', null);
      if (cpRes.error) throw cpRes.error;
      var res = await this.sb.from('boards').delete().eq('id', id);
      if (res.error) throw res.error;
      await this.refreshData();
    },

    /* 모든 판·판매 기록을 0건으로 — 테스트 판 정리용 (관리자 전용)
       서버 함수 admin_clear_all_boards() 가 있으면 그것을 쓰고,
       없으면 관리자 RLS 권한으로 직접 지운다. */
    async clearAllBoards() {
      if (this.mode === 'local') {
        var counts = {
          boards: state.boards.length,
          draws: state.draws.length,
          deliveries: state.deliveries.length,
          claims: state.claims.length
        };
        state.boards = [];
        state.draws = [];
        state.deliveries = [];
        state.claims = [];
        /* 판에 묶인 미사용 뽑기권은 주인을 잃으므로 함께 정리 (모든 판 뽑기권은 유지) */
        state.coupons = state.coupons.filter(function (c) { return !(c.boardId && !c.usedAt); });
        persist();
        buildLocalViews();
        return counts;
      }
      var rpc = await this.sb.rpc('admin_clear_all_boards');
      if (!rpc.error) {
        await this.refreshData();
        return rpc.data || {};
      }
      var detail = String(rpc.error.code || '') + ' ' + String(rpc.error.message || '');
      if (!/PGRST202|Could not find the function|schema cache|does not exist/i.test(detail)) {
        throw new Error(rpc.error.message || '전체 비우기에 실패했어요.');
      }
      /* 서버 함수가 아직 없을 때: 관리자 권한으로 자식 행부터 직접 삭제 */
      var steps = [
        { table: 'deliveries', col: 'id' },
        { table: 'draws', col: 'id' },
        { table: 'tickets', col: 'id' },
        { table: 'purchase_claims', col: 'id' }
      ];
      for (var i = 0; i < steps.length; i++) {
        var del = await this.sb.from(steps[i].table).delete().not(steps[i].col, 'is', null);
        if (del.error) throw new Error(steps[i].table + ' 삭제 실패: ' + (del.error.message || ''));
      }
      /* 판에 묶인 미사용 뽑기권은 판이 사라지면 '모든 판' 뽑기권으로 바뀌어 버리므로 먼저 지운다 */
      var cpDel = await this.sb.from('coupons').delete().is('used_at', null).not('board_id', 'is', null);
      if (cpDel.error) throw new Error('coupons 삭제 실패: ' + (cpDel.error.message || ''));
      var bdDel = await this.sb.from('boards').delete().not('id', 'is', null);
      if (bdDel.error) throw new Error('boards 삭제 실패: ' + (bdDel.error.message || ''));
      await this.refreshData();
      return { mode: 'direct' };
    },

    /* 판매 기록 초기화 — 티켓·보관함(draws)·배송요청을 0건으로, 판은 다시 판매 중으로 */
    async resetBoard(id) {
      if (this.mode === 'local') {
        var b = getBoard(id);
        if (!b) return { mode: 'local', reset: 0 };
        var sold = openedCount(b);
        b.opens = [];
        b.status = 'open';
        state.draws = state.draws.filter(function (d) { return d.boardId !== id; });
        state.deliveries = state.deliveries.filter(function (d) { return d.boardId !== id; });
        persist();
        buildLocalViews();
        return { mode: 'local', reset: sold };
      }
      var res = await this.sb.rpc('admin_reset_board', { p_board_id: id });
      if (res.error) {
        var detail = String(res.error.code || '') + ' ' + String(res.error.message || '');
        if (/PGRST202|Could not find the function|schema cache|does not exist/i.test(detail)) {
          /* 서버 함수가 아직 설치되지 않았으면: 관리자 권한(RLS)으로 같은 일을 직접 처리하고 설치 안내를 띄운다 */
          var d1 = await this.sb.from('deliveries').delete().eq('board_id', id);
          if (d1.error) throw d1.error;
          var d2 = await this.sb.from('draws').delete().eq('board_id', id);
          if (d2.error) throw d2.error;
          var t1 = await this.sb.from('tickets')
            .update({ status: 'available', buyer_id: null, buyer_name: null, grade: null, drawn_at: null })
            .eq('board_id', id);
          if (t1.error) throw t1.error;
          var b1 = await this.sb.from('boards').update({ status: 'open' }).eq('id', id);
          if (b1.error) throw b1.error;
          await this.refreshData();
          return { mode: 'direct', rpcMissing: true };
        }
        throw new Error(res.error.message || '판 초기화에 실패했어요.');
      }
      await this.refreshData();
      return { mode: 'rpc', rpcMissing: false, reset: res.data && res.data.reset };
    },

    async generateCodes(boardId, count) {
      var made = [];
      if (this.mode === 'local') {
        for (var i = 0; i < count; i++) {
          var code, guard = 0;
          do { code = randomCode(); guard++; } while (guard < 60 && state.codes.some(function (c) { return c.code === code; }));
          state.codes.unshift({ code: code, boardId: boardId || null, createdAt: nowISO(), usedAt: null, usedN: null, usedBy: null, demo: false });
          made.push(code);
        }
        persist();
        return made;
      }
      for (var k = 0; k < count; k++) made.push(randomCode());
      var rows = made.map(function (c) { return { code: c, board_id: boardId || null }; });
      var res = await this.sb.from('exchange_codes').insert(rows);
      if (res.error) throw res.error;
      await this.loadAdmin();
      return made;
    },

    async revokeCode(code) {
      if (this.mode === 'local') {
        state.codes = state.codes.filter(function (c) { return c.code !== code; });
        persist();
        return;
      }
      var res = await this.sb.from('exchange_codes').delete().eq('code', code);
      if (res.error) throw res.error;
      await this.loadAdmin();
    },

    subscribe() {
      if (!this.sb) return;
      if (this._subscribed) return;
      this._subscribed = true;
      var self = this;
      var timer = null;
      var kick = function () {
        clearTimeout(timer);
        timer = setTimeout(async function () {
          try {
            await self.refreshData();
            if (state.me && state.me.isAdmin && ui.view === 'admin' && ui.adminUnlocked) await self.loadAdmin();
            renderAll();
          } catch (e) { /* 실시간 갱신 실패는 조용히 무시 */ }
        }, 350);
      };
      try {
        this.sb.channel('kujiking-live')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' }, kick)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'boards' }, kick)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'coupons' }, kick)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'draws' }, kick)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, kick)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'purchase_claims' }, kick)
          .subscribe();
      } catch (e) { console.warn('[쿠지킹] 실시간 구독 실패', e); }
    }
  };

  function mapClaim(c) {
    return {
      id: c.id, userId: c.user_id, boardId: c.board_id, channel: c.channel,
      orderNo: c.order_no, qty: c.qty, amount: c.amount, memo: c.memo,
      status: c.status, granted: c.granted, at: c.created_at,
      decidedAt: c.decided_at
    };
  }
  function mapDelivery(d) {
    return {
      id: d.id, userId: d.user_id, drawId: d.draw_id, boardId: d.board_id,
      itemLabel: d.item_label, grade: d.grade, recipient: d.recipient, phone: d.phone,
      postcode: d.postcode, address: d.address, memo: d.memo, carrier: d.carrier,
      tracking: d.tracking, status: d.status, requestedAt: d.requested_at, shippedAt: d.shipped_at
    };
  }

  function grantLocalCoupons(userId, boardId, qty, note) {
    var count = Math.max(1, Math.min(100, Number(qty) || 1));
    var board = boardId ? getBoard(boardId) : null;
    for (var i = 0; i < count; i++) {
      state.coupons.unshift({
        id: uid('cp'), userId: userId, boardId: boardId || null,
        kind: boardId ? 'board' : 'universal',
        label: board ? board.title + ' 전용 뽑기권' : '모든 판 뽑기권',
        note: note || '관리자 지급', grantedAt: nowISO(), usedAt: null, usedDrawId: null
      });
    }
    return count;
  }

  function buildLocalViews() {
    var uidNow = state.session ? state.session.userId : null;
    if (Backend.mode === 'local') {
      state.me = uidNow ? userById(uidNow) : null;
      state.myCoupons = state.coupons.filter(function (c) { return c.userId === uidNow; })
        .sort(function (a, b) { return new Date(b.grantedAt) - new Date(a.grantedAt); });
      state.myDraws = state.draws.filter(function (d) { return d.userId === uidNow; })
        .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
      state.myClaims = state.claims.filter(function (c) { return c.userId === uidNow; })
        .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
      state.myDeliveries = state.deliveries.filter(function (d) { return d.userId === uidNow; })
        .sort(function (a, b) { return new Date(b.requestedAt) - new Date(a.requestedAt); });

      state.adminMembers = state.users.map(function (u) {
        return Object.assign({}, u, {
          couponCount: state.coupons.filter(function (c) { return c.userId === u.id && !c.usedAt; }).length,
          drawCount: state.draws.filter(function (d) { return d.userId === u.id; }).length
        });
      });
      state.adminClaims = state.claims.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); })
        .map(function (c) {
          var u = userById(c.userId);
          return Object.assign({}, c, { nickname: u ? u.nickname : '', phone: u ? u.phone : '' });
        });
      state.adminDeliveries = state.deliveries.slice().sort(function (a, b) { return new Date(b.requestedAt) - new Date(a.requestedAt); })
        .map(function (d) {
          var u = userById(d.userId);
          return Object.assign({}, d, { nickname: u ? u.nickname : '', phone: u ? u.phone : '' });
        });
    }
  }

  /* ---------- 로컬 뽑기 (원자성 흉내) ---------- */
  async function localDraw(args) {
    var board = getBoard(args.boardId);
    if (!board) throw new Error('판을 찾을 수 없습니다.');
    if (board.status !== 'open') throw new Error('종료된 판입니다.');
    if (remaining(board) <= 0) throw new Error('이 판은 전량 소진되었어요.');

    var already = board.opens.filter(function (o) { return o.n === args.n; })[0];
    if (already) throw new Error('이미 판매된 번호예요. 다른 번호를 골라 주세요.');

    var source = null, demo = false;

    if (args.couponId) {
      var coupon = null;
      for (var i = 0; i < state.coupons.length; i++) {
        if (state.coupons[i].id === args.couponId) { coupon = state.coupons[i]; break; }
      }
      if (!coupon || coupon.userId !== (state.me && state.me.id)) throw new Error('사용할 수 없는 쿠폰입니다.');
      if (coupon.usedAt) throw new Error('이미 사용한 쿠폰입니다.');
      if (coupon.boardId && coupon.boardId !== board.id) throw new Error('이 쿠폰은 다른 판에서만 사용할 수 있습니다.');
      coupon.usedAt = nowISO();
      source = 'coupon';
    } else if (args.code) {
      var key = normalizeCode(args.code);
      if (!key) throw new Error('교환 코드를 입력해 주세요.');
      if (key === normalizeCode(state.settings.demoCode)) {
        source = 'demo';
        demo = true;
      } else {
        var rec = null;
        for (var j = 0; j < state.codes.length; j++) {
          if (normalizeCode(state.codes[j].code) === key) { rec = state.codes[j]; break; }
        }
        if (!rec) throw new Error('등록되지 않은 코드예요. 코드를 다시 확인해 주세요.');
        if (rec.usedAt) throw new Error('이미 사용된 코드예요 (' + formatDateTime(rec.usedAt) + ' · ' + rec.usedN + '번)');
        if (rec.boardId && rec.boardId !== board.id) {
          var other = getBoard(rec.boardId);
          throw new Error('이 코드는 다른 판(' + (other ? other.title : '삭제된 판') + ') 전용이에요.');
        }
        rec.usedAt = nowISO();
        rec.usedN = args.n;
        rec.usedBy = state.me ? state.me.id : null;
        source = 'code';
      }
    } else if (args.usePoints || args.withPoints) {
      /* 굿즈 포인트로 뽑기 (v3.6): 판 가격만큼 회원 포인트를 차감한다 */
      if (!state.me) throw new Error('포인트로 뽑으려면 로그인이 필요합니다.');
      var meU = userById(state.me.id);
      if (!meU) throw new Error('회원 정보를 찾을 수 없습니다. 다시 로그인해 주세요.');
      var priceP = Number(board.price) || 0;
      var balP = Number(meU.points) || 0;
      if (priceP <= 0) throw new Error('이 판은 포인트로 뽑을 수 없습니다.');
      if (balP < priceP) throw new Error('굿즈 포인트가 부족합니다. (필요 ' + fmt(priceP) + 'P · 보유 ' + fmt(balP) + 'P)');
      meU.points = balP - priceP;
      source = 'points';
    } else {
      throw new Error('쿠폰 · 교환 코드 · 굿즈 포인트 중 하나가 필요합니다.');
    }

    var map = await getMapping(board);
    var grade = map[args.n] || board.tiers[board.tiers.length - 1].grade;
    var tier = tierOf(board, grade) || { label: '', points: 0 };
    var isLast = remaining(board) === 1;
    var name = state.me ? maskName(state.me.nickname) : '게스트';

    board.opens.unshift({
      n: args.n, grade: grade, at: nowISO(), name: name,
      userId: state.me ? state.me.id : null, demo: demo, last: isLast
    });

    var itemStatus = null;
    var points = 0;
    var pointsAward = Number(tier.points_awarded || 0);
    if (tier.pointOnly || pointsAward > 0) {
      points = pointsAward > 0 ? pointsAward : Number(tier.points || 0);
      itemStatus = '포인트지급';
      if (state.me) {
        var u = userById(state.me.id);
        if (u) u.points = (Number(u.points) || 0) + points;
      }
    } else if (state.me) {
      itemStatus = '보관중';
    }

    var draw = {
      id: uid('d'), boardId: board.id, n: args.n,
      userId: state.me ? state.me.id : null,
      grade: grade, tierLabel: tier.label || '', points: points,
      itemStatus: itemStatus, source: source, at: nowISO(), deliveryId: null, last: isLast
    };
    state.draws.unshift(draw);

    /* 라스트원상 — 마지막 1장이면 라스트원 상품을 보관함에 한 행 더 넣는다 (로그인 상태에서만) */
    var lastOneWon = false;
    if (isLast && !board.lastOneWinnerName && (board.lastOneLabel || '').trim()) {
      lastOneWon = true;
      board.lastOneWinnerName = name;
      board.lastOneWonAt = nowISO();
      if (state.session) board.lastOneWinnerId = state.session.userId;
      if (state.me) {
        state.draws.unshift({
          id: uid('d'), boardId: board.id, n: 0,
          userId: state.me.id, grade: 'LAST', tierLabel: board.lastOneLabel || '라스트원상',
          points: 0, itemStatus: '보관중', source: source, at: nowISO(), deliveryId: null,
          last: true, lastOne: true
        });
      }
    }

    if (args.couponId) {
      var c2 = state.coupons.filter(function (c) { return c.id === args.couponId; })[0];
      if (c2) c2.usedDrawId = draw.id;
    }

    persist();
    buildLocalViews();

    return {
      grade: grade, tierLabel: tier.label || '', points: points,
      itemStatus: itemStatus, isLast: isLast, remaining: remaining(board),
      lastOneWon: lastOneWon,
      lastOneLabel: lastOneWon ? (board.lastOneLabel || '') : '',
      lastOneImage: lastOneWon ? (board.lastOneImage || '') : '',
      lastOneDesc: lastOneWon ? (board.lastOneDesc || '') : '',
      lastOneWinnerName: lastOneWon ? name : '',
      source: source, demo: demo, guest: !state.me,
      pointsBalance: state.me ? Number((userById(state.me.id) || {}).points || 0) : null
    };
  }

  /* =========================================================
     4. 모달
     ========================================================= */
  var modalRoot, modalPanel, modalShell, lastFocused = null;
  var confirmResolve = null;

  function openModal(html, opts) {
    opts = opts || {};
    modalRoot.hidden = false;
    modalShell.classList.remove('is-quake');
    modalShell.classList.toggle('wide', !!opts.wide);
    modalShell.classList.toggle('dark', !!opts.dark);
    modalShell.classList.toggle('is-drag', !!opts.dragLock);
    modalPanel.innerHTML = html;
    if (opts.resetScroll && modalShell) { try { modalShell.scrollTop = 0; } catch (e) {} }
    document.body.style.overflow = 'hidden';
    lastFocused = document.activeElement;
    if (!opts.keepFocus) {
      var f = modalPanel.querySelector('input,select,button');
      if (f && !opts.noAutofocus) setTimeout(function () { try { f.focus(); } catch (e) {} }, 40);
    }
  }
  function closeModal() {
    if (!modalRoot || modalRoot.hidden) return;
    /* 이미 뽑힌 결과를 종이·봉인 뒤에 숨긴 채로 닫지 않는다 — 먼저 개봉 연출로 보여준다 */
    if (ui.draw && ui.draw.step === 'peel' && ui.draw.result && !ui.draw.revealed) { peelSnap(); return; }
    if (ui.draw && ui.draw.step === 'seal' && ui.draw.result && !ui.draw.revealed) { sealSnap(); return; }
    /* 승격 연출 중에는 먼저 끝까지 보여준다 (한 번 더 누르면 닫힌다) */
    if (ui.draw && ui.draw.step === 'promote' && ui.draw.result) { ui.draw.promoSkip = true; return; }
    closePostcodeLayer();
    modalRoot.hidden = true;
    modalPanel.innerHTML = '';
    document.body.style.overflow = '';
    ui.draw = null;
    if (confirmResolve) { var p = confirmResolve; confirmResolve = null; p(false); }
    if (lastFocused && lastFocused.focus) { try { lastFocused.focus(); } catch (e) {} }
  }
  /* ---------- 주소 검색 (카카오/다음 우편번호, API 키 불필요) ---------- */
  /* t1.daumcdn.net 은 2026-11-30 종료 예정 → t1.kakaocdn.net 먼저, 안 되면 기존 도메인 */
  var POSTCODE_SRCS = [
    'https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js',
    'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js'
  ];
  var daumPostcodeLoading = null;

  function postcodeNS() {
    if (window.kakao && window.kakao.Postcode) return window.kakao.Postcode;
    if (window.daum && window.daum.Postcode) return window.daum.Postcode;
    return null;
  }

  function loadPostcodeScript(src) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(ok) { if (settled) return; settled = true; resolve(ok); }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { finish(!!postcodeNS()); };
      s.onerror = function () { finish(false); };
      document.head.appendChild(s);
      setTimeout(function () { finish(!!postcodeNS()); }, 8000);
    });
  }

  function loadDaumPostcode() {
    if (postcodeNS()) return Promise.resolve(true);
    if (daumPostcodeLoading) return daumPostcodeLoading;
    daumPostcodeLoading = loadPostcodeScript(POSTCODE_SRCS[0]).then(function (ok) {
      if (ok) return true;
      return loadPostcodeScript(POSTCODE_SRCS[1]);
    }).then(function (ok) {
      if (!ok) daumPostcodeLoading = null; /* 다음 시도 때 다시 받도록 */
      return ok;
    });
    return daumPostcodeLoading;
  }

  function closePostcodeLayer() {
    var layer = document.getElementById('postcodeLayer');
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
  }

  function openPostcodeLayer(form) {
    if (!form) return;
    if (document.getElementById('postcodeLayer')) return;
    var layer = document.createElement('div');
    layer.id = 'postcodeLayer';
    layer.className = 'postcode-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', '주소 검색');
    layer.innerHTML =
      '<div class="postcode-frame">' +
        '<div class="postcode-head"><b>주소 검색</b>' +
          '<button type="button" class="postcode-close" data-action="close-postcode" aria-label="주소 검색 닫기">✕</button>' +
        '</div>' +
        '<div class="postcode-body" data-role="postcode-body">' +
          '<p class="postcode-loading">주소 검색을 불러오는 중…</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(layer);

    var body = layer.querySelector('[data-role="postcode-body"]');
    loadDaumPostcode().then(function (ok) {
      if (!document.getElementById('postcodeLayer') || !body) return;
      if (!ok) {
        body.innerHTML = '<div class="postcode-loading">주소 검색을 불러오지 못했어요.<br>' +
          '인터넷 연결을 확인하고 다시 눌러주세요.<br>우편번호·주소는 직접 입력해도 됩니다.</div>';
        return;
      }
      body.innerHTML = '';
      try {
        var PostcodeCtor = postcodeNS();
        new PostcodeCtor({
          width: '100%',
          height: '100%',
          oncomplete: function (data) {
            var base = data.userSelectedType === 'R'
              ? (data.roadAddress || data.autoRoadAddress || '')
              : (data.jibunAddress || data.autoJibunAddress || '');
            if (data.userSelectedType === 'R' && data.buildingName) base += ' (' + data.buildingName + ')';
            var pc = form.querySelector('input[name="postcode"]');
            var addr = form.querySelector('input[name="address"]');
            var det = form.querySelector('input[name="detail"]');
            if (pc) pc.value = data.zonecode || '';
            if (addr) addr.value = base;
            closePostcodeLayer();
            if (det) { try { det.focus(); } catch (e) {} }
          },
          onclose: function () { closePostcodeLayer(); }
        }).embed(body);
        var ifr = body.querySelector('iframe');
        if (ifr) {
          ifr.style.width = '100%';
          ifr.style.height = '100%';
          ifr.style.border = '0';
          ifr.style.display = 'block';
        }
      } catch (e) {
        body.innerHTML = '<div class="postcode-loading">주소 검색을 열지 못했어요.<br>우편번호·주소를 직접 입력해 주세요.</div>';
      }
    });
  }

  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      openModal(
        '<h2 class="modal-title" id="modalTitle">' + h(opts.title) + '</h2>' +
        '<p class="modal-sub">' + (opts.message || '') + '</p>' +
        '<div class="modal-actions">' +
        '<button class="btn btn-outline" data-action="confirm-no">' + h(opts.cancelLabel || '취소') + '</button>' +
        '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-action="confirm-yes">' + h(opts.confirmLabel || '확인') + '</button>' +
        '</div>'
      );
      confirmResolve = resolve;
    });
  }

  /* =========================================================
     5. 라우팅
     ========================================================= */
  function parseRoute() {
    var raw = (location.hash || '#/').replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean);
    var seg = parts[0] || 'home';
    if (seg === 'board') return { view: 'board', id: parts[1] || null };
    if (seg === 'my') return { view: 'my', id: null };
    if (seg === 'winners') return { view: 'winners', id: parts[1] || null };
    if (seg === 'fairness') return { view: 'fairness', id: parts[1] || null };
    if (seg === 'admin') return { view: 'admin', id: null };
    return { view: 'home', id: null };
  }

  function route() {
    var r = parseRoute();
    ui.view = r.view;
    if (r.view === 'board') {
      var board = r.id ? getBoard(r.id) : firstBoard();
      if (!board) ui.view = 'home';
      else ui.boardId = board.id;
    }
    if (r.view === 'fairness' && r.id && getBoard(r.id)) ui.fairnessBoardId = r.id;
    if (r.view === 'winners' && r.id) ui.winnersBoardId = r.id;

    $$('[data-view]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-view') === ui.view);
    });
    $$('.main-nav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === ui.view);
    });
    setMenu(false);
    if (modalRoot && !modalRoot.hidden) closeModal();
    window.scrollTo({ top: 0, behavior: 'auto' });
    renderView();
    renderHeader();
  }

  function renderAll() {
    renderHeader();
    if (!ui.ready) return;
    renderView();
  }

  function renderView() {
    if (ui.view === 'home') return renderHome();
    if (ui.view === 'board') return renderBoard();
    if (ui.view === 'my') return renderMy();
    if (ui.view === 'winners') return renderWinners();
    if (ui.view === 'fairness') return renderFairness();
    if (ui.view === 'admin') return renderAdmin();
  }

  function setMenu(open) {
    var nav = $('#mainNav');
    var toggle = $('#navToggle');
    if (!nav || !toggle) return;
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
  }

  /* =========================================================
     6. 헤더 · 공통 조각
     ========================================================= */
  function availableCoupons() {
    return (state.myCoupons || []).filter(function (c) { return !c.usedAt; });
  }
  function couponsFor(board) {
    return availableCoupons().filter(function (c) { return !c.boardId || c.boardId === board.id; })
      .sort(function (a, b) { return (a.boardId ? 0 : 1) - (b.boardId ? 0 : 1); });
  }

  /* ---------- 유튜브 라이브 ---------- */
  var YT_LIVE_SOON = '현재 라이브 방송 준비 중입니다! 관리자 설정에서 유튜브 주소를 연결할 수 있어요.';

  /* 입력값을 방문자에게 열어 줄 주소로 바꾼다. @핸들이나 채널 주소는 /live 로 붙는다. */
  function youtubeLiveTarget(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
    if (!s) return '';
    /* @핸들, 또는 점·슬래시 없는 채널명 */
    if (/^@[A-Za-z0-9._-]{2,60}$/.test(s)) return 'https://www.youtube.com/' + s + '/live';
    if (!/[\/\s]/.test(s) && !/\.[a-z]{2,}$/i.test(s) && /^[A-Za-z0-9._-]{2,60}$/.test(s)) {
      return 'https://www.youtube.com/@' + s + '/live';
    }
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    var url;
    try { url = new URL(s); } catch (e) { return ''; }
    var host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) return '';
    if (!/(^|\.)youtube\.com$/.test(host)) return url.href;
    var path = url.pathname.replace(/\/+$/, '');
    if (!path) return 'https://www.youtube.com/';
    if (url.searchParams.get('v') || url.searchParams.get('list')) return url.href;
    if (/^\/(live|watch|shorts|embed|playlist)\//i.test(path)) return url.href;
    if (/\/(live|videos|streams|shorts|watch|playlist|embed|results|hashtag)$/i.test(path)) return url.href;
    return url.protocol + '//' + url.host + path + '/live';
  }

  function youtubeLiveEnabled() {
    return state.settings.youtubeLiveEnabled !== false;
  }

  function youtubeLiveUrl() {
    return youtubeLiveTarget(state.settings.youtubeLiveUrl);
  }

  function youtubeLiveSql(raw, enabled) {
    var value = String(raw || '').replace(/'/g, "''");
    return "insert into public.app_settings (key, value) values\n" +
      "  ('youtube_live_url', '" + value + "'),\n" +
      "  ('youtube_live_enabled', '" + (enabled ? 'true' : 'false') + "')\n" +
      "on conflict (key) do update set value = excluded.value;";
  }

  function openInNewTab(url) {
    if (!url) return false;
    try {
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch (e) {
      var win = window.open(url, '_blank', 'noopener');
      if (win) { try { win.opener = null; } catch (e2) {} }
      return !!win;
    }
  }

  function openYoutubeLive() {
    var target = youtubeLiveUrl();
    if (target) {
      openInNewTab(target);
      return true;
    }
    openModal('<div class="yt-soon">' +
      '<span class="yt-soon-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><rect x="1.6" y="4.6" width="20.8" height="14.8" rx="4.4" fill="currentColor"/><path d="M10.2 8.9l5.6 3.1-5.6 3.1z" fill="#fff"/></svg></span>' +
      '<h2 class="modal-title" id="modalTitle">유튜브 라이브</h2>' +
      '<p class="modal-sub">' + h(YT_LIVE_SOON) + '</p>' +
      '<div class="modal-actions"><button class="btn btn-dark" type="button" data-action="close-modal">확인</button></div>' +
      '</div>');
    return false;
  }

  async function saveYoutubeLive(raw, enabled) {
    var url = String(raw || '').trim();
    if (Backend.mode === 'local') {
      state.settings.youtubeLiveUrl = url;
      state.settings.youtubeLiveEnabled = !!enabled;
      persist();
      return 'local';
    }
    var res = await Backend.sb.from('app_settings').upsert([
      { key: 'youtube_live_url', value: url },
      { key: 'youtube_live_enabled', value: enabled ? 'true' : 'false' }
    ], { onConflict: 'key' });
    if (res.error) throw res.error;
    state.settings.youtubeLiveUrl = url;
    state.settings.youtubeLiveEnabled = !!enabled;
    return 'server';
  }

  function updateYoutubePreview() {
    var box = $('#ytLivePreview');
    if (!box) return;
    var input = $('form[data-form="save-youtube"] input[name="url"]');
    var raw = input ? input.value.trim() : String(state.settings.youtubeLiveUrl || '');
    if (!raw) {
      box.innerHTML = '아직 주소를 넣지 않았어요. 방문자가 <b>라이브</b> 버튼을 누르면 “라이브 방송 준비 중” 안내가 보입니다.';
      return;
    }
    var target = youtubeLiveTarget(raw);
    if (!target) {
      box.innerHTML = '주소를 확인해 주세요. 예: <code>@kujiking</code> 또는 <code>https://www.youtube.com/@kujiking/live</code>';
      return;
    }
    box.innerHTML = '방문자에게는 이 주소가 열립니다 → <a href="' + h(target) + '" target="_blank" rel="noopener">' + h(target) + '</a>';
  }

  function renderYoutubeSettings() {
    var form = $('form[data-form="save-youtube"]');
    if (form) {
      var input = form.querySelector('input[name="url"]');
      var check = form.querySelector('input[name="enabled"]');
      if (input && document.activeElement !== input) input.value = state.settings.youtubeLiveUrl || '';
      if (check) check.checked = youtubeLiveEnabled();
    }
    var badge = $('#ytLiveStateBadge');
    if (badge) {
      var on = youtubeLiveEnabled();
      badge.className = 'badge ' + (on ? 'badge-live' : 'badge-closed');
      badge.textContent = on ? '상단 버튼 표시 중' : '상단 버튼 숨김';
      badge.hidden = false;
    }
    var code = $('#ytLiveSqlCode');
    if (code) code.textContent = youtubeLiveSql(state.settings.youtubeLiveUrl || '', youtubeLiveEnabled());
    updateYoutubePreview();
  }

  /* ---------- 고객센터 · 배송비 ---------- */
  var SHIP_NOTICE_DEFAULT = '기본 배송비 3,500원 · 보관함에서 3건 이상 묶음(합배송) 신청 시 무료배송 (제주·도서산간 +3,000원)';
  var KAKAO_SOON = '현재 1:1 카카오톡 상담을 연결 중입니다! 잠시만 기다려 주세요.';

  function shippingNotice() {
    var s = String(state.settings.shippingFeeNotice == null ? '' : state.settings.shippingFeeNotice).replace(/\s+/g, ' ').trim();
    return s || SHIP_NOTICE_DEFAULT;
  }

  /* 입력값을 새 창으로 열 주소로 바꿈다. http(s) 주소가 아니면 빈 값. */
  function kakaoTarget(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    var url;
    try { url = new URL(s); } catch (e) { return ''; }
    if (!/^https?:$/.test(url.protocol)) return '';
    var host = url.hostname.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) return '';
    return url.href;
  }

  function kakaoOpenchatUrl() {
    return kakaoTarget(state.settings.kakaoOpenchatUrl) || KAKAO_CHAT_URL;
  }

  function kakaoMarkHTML(cls) {
    return '<span class="kakao-mark' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 2.9c-5.3 0-9.6 3.4-9.6 7.6 0 2.7 1.8 5.1 4.4 6.4l-1 3.3c-.1.4.3.7.6.5l4-2.5c.5.1 1 .1 1.6.1 5.3 0 9.6-3.4 9.6-7.6S17.3 2.9 12 2.9z" fill="currentColor"/></svg></span>';
  }

  function kakaoPillHTML(cls) {
    return '<button class="kakao-pill' + (cls ? ' ' + cls : '') + '" type="button" data-action="open-kakao">' +
      kakaoMarkHTML() +
    '<span class="kakao-pill-word">1:1 카카오톡 문의</span></button>';
  }

  function openKakaoInquiry(raw) {
    var target = kakaoTarget(raw) || kakaoOpenchatUrl();
    if (target) {
      openInNewTab(target);
      return true;
    }
    openModal('<div class="kakao-soon">' +
      '<span class="kakao-soon-mark" aria-hidden="true">' + kakaoMarkHTML('kakao-mark-lg') + '</span>' +
      '<h2 class="modal-title" id="modalTitle">1:1 카카오톡 문의</h2>' +
      '<p class="modal-sub">' + h(KAKAO_SOON) + '</p>' +
      '<div class="modal-actions"><button class="btn btn-dark" type="button" data-action="close-modal">확인</button></div>' +
      '</div>');
    return false;
  }

  /* 방문자 화면(푸터·이용 안내·보관함·배송 신청)의 배송비 문구를 지금 설정값으로 맞춘다. */
  function renderShippingCopy() {
    var text = shippingNotice();
    $$('[data-ship-notice]').forEach(function (el) {
      if (el.textContent !== text) el.textContent = text;
    });
    var on = !!kakaoOpenchatUrl();
    $$('[data-action="open-kakao"]').forEach(function (el) {
      el.classList.toggle('is-soon', !on);
      el.setAttribute('title', on ? '카카오톡 1:1 상담 열기 (새 창)' : '1:1 카카오톡 상담 연결 준비 중');
    });
  }

  function shipNoticeBoxHTML(cls) {
    return '<div class="ship-note' + (cls ? ' ' + cls : '') + '">' +
      '<span class="ship-note-icon" aria-hidden="true">' + icon('truck') + '</span>' +
      '<div class="ship-note-body">' +
        '<b>배송비 · 합배송 안내</b>' +
        '<p data-ship-notice>' + h(shippingNotice()) + '</p>' +
      '</div>' +
      kakaoPillHTML('kakao-pill-sm') +
    '</div>';
  }

  function csSettingsSql(kakao, notice) {
    var k = String(kakao || '').replace(/'/g, "''");
    var n = String(notice || '').replace(/'/g, "''");
    return "insert into public.app_settings (key, value) values\n" +
      "  ('kakao_openchat_url', '" + k + "'),\n" +
      "  ('shipping_fee_notice', '" + n + "')\n" +
      "on conflict (key) do update set value = excluded.value;";
  }

  async function saveCsSettings(kakao, notice) {
    var url = String(kakao || '').trim();
    var note = String(notice || '').replace(/\s+/g, ' ').trim();
    if (Backend.mode === 'local') {
      state.settings.kakaoOpenchatUrl = url;
      state.settings.shippingFeeNotice = note;
      persist();
      return 'local';
    }
    var res = await Backend.sb.from('app_settings').upsert([
      { key: 'kakao_openchat_url', value: url },
      { key: 'shipping_fee_notice', value: note }
    ], { onConflict: 'key' });
    if (res.error) throw res.error;
    state.settings.kakaoOpenchatUrl = url;
    state.settings.shippingFeeNotice = note;
    return 'server';
  }

  function csTypedValues() {
    var form = $('form[data-form="save-cs"]');
    var ki = form ? form.querySelector('input[name="kakao"]') : null;
    var ni = form ? form.querySelector('textarea[name="shipping"]') : null;
    return {
      kakao: ki ? ki.value.trim() : String(state.settings.kakaoOpenchatUrl || ''),
      notice: ni ? ni.value.replace(/\s+/g, ' ').trim() : String(state.settings.shippingFeeNotice || '')
    };
  }

  function updateCsPreview() {
    var prev = $('#csPreview');
    if (!prev) return;
    var typed = csTypedValues();
    var noteText = typed.notice || SHIP_NOTICE_DEFAULT;
    var target = kakaoTarget(typed.kakao);
    prev.innerHTML = '<span>방문자에게 보이는 배송비 안내 → <b>' + h(noteText) + '</b></span>' +
      (typed.kakao
        ? (target ? '<span>문의 버튼 → <a href="' + h(target) + '" target="_blank" rel="noopener">' + h(target) + '</a></span>'
                  : '<span>주소를 확인해 주세요. 예: <code>https://pf.kakao.com/_xnxhmvX/chat</code></span>')
        : '<span>문의 버튼 → 지금은 “' + h(KAKAO_SOON) + '” 안내가 보입니다.</span>');
  }

  function renderCsSettings() {
    var form = $('form[data-form="save-cs"]');
    if (form) {
      var ki = form.querySelector('input[name="kakao"]');
      var ni = form.querySelector('textarea[name="shipping"]');
      if (ki && document.activeElement !== ki) ki.value = state.settings.kakaoOpenchatUrl || '';
      if (ni && document.activeElement !== ni) ni.value = state.settings.shippingFeeNotice || '';
    }
    var badge = $('#csStateBadge');
    if (badge) {
      var on = !!kakaoOpenchatUrl();
      badge.className = 'badge ' + (on ? 'badge-live' : 'badge-closed');
      badge.textContent = on ? '카카오톡 상담 연결됨' : '연결 전 · 준비 중 안내';
      badge.hidden = false;
    }
    updateCsPreview();
    var code = $('#csSqlCode');
    if (code) code.textContent = csSettingsSql(state.settings.kakaoOpenchatUrl || '', state.settings.shippingFeeNotice || '');
  }

  function renderHeader() {
    var live = Backend.mode === 'supabase';
    document.body.classList.toggle('is-live', live);
    var ad = $('.announce-demo');
    var al = $('.announce-live');
    if (ad) ad.hidden = live;
    if (al) al.hidden = !live;

    var ytBtn = $('#ytLiveBtn');
    if (ytBtn) {
      var ytOn = youtubeLiveEnabled();
      ytBtn.hidden = !ytOn;
      if (ytOn) {
        var ytReady = !!youtubeLiveUrl();
        ytBtn.classList.toggle('is-soon', !ytReady);
        ytBtn.setAttribute('aria-label', ytReady ? '유튜브 라이브 방송 보기 (새 창)' : '유튜브 라이브 · 방송 준비 중');
        ytBtn.setAttribute('title', ytReady ? '유튜브 라이브 방송 보기' : '라이브 방송 준비 중');
      }
    }

    var btn = $('#authBtn');
    var chip = $('#userChip');
    var user = me();
    if (btn) btn.hidden = !!user;
    if (chip) chip.hidden = !user;
    if (user) {
      var av = $('#userAvatar');
      if (av) av.textContent = (user.nickname || '쿠').charAt(0);
      var nick = $('#userNickname');
      if (nick) nick.textContent = user.nickname || '쿠지팬';
      var cEl = $('#userCoupons');
      if (cEl) cEl.textContent = '쿠폰 ' + fmt(availableCoupons().length);
      var pEl = $('#userPoints');
      if (pEl) pEl.textContent = fmt(user.points || 0) + 'P';
    }
    var modeBar = $('#modeBar');
    if (modeBar) {
      if (Backend.mode === 'supabase') {
        modeBar.hidden = true;
      } else {
        modeBar.hidden = false;
        var barText;
        if (Backend.fallbackReason === 'missing_tables') {
          barText = 'Supabase에 연결했지만 데이터베이스 테이블이 아직 없어 데모 모드로 실행 중입니다 · SQL Editor에서 schema.sql을 실행해 주세요';
        } else if (Backend.fallbackReason === 'network') {
          barText = 'Supabase 서버에 닿지 않아 데모 모드로 실행 중입니다 · 데이터는 이 브라우저에만 저장됩니다';
        } else if (Backend.justFellBack) {
          barText = 'Supabase 설정을 확인하지 못해 데모 모드로 실행 중입니다 · 데이터는 이 브라우저에만 저장됩니다';
        } else {
          barText = '데모 모드 · 데이터는 이 브라우저에만 저장됩니다 · Supabase 키를 넣으면 실시간 서버 모드로 전환됩니다';
        }
        modeBar.innerHTML = '<div class="container mode-inner">' +
          '<span class="mode-dot"></span>' +
          '<b>데모 모드</b>' +
          '<span>' + h(barText) + '</span>' +
          '<a href="#/admin" class="mode-link">' + (Backend.fallbackReason === 'missing_tables' ? 'SQL 실행 안내 →' : '연결 방법 보기 →') + '</a>' +
          '</div>';
      }
    }

    renderShippingCopy();
  }

  function boardCardHTML(board) {
    var left = remaining(board);
    var lo = lastOneStatus(board);
    var pct = board.tickets ? Math.round(openedCount(board) / board.tickets * 100) : 0;
    var soldout = left === 0;
    var closed = board.status !== 'open';
    var low = isLowStock(board);
    var statusBadge = soldout
      ? '<span class="badge badge-closed cover-status">전량 소진</span>'
      : board.status === 'open'
        ? '<span class="badge badge-live cover-status">진행 중</span>'
        : '<span class="badge badge-closed cover-status">종료</span>';
    var coverInner = board.cover
      ? '<img class="cover-img" src="' + h(coverSrc(board.cover)) + '" alt="' + h(board.category + ' 상품 이미지') + '" loading="lazy" decoding="async">' +
        '<span class="cover-scrim" aria-hidden="true"></span>'
      : '<span class="cover-kicker">KUJIKING KUJI</span>' +
        '<strong class="cover-title">' + h(board.category || '쿠지') + '</strong>' +
        '<span class="cover-sub">' + h(board.sub || board.title.replace(/^\[[^\]]*\]\s*/, '')) + '</span>';
    return '' +
      '<article class="board-card' + (low ? ' is-lowstock' : '') + (soldout ? ' is-soldout' : '') + (closed ? ' is-closed' : '') + '">' +
        '<a class="board-card-cover ' + (board.cover ? 'has-image ' : '') + categoryClass(board.category) + '" href="#/board/' + h(board.id) + '" aria-label="' + h(board.title) + ' 열기">' +
          coverInner +
          '<span class="badge cover-tag">' + h(board.category || '자체 스페셜') + '</span>' +
          statusBadge +
          '<span class="cover-price">1장 ' + won(board.price) + ' · ' + fmt(board.tickets) + '장</span>' +
        '</a>' +
        '<div class="board-card-body">' +
          (soldout ? '<span class="soldout-stamp">품절<span>SOLD OUT</span></span>' : '') +
          (!soldout && closed ? '<span class="soldout-stamp is-closed-stamp">판 종료<span>CLOSED</span></span>' : '') +
          (low ? '<span class="lowstock-flag">🔥 품절임박 · ' + fmt(left) + '장 남음</span>' : '') +
          (lo && lo.won ? '<span class="last-won-flag">🏆 라스트원 획득: ' + h(lo.name) + '</span>' : '') +
          (lo && lo.soon ? '<span class="last-soon-flag">🔥 라스트원까지 ' + fmt(lo.left) + '장!</span>' : '') +
          '<div class="board-card-top">' +
            '<span class="band-tag band-' + priceBand(board.price) + '">' + priceBandLabel(board.price) + '</span>' +
            '<span class="muted sold-line">판매 ' + fmt(openedCount(board)) + '장</span>' +
          '</div>' +
          '<h3><a href="#/board/' + h(board.id) + '">' + h(board.title) + '</a></h3>' +
          '<div class="progress">' +
            '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="progress-labels"><span>' + pct + '% 진행</span><span>남은 번호 <b>' + fmt(left) + '</b>장</span></div>' +
          '</div>' +
          '<div class="grade-chips">' + board.tiers.slice(0, 5).map(function (t) {
            return '<span class="grade-chip"><i style="background:' + gradeColor(t.grade) + '"></i>' + h(t.grade) + ' <b>' + fmt(t.count) + '</b></span>';
          }).join('') + '</div>' +
          '<div class="board-card-foot">' +
            '<div class="price-tag"><strong>' + fmt(board.price) + '</strong><span>원 / 1장</span></div>' +
            (soldout
              ? '<span class="btn btn-outline" aria-disabled="true">전량 소진</span>'
              : '<a class="btn btn-primary" href="#/board/' + h(board.id) + '">뽑기 시작</a>') +
          '</div>' +
        '</div>' +
      '</article>';
  }

  /* =========================================================
     7. 홈
     ========================================================= */
  function renderHome() {
    var openBoards = state.boards.filter(function (b) { return b.status === 'open'; });
    var totalLeft = openBoards.reduce(function (s, b) { return s + remaining(b); }, 0);
    var totalSold = state.boards.reduce(function (s, b) { return s + openedCount(b); }, 0);

    var factBoards = $('#factBoards');
    if (factBoards) factBoards.textContent = fmt(openBoards.length);
    var factRemaining = $('#factRemaining');
    if (factRemaining) factRemaining.textContent = fmt(totalLeft);
    var factSales = $('#factSales');
    if (factSales) factSales.textContent = fmt(totalSold);

    var first = openBoards[0] || state.boards[0];
    var chip = $('#heroBoardLink');
    if (chip) chip.href = first ? '#/board/' + first.id : '#/board';

    renderFilters();
    renderLiveTicker();
    var filterBar = $('.filter-bar');
    if (filterBar) filterBar.hidden = !state.boards.length;

    var list = $('#boardList');
    if (!list) return;
    var filtered = filteredBoards();
    if (!filtered.length) {
      if (!state.boards.length) {
        /* 판이 하나도 없을 때 — 데모 판을 되살리지 않고 깔끔한 빈 화면 */
        list.innerHTML = state.loadError
          ? '<div class="card empty board-empty is-error">' +
              '<span class="empty-icon">' + icon('alert') + '</span>' +
              '<h3>판을 불러오지 못했어요</h3>' +
              '<p>서버에 잠시 연결하지 못했습니다. 아래 버튼을 눌러 다시 시도해 주세요.</p>' +
              '<div class="btn-row" style="justify-content:center"><button type="button" class="btn btn-primary" data-action="reconnect-backend">다시 연결</button></div>' +
              '<p class="small muted" data-role="load-error">' + h(state.loadError) + '</p>' +
            '</div>'
          : '<div class="card empty board-empty">' +
              '<span class="empty-icon">' + icon('ticket') + '</span>' +
              '<h3>진행 중인 뽑기판이 없어요</h3>' +
              '<p>새 판을 준비하고 있어요. 곧 첫 쿠지가 열립니다.<br>뽑기권(쿠폰)과 교환 코드는 그대로 사용할 수 있어요.</p>' +
            '</div>';
      } else {
        list.innerHTML = '<div class="card empty filter-empty">' +
          '<span class="empty-icon">' + icon('ticket') + '</span>' +
          '<p>이 조건의 판은 아직 준비 중이에요.<br>다른 카테고리나 금액을 골라보세요.</p>' +
          '<button class="btn btn-outline" data-action="reset-filter">전체 판 보기</button>' +
          '</div>';
      }
    } else {
      list.innerHTML = filtered.map(boardCardHTML).join('');
    }
    var summary = $('#filterSummary');
    if (summary) {
      var parts = [];
      if (ui.filters.category !== '전체') parts.push(ui.filters.category);
      var band = PRICE_BANDS.filter(function (p) { return p.id === ui.filters.price; })[0];
      if (band && band.id !== 'all') parts.push(band.label);
      summary.textContent = '총 ' + filtered.length + '개 판' + (parts.length ? ' · ' + parts.join(' · ') : '');
    }
  }

  function renderFilters() {
    var catBox = $('#categoryChips');
    if (catBox) {
      var cats = ['전체'].concat(CATEGORIES);
      catBox.innerHTML = cats.map(function (c) {
        var count = c === '전체'
          ? state.boards.filter(function (b) { return b.status === 'open'; }).length
          : state.boards.filter(function (b) { return b.status === 'open' && b.category === c; }).length;
        return '<button class="chip' + (ui.filters.category === c ? ' active' : '') + '" data-action="filter-cat" data-value="' + h(c) + '">' +
          h(c) + '<span class="chip-num">' + count + '</span></button>';
      }).join('');
    }
    var priceBox = $('#priceChips');
    if (priceBox) {
      priceBox.innerHTML = PRICE_BANDS.map(function (p) {
        return '<button class="chip' + (ui.filters.price === p.id ? ' active' : '') + '" data-action="filter-price" data-value="' + p.id + '">' + h(p.label) + '</button>';
      }).join('');
    }
    var sort = $('#boardSort');
    if (sort) sort.value = ui.filters.sort;
  }

  function filteredBoards() {
    var list = state.boards.filter(function (b) { return b.status === 'open'; });
    if (ui.filters.category !== '전체') list = list.filter(function (b) { return b.category === ui.filters.category; });
    if (ui.filters.price !== 'all') list = list.filter(function (b) { return priceBand(b.price) === ui.filters.price; });
    var sort = ui.filters.sort;
    list = list.slice();
    if (sort === 'price-asc') list.sort(function (a, b) { return a.price - b.price; });
    else if (sort === 'price-desc') list.sort(function (a, b) { return b.price - a.price; });
    else if (sort === 'ending') {
      list.sort(function (a, b) {
        var ra = a.tickets ? remaining(a) / a.tickets : 1;
        var rb = b.tickets ? remaining(b) / b.tickets : 1;
        return ra - rb;
      });
    } else if (sort === 'new') list.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    else list.sort(function (a, b) { return openedCount(b) - openedCount(a); });
    /* v3.9.7 — 품절(잔여 0)·종료 판은 흑백으로 목록 맨 뒤에 밀어둔다 */
    var live = [], done = [];
    list.forEach(function (b) { (isFinishedBoard(b) ? done : live).push(b); });
    return live.concat(done);
  }

  function renderLiveTicker() {
    var box = $('#liveTicker');
    if (!box) return;
    var rows = [];
    state.boards.forEach(function (b) {
      (b.opens || []).slice(0, 4).forEach(function (o) {
        rows.push({ board: b, open: o });
      });
    });
    rows.sort(function (a, b) { return new Date(b.open.at) - new Date(a.open.at); });
    rows = rows.slice(0, 6);
    if (!rows.length) {
      box.innerHTML = '<div class="ticker-empty"><span class="live-dot"></span>첫 판매를 기다리고 있어요. 첫 번째 주인공이 되어보세요!</div>';
      return;
    }
    box.innerHTML = '<div class="ticker-head"><span class="live-dot"></span><b>실시간 판매</b><span class="muted">방금 팔린 번호</span></div>' +
      '<div class="ticker-track">' + rows.map(function (r) {
        return '<a class="ticker-item' + (r.open.last ? ' is-lastone' : '') + '" href="#/board/' + h(r.board.id) + '">' +
          '<span class="ticker-cat">' + h(r.board.category) + '</span>' +
          '<b>' + r.open.n + '번</b>' +
          '<span class="ticker-name">' + h(r.open.name) + '</span>' +
          (r.open.last ? '<span class="ticker-last">🏆 라스트원</span>' : '') +
          '<span class="ticker-time">' + timeAgo(r.open.at) + '</span>' +
        '</a>';
      }).join('') + '</div>';
  }

  /* =========================================================
     8. 뽑기판
     ========================================================= */
  function renderBoard() {
    var board = getBoard(ui.boardId) || firstBoard();
    if (!board) {
      var hero = $('#boardHero');
      if (hero) hero.innerHTML = '<div class="empty" style="padding:40px"><p>열린 쿠지판이 없어요.</p><a class="btn btn-primary" href="#/admin">판 만들기</a></div>';
      return;
    }
    ui.boardId = board.id;
    renderBoardHero(board);
    renderCouponCard(board);
    renderBoardStatus(board);
    renderTicketGrid(board);
    renderMultiDraw(board);
    renderSalesPanel(board);
    renderPrizesPanel(board);
    renderBoardManual(board);
    renderBoardNotice(board);
    $$('.board-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-board-tab') === ui.boardTab);
    });
    $$('[data-board-panel]').forEach(function (p) {
      p.hidden = p.getAttribute('data-board-panel') !== ui.boardTab;
    });
  }

  function renderBoardHero(board) {
    var el = $('#boardHero');
    if (!el) return;
    var left = remaining(board);
    var pct = board.tickets ? Math.round(openedCount(board) / board.tickets * 100) : 0;
    var low = isLowStock(board);
    var lo = lastOneStatus(board);
    el.classList.toggle('is-lowstock', low);
    el.innerHTML = '' +
      '<div class="board-cover ' + (board.cover ? 'has-image ' : '') + categoryClass(board.category) + '">' +
        (board.cover
          ? '<img class="cover-img" src="' + h(coverSrc(board.cover)) + '" alt="' + h(board.category + ' 상품 이미지') + '">' +
            '<span class="cover-scrim" aria-hidden="true"></span>'
          : '<span class="cover-kicker">KUJIKING KUJI</span>' +
            '<strong class="cover-title">' + h(board.category) + '</strong>' +
            '<span class="cover-sub">' + h(board.sub || '') + '</span>') +
      '</div>' +
      '<div class="board-hero-body">' +
        '<span class="pill pill-cream">' + h(board.category) + ' · ' + priceBandLabel(board.price) + '</span>' +
        (low ? '<span class="pill pill-lowstock">🔥 품절임박! 라스트원 찬스</span>' : '') +
        (lo && lo.won ? '<span class="pill pill-lastwon">🏆 라스트원 획득: ' + h(lo.name) + '</span>' : '') +
        (lo && lo.soon ? '<span class="pill pill-lowstock">🔥 라스트원까지 ' + fmt(lo.left) + '장!</span>' : '') +
        '<h1>' + h(board.title) + '</h1>' +
        '<div class="board-meta">' +
          '<span>1장 <b>' + won(board.price) + '</b></span>' +
          '<span>총 <b>' + fmt(board.tickets) + '</b>장</span>' +
          '<span>남은 번호 <b>' + fmt(left) + '</b>장</span>' +
          '<span>라스트원상 포함</span>' +
        '</div>' +
        '<div class="progress">' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="progress-labels"><span>판매 ' + fmt(openedCount(board)) + ' / ' + fmt(board.tickets) + '</span><span>' + pct + '% 진행</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="board-hero-cta">' +
        '<div class="price-tag"><strong>' + fmt(board.price) + '</strong><span>원 / 1장</span></div>' +
        (left === 0
          ? '<span class="btn btn-outline" aria-disabled="true">전량 소진</span>'
          : '<button class="btn btn-primary" data-action="scroll-grid">번호 골라 뽑기</button>') +
        '<button class="btn btn-outline btn-sm" data-action="open-code-modal">교환 코드 입력</button>' +
        '<small>' + (left === 0 ? '이 판은 전량 소진되었습니다' : '번호를 고르면 쿠폰 또는 코드로 뽑을 수 있어요') + '</small>' +
      '</div>';
  }

  function renderCouponCard(board) {
    var el = $('#couponCard');
    if (!el) return;
    var user = me();
    if (!user) {
      el.innerHTML = '<h2>뽑기권으로 뽑기</h2>' +
        '<p class="aside-hint">로그인하면 구매확인으로 받은 뽑기권이 계정에 쌓이고, 당첨 상품을 보관함에서 배송 신청할 수 있어요.</p>' +
        '<button class="btn btn-primary btn-block btn-sm" data-action="open-auth">로그인 / 회원가입</button>' +
        '<button class="btn btn-ghost btn-block btn-sm demo-only" data-action="demo-login">체험 계정으로 시작</button>' +
        '<div class="aside-note">교환 코드가 있으면 로그인 없이도 번호를 열 수 있어요.</div>';
      return;
    }
    var mine = couponsFor(board);
    var total = availableCoupons().length;
    el.innerHTML = '<h2>내 뽑기권 <span class="badge badge-live">' + fmt(total) + '장</span></h2>' +
      (mine.length
        ? '<p class="aside-hint">이 판에 쓸 수 있는 쿠폰 <b>' + fmt(mine.length) + '장</b>이 있어요. 번호를 고른 뒤 쿠폰으로 바로 뽑을 수 있습니다.</p>' +
          '<ul class="coupon-mini">' + mine.slice(0, 3).map(function (c) {
            return '<li><b>' + h(c.boardId ? '이 판 전용' : '전체 사용') + '</b><span>' + h(c.label || '') + '</span></li>';
          }).join('') + '</ul>' +
          '<button class="btn btn-primary btn-block btn-sm" data-action="scroll-grid">쿠폰으로 뽑기</button>'
        : '<p class="aside-hint">이 판에 쓸 수 있는 쿠폰이 없어요. 구매확인을 요청하면 관리자 확인 후 뽑기권이 지급됩니다.</p>' +
          '<button class="btn btn-outline btn-block btn-sm" data-action="go-claim">구매확인 요청</button>' +
          '<div class="aside-note">다른 판 전용 쿠폰은 해당 판에서만 쓸 수 있어요.</div>');
  }

  function tierThumb(t, cls) {
    if (!t || !t.image) {
      return '<span class="' + (cls || 'tier-thumb') + ' is-empty" style="background:' + gradeColor(t ? t.grade : 'e') + '22">' +
        '<b style="color:' + gradeColor(t ? t.grade : 'e') + '">' + h(t ? t.grade : '-') + '</b></span>';
    }
    return '<span class="' + (cls || 'tier-thumb') + '"><img src="' + h(coverSrc(t.image)) + '" alt="' + h(t.label || '') + '" loading="lazy" decoding="async"></span>';
  }

  function renderBoardStatus(board) {
    var el = $('#boardStatus');
    if (!el) return;
    var lo = lastOneStatus(board);
    var rows = board.tiers.map(function (t) {
      var sold = (board.opens || []).filter(function (o) { return o.grade === t.grade; }).length;
      var left = Number(t.count) - sold;
      return '<div class="grade-row' + (left <= 0 ? ' is-out' : '') + '">' +
        tierThumb(t, 'tier-thumb sm') +
        '<span class="grade-name"><b>' + h(t.label) + '</b>' +
        '<span><i class="grade-dot" style="background:' + gradeColor(t.grade) + '"></i>' + h(t.grade) + '상 · ' +
        (t.pointOnly ? '굿즈 포인트 ' + fmt(t.points) + 'P' : h(t.desc || ('전환 ' + fmt(t.points) + 'P'))) + '</span></span>' +
        '<span class="grade-count">' + (left <= 0 ? '소진' : '<em>' + fmt(left) + '</em> / ' + fmt(t.count)) + '</span>' +
      '</div>';
    }).join('');
    el.innerHTML = '<h2>등급 현황 <span class="badge badge-live">실시간</span></h2>' +
      '<div class="grade-rows">' + rows + '</div>' +
      '<button type="button" class="lastone-card' + (lo && lo.won ? ' is-won' : '') + '" data-action="zoom-last">' +
        (board.lastOneImage ? '<img src="' + h(coverSrc(board.lastOneImage)) + '" alt="" loading="lazy">' : '') +
        '<span class="lastone-body"><span class="lastone-kicker">LAST ONE</span><b>' + h(board.lastOneLabel || '라스트원상') + '</b>' +
        (lo && lo.won
          ? '<small class="lastone-won">🏆 라스트원 획득: ' + h(lo.name) + (lo.at ? ' · ' + formatDateTime(lo.at) : '') + '</small>'
          : (lo && lo.soon ? '<small class="lastone-soon">🔥 라스트원까지 ' + fmt(lo.left) + '장!</small>' : '')) +
        (board.lastOneDesc ? '<small>' + h(board.lastOneDesc) + '</small>' : '') + '</span>' +
      '</button>';
  }

  function renderTicketGrid(board) {
    var grid = $('#ticketGrid');
    if (!grid) return;
    var sold = new Map();
    (board.opens || []).forEach(function (o) { sold.set(o.n, o); });
    var html = '';
    for (var n = 1; n <= board.tickets; n++) {
      var o = sold.get(n);
      if (o) {
        html += '<button class="ticket is-open" style="--ticket-color:' + gradeColor(o.grade) + '" ' +
          'data-action="ticket-info" data-n="' + n + '" title="' + h(o.name + ' · ' + timeAgo(o.at)) + '" ' +
          'aria-label="' + n + '번, ' + h(o.grade) + '상 판매 완료">' +
          '<span class="ticket-grade">' + h(o.grade) + '</span>' +
          '<span class="ticket-num">' + n + '</span>' +
          '<span class="ticket-buyer">' + h(o.name) + '</span>' +
          (o.last ? '<span class="last-flag" aria-hidden="true">' + icon('crown') + '</span>' : '') +
          '</button>';
      } else {
        html += '<button class="ticket" data-action="pick-ticket" data-n="' + n + '" aria-label="' + n + '번 선택">' +
          '<span class="ticket-num">' + pad2(n) + '</span>' +
          '<span class="ticket-hint">뽑기</span>' +
          '</button>';
      }
    }
    grid.classList.toggle('is-dense', board.tickets > 100);
    grid.innerHTML = html;
    var summary = $('#gridSummary');
    if (summary) summary.textContent = fmt(board.tickets) + '장 중 ' + fmt(remaining(board)) + '장 남음 · 판매 ' + fmt(openedCount(board)) + '장';
    var sc = $('#salesCount');
    if (sc) sc.textContent = fmt(openedCount(board));
  }

  /* =========================================================
     무작위 연뽑 (v3.9.3) — 5 · 10 · 15 · 20장
     번호를 고르지 않고 남은 번호 중 무작위로 N개를 골라
     한 장씩 차례로 뽑은 뒤 결과를 한 화면에 요약한다.
     ========================================================= */
  var MULTI_COUNTS = [5, 10, 15, 20];

  function multiState(board) {
    var user = me();
    var price = Math.max(0, Number(board.price) || 0);
    return {
      left: remaining(board),
      price: price,
      mine: user ? couponsFor(board) : [],
      have: user ? Number(user.points || 0) : 0,
      user: user
    };
  }

  function renderMultiDraw(board) {
    var el = $('#multiDraw');
    if (!el) return;
    var ms = multiState(board);
    if (board.status !== 'open' || ms.left <= 0) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;

    var buttons = MULTI_COUNTS.map(function (n) {
      var short = ms.left < n;
      var canCoupon = ms.mine.length >= n;
      var canPoints = ms.price > 0 && ms.have >= ms.price * n;
      var state = short ? ('잔여 ' + fmt(ms.left) + '장')
        : (canCoupon ? ('쿠폰 ' + fmt(n) + '장') : (canPoints ? ('포인트 ' + fmt(ms.price * n) + 'P') : '체험 코드'));
      return '<button class="md-btn' + (short ? ' is-off' : '') + '" type="button" data-action="multi-draw" data-count="' + n + '"' +
        (short ? ' disabled aria-disabled="true"' : '') + '>' +
        '<span class="md-n">' + n + '<em>연뽑</em></span>' +
        '<span class="md-price">' + won(ms.price * n) + '</span>' +
        '<span class="md-state">' + h(state) + '</span>' +
      '</button>';
    }).join('');

    /* 5장도 남지 않았을 때: 남은 번호를 한 번에 뽑는 마지막 버튼 */
    var restBtn = (ms.left < MULTI_COUNTS[0])
      ? '<button class="md-btn md-rest" type="button" data-action="multi-draw" data-count="' + ms.left + '">' +
          '<span class="md-n">' + ms.left + '<em>연뽑</em></span>' +
          '<span class="md-price">' + won(ms.price * ms.left) + '</span>' +
          '<span class="md-state">잔여 전체</span>' +
        '</button>'
      : '';

    el.innerHTML = '<div class="md-head">' +
        '<span class="md-dice" aria-hidden="true">🎲</span>' +
        '<div class="md-copy"><b>무작위 연뽑</b>' +
          '<p>번호를 고르지 않고 <b>남은 번호 중에서 무작위로</b> 뽑아요. 결과는 한 장씩 차례로 나옵니다.</p>' +
        '</div>' +
      '</div>' +
      '<div class="md-row">' + buttons + restBtn + '</div>' +
      '<p class="md-foot">쿠폰은 보유한 뽑기권에서 차례로 쓰고, 포인트는 1장 가격 × 장수만큼 차감돼요. 교환 코드는 1장 전용이라 연뽑에는 체험 코드를 써 주세요.</p>';
  }

  function openMultiDraw(count) {
    var board = getBoard(ui.boardId);
    if (!board) return;
    if (board.status !== 'open') { toast('종료된 판이에요', 'err'); return; }
    var left = remaining(board);
    if (left <= 0) { toast('이 판은 전량 소진되었어요', 'err'); return; }
    var n = Math.min(Math.max(1, Number(count) || MULTI_COUNTS[0]), left);
    ui.draw = { boardId: board.id, batch: true, count: n, step: 'source', busy: false, results: [], numbers: [], error: '' };
    renderDrawModal();
  }

  function renderSalesPanel(board) {
    var el = $('#salesPanel');
    if (!el) return;
    var rows = (board.opens || []).slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    if (!rows.length) {
      el.innerHTML = '<div class="empty"><span class="empty-icon">' + icon('clock') + '</span><p>아직 판매 내역이 없어요. 첫 번째로 이 판의 번호를 뽑아보세요!</p>' +
        '<button class="btn btn-primary" data-action="scroll-grid">번호 고르기</button></div>';
      return;
    }
    el.innerHTML = '<div class="sales-head">' +
        '<div><h2>실제 판매 내역</h2><p class="muted">구매자 닉네임은 개인정보 보호를 위해 마스킹해서 표시합니다.</p></div>' +
        '<div class="sales-stats"><span>판매 <b>' + fmt(rows.length) + '</b>장</span><span>남은 <b>' + fmt(remaining(board)) + '</b>장</span></div>' +
      '</div>' +
      '<div class="sales-list">' + rows.map(function (o) {
        var tier = tierOf(board, o.grade);
        return '<div class="sales-row">' +
          '<span class="sales-time">' + formatDateTime(o.at) + '<em>' + timeAgo(o.at) + '</em></span>' +
          '<span class="sales-num">' + o.n + '번</span>' +
          '<span class="sales-name">' + h(o.name) + (o.demo ? ' <i class="demo-i">체험</i>' : '') + '</span>' +
          '<span class="grade-badge sm" style="background:' + gradeColor(o.grade) + '">' + h(o.grade) + '</span>' +
          '<span class="sales-prize">' + h(tier ? tier.label : '') + '</span>' +
          (o.last ? '<span class="badge">' + icon('crown') + ' 라스트원</span>' : '') +
        '</div>';
      }).join('') + '</div>';
  }

  function renderPrizesPanel(board) {
    var el = $('#prizesPanel');
    if (!el) return;
    var total = board.tickets || 1;
    var cards = board.tiers.map(function (t) {
      var sold = (board.opens || []).filter(function (o) { return o.grade === t.grade; }).length;
      var left = Math.max(0, Number(t.count) - sold);
      var pct = (t.count / total * 100).toFixed(1).replace(/\.0$/, '');
      var isP = String(t.grade).toUpperCase() === 'P' || !!t.pointOnly;
      return '<button type="button" class="prize-card' + (left === 0 ? ' is-out' : '') + (isP ? ' is-point' : '') + '" data-action="zoom-tier" data-grade="' + h(t.grade) + '">' +
          '<span class="prize-media">' +
            (t.image ? '<img src="' + h(coverSrc(t.image)) + '" alt="' + h(t.label) + '" loading="lazy" decoding="async">'
                     : (isP ? '<span class="prize-media-point"><b>P</b><em>' + fmt(t.points) + 'P</em></span>'
                            : '<span class="prize-media-empty" style="color:' + gradeColor(t.grade) + '">' + h(t.grade) + '</span>')) +
            (t.image ? '' : '<span class="rank-badge grade-' + h(String(t.grade).toLowerCase()) + '">' + h(t.grade) + '상</span>') +
            (left === 0 ? '<span class="prize-out">소진</span>' : '') +
          '</span>' +
          '<span class="prize-body">' +
            '<b class="prize-name">' + h(t.label) + '</b>' +
            (t.desc ? '<span class="prize-desc">' + h(t.desc) + '</span>' : '') +
            '<span class="prize-meta"><span>' + (isP ? '당첨 ' + fmt(t.count) + '장' : '수령 ' + fmt(t.count) + '개') + '</span><span>' + pct + '%</span><span>잔여 ' + fmt(left) + '</span></span>' +
          '</span>' +
        '</button>';
    }).join('');

    var lo = '<button type="button" class="prize-card prize-last" data-action="zoom-last">' +
        '<span class="prize-media">' +
          (board.lastOneImage ? '<img src="' + h(coverSrc(board.lastOneImage)) + '" alt="' + h(board.lastOneLabel || '라스트원상') + '" loading="lazy" decoding="async">'
                              : '<span class="prize-media-empty">★</span>') +
          (board.lastOneImage ? '' : '<span class="rank-badge grade-last">LAST ONE</span>') +
        '</span>' +
        '<span class="prize-body">' +
          '<b class="prize-name">' + h(board.lastOneLabel || '라스트원상') + '</b>' +
          (board.lastOneDesc ? '<span class="prize-desc">' + h(board.lastOneDesc) + '</span>' : '') +
          '<span class="prize-meta"><span>' + (board.lastOneWinnerName ? '🏆 ' + h(board.lastOneWinnerName) : '마지막 1장') + '</span><span>' + (board.lastOneWinnerName ? '지급 완료' : '별도 지급') + '</span></span>' +
        '</span>' +
      '</button>';

    var lineupSrc = lineupSrcOf(board);
    var lineupBlock = lineupSrc
        ? '<figure class="prize-lineup"><img src="' + h(coverSrc(lineupSrc)) + '" alt="' + h(board.title) + ' 전체 구성 피규어 라인업" width="1600" height="760" loading="lazy" decoding="async" onerror="var f=this.closest(&quot;figure&quot;);if(f){f.style.display=&quot;none&quot;}"></figure>'
        : '';

    el.innerHTML = '<div class="prizes-head"><div class="prizes-head-main">' +
        '<span class="step-no">1</span>' +
        '<div><h2>상품 구성 <span class="muted">총 ' + fmt(board.tickets) + '장</span></h2>' +
        '<p class="muted">' + ((board.tiers.length * 20 === Number(board.tickets) && !hasPointTier(board))
            ? '등급 ' + board.tiers.length + '종 × 20장 = ' + fmt(board.tickets) + '장 구성입니다. '
            : '등급 ' + board.tiers.length + '종 · 총 ' + fmt(board.tickets) + '장 구성입니다. ') +
          '실물 이미지를 누르면 크게 볼 수 있어요.</p></div></div>' +
        '<span class="prizes-count">' + board.tiers.length + '등급 + 라스트원</span></div>' +
      lineupBlock +
      '<div class="prize-gallery' + (board.tiers.length > 6 ? ' is-dense' : '') + '">' + cards + lo + '</div>' +
      '<div class="prize-table-wrap">' +
        '<div class="table-scroll"><table class="data-table prob-table"><thead><tr><th>등급</th><th>상품</th><th>수량</th><th>확률</th><th>잔여</th></tr></thead><tbody>' +
        board.tiers.map(function (t) {
          var sold = (board.opens || []).filter(function (o) { return o.grade === t.grade; }).length;
          var pct = board.tickets ? (t.count / board.tickets * 100) : 0;
          return '<tr>' +
            '<td><span class="grade-badge" style="background:' + gradeColor(t.grade) + ';width:28px;height:28px;font-size:12px">' + h(t.grade) + '</span></td>' +
            '<td>' + h(t.label) + (t.pointOnly ? ' <span class="muted">P상 · 즉시 적립</span>' : '') + '</td>' +
            '<td class="num">' + fmt(t.count) + '개</td>' +
            '<td class="num">' + pct.toFixed(1).replace(/\.0$/, '') + '%</td>' +
            '<td class="num">' + fmt(Math.max(0, t.count - sold)) + '개</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>' +
      '</div>';
  }

  function renderBoardManual(board) {
    var el = $('#boardManual');
    if (!el) return;
    var m = manualOf(board);
    var specs = Array.isArray(m.specs) ? m.specs : [];
    var lineup = Array.isArray(m.lineup) ? m.lineup : [];
    var notes = Array.isArray(m.notes) ? m.notes : [];
    var probs = (board.tiers || []).map(function (t) {
      return t.grade + '상 ' + (t.count / (board.tickets || 1) * 100).toFixed(1).replace(/\.0$/, '') + '%';
    }).join(' · ');
    var baseNotes = [
      probs ? '등급별 확률: ' + probs : '등급별 확률은 상품 구성 표를 참고해 주세요.',
      '한 번 연 번호는 되돌릴 수 없고, 개봉(사용) 후에는 청약철회가 제한됩니다.',
      '당첨 상품은 내 보관함에 보관되고, 배송 신청 또는 굿즈 포인트 전환을 선택할 수 있습니다.',
      '상품 사진은 제조사 제공 이미지이며, 실제 상품과 색상·조립 상태가 다를 수 있습니다.'
    ];
    var allNotes = notes.concat(baseNotes);
    el.innerHTML = '<details class="manual-details">' +
        '<summary class="manual-summary-bar">' +
          '<span class="manual-kicker">PRODUCT MANUAL</span>' +
          '<b>상품 설명서 · 안내</b>' +
          '<span class="manual-summary-text">' + h(m.summary || (board.title + '의 실제 상품 구성과 이용 안내입니다.')) + '</span>' +
          '<span class="manual-toggle">펼치기</span>' +
        '</summary>' +
        '<div class="manual-body">' +
          '<div class="manual-head">' +
            '<div><h2>상품 설명서 · 안내</h2>' +
            '<p class="manual-summary">' + h(m.summary || (board.title + '의 실제 상품 구성과 이용 안내입니다.')) + '</p></div>' +
            '<div class="manual-stamp"><span>OFFICIAL LINEUP</span><b>' + h((specs.filter(function (s) { return s.k === '세트 구성'; })[0] || {}).v || '실물 상품') + '</b></div>' +
          '</div>' +
          '<div class="manual-grid">' +
            '<dl class="manual-specs">' + (specs.length ? specs.map(function (s) {
              return '<div><dt>' + h(s.k) + '</dt><dd>' + h(s.v) + '</dd></div>';
            }).join('') : '<div><dt>시리즈</dt><dd>' + h(board.category) + '</dd></div><div><dt>판매</dt><dd>1장 ' + won(board.price) + ' · 총 ' + fmt(board.tickets) + '장</dd></div>') + '</dl>' +
            (lineup.length ? '<div class="manual-lineup"><h3>실제 라인업</h3><ul>' + lineup.map(function (line) {
              return '<li>' + h(line) + '</li>';
            }).join('') + '</ul></div>' : '') +
          '</div>' +
          '<div class="manual-notes"><h3>이용 안내 · 유의사항</h3><ul>' + allNotes.map(function (n) {
            return '<li>' + h(n) + '</li>';
          }).join('') + '</ul></div>' +
        '</div>' +
      '</details>';
  }

  function showTierZoom(grade) {
    var board = getBoard(ui.boardId);
    if (!board) return;
    var isLast = grade === 'LAST';
    var t = isLast ? null : tierOf(board, grade);
    if (!isLast && !t) return;
    var image = isLast ? board.lastOneImage : t.image;
    var label = isLast ? (board.lastOneLabel || '라스트원상') : t.label;
    var desc = isLast ? board.lastOneDesc : t.desc;
    var badgeCls = isLast ? 'grade-last' : ('grade-' + String(grade).toLowerCase());
    var badgeTxt = isLast ? 'LAST ONE' : grade + '상';
    var isP = !isLast && (String(grade).toUpperCase() === 'P' || !!t.pointOnly);
    openModal('' +
      '<div class="zoom-view' + (isP ? ' is-point' : '') + '">' +
        '<div class="zoom-media">' +
          (image ? '<img src="' + h(image) + '" alt="' + h(label) + '">'
                 : (isP ? '<div class="zoom-point"><b>P</b><em>' + fmt(t.points) + 'P</em></div>' : '<div class="zoom-empty">이미지 준비 중</div>')) +
          (image ? '' : '<span class="rank-badge ' + badgeCls + ' lg">' + h(badgeTxt) + '</span>') +
        '</div>' +
        '<h2 class="zoom-title">' + h(label) + '</h2>' +
        (desc ? '<p class="zoom-desc">' + h(desc) + '</p>' : '') +
        '<p class="zoom-meta">' + (isLast
          ? (board.lastOneWinnerName
              ? '🏆 라스트원 획득: ' + h(board.lastOneWinnerName) + (board.lastOneWonAt ? ' · ' + formatDateTime(board.lastOneWonAt) : '')
              : '마지막 1장을 뽑은 분께 추가 지급')
          : (isP ? ('당정 ' + fmt(t.count) + '장 · 바로 ' + fmt(t.points) + 'P 적립') : ('수령 ' + fmt(t.count) + '개 · 전환 ' + fmt(t.points) + 'P'))) + '</p>' +
        '<div class="modal-actions"><button class="btn btn-dark" data-action="close-modal">닫기</button></div>' +
      '</div>');
  }

  function renderBoardNotice(board) {
    var el = $('#boardNotice');
    if (!el) return;
    var probs = board.tiers.map(function (t) {
      return t.grade + ' ' + (t.count / board.tickets * 100).toFixed(1).replace(/\.0$/, '') + '%';
    }).join(' · ');
    el.innerHTML = '<h3>뽑기 이용 안내</h3><ul>' +
      '<li>라스트원상은 한 판의 마지막 1장을 뽑은 분께 추가로 지급됩니다.</li>' +
      '<li>쿠폰(뽑기권)은 구매확인 승인 후 계정에 지급되며, 이 판 전용 또는 모든 판 사용권으로 나뉩니다.</li>' +
      '<li>교환 코드는 1회용이며, 개봉(사용) 후에는 재사용할 수 없습니다.</li>' +
      '<li>굿즈 포인트로도 뽑을 수 있습니다. 뽑으면 이 판 가격(' + won(board.price) + ')만큼 회원 포인트에서 차감됩니다.</li>' +
      '<li>당첨 상품은 <a href="#/my" class="inline-link">내 보관함</a>에서 배송 신청 또는 굿즈 포인트 전환을 선택할 수 있습니다.</li>' +
      '<li>상품 라인업과 확률·유의사항은 위 <b>상품 설명서</b>에서 확인해 주세요.</li>' +
      '</ul>' +
      '<div class="ship-line">' +
        '<div class="ship-line-copy"><b>배송비 · 합배송</b><span data-ship-notice>' + h(shippingNotice()) + '</span></div>' +
        kakaoPillHTML('kakao-pill-sm') +
      '</div>' +
      '<p class="fine">봉인 해시(SHA-256): <code>' + h(String(board.seedHash || '').slice(0, 40)) + '…</code><br>' +
      '결과는 판이 열리기 전 봉인되었으며, <a href="#/fairness/' + h(board.id) + '" class="inline-link">공정성 검증</a>에서 직접 확인할 수 있습니다.</p>';
  }

  /* =========================================================
     9. 뽑기 흐름
     ========================================================= */
  function pickTicket(n) {
    var board = getBoard(ui.boardId);
    if (!board) return;
    if (board.status !== 'open') { toast('종료된 판이에요', 'err'); return; }
    if (remaining(board) === 0) { toast('이 판은 전량 소진되었어요', 'err'); return; }
    var existing = (board.opens || []).filter(function (o) { return o.n === n; })[0];
    if (existing) { showTicketInfo(n); return; }

    ui.draw = { boardId: board.id, n: n, step: 'source', busy: false };
    renderDrawModal();
  }

  function renderDrawModal() {
    var d = ui.draw;
    if (!d) return;
    var board = getBoard(d.boardId);
    if (!board) return;
    var dark = d.step === 'seal' || d.step === 'promote' || (d.step === 'result' && !d.batch && isEpicGrade(d.result && d.result.grade)) || (d.step === 'spotlight' && isEpicGrade(d.result && d.result.grade));
    var html;
    if (d.step === 'source') html = d.batch ? multiSourceHTML(board, d) : drawSourceHTML(board, d);
    else if (d.step === 'drawing') html = multiProgressHTML(board, d);
    else if (d.step === 'reveal') html = multiRevealHTML(board, d);
    else if (d.step === 'spotlight') html = drawResultHTML(board, d);
    else if (d.step === 'peel') html = drawPeelHTML(board, d);
    else if (d.step === 'seal') html = drawSealHTML(board, d);
    else if (d.step === 'promote') html = drawPromoteHTML(board, d);
    else html = d.batch ? batchResultHTML(board, d) : drawResultHTML(board, d);
    openModal(html, {
      keepFocus: d.step === 'result',
      noAutofocus: d.step === 'peel' || d.step === 'seal' || d.step === 'promote' || d.step === 'drawing' || d.step === 'reveal' || d.step === 'spotlight',
      dark: dark,
      dragLock: d.step === 'peel' || d.step === 'seal',
      resetScroll: d.step === 'result' || d.step === 'spotlight' || d.step === 'seal' || d.step === 'peel' || d.step === 'promote' || d.step === 'drawing'
    });
    /* B상 · A상 · 라스트원은 결과가 터질 때 모달 전체가 흔들린다 */
    if ((d.step === 'result' || d.step === 'spotlight') && modalShell && !d.batch) {
      var hitLv = gradeLevel(d.result && d.result.grade);
      if (hitLv >= 2) {
        modalShell.style.setProperty('--quake', hitLv >= 3 ? '1.75' : '1');
        modalShell.classList.remove('is-quake');
        void modalShell.offsetWidth;
        modalShell.classList.add('is-quake');
      }
    }
    if (d.step === 'source') {
      var input = d.batch ? $('#multiCodeInput') : $('#drawCodeInput');
      if (input && ui.pendingCode) input.value = ui.pendingCode;
    } else if (d.step === 'peel') {
      bindPeel();
      paintPeek(d);
    } else if (d.step === 'seal') {
      bindSeal();
    } else if (d.step === 'promote') {
      bindPromote(d);
    } else if (d.step === 'result' || d.step === 'spotlight') {
      /* 라스트원상 당첨 — 결과 화면이 처음 뜰 때 한 번만 축하 연출 */
      if (!d.batch) lastOneCelebrate(d);
    }
  }

  function drawSourceHTML(board, d) {
    var user = me();
    var mine = couponsFor(board);
    var price = Math.max(0, Number(board.price) || 0);
    var have = user ? Number(user.points || 0) : 0;
    var gap = Math.max(0, price - have);
    var canPoints = !!user && price > 0 && have >= price;
    var html = '<h2 class="modal-title" id="modalTitle">' + d.n + '번 뽑기</h2>' +
      '<p class="modal-sub">' + h(board.title) + ' · ' + won(board.price) + '</p>';

    if (mine.length) {
      html += '<div class="pay-option is-primary">' +
        '<div class="pay-head"><span class="pay-badge">보유 뽑기권</span><b>' + fmt(mine.length) + '장 사용 가능</b></div>' +
        '<p class="pay-desc">' + h(mine[0].boardId ? '이 판 전용 쿠폰을 먼저 사용합니다.' : '모든 판에 쓸 수 있는 쿠폰입니다.') + '</p>' +
        '<button class="btn btn-primary btn-block" data-action="draw-coupon" data-id="' + h(mine[0].id) + '">쿠폰 1장으로 뽑기</button>' +
      '</div>';
    } else if (!user) {
      html += '<div class="pay-option login-hint">' +
        '<div class="pay-head"><span class="pay-badge">회원 혜택</span><b>로그인하면 뽑기권으로 뽑기</b></div>' +
        '<p class="pay-desc">구매확인으로 받은 뽑기권이 계정에 쌓이고, 당첨 상품을 보관함에서 배송 신청할 수 있어요.</p>' +
        '<button class="btn btn-outline btn-block btn-sm" data-action="open-auth">로그인 / 회원가입</button>' +
      '</div>';
    } else {
      html += '<div class="pay-option">' +
        '<div class="pay-head"><span class="pay-badge">보유 뽑기권</span><b>0장</b></div>' +
        '<p class="pay-desc">구매확인을 요청하면 관리자 확인 후 뽑기권이 지급됩니다.</p>' +
        '<button class="btn btn-outline btn-block btn-sm" data-action="go-claim">구매확인 요청하기</button>' +
      '</div>';
    }

    /* 굿즈 포인트로 뽑기 — 로그인 회원이면 항상 보이고, 잔액이 모자라면 안내와 함께 잠근다 */
    if (user) {
      html += '<div class="pay-option is-points' + (canPoints ? '' : ' is-off') + '">' +
        '<div class="pay-head"><span class="pay-badge is-points">굿즈 포인트</span>' +
        '<b class="pay-need">포인트로 뽑기 <em>(필요: ' + fmt(price) + 'P · 보유: ' + fmt(have) + 'P)</em></b></div>' +
        '<p class="pay-desc">' + (canPoints
          ? '보관함 상품을 포인트로 바꾼 잔액으로 바로 뽑을 수 있어요. 뽑으면 <b>' + fmt(price) + 'P</b>가 차감됩니다.'
          : '<b class="pay-gap">' + fmt(gap) + 'P</b> 부족해요. 내 보관함에서 당첨 상품을 <b>포인트 전환</b>하면 바로 뽑을 수 있어요.') + '</p>' +
        (canPoints
          ? '<button class="btn btn-gold btn-block" data-action="draw-points">포인트로 뽑기 (' + fmt(price) + 'P 사용)</button>'
          : '<button class="btn btn-outline btn-block btn-sm" data-action="go-my-points">내 보관함에서 포인트 전환하기</button>') +
        '</div>';
    } else {
      html += '<div class="pay-option is-points is-off">' +
        '<div class="pay-head"><span class="pay-badge is-points">굿즈 포인트</span>' +
        '<b class="pay-need">포인트로 뽑기 <em>(필요: ' + fmt(price) + 'P · 보유: 0P)</em></b></div>' +
        '<p class="pay-desc">로그인하면 보유 굿즈 포인트로도 뽑을 수 있어요. 하위 등급을 포인트로 바꿔 모을 수 있습니다.</p>' +
        '<button class="btn btn-outline btn-block btn-sm" data-action="open-auth">로그인하고 포인트로 뽑기</button>' +
        '</div>';
    }

    html += '<div class="pay-divider"><span>또는 교환 코드</span></div>' +
      '<form class="code-form" data-form="draw-code" novalidate>' +
      '<label class="sr-only" for="drawCodeInput">교환 코드</label>' +
      '<input id="drawCodeInput" class="code-input" name="code" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="24" placeholder="KJ-XXXX-XXXX">' +
      '<p class="field-error" data-role="code-error" role="alert"></p>' +
      '<button class="btn ' + (mine.length ? 'btn-outline' : 'btn-primary') + '" type="submit">코드 확인</button>' +
    '</form>' +
    '<div class="demo-box">' +
      '<p><strong>체험용 무료 코드</strong>' + h(state.settings.demoCode) + ' — 결제 없이 뽑기를 미리 체험해 볼 수 있어요.</p>' +
      '<button class="btn btn-outline btn-sm" type="button" data-action="fill-demo-code">' + h(state.settings.demoCode) + ' 넣기</button>' +
    '</div>' +
    '<p class="result-meta">한 번 개봉한 번호는 되돌릴 수 없어요.</p>';

    return html;
  }

  /* ---------- 무작위 연뽑: 결제 수단 선택 ---------- */
  function multiSourceHTML(board, d) {
    var ms = multiState(board);
    var n = d.count;
    var need = ms.price * n;
    var canCoupon = ms.mine.length >= n;
    var canPoints = ms.price > 0 && ms.have >= need;
    var html = '<h2 class="modal-title" id="modalTitle">무작위 ' + n + '연뽑</h2>' +
      '<p class="modal-sub">' + h(board.title) + ' · 1장 ' + won(ms.price) + ' · <b>' + n + '장 ' + won(need) + '</b></p>' +
      '<div class="md-how"><span class="md-how-dice" aria-hidden="true">🎲</span>' +
        '<p>남은 번호 <b>' + fmt(ms.left) + '장</b> 중 무작위로 <b>' + n + '개</b> 번호를 골라 봉인된 티켓으로 도착시켜요. 카드를 하나씩 누르면 그 자리에서 개봉됩니다.</p></div>';

    /* 보유 뽑기권 */
    html += '<div class="pay-option' + (canCoupon ? ' is-primary' : '') + '">' +
      '<div class="pay-head"><span class="pay-badge">보유 뽑기권</span><b>' + fmt(ms.mine.length) + '장 보유</b></div>' +
      '<p class="pay-desc">' + (canCoupon
        ? '이 판에 쓸 수 있는 뽑기권 <b>' + n + '장</b>을 차례로 사용합니다.'
        : '<b class="pay-gap">' + fmt(Math.max(0, n - ms.mine.length)) + '장</b> 부족해요. (필요 ' + n + '장 · 보유 ' + fmt(ms.mine.length) + '장)') + '</p>' +
      (canCoupon
        ? '<button class="btn btn-primary btn-block" data-action="multi-coupon">쿠폰 ' + n + '장으로 뽑기</button>'
        : (ms.user
          ? '<button class="btn btn-outline btn-block btn-sm" data-action="go-claim">구매확인 요청하기</button>'
          : '<button class="btn btn-outline btn-block btn-sm" data-action="open-auth">로그인 / 회원가입</button>')) +
    '</div>';

    /* 굿즈 포인트 */
    if (ms.user) {
      html += '<div class="pay-option is-points' + (canPoints ? '' : ' is-off') + '">' +
        '<div class="pay-head"><span class="pay-badge is-points">굿즈 포인트</span>' +
        '<b class="pay-need">포인트로 뽑기 <em>(필요: ' + fmt(need) + 'P · 보유: ' + fmt(ms.have) + 'P)</em></b></div>' +
        '<p class="pay-desc">' + (canPoints
          ? '<b>' + n + '장</b>을 뽑으면 <b>' + fmt(need) + 'P</b>가 차감됩니다.'
          : '<b class="pay-gap">' + fmt(Math.max(0, need - ms.have)) + 'P</b> 부족해요. 내 보관함에서 당첨 상품을 포인트로 바꾸면 바로 뽑을 수 있어요.') + '</p>' +
        (canPoints
          ? '<button class="btn btn-gold btn-block" data-action="multi-points">포인트로 ' + n + '장 뽑기 (' + fmt(need) + 'P)</button>'
          : '<button class="btn btn-outline btn-block btn-sm" data-action="go-my-points">내 보관함에서 포인트 전환하기</button>') +
      '</div>';
    } else {
      html += '<div class="pay-option is-points is-off">' +
        '<div class="pay-head"><span class="pay-badge is-points">굿즈 포인트</span>' +
        '<b class="pay-need">포인트로 뽑기 <em>(필요: ' + fmt(need) + 'P)</em></b></div>' +
        '<p class="pay-desc">로그인하면 보유 포인트로 <b>' + n + '장</b>을 한 번에 뽑을 수 있어요.</p>' +
        '<button class="btn btn-outline btn-block btn-sm" data-action="open-auth">로그인하고 포인트로 뽑기</button>' +
      '</div>';
    }

    /* 교환 코드 — 1회용 코드는 1장 전용, 체험 코드는 연뽑 가능 */
    html += '<div class="pay-divider"><span>또는 교환 코드</span></div>' +
      '<form class="code-form" data-form="multi-code" novalidate>' +
        '<label class="sr-only" for="multiCodeInput">교환 코드</label>' +
        '<input id="multiCodeInput" class="code-input" name="code" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="24" placeholder="KJ-XXXX-XXXX">' +
        '<p class="field-error" data-role="code-error" role="alert"></p>' +
        '<button class="btn btn-outline" type="submit">코드로 ' + n + '장 뽑기</button>' +
      '</form>' +
      '<p class="md-code-note">교환 코드는 <b>1장 전용</b>이에요. ' + n + '장 연뽑은 <b>보유 쿠폰 · 포인트 · 체험 코드</b>로 할 수 있어요.</p>' +
      '<div class="demo-box">' +
        '<p><strong>체험용 무료 코드</strong>' + h(state.settings.demoCode) + ' — 체험 코드는 연뽑에도 쓸 수 있어요.</p>' +
        '<button class="btn btn-outline btn-sm" type="button" data-action="fill-demo-code">' + h(state.settings.demoCode) + ' 넣기</button>' +
      '</div>' +
      '<p class="result-meta">한 번 개봉한 번호는 되돌릴 수 없어요. 뽑을 번호는 무작위로 정해지며 뽑기 직전에 확정됩니다.</p>';

    return html;
  }

  /* ---------- 무작위 연뽑: 한 장씩 뽑는 진행 화면 ---------- */
  /* 진행 중에는 등급·상품명·이미지를 절대 노출하지 않는다.
     결과는 봉인된 티켓 그리드에서 직접 개봉할 때만 공개한다 (스포일러 방지). */
  function multiProgressRows(d) {
    var rows = '';
    for (var i = 0; i < d.count; i++) {
      var r = d.results[i];
      var no = d.numbers[i];
      if (r) {
        rows += '<li class="mdp-row is-done">' +
          '<span class="mdp-no">#' + pad2(r.n) + '</span>' +
          '<span class="mdp-label">티켓 확보 완료 ✓</span>' +
        '</li>';
      } else if (i === d.results.length && !d.error) {
        rows += '<li class="mdp-row is-now">' +
          '<span class="mdp-no">#' + pad2(no) + '</span>' +
          '<span class="mdp-spin" aria-hidden="true">🎲</span>' +
          '<span class="mdp-wait">티켓 확보 중…</span>' +
        '</li>';
      } else {
        rows += '<li class="mdp-row is-wait">' +
          '<span class="mdp-no">#' + pad2(no) + '</span>' +
          '<span class="mdp-wait">대기</span>' +
        '</li>';
      }
    }
    return rows;
  }

  function multiProgressHTML(board, d) {
    var pct = d.count ? Math.round(d.results.length / d.count * 100) : 0;
    return '<div class="mdp-stage">' +
      '<p class="mdp-kicker">MULTI DRAW · 무작위 ' + d.count + '연뽑</p>' +
      '<h2 class="modal-title" id="modalTitle" style="padding-right:0">번호를 뽑고 있어요</h2>' +
      '<p class="modal-sub">남은 번호 중 무작위로 고른 번호를 봉인된 채로 모읍니다. 등급과 상품은 카드를 열 때 공개돼요.</p>' +
      '<div class="mdp-bar" aria-hidden="true"><i id="mdpBarFill" style="width:' + pct + '%"></i></div>' +
      '<p class="mdp-count"><b id="mdpDone">' + d.results.length + '</b> / ' + d.count + '장</p>' +
      '<ul class="mdp-list" id="mdpList">' + multiProgressRows(d) + '</ul>' +
      (d.error ? '<p class="mdp-err" id="mdpErr">' + h(d.error) + '</p>' : '') +
    '</div>';
  }

  /* 진행 화면은 모달을 다시 그리지 않고 목록만 갱신한다 (스크롤·초점이 튀지 않게) */
  function updateMultiProgress() {
    var d = ui.draw;
    if (!d || d.step !== 'drawing') return;
    var list = $('#mdpList');
    if (list) list.innerHTML = multiProgressRows(d);
    var done = $('#mdpDone');
    if (done) done.textContent = String(d.results.length);
    var bar = $('#mdpBarFill');
    if (bar) bar.style.width = Math.round(d.results.length / Math.max(1, d.count) * 100) + '%';
    if (d.error) {
      var err = $('#mdpErr');
      if (err) err.textContent = d.error;
      else if (list) list.insertAdjacentHTML('afterend', '<p class="mdp-err" id="mdpErr">' + h(d.error) + '</p>');
    }
  }

  /* ---------- 무작위 연뽑: 봉인 티켓 그리드 (한 장씩 직접 개봉) ----------
     뽑기가 끝나면 결과를 바로 보여 주지 않고 N장의 '봉인 티켓'으로 깔아 둔다.
     한 장을 누르면 그 카드만 샤악! 하고 뒤집혀 등급·상품이 공개되고,
     C상 이상이면 C→B→A 승격 연출을 한 번 보여 준 뒤 그 카드로 돌아온다. */
  function mrGradeText(g) {
    return String(g || '').toUpperCase() === 'LAST' ? '라스트원' : (String(g || '') + '상');
  }
  function mrGradeKey(g) {
    return String(g || '').toUpperCase() === 'LAST' ? 'last' : String(g || '').toLowerCase();
  }
  function mrBc(g) {
    var k = mrGradeKey(g);
    return k === 'last' ? 'var(--gold)' : 'var(--grade-' + k + ')';
  }
  function multiRevealOpened(d) {
    var rs = d.results || [], k = 0;
    for (var i = 0; i < rs.length; i++) if (d.revealed && d.revealed[i]) k++;
    return k;
  }

  /* 카드 앞면 = 봉인(#번호 · ? · 띠링!) / 뒷면 = 공개면(등급 배지 · 상품명) */
  function multiRevealFace(board, r) {
    var t = tierOf(board, r.grade) || {};
    var label = r.tierLabel || t.label || '';
    var g = String(r.grade || '').toUpperCase();
    return '<span class="mrv-face mrv-back" style="--bc:' + mrBc(r.grade) + '">' +
      '<span class="mrv-bn">#' + r.n + '</span>' +
      '<b class="mrv-bg">' + h(g === 'LAST' ? 'L' : g) + '<i>' + (g === 'LAST' ? 'LAST' : '상') + '</i></b>' +
      '<span class="mrv-bp">' + h(label) + '</span>' +
    '</span>';
  }

  function multiRevealSummaryHTML(board, d) {
    var rs = d.results || [];
    var phys = rs.filter(function (r) { return !isPointPrize(r); });
    var pts = rs.filter(isPointPrize).reduce(function (s, r) { return s + (Number(r.points) || 0); }, 0);
    var lastWin = rs.filter(function (r) { return r.isLast; })[0];
    var list = phys.slice().sort(function (a, b) { return gradeLevel(b.grade) - gradeLevel(a.grade); }).map(function (r) {
      var t = tierOf(board, r.grade) || {};
      var img = r.tierImage || t.image || '';
      return '<li><span class="mrv-sthumb" style="--bc:' + mrBc(r.grade) + '">' +
          (img ? '<img src="' + h(coverSrc(img)) + '" alt="" loading="lazy">' : '<b>' + h(String(r.grade).toUpperCase() === 'LAST' ? 'L' : r.grade) + '</b>') +
        '</span>' +
        '<span class="mrv-sp" style="--bc:' + mrBc(r.grade) + '">' + h(mrGradeText(r.grade)) + '</span>' +
        '<span class="mrv-sl">' + h(r.tierLabel || t.label || '') + '</span>' +
        '<span class="mrv-sn2">#' + r.n + '</span></li>';
    }).join('');
    return '<div class="mrv-sum">' +
      '<p class="mrv-sum-title">🎉 ' + rs.length + '장 모두 개봉 완료!</p>' +
      '<div class="mrv-sum-nums">' +
        '<span>실물 <b>' + phys.length + '</b>개</span>' +
        (pts > 0 ? '<span>총 적립 <b>+' + fmt(pts) + 'P</b></span>' : '') +
        (lastWin ? '<span>👑 라스트원</span>' : '') +
      '</div>' +
      (list ? '<ul class="mrv-sum-list">' + list + '</ul>' : '') +
      '<p class="mrv-sum-note">' + (me()
        ? '당첨 상품은 내 보관함에 담겼어요. 배송 신청은 내 보관함에서 할 수 있어요.'
        : '로그인하면 당첨 상품이 보관함에 담기고 배송 신청까지 됩니다.') + '</p>' +
    '</div>';
  }

  /* 방금 연 티켓을 상품 사진·이름과 함께 보여 주는 띠 (스몰 카드에서도 당첨 상품이 바로 보이게) */
  function multiRevealLastHTML(board, d) {
    var idx = d.lastOpenIdx;
    var r = (idx != null && idx >= 0) ? (d.results || [])[idx] : null;
    if (!r || !(d.revealed && d.revealed[idx])) return '';
    var t = tierOf(board, r.grade) || {};
    var label = r.tierLabel || t.label || '';
    var img = r.tierImage || t.image || '';
    var point = isPointPrize(r);
    return '<div class="mrv-last" style="--bc:' + mrBc(r.grade) + '">' +
      (point || !img
        ? '<span class="mrv-last-thumb is-txt"><b>' + h(String(r.grade).toUpperCase() === 'LAST' ? 'L' : r.grade) + '</b></span>'
        : '<span class="mrv-last-thumb"><img src="' + h(coverSrc(img)) + '" alt="' + h(label) + '"></span>') +
      '<span class="mrv-last-body">' +
        '<span class="mrv-last-top">방금 개봉 · #' + r.n + ' · <b>' + h(mrGradeText(r.grade)) + '</b></span>' +
        '<span class="mrv-last-name">' + h(point ? ('굿즈 포인트 +' + fmt(Number(r.points) || 0) + 'P') : label) + '</span>' +
      '</span>' +
    '</div>';
  }

  function multiRevealHTML(board, d) {
    var rs = d.results || [];
    var total = d.count || rs.length;
    var opened = multiRevealOpened(d);
    var allOpen = rs.length > 0 && opened >= rs.length;
    var missing = Math.max(0, total - rs.length);
    var cards = '';
    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      var isOpen = !!(d.revealed && d.revealed[i]);
      var delay = (d.revealDelay && d.revealDelay[i]) || 0;
      var cls = 'mrv-card' + (isOpen ? ' is-open' : '') +
        (isOpen && gradeLevel(r.grade) >= 1 ? ' is-epic' : '') +
        (d.glowIdx === i ? ' is-glow' : '') +
        (delay ? ' is-stagger' : '');
      cards += '<button type="button" class="' + cls + '" data-action="reveal-card" data-idx="' + i + '"' +
        ' aria-label="' + (isOpen ? (r.n + '번 ' + mrGradeText(r.grade) + ' · ' + h(r.tierLabel || '')) : (r.n + '번 티켓 개봉')) + '"' +
        (delay ? ' style="--md:' + delay + 'ms"' : '') + '>' +
        '<span class="mrv-flip">' +
          '<span class="mrv-face mrv-front">' +
            '<span class="mrv-sn">#' + pad2(r.n) + '</span>' +
            '<span class="mrv-q">?</span>' +
            '<span class="mrv-tap">띠링!</span>' +
          '</span>' +
          (isOpen ? multiRevealFace(board, r) : '<span class="mrv-face mrv-back"></span>') +
        '</span>' +
        '<span class="mrv-shazam" aria-hidden="true">샤악!</span>' +
      '</button>';
    }
    return '<div class="mrv-stage">' +
      '<p class="mdp-kicker">MULTI DRAW · 무작위 ' + total + '연뽑</p>' +
      '<h2 class="modal-title" id="modalTitle">티켓 ' + rs.length + '장이 도착했어요</h2>' +
      '<p class="modal-sub">' + (allOpen
        ? '모두 개봉했어요. 아래에서 결과를 확인하세요.'
        : '카드를 하나씩 눌러 개봉하세요. 찢는 순간 등급과 상품이 공개됩니다.') + '</p>' +
      '<div class="mrv-top">' +
        '<span class="mrv-prog"><b id="mrvOpened">' + opened + '</b> / ' + rs.length + '장 개봉</span>' +
        '<button class="btn btn-gold btn-sm mrv-all" type="button" data-action="reveal-all"' + (allOpen ? ' disabled' : '') + '>✨ 한꺼번에 모두 열기</button>' +
      '</div>' +
      '<div class="mdp-bar" aria-hidden="true"><i id="mdpBarFill" style="width:' + Math.round(opened / Math.max(1, rs.length) * 100) + '%"></i></div>' +
      multiRevealLastHTML(board, d) +
      '<div class="mrv-grid" id="mrvGrid">' + cards + '</div>' +
      (allOpen ? multiRevealSummaryHTML(board, d) : '') +
      (missing ? '<p class="batch-warn">⚠ ' + missing + '장은 다른 분이 먼저 뽑아 진행하지 못했어요.</p>' : '') +
      (d.error ? '<p class="mdp-err">' + h(d.error) + '</p>' : '') +
      '<div class="modal-actions">' +
        '<button class="btn btn-outline" type="button" data-action="reveal-summary">결과 요약 보기</button>' +
        '<button class="btn btn-dark" type="button" data-action="close-modal">확인</button>' +
      '</div>' +
    '</div>';
  }

  /* 방금 연 티켓 띠를 다시 그린다 (전체 리렌더 없이) */
  function refreshLastStrip(board, d) {
    var html = multiRevealLastHTML(board, d);
    var cur = document.querySelector('.mrv-last');
    if (cur) { cur.outerHTML = html || '<div class="mrv-last" hidden></div>'; return; }
    if (!html) return;
    var bar = document.querySelector('#mdpBarFill');
    var host = bar ? bar.closest('.mdp-bar') : null;
    if (host) host.insertAdjacentHTML('afterend', html);
  }

  function refreshRevealHud(d) {
    var total = (d.results || []).length;
    var opened = multiRevealOpened(d);
    var cnt = $('#mrvOpened');
    if (cnt) cnt.textContent = String(opened);
    var bar = $('#mdpBarFill');
    if (bar) bar.style.width = Math.round(opened / Math.max(1, total) * 100) + '%';
    return total > 0 && opened >= total;
  }

  /* 한 장 개봉 — D~P상은 그 자리에서 뒤집기, C상 이상은 클라이맥스 연출로 */
  function openRevealCard(idx) {
    var d = ui.draw;
    if (!d || d.step !== 'reveal' || !d.batch) return;
    if (!d.revealed) d.revealed = {};
    if (d.revealed[idx]) return;
    var board = getBoard(d.boardId);
    var r = (d.results || [])[idx];
    if (!board || !r) return;
    kujiSound.unlock();
    if (isSealGrade(r.grade)) { startCardPromotion(idx); return; }

    var card = document.querySelector('.mrv-card[data-idx="' + idx + '"]');
    var back = card ? card.querySelector('.mrv-back') : null;
    d.revealed[idx] = true;
    d.lastOpenIdx = idx;
    if (back) back.outerHTML = multiRevealFace(board, r);
    if (card) {
      void card.offsetWidth;          /* 초기 스타일을 먼저 계산해야 샤악 개봉 전환이 돈다 */
      card.classList.add('is-open', 'is-fresh');
    }
    kujiSound.snap(0);
    refreshLastStrip(board, d);
    if (refreshRevealHud(d)) {
      setTimeout(function () {
        if (ui.draw === d && d.step === 'reveal') renderDrawModal();
      }, 640);
    }
  }

  /* 상위상 카드 — 봉인이 스스로 빛나다가 승격 연출로 넘어간다 (등급은 연출 끝에 공개) */
  function startCardPromotion(idx) {
    var d = ui.draw;
    if (!d || d.step !== 'reveal' || !d.batch || d.charging) return;
    var r = (d.results || [])[idx];
    if (!r) return;
    d.charging = true;
    d.promoIdx = idx;
    d.promoReturn = 'reveal';
    d.result = r;
    d.best = r;
    d.n = r.n;
    var card = document.querySelector('.mrv-card[data-idx="' + idx + '"]');
    if (card) card.classList.add('is-charging');
    kujiSound.sealCharge();
    setTimeout(function () {
      d.charging = false;
      if (!ui.draw || ui.draw !== d || d.step !== 'reveal') return;
      d.step = 'promote';
      d.revealing = false;
      d.promoStarted = false;
      d.promoSkip = false;
      renderDrawModal();
    }, 620);
  }

  /* 한꺼번에 모두 열기 — 남은 티켓을 연달아 열고, 상위상은 마지막에 클라이맥스로 */
  async function revealAllCards() {
    var d = ui.draw;
    if (!d || d.step !== 'reveal' || !d.batch || d.charging) return;
    if (!d.revealed) d.revealed = {};
    var rs = d.results || [];
    var pending = [];
    for (var i = 0; i < rs.length; i++) if (!d.revealed[i]) pending.push(i);
    if (!pending.length) return;
    var bestIdx = -1;
    pending.forEach(function (i) {
      if (!isSealGrade(rs[i].grade)) return;
      if (bestIdx < 0 || gradeLevel(rs[i].grade) > gradeLevel(rs[bestIdx].grade)) bestIdx = i;
    });
    d.revealDelay = {};
    var k = 0;
    pending.forEach(function (i) {
      if (i === bestIdx) return;
      d.revealed[i] = true;
      d.lastOpenIdx = i;
      d.revealDelay[i] = Math.min(560, k * 55);
      k++;
    });
    if (bestIdx >= 0 && k === 0) d.lastOpenIdx = null;
    kujiSound.unlock();
    kujiSound.snap(0);
    renderDrawModal();
    d.revealDelay = null;
    if (bestIdx < 0) return;
    await waitMs(Math.min(720, 220 + k * 55));
    if (!ui.draw || ui.draw !== d || d.step !== 'reveal') return;
    startCardPromotion(bestIdx);
  }

  /* ---------- 무작위 연뽑: 결과 요약 ---------- */
  function batchResultHTML(board, d) {
    var rows = (d.results || []).slice();
    var physical = rows.filter(function (r) { return !isPointPrize(r); });
    var pointRows = rows.filter(isPointPrize);
    var ptsTotal = pointRows.reduce(function (s, r) { return s + (Number(r.points) || 0); }, 0);
    var lastWin = rows.filter(function (r) { return r.lastOneWon || r.isLast || String(r.grade || '').toUpperCase() === 'LAST'; })[0];
    /* 라스트원 보너스 행은 뽑은 장수에서 뺐다 (N연뽑 = N장) */
    var picked = rows.filter(function (r) { return String(r.grade || '').toUpperCase() !== 'LAST'; });
    var missing = Math.max(0, (d.count || picked.length) - picked.length);
    var pay = d.pay || {};
    var price = Math.max(0, Number(board.price) || 0);
    var payLabel = pay.usePoints ? ('굿즈 포인트 ' + fmt(price * picked.length) + 'P')
      : (pay.code ? '체험 코드' : ('뽑기권 ' + picked.length + '장'));

    /* 최고 등급 실물 */
    var bestPhys = physical[0] || null;
    physical.forEach(function (r) { if (gradeLevel(r.grade) > gradeLevel(bestPhys.grade)) bestPhys = r; });
    var bestLv = bestPhys ? gradeLevel(bestPhys.grade) : 0;
    var heroImg = bestPhys ? (bestPhys.tierImage || (tierOf(board, bestPhys.grade) || {}).image ||
      (String(bestPhys.grade).toUpperCase() === 'LAST' ? (board.lastOneImage || '') : '')) : '';
    var heroLabel = bestPhys ? (bestPhys.tierLabel || (tierOf(board, bestPhys.grade) || {}).label ||
      (String(bestPhys.grade).toUpperCase() === 'LAST' ? (board.lastOneLabel || '라스트원상') : '')) : '';
    var heroGrade = bestPhys ? (String(bestPhys.grade).toUpperCase() === 'LAST' ? '라스트원' : bestPhys.grade + '상') : '';

    var cards = rows.map(function (r, i) {
      var g = String(r.grade || '').toUpperCase();
      var gk = g === 'LAST' ? 'last' : String(r.grade || '').toLowerCase();
      return '<li class="bcard grade-' + h(gk) + '" style="--i:' + i + '">' +
        '<span class="bcard-n">' + (g === 'LAST' ? '라스트원' : '#' + r.n) + '</span>' +
        '<span class="bcard-g">' + h(g === 'LAST' ? 'LAST' : r.grade + '상') + '</span>' +
        (Number(r.points) > 0 ? '<span class="bcard-p">+' + fmt(r.points) + 'P</span>' : '') +
      '</li>';
    }).join('');

    var others = physical.filter(function (r) { return r !== bestPhys; });
    var otherHTML = others.length
      ? '<ul class="batch-prizes">' + others.map(function (r) {
          var g = String(r.grade || '').toUpperCase();
          var t = tierOf(board, r.grade) || {};
          var img = r.tierImage || t.image || '';
          return '<li class="bp-row">' +
            (img ? '<span class="bp-thumb"><img src="' + h(coverSrc(img)) + '" alt="" loading="lazy"></span>' : '<span class="bp-thumb is-empty">' + h(r.grade) + '</span>') +
            '<span class="bp-body"><b>' + h(g === 'LAST' ? '라스트원' : r.grade + '상') + '</b><span>' + h(r.tierLabel || t.label || '') + '</span></span>' +
            '<span class="bp-n">' + (g === 'LAST' ? '보너스' : '#' + r.n) + '</span>' +
          '</li>';
        }).join('') + '</ul>'
      : '';

    var hero = bestPhys
      ? '<div class="batch-best' + (bestLv >= 1 ? ' is-epic lv' + bestLv : '') + ' grade-' + h(String(bestPhys.grade || '').toLowerCase()) + '">' +
          '<span class="bb-tag">' + (bestLv >= 1 ? '최고 등급' : '최고 상품') + '</span>' +
          '<span class="bb-media">' +
            (heroImg ? '<img src="' + h(heroImg) + '" alt="' + h(heroLabel) + '">' : '<b>' + h(String(bestPhys.grade).toUpperCase() === 'LAST' ? 'L' : bestPhys.grade) + '</b>') +
          '</span>' +
          '<span class="bb-body">' +
            '<b class="bb-grade">' + h(heroGrade) + '</b>' +
            '<span class="bb-label">' + h(heroLabel) + '</span>' +
            '<span class="bb-hold">' + (me() ? '내 보관함에 담겼어요' : '로그인하면 보관함에 담기고 배송 신청까지 됩니다') + '</span>' +
          '</span>' +
        '</div>'
      : '';

    var ptsBox = ptsTotal > 0
      ? '<div class="batch-pts">' +
          '<span class="bp-badge">P상 ' + fmt(pointRows.length) + '장</span>' +
          '<b>+' + fmt(ptsTotal) + 'P</b><span class="bp-sub">적립됐어요</span>' +
        '</div>'
      : '';

    return '<div class="batch-wrap">' +
      '<p class="batch-kicker">MULTI DRAW · 무작위 ' + (d.count || rows.length) + '연뽑</p>' +
      '<h2 class="batch-title" id="modalTitle">' + (picked.length > 1 ? picked.length + '장 뽑기 완료!' : '1장 뽑기 완료!') + '</h2>' +
      '<p class="batch-sub">' + h(board.title) + ' · ' + h(payLabel) + ' 사용</p>' +
      hero + otherHTML + ptsBox +
      (lastWin ? lastOneBannerHTML(lastWin, board, { big: true }) : '') +
      '<div class="batch-all"><span class="batch-all-head">뽑은 번호 ' + picked.length + '장' + (lastWin ? ' + 라스트원상' : '') + '</span>' +
        '<ul class="batch-cards">' + cards + '</ul></div>' +
      (missing ? '<p class="batch-warn">⚠ ' + missing + '장은 다른 분이 먼저 뽑아 진행하지 못했어요. 이미 뽑힌 ' + rows.length + '장의 결과는 그대로 보관함에 담겼습니다.</p>' : '') +
      '<p class="remaining-line">남은 번호 <b>' + fmt(remaining(board)) + '</b>장' + (remaining(board) === 0 ? ' · 이 판은 전량 소진되었습니다' : '') + '</p>' +
      '<div class="modal-actions">' +
        (me() && physical.length ? '<button class="btn btn-outline" data-action="go-my">내 보관함 보기</button>' : '') +
        '<button class="btn btn-dark" data-action="close-modal">확인</button>' +
      '</div>' +
    '</div>';
  }

  /* ---------- 개봉 효과음: 합성 PCM → Web Audio(AudioBuffer) 재생 ----------
     iOS 사파리에서 HTML5 <audio>.play() 는 '미디어' 오디오 세션으로 재생돼
     아이폰 하드웨어 무음 스위치를 무시한다(무음 모드인데 소리가 난다).
     반면 AudioContext(Web Audio)는 무음 스위치를 그대로 따르므로, 합성해 둔
     16bit PCM 을 AudioBuffer 로 디코드해 BufferSource 로 재생한다.
     (audioSession 은 'ambient' 로 두고 'playback' 으로는 절대 바꾸지 않는다.)
     AudioContext 자체가 없는 브라우저에서만 <audio> 로 폴백한다. */
  var kujiSound = (function () {
    var RATE = 22050, WA_GAIN = 3.4, PCM_PEAK = 0.95, PCM_GAIN = 1.22;
    var KEYS = ['tear', 'seal', 'snap', 'fanD', 'fanC', 'fanB', 'fanA', 'promoC', 'promote1', 'promote2'];
    var muted = null, lastTick = 0, lastSeal = 0, flashTimer = 0;
    var ctx = null, master = null, pcmBus = null, noiseBuf = null, running = false;
    var urls = {}, els = {}, cursor = {}, htmlOk = {}, primed = false, primeTries = 0, playSeq = 0;
    var pcm = {}, abuf = {}, lastPCM = null, gestureHooked = false;

    /* iOS 16.4+ 오디오 세션: 'ambient' = 다른 오디오와 섞이고 하드웨어 무음 스위치를 따른다.
       아이폰 무음 모드에서 사이트도 조용해야 하므로 'playback' 은 절대 쓰지 않는다. */
    function ambientSession() {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'ambient';
      } catch (e) {}
    }
    function isMuted() {
      if (muted === null) {
        try { muted = window.localStorage.getItem('kujiking.sound') === 'off'; } catch (e) { muted = false; }
      }
      return muted;
    }
    function setMuted(v) {
      muted = !!v;
      try { window.localStorage.setItem('kujiking.sound', muted ? 'off' : 'on'); } catch (e) {}
    }
    function refreshToggle(flash) {
      var btn = document.getElementById('peelSound');
      var off = isMuted();
      if (btn) {
        btn.textContent = off ? '🔇 소리 꺼짐' : (flash ? '🔊 효과음 재생!' : '🔊 소리 켜짐');
        btn.setAttribute('aria-pressed', off ? 'false' : 'true');
        btn.title = off ? '개봉 효과음 켜기 (누르면 테스트음이 재생됩니다)' : '개봉 효과음 끄기';
      }
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
      if (flash && !off && btn) {
        flashTimer = setTimeout(function () { flashTimer = 0; refreshToggle(false); }, 1200);
      }
    }

    /* ================= 16bit PCM WAV 합성기 ================= */
    function buf(dur) {
      var n = Math.max(1, Math.round(RATE * dur));
      return { rate: RATE, n: n, d: new Float32Array(n) };
    }
    /* 배음을 제한한 파형 하나(피치 글라이드 지원). 사각·톱니의 앨리어싱을 피한다 */
    function tone(b, t0, dur, f0, vol, type, f1, atk) {
      var d = b.d, n = b.n, rate = b.rate;
      var i0 = Math.round(t0 * rate), len = Math.round(dur * rate);
      if (len < 2 || f0 <= 0) return;
      var harms = type === 'sine' ? [1]
        : type === 'triangle' ? [1, 3, 5, 7]
        : type === 'square' ? [1, 3, 5, 7, 9]
        : [1, 2, 3, 4, 5, 6, 7, 8];
      var attack = atk == null ? 0.006 : atk;
      var dec = Math.max(0.02, dur * 0.34);
      var phase = 0, k, h;
      for (var i = 0; i < len; i++) {
        var idx = i0 + i;
        if (idx >= n) break;
        if (idx < 0) continue;
        var t = i / rate, p = i / len;
        var f = f1 ? f0 * Math.pow(f1 / f0, p) : f0;
        phase += 2 * Math.PI * f / rate;
        var s = 0;
        for (k = 0; k < harms.length; k++) {
          h = harms[k];
          if (f * h > rate * 0.45) break;
          var amp = type === 'triangle' ? (h % 4 === 1 ? 1 : -1) / (h * h) : 1 / h;
          s += Math.sin(phase * h) * amp;
        }
        var e = t < attack ? t / attack : Math.exp(-(t - attack) / dec);
        d[idx] += s * vol * e;
      }
    }
    /* 필터를 건 노이즈 한 방 (찢김·지직·펀치) */
    function noise(b, t0, dur, vol, opt) {
      opt = opt || {};
      var d = b.d, n = b.n, rate = b.rate;
      var i0 = Math.round(t0 * rate), len = Math.round(dur * rate);
      if (len < 2) return;
      var type = opt.type || 'bandpass';
      var base = Math.min(Math.max(300, opt.f || 3000), rate * 0.4);
      var fcHi = Math.min(base * 1.7, rate * 0.45);
      var fcLo = Math.min(Math.max(140, base * 0.55), rate * 0.45);
      var aHi = 1 - Math.exp(-2 * Math.PI * fcHi / rate);
      var aLo = 1 - Math.exp(-2 * Math.PI * fcLo / rate);
      var attack = opt.atk == null ? 0.003 : opt.atk;
      var dec = Math.max(0.006, opt.dec || dur * 0.3);
      var l1 = 0, l2 = 0, l3 = 0, l4 = 0;
      for (var i = 0; i < len; i++) {
        var idx = i0 + i;
        if (idx >= n) break;
        if (idx < 0) continue;
        var x = Math.random() * 2 - 1;
        /* 1극 저역통과 두 번(2차) — 어떤 컷오프에서도 발진하지 않는다 */
        l1 += aHi * (x - l1);
        l2 += aHi * (l1 - l2);
        l3 += aLo * (x - l3);
        var hp1 = x - l3;
        l4 += aLo * (hp1 - l4);
        var hp2 = hp1 - l4;
        var s = type === 'lowpass' ? l2 : type === 'highpass' ? hp2 : 2 * (l1 - l3);
        var t = i / rate;
        var e = t < attack ? t / attack : Math.exp(-(t - attack) / dec);
        d[idx] += s * vol * e;
      }
    }
    /* 배를 때리는 저음 (두근 / 쿵) */
    function thump(b, t0, f0, f1, dur, vol) { tone(b, t0, dur, f0, vol, 'sine', f1, 0.003); }
    /* 짧게 흩뿌리는 반짝임 */
    function sparkle(b, t0, count, base, vol) {
      for (var i = 0; i < count; i++) {
        tone(b, t0 + i * 0.028 + Math.random() * 0.02, 0.1 + Math.random() * 0.08, base + Math.random() * 1900, vol, 'sine');
      }
    }
    /* Float32 버퍼 → 피크 정규화 PCM (AudioBuffer 재생용 원본) */
    function toPCM(b, peak) {
      var n = b.n, d = b.d, i, m = 0, a, v;
      for (i = 0; i < n; i++) { a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
      var g = m > 0.0002 ? (peak || PCM_PEAK) / m : 1;
      var fade = Math.min(Math.floor(0.01 * b.rate), Math.floor(n / 3));
      var out = new Float32Array(n);
      for (i = 0; i < n; i++) {
        v = d[i] * g;
        if (i > n - fade) v *= (n - i) / fade;
        out[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
      }
      return { rate: b.rate, n: n, d: out };
    }
    /* 정규화 PCM → 16bit PCM WAV blob URL (AudioContext 가 없을 때의 <audio> 폴백용) */
    function toURL(p) {
      var n = p.n, d = p.d, i, v;
      var size = 44 + n * 2, ab = new ArrayBuffer(size), dv = new DataView(ab);
      function str(off, s) { for (var j = 0; j < s.length; j++) dv.setUint8(off + j, s.charCodeAt(j)); }
      str(0, 'RIFF'); dv.setUint32(4, size - 8, true); str(8, 'WAVE');
      str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, p.rate, true); dv.setUint32(28, p.rate * 2, true);
      dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      str(36, 'data'); dv.setUint32(40, n * 2, true);
      for (i = 0; i < n; i++) {
        v = d[i];
        dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
      try {
        var blob = new Blob([ab], { type: 'audio/wav' });
        if (window.URL && window.URL.createObjectURL) return window.URL.createObjectURL(blob);
      } catch (e) {}
      return '';
    }

    /* 종이 찢기: 촘촘한 하이패스 노이즈 + 섬유가 끊기는 짧은 클릭 (0.13초) */
    function buildTear() {
      var b = buf(0.13), i;
      noise(b, 0, 0.12, 0.6, { type: 'bandpass', f: 2600, q: 1.3, dec: 0.05, atk: 0.003 });
      for (i = 0; i < 6; i++) {
        noise(b, i * 0.011 + Math.random() * 0.008, 0.05 + Math.random() * 0.035, 0.75,
          { type: 'highpass', f: 3000 + Math.random() * 3200, q: 0.8, dec: 0.016, atk: 0.0015 });
      }
      for (i = 0; i < 3; i++) tone(b, 0.008 + i * 0.022, 0.014, 3400 + Math.random() * 2200, 0.22, 'square', null, 0.001);
      tone(b, 0, 0.1, 240, 0.22, 'triangle', 120, 0.004);
      return toURL(lastPCM = toPCM(b, 0.8));
    }
    /* 황금 봉인: 두근-두근 심장박동 + 금빛 셔머 + 낮게 깔리는 서브베이스 (0.7초) */
    function buildSeal() {
      var b = buf(0.78), i;
      thump(b, 0.0, 112, 42, 0.3, 0.95);
      thump(b, 0.0, 56, 30, 0.34, 0.5);
      thump(b, 0.21, 98, 38, 0.28, 0.75);
      thump(b, 0.23, 50, 28, 0.3, 0.38);
      tone(b, 0, 0.76, 60, 0.26, 'sine', 88, 0.05);
      for (i = 0; i < 8; i++) tone(b, 0.08 + i * 0.072, 0.24, 1700 + Math.random() * 2500, 0.12, 'sine', 2600 + Math.random() * 1600);
      [261.63, 329.63, 392.0, 523.25].forEach(function (f, k) {
        tone(b, 0.34 + k * 0.07, 0.42, f, 0.26, 'triangle');
      });
      return toURL(lastPCM = toPCM(b, 0.93));
    }
    /* 찢어지는 순간: 펀치 크랙 + 반짝이는 종소리 (0.38초) */
    function buildSnap() {
      var b = buf(0.42), i;
      noise(b, 0, 0.06, 0.95, { type: 'highpass', f: 4800, q: 0.7, dec: 0.012, atk: 0.001 });
      noise(b, 0.002, 0.26, 0.75, { type: 'bandpass', f: 2400, q: 0.9, dec: 0.07, atk: 0.002 });
      thump(b, 0, 190, 50, 0.26, 0.9);
      tone(b, 0.01, 0.15, 340, 0.38, 'sine', 150, 0.002);
      [1046.5, 1318.51, 1567.98, 2093].forEach(function (f, k) {
        tone(b, 0.07 + k * 0.05, 0.34 - k * 0.03, f, 0.3, 'sine');
      });
      for (i = 0; i < 6; i++) tone(b, 0.12 + Math.random() * 0.18, 0.13, 2800 + Math.random() * 2200, 0.12, 'sine');
      return toURL(lastPCM = toPCM(b, 0.94));
    }
    /* 등급별 팡파레 — 0: D 이하 팝 · 1: C 밝은 신스 화음 · 2: B 금빛 브라스 · 3: A/라스트원 대서사 */
    function buildFanfare(level) {
      var b, i;
      if (level <= 0) {
        b = buf(0.85);
        tone(b, 0, 0.32, 783.99, 0.6, 'triangle');
        tone(b, 0.1, 0.45, 1046.5, 0.55, 'sine');
        tone(b, 0.02, 0.26, 1567.98, 0.26, 'sine');
        tone(b, 0.2, 0.52, 1318.51, 0.36, 'triangle');
        thump(b, 0, 170, 60, 0.18, 0.55);
        sparkle(b, 0.12, 7, 2500, 0.16);
        return toURL(lastPCM = toPCM(b, 0.9));
      }
      if (level === 1) {
        b = buf(1.05);
        [523.25, 659.25, 783.99].forEach(function (f, k) {
          tone(b, k * 0.05, 0.78, f, 0.36, 'saw');
          tone(b, k * 0.05, 0.55, f * 2, 0.18, 'sine');
        });
        tone(b, 0.3, 0.62, 1046.5, 0.32, 'triangle');
        tone(b, 0.38, 0.6, 1318.51, 0.3, 'triangle');
        thump(b, 0, 150, 55, 0.22, 0.6);
        sparkle(b, 0.3, 10, 2400, 0.14);
        return toURL(lastPCM = toPCM(b, 0.92));
      }
      if (level === 2) {
        b = buf(1.32);
        [392, 523.25, 659.25, 783.99, 1046.5].forEach(function (f, k) {
          var at = k * 0.14;
          tone(b, at, 0.5, f, 0.42, 'saw');
          tone(b, at, 0.3, f * 2, 0.2, 'sine');
        });
        thump(b, 0, 160, 50, 0.3, 0.75);
        thump(b, 0.7, 140, 46, 0.34, 0.65);
        tone(b, 0.7, 0.62, 1567.98, 0.32, 'sine');
        sparkle(b, 0.62, 12, 2500, 0.14);
        return toURL(lastPCM = toPCM(b, 0.93));
      }
      b = buf(2.0);
      [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98].forEach(function (f, k) {
        var at = k * 0.105;
        tone(b, at, 0.5, f, 0.4, 'saw');
        tone(b, at, 0.28, f * 2, 0.2, 'sine');
      });
      var tail = 9 * 0.105;
      [261.63, 392, 523.25].forEach(function (f) { tone(b, tail, 1.0, f, 0.26, 'saw'); });
      [1046.5, 1318.51, 1567.98, 2093].forEach(function (f, k) {
        tone(b, tail + k * 0.06, 0.95 - k * 0.1, f, 0.3, 'sine');
      });
      thump(b, 0, 170, 46, 0.42, 0.85);
      thump(b, tail, 150, 42, 0.5, 0.8);
      noise(b, tail, 0.95, 0.2, { type: 'highpass', f: 7000, q: 0.6, dec: 0.4, atk: 0.05 });
      sparkle(b, tail, 18, 2600, 0.16);
      return toURL(lastPCM = toPCM(b, 0.95));
    }

    /* 승격 1막(C상 확인): 짧고 또렷한 밝은 벨 + 반짝임 (0.62초) */
    function buildPromoC() {
      var b = buf(0.62);
      tone(b, 0, 0.22, 880, 0.46, 'triangle');
      tone(b, 0.07, 0.3, 1174.66, 0.4, 'sine');
      tone(b, 0.15, 0.36, 1760, 0.26, 'sine', 2349.32);
      thump(b, 0, 168, 72, 0.14, 0.5);
      noise(b, 0, 0.09, 0.22, { type: 'highpass', f: 5600, dec: 0.03, atk: 0.002 });
      sparkle(b, 0.12, 6, 2600, 0.12);
      return toURL(lastPCM = toPCM(b, 0.9));
    }
    /* 1차 승격(C → B): 전기 지직 + 위로 훑는 아크 + 상승 화음 (1.05초) */
    function buildPromote1() {
      var b = buf(1.05), i;
      for (i = 0; i < 7; i++) {
        noise(b, 0.004 + i * 0.026, 0.07, 0.4 + i * 0.03,
          { type: 'bandpass', f: 1200 + i * 900, dec: 0.018, atk: 0.001 });
      }
      tone(b, 0, 0.24, 190, 0.3, 'square', 2500, 0.002);
      tone(b, 0.02, 0.2, 95, 0.26, 'saw', 760, 0.004);
      [329.63, 415.3, 523.25].forEach(function (f, k) {
        tone(b, 0.1 + k * 0.05, 0.52, f * 0.5, 0.3, 'saw', f);
        tone(b, 0.1 + k * 0.05, 0.4, f, 0.17, 'triangle', f * 1.5);
      });
      thump(b, 0.3, 200, 46, 0.4, 0.85);
      thump(b, 0.3, 72, 32, 0.5, 0.5);
      noise(b, 0.3, 0.3, 0.5, { type: 'highpass', f: 4400, dec: 0.08, atk: 0.001 });
      [659.25, 830.61, 987.77, 1318.51].forEach(function (f, k) {
        tone(b, 0.33 + k * 0.045, 0.55 - k * 0.05, f, 0.28, 'sine');
      });
      sparkle(b, 0.38, 9, 2600, 0.13);
      return toURL(lastPCM = toPCM(b, 0.94));
    }
    /* 2차 승격(B → A·라스트원): 천둥 저음 드롭 + 번개 크랙 + 클라이맥스 팡파레 (2.25초) */
    function buildPromote2() {
      var b = buf(2.25), i;
      noise(b, 0, 0.95, 0.5, { type: 'lowpass', f: 380, dec: 0.44, atk: 0.02 });
      noise(b, 0, 0.22, 0.62, { type: 'highpass', f: 3200, dec: 0.06, atk: 0.001 });
      for (i = 0; i < 9; i++) {
        noise(b, 0.02 + i * 0.021, 0.065, 0.34 + Math.random() * 0.22,
          { type: 'highpass', f: 2600 + Math.random() * 4200, dec: 0.013, atk: 0.001 });
      }
      tone(b, 0, 0.5, 150, 0.5, 'sine', 32, 0.004);
      thump(b, 0, 132, 28, 0.58, 0.95);
      thump(b, 0.02, 62, 24, 0.7, 0.6);
      [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98].forEach(function (f, k) {
        tone(b, 0.16 + k * 0.072, 0.3, f * 0.5, 0.24, 'saw', f);
        tone(b, 0.16 + k * 0.072, 0.22, f, 0.14, 'triangle', f * 2);
      });
      var t1 = 0.7;
      [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5].forEach(function (f, k) {
        tone(b, t1 + k * 0.055, 0.5, f, 0.32, 'saw');
        tone(b, t1 + k * 0.055, 0.3, f * 2, 0.16, 'sine');
      });
      [1046.5, 1318.51, 1567.98, 2093, 2637].forEach(function (f, k) {
        tone(b, t1 + 0.34 + k * 0.05, 1.35 - k * 0.14, f, 0.28, 'sine');
      });
      thump(b, t1 + 0.3, 158, 34, 0.55, 0.9);
      noise(b, t1 + 0.3, 1.5, 0.2, { type: 'highpass', f: 6800, dec: 0.6, atk: 0.06 });
      sparkle(b, t1 + 0.34, 22, 2800, 0.14);
      return toURL(lastPCM = toPCM(b, 0.96));
    }

    function buildAll() {
      try { urls.tear = buildTear(); pcm.tear = lastPCM; } catch (e) {}
      try { urls.seal = buildSeal(); pcm.seal = lastPCM; } catch (e) {}
      try { urls.snap = buildSnap(); pcm.snap = lastPCM; } catch (e) {}
      try { urls.fanD = buildFanfare(0); pcm.fanD = lastPCM; } catch (e) {}
      try { urls.fanC = buildFanfare(1); pcm.fanC = lastPCM; } catch (e) {}
      try { urls.fanB = buildFanfare(2); pcm.fanB = lastPCM; } catch (e) {}
      try { urls.fanA = buildFanfare(3); pcm.fanA = lastPCM; } catch (e) {}
      try { urls.promoC = buildPromoC(); pcm.promoC = lastPCM; } catch (e) {}
      try { urls.promote1 = buildPromote1(); pcm.promote1 = lastPCM; } catch (e) {}
      try { urls.promote2 = buildPromote2(); pcm.promote2 = lastPCM; } catch (e) {}
    }
    /* WAV 마다 <audio> 요소를 만들고 사운드별로 1개(찢기는 3개) 풀을 둔다 */
    function buildElements() {
      if (els.tear && els.tear.length) return;
      var host = null;
      try {
        host = document.getElementById('kujiSoundBank');
        if (!host && document.body) {
          host = document.createElement('div');
          host.id = 'kujiSoundBank';
          host.setAttribute('aria-hidden', 'true');
          host.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;';
          document.body.appendChild(host);
        }
      } catch (e) { host = null; }
      KEYS.forEach(function (k) {
        if (!urls[k]) return;
        var n = k === 'tear' ? 3 : 1, i, el;
        els[k] = [];
        for (i = 0; i < n; i++) {
          try {
            el = document.createElement('audio');
            el.preload = 'auto';
            el.muted = false;
            el.setAttribute('playsinline', '');
            el.setAttribute('webkit-playsinline', '');
            el.setAttribute('aria-hidden', 'true');
            el.__key = k;
            el.src = urls[k];
            if (host) host.appendChild(el);
            try { el.load(); } catch (e2) {}
            els[k].push(el);
          } catch (e2) {}
        }
        cursor[k] = 0;
      });
    }
    /* 첫 제스처에서 모든 <audio> 요소를 무음(muted)으로 한 번 재생해 잠금을 푼다.
       이후에는 터치가 끝난 뒤(touchmove·setTimeout 안)에도 play() 가 허용된다.
       이때 소리가 새지 않도록 muted 와 volume 0 을 함께 건다. */
    function prime() {
      if (primed) return;
      var list = [], k, i;
      for (k in els) {
        if (!els.hasOwnProperty(k)) continue;
        for (i = 0; i < els[k].length; i++) list.push(els[k][i]);
      }
      if (!list.length) return;
      primeTries++;
      var seqAtStart = playSeq;
      var left = list.length, okCount = 0;
      var settle = function () {
        if (--left > 0) return;
        primed = okCount >= 4 || primeTries >= 6;
      };
      list.forEach(function (el) {
        try {
          el.muted = true;
          try { el.volume = 0; } catch (ev) {}
          try { el.pause(); } catch (e) {}
          try { el.currentTime = 0; } catch (e) {}
          var p = el.play();
          if (p && p.then) {
            p.then(function () {
              /* 프라임 도중에 실제 효과음이 시작됐다면 그 소리를 끊지 않는다.
                 그 경우 이 요소는 무음인 채로 끝까지 흐르게 두고(들리지 않음),
                 다음 재생 직전에 elPlay 가 muted 를 풀어 준다. */
              try {
                if (playSeq === seqAtStart) { el.pause(); el.currentTime = 0; el.muted = false; }
              } catch (e) {}
              htmlOk[el.__key] = true; okCount++; settle();
            }, function () {
              try { if (playSeq === seqAtStart) el.muted = false; } catch (e) {}
              htmlOk[el.__key] = false; settle();
            });
          } else {
            try { el.pause(); el.muted = false; } catch (e) {}
            htmlOk[el.__key] = true; okCount++; settle();
          }
        } catch (e) {
          try { el.muted = false; } catch (e2) {}
          htmlOk[el.__key] = false; settle();
        }
      });
    }
    /* <audio> 로 재생(폴백). 필요할 때 처음 한 번 <audio> 풀을 만든다 */
    function elPlay(key, vol) {
      if (isMuted()) return true;
      var pool = els[key];
      if (!pool || !pool.length) {
        try { buildElements(); } catch (e) {}
        pool = els[key];
      }
      if (!pool || !pool.length) return false;
      var el = pool[cursor[key] % pool.length];
      cursor[key] = (cursor[key] + 1) % 1024;
      playSeq++;
      try { el.muted = false; } catch (e) {}
      try { el.volume = Math.max(0.05, Math.min(1, vol == null ? 1 : vol)); } catch (e) {}
      try { el.pause(); } catch (e) {}
      try { el.currentTime = 0; } catch (e) {}
      var p = null;
      try { p = el.play(); } catch (e) { p = null; }
      if (!p) { fallback(key, vol); return false; }
      if (p.then) {
        p.then(function () { htmlOk[key] = true; }, function () {
          htmlOk[key] = false;
          fallback(key, vol);
        });
      }
      return true;
    }
    function fallback(key, vol) {
      if (isMuted()) return;
      if (key === 'tear') waTear(vol);
      else if (key === 'seal') waSeal();
      else if (key === 'snap') waSnap(0);
      else if (key === 'promoC') waPromoC();
      else if (key === 'promote1') waPromote1();
      else if (key === 'promote2') waPromote2();
      else waFanfare(key === 'fanA' ? 3 : key === 'fanB' ? 2 : key === 'fanC' ? 1 : 0);
    }
    function buzz(pattern) {
      /* 안드로이드 크롬·삼성 인터넷만 지원. iOS 사파리는 애플 정책상 navigator.vibrate 가 없어 조용히 무시된다 */
      try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
    }

    /* ================= 웹오디오 폴백(3.4배 부스트) ================= */
    function makeCtx() {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      if (!ctx) {
        try { ctx = new C(); } catch (e) { return null; }
        try { ctx.onstatechange = function () { running = (ctx.state === 'running'); }; } catch (e) {}
        try {
          /* PCM 전용 버스: 1.22배로 올리고 리미터로 어깨만 다듬어 크고 또렷하게.
             (작은 gain 은 iOS 에서 통째로 무음 처리되는 사례가 있다) */
          if (ctx.createGain) {
            pcmBus = ctx.createGain();
            pcmBus.gain.value = PCM_GAIN;
            if (ctx.createDynamicsCompressor) {
              var lim = ctx.createDynamicsCompressor();
              lim.threshold.value = -2;
              lim.knee.value = 0;
              lim.ratio.value = 20;
              lim.attack.value = 0.001;
              lim.release.value = 0.08;
              pcmBus.connect(lim);
              lim.connect(ctx.destination);
            } else {
              pcmBus.connect(ctx.destination);
            }
          }
        } catch (e) { pcmBus = null; }
        try {
          if (ctx.createDynamicsCompressor) {
            master = ctx.createDynamicsCompressor();
            master.threshold.value = -14;
            master.knee.value = 18;
            master.ratio.value = 6;
            master.attack.value = 0.003;
            master.release.value = 0.22;
            master.connect(ctx.destination);
          }
        } catch (e) { master = null; }
      }
      if (ctx.state !== 'running' && ctx.state !== 'closed') { try { ctx.resume(); } catch (e) {} }
      return ctx;
    }
    function out(c) { return master || c.destination; }
    function ac() { if (isMuted()) return null; return makeCtx(); }
    function wakeCtx() {
      var c = makeCtx();
      if (!c) return;
      try {
        var p = c.resume();
        if (p && p.then) p.then(function () { running = (c.state === 'running'); }, function () {});
      } catch (e) {}
      setTimeout(function () { running = !!(ctx && ctx.state === 'running'); }, 160);
      setTimeout(function () { running = !!(ctx && ctx.state === 'running'); }, 480);
    }
    function unlock() {
      ambientSession();
      wakeCtx();
      /* AudioContext 가 없는 브라우저만 <audio> 를 미리 깨워 둔다 */
      if (!(window.AudioContext || window.webkitAudioContext)) prime();
    }

    /* ================= AudioBuffer 재생 (기본) ================= */
    function audioBuf(key) {
      if (abuf[key]) return abuf[key];
      var p = pcm[key];
      if (!p || !ctx) return null;
      try {
        var b = ctx.createBuffer(1, p.n, p.rate);
        b.getChannelData(0).set(p.d);
        abuf[key] = b;
        return b;
      } catch (e) { return null; }
    }
    /* BufferSource → 볼륨 GainNode → PCM 버스. 재생이 시작되면 true */
    function ctxPlay(key, vol) {
      if (isMuted()) return true;
      var c = makeCtx();
      if (!c) return false;
      if (c.state === 'suspended' || c.state === 'interrupted') { try { c.resume(); } catch (e) {} }
      var buf = audioBuf(key);
      if (!buf) return false;
      try {
        var src = c.createBufferSource();
        src.buffer = buf;
        var v = Math.max(0.05, Math.min(1, vol == null ? 1 : vol));
        if (c.createGain) {
          var g = c.createGain();
          g.gain.value = v;
          src.connect(g);
          g.connect(pcmBus || out(c));
        } else {
          src.connect(pcmBus || out(c));
        }
        src.start(0);
        return true;
      } catch (e) { return false; }
    }
    /* 기본은 AudioBuffer, 안 되면 <audio>(→ 웹오디오 신스) 폴백 */
    function play(key, vol) {
      if (isMuted()) return true;
      if (ctxPlay(key, vol)) return true;
      return elPlay(key, vol);
    }
    function noiseBuffer(c) {
      if (noiseBuf) return noiseBuf;
      var len = Math.floor(c.sampleRate * 0.6);
      noiseBuf = c.createBuffer(1, len, c.sampleRate);
      var data = noiseBuf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return noiseBuf;
    }
    /* 기본 음 하나 (endFreq 로 피치 글라이드) */
    function blip(c, at, freq, dur, vol, type, endFreq) {
      var v = Math.min(1, vol * WA_GAIN);
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(Math.max(20, freq), at);
      if (endFreq && endFreq !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), at + dur);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0004, v), at + Math.min(0.014, dur * 0.35));
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(out(c));
      o.start(at); o.stop(at + dur + 0.05);
    }
    function thumpWA(c, at, from, to, dur, vol) {
      var v = Math.min(1, vol * WA_GAIN);
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(Math.max(20, from), at);
      o.frequency.exponentialRampToValueAtTime(Math.max(18, to), at + dur * 0.82);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0004, v), at + 0.016);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(out(c));
      o.start(at); o.stop(at + dur + 0.06);
    }
    function noiseHit(c, at, o) {
      o = o || {};
      var dur = o.dur || 0.2;
      var src = c.createBufferSource(); src.buffer = noiseBuffer(c);
      var f = c.createBiquadFilter();
      f.type = o.type || 'bandpass';
      f.Q.value = o.q == null ? 1 : o.q;
      f.frequency.setValueAtTime(o.f0 || 2000, at);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(60, o.f1), at + (o.sweep || dur * 0.8));
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0004, Math.min(1, (o.vol || 0.1) * WA_GAIN)), at + (o.attack == null ? 0.004 : o.attack));
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      src.connect(f); f.connect(g); g.connect(out(c));
      src.start(at, Math.random() * 0.3, dur + 0.06);
    }
    function sparkleWA(c, at, n, base, vol) {
      for (var i = 0; i < n; i++) blip(c, at + i * 0.026 + Math.random() * 0.02, (base || 2400) + Math.random() * 1700, 0.08 + Math.random() * 0.07, vol || 0.02, 'sine');
    }
    function heartbeat(c, at, gain) {
      thumpWA(c, at, 98, 45, 0.3, 0.2 * gain);
      thumpWA(c, at + 0.2, 84, 38, 0.26, 0.15 * gain);
      blip(c, at, 156, 0.1, 0.05 * gain, 'sine', 62);
    }
    function waTear(amount) {
      var c = ac();
      if (!c) return;
      var now = c.currentTime;
      var a = Math.max(0, Math.min(1, Number(amount) || 0));
      noiseHit(c, now, {
        f0: 1200 + a * 2600 + Math.random() * 700,
        f1: 2200 + a * 3800,
        sweep: 0.055,
        q: 0.7 + a * 0.9,
        vol: 0.06 + a * 0.12,
        dur: 0.06 + Math.random() * 0.05,
        attack: 0.004
      });
      blip(c, now + 0.004, 2600 + a * 3200 + Math.random() * 1400, 0.03, 0.03 + a * 0.05, 'square');
      thumpWA(c, now, 240, 110, 0.07, 0.05 + a * 0.05);
    }
    function waSnap(level) {
      var c = ac();
      if (!c) return;
      var lv = Number(level) || 0;
      var now = c.currentTime;
      noiseHit(c, now, { type: 'highpass', f0: 1400, vol: 0.3 + lv * 0.05, dur: 0.11, attack: 0.001 });
      noiseHit(c, now, { f0: 3000, f1: 680, sweep: 0.22, q: 0.7, vol: 0.26, dur: 0.3 });
      thumpWA(c, now, 180, 52, 0.24, 0.3 + lv * 0.05);
      blip(c, now + 0.01, 330, 0.14, 0.12, 'sine', 140);
      sparkleWA(c, now + 0.05, 4 + lv * 3, 2200 + lv * 250, 0.07);
      if (lv >= 2) {
        [1046.5, 1318.51, 1567.98, 2093].forEach(function (f, i) {
          blip(c, now + 0.16 + i * 0.05, f, 0.5, 0.09, 'sine');
        });
      }
    }
    function waSeal() {
      var c = ac();
      if (!c) return;
      var now = c.currentTime + 0.02;
      heartbeat(c, now, 1);
      heartbeat(c, now + 0.54, 0.82);
      var o = c.createOscillator(), g = c.createGain(), lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.setValueAtTime(170, now);
      o.type = 'sine';
      o.frequency.setValueAtTime(56, now);
      o.frequency.linearRampToValueAtTime(96, now + 1.6);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.075 * WA_GAIN, now + 0.28);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.95);
      o.connect(lp); lp.connect(g); g.connect(out(c));
      o.start(now); o.stop(now + 2.05);
      noiseHit(c, now + 0.08, { type: 'highpass', f0: 5200, vol: 0.04, dur: 1.15, attack: 0.16 });
      for (var i = 0; i < 7; i++) {
        blip(c, now + 0.24 + i * 0.105, 1800 + Math.random() * 2400, 0.14, 0.03, 'sine');
      }
      [261.63, 329.63, 392].forEach(function (f, i) {
        blip(c, now + 0.42 + i * 0.18, f, 0.7, 0.075, 'triangle');
      });
    }
    function waPromoC() {
      var c = ac();
      if (!c) return;
      var now = c.currentTime + 0.01;
      blip(c, now, 880, 0.22, 0.09, 'triangle');
      blip(c, now + 0.07, 1174.66, 0.3, 0.08, 'sine');
      blip(c, now + 0.15, 1760, 0.34, 0.06, 'sine');
      thumpWA(c, now, 168, 72, 0.14, 0.16);
      sparkleWA(c, now + 0.12, 5, 2600, 0.03);
    }
    function waPromote1() {
      var c = ac();
      if (!c) return;
      var now = c.currentTime + 0.01, i;
      for (i = 0; i < 5; i++) {
        noiseHit(c, now + i * 0.03, { f0: 1200 + i * 900, f1: 2600 + i * 900, sweep: 0.03, q: 1.2, vol: 0.11, dur: 0.07, attack: 0.001 });
      }
      blip(c, now, 190, 0.22, 0.09, 'square', 2500);
      [329.63, 415.3, 523.25].forEach(function (f, k) {
        blip(c, now + 0.08 + k * 0.05, f * 0.5, 0.3, 0.06, 'sawtooth', f);
        blip(c, now + 0.08 + k * 0.05, f, 0.24, 0.035, 'triangle', f * 1.5);
      });
      thumpWA(c, now + 0.3, 190, 46, 0.35, 0.26);
      noiseHit(c, now + 0.3, { type: 'highpass', f0: 4400, vol: 0.13, dur: 0.22, attack: 0.001 });
      [659.25, 830.61, 987.77, 1318.51].forEach(function (f, k) {
        blip(c, now + 0.34 + k * 0.05, f, 0.5, 0.055, 'sine');
      });
      sparkleWA(c, now + 0.4, 7, 2600, 0.03);
    }
    function waPromote2() {
      var c = ac();
      if (!c) return;
      var now = c.currentTime + 0.01, i;
      noiseHit(c, now, { type: 'lowpass', f0: 420, f1: 160, sweep: 0.7, vol: 0.2, dur: 0.9, attack: 0.02 });
      for (i = 0; i < 7; i++) {
        noiseHit(c, now + 0.03 + i * 0.03, { type: 'highpass', f0: 2800 + Math.random() * 3600, vol: 0.1, dur: 0.07, attack: 0.001 });
      }
      thumpWA(c, now, 130, 28, 0.6, 0.34);
      [523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98].forEach(function (f, k) {
        blip(c, now + 0.14 + k * 0.07, f * 0.5, 0.28, 0.05, 'sawtooth', f);
      });
      var t1 = now + 0.68;
      [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5].forEach(function (f, k) {
        blip(c, t1 + k * 0.055, f, 0.5, 0.07, 'sawtooth');
        blip(c, t1 + k * 0.055, f * 2, 0.3, 0.03, 'sine');
      });
      [1046.5, 1318.51, 1567.98, 2093].forEach(function (f, k) {
        blip(c, t1 + 0.34 + k * 0.05, f, 1.1 - k * 0.12, 0.07, 'sine');
      });
      thumpWA(c, t1 + 0.3, 158, 34, 0.55, 0.3);
      noiseHit(c, t1 + 0.3, { type: 'highpass', f0: 6800, vol: 0.05, dur: 1.3, attack: 0.06 });
      sparkleWA(c, t1 + 0.34, 16, 2800, 0.035);
    }
    function waFanfare(level) {
      var c = ac();
      if (!c) return;
      var lv = level === true ? 3 : (level === false ? 0 : (Number(level) || 0));
      var t0 = c.currentTime + 0.05;
      if (lv <= 0) {
        blip(c, t0, 783.99, 0.18, 0.1, 'triangle');
        blip(c, t0 + 0.09, 1046.5, 0.3, 0.09, 'sine');
        sparkleWA(c, t0 + 0.12, 3, 2600, 0.03);
        return;
      }
      if (lv === 1) {
        [523.25, 659.25, 783.99].forEach(function (f, i) {
          blip(c, t0 + i * 0.06, f, 0.52, 0.08, 'sawtooth');
          blip(c, t0 + i * 0.06, f * 2, 0.3, 0.03, 'sine');
        });
        [1046.5, 1318.51].forEach(function (f, i) {
          blip(c, t0 + 0.22 + i * 0.06, f, 0.55, 0.06, 'triangle');
        });
        thumpWA(c, t0, 140, 60, 0.24, 0.18);
        sparkleWA(c, t0 + 0.3, 6, 2500, 0.03);
        return;
      }
      if (lv === 2) {
        [392, 523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
          var at = t0 + i * 0.105;
          blip(c, at, f, 0.44, 0.09, 'sawtooth');
          blip(c, at + 0.005, f * 2, 0.28, 0.04, 'triangle');
        });
        thumpWA(c, t0, 150, 52, 0.3, 0.22);
        thumpWA(c, t0 + 0.55, 132, 48, 0.34, 0.2);
        blip(c, t0 + 0.56, 1567.98, 0.8, 0.1, 'sine');
        sparkleWA(c, t0 + 0.5, 10, 2400, 0.035);
        return;
      }
      var rise = [261.63, 329.63, 392, 523.25, 659.25, 783.99, 1046.5, 1318.51, 1567.98];
      rise.forEach(function (f, i) {
        var at = t0 + i * 0.082;
        blip(c, at, f, 0.42, 0.08 + i * 0.003, 'sawtooth');
        blip(c, at + 0.004, f * 2, 0.22, 0.03, 'triangle');
      });
      var tail = t0 + rise.length * 0.082;
      [1046.5, 1318.51, 1567.98, 2093].forEach(function (f, i) {
        blip(c, tail + i * 0.07, f, 0.9, 0.09, 'sine');
      });
      thumpWA(c, t0, 170, 46, 0.42, 0.3);
      thumpWA(c, tail, 148, 42, 0.5, 0.28);
      noiseHit(c, tail, { type: 'highpass', f0: 7000, vol: 0.05, dur: 1.2, attack: 0.05 });
      sparkleWA(c, tail + 0.04, 16, 2600, 0.035);
    }

    /* ================= 바깥으로 내보내는 재생 API ================= */
    /* 찢기 진행률이 한 칸(약 11%) 넘어갈 때마다 짧은 진동 — 종이 '드드득' 찢는 리듬.
       진동 모터가 뭉개지지 않게 78ms 간격으로 제한하고, 소리와 같은 지점에서 울린다. */
    var ripStep = -1, ripAt = 0;
    function ripBuzz(a) {
      if (isMuted()) return;
      var step = Math.floor(a * 9);
      if (step === ripStep) return;
      var now = Date.now();
      if (now - ripAt < 78) return;
      ripStep = step;
      ripAt = now;
      buzz([12]);
    }
    function tear(amount) {
      if (isMuted()) return;
      var a = Math.max(0, Math.min(1, Number(amount) || 0));
      var now = Date.now();
      if (now - lastTick < 50) return;
      lastTick = now;
      play('tear', 0.7 + a * 0.3);
      ripBuzz(a);
    }
    function snap(level) {
      if (isMuted()) return;
      var lv = Number(level) || 0;
      play('snap', 1);
      buzz(lv >= 2 ? [0, 22, 26, 16, 40, 30] : [18]);
    }
    function sealCharge() {
      if (isMuted()) return;
      var now = Date.now();
      if (now - lastSeal < 700) return;
      lastSeal = now;
      play('seal', 1);
      buzz([35, 40, 60]);
    }
    /* 승격 연출 1막(등급 확인 첫 비트) / 1차·2차 승격 */
    function cBeat() {
      if (isMuted()) return;
      play('promoC', 1);
      buzz([0, 12, 16]);
    }
    function promote(step) {
      if (isMuted()) return;
      var s = Number(step) >= 2 ? 2 : 1;
      play(s >= 2 ? 'promote2' : 'promote1', 1);
      buzz(s >= 2 ? [50, 40, 70, 40, 110] : [35, 40, 60]);
    }
    function fanfare(level) {
      if (isMuted()) return;
      var lv = level === true ? 3 : (level === false ? 0 : (Number(level) || 0));
      play(lv >= 3 ? 'fanA' : lv === 2 ? 'fanB' : lv === 1 ? 'fanC' : 'fanD', 1);
      buzz(lv >= 3 ? [50, 40, 70, 40, 110] : lv === 2 ? [0, 26, 34, 22, 40, 30] : lv === 1 ? [0, 16, 22, 20] : [18]);
    }
    /* 소리 켜기 버튼: 바로 들리는 테스트음 */
    function test(withFanfare) {
      if (isMuted()) return;
      unlock();
      play('snap', 1);
      if (withFanfare) setTimeout(function () { if (!isMuted()) play('fanC', 1); }, 430);
    }

    /* 첫 제스처에서 오디오 잠금 해제.
       AudioContext 는 제스처 안에서 resume() 해야 계속 살아 있으므로, 소리를 내지 않는
       resume 만 문서 전체 제스처에 걸어 둔다(누른다고 소리가 나지는 않는다). */
    try {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { ambientSession(); wakeCtx(); }
        else if (ctx && ctx.state === 'running') running = true;
      }, { passive: true });
    } catch (e) {}

    function hookGestures() {
      if (gestureHooked) return;
      gestureHooked = true;
      var wake = function () { ambientSession(); wakeCtx(); };
      ['pointerdown', 'touchstart', 'touchend', 'click', 'keydown'].forEach(function (ev) {
        try { document.addEventListener(ev, wake, { passive: true, capture: true }); } catch (e) {}
      });
    }

    /* 시작: PCM 합성 + 세션 타입(ambient) + 제스처 잠금 해제 */
    try {
      ambientSession();
      buildAll();
      hookGestures();
    } catch (e) {}
    try { document.addEventListener('DOMContentLoaded', function () { refreshToggle(false); }, { once: true }); } catch (e) {}

    return {
      tear: tear, snap: snap, fanfare: fanfare, sealCharge: sealCharge, test: test,
      cBeat: cBeat, promote: promote,
      unlock: unlock, buzz: buzz,
      isMuted: isMuted, setMuted: setMuted, refreshToggle: refreshToggle,
      toggle: function () { setMuted(!isMuted()); }
    };
  })();


  /* =========================================================
     종이 티켓 찢기 · 3D 펼치기(peel) 연출
     ========================================================= */
  var PEEL_TEAR = 0.30;      /* 이 진행률까지는 절취선만 찢는다 */
  var PEEL_TEAR_PX = 34;     /* 찢겨 벌어지는 최대 간격(px) */
  var PEEL_MAX_ANGLE = 92;   /* 완전히 펼쳐졌을 때의 회전각(deg) */

  /* 찢긴 톱니(종이 이) 모양을 SVG data URI 로 만든다 */
  function teethURL(fill, teeth, vertical) {
    var n = teeth || 26, hh = 10, d, i;
    if (vertical) {
      d = 'M' + hh + ',0 L' + (hh * 0.6).toFixed(2) + ',0';
      for (i = 0; i < n; i++) d += ' L0,' + (i + 0.5).toFixed(2) + ' L' + (hh * 0.6).toFixed(2) + ',' + (i + 1).toFixed(2);
      d += ' L' + hh + ',' + n + ' Z';
    } else {
      d = 'M0,' + hh + ' L0,' + (hh * 0.6).toFixed(2);
      for (i = 0; i < n; i++) d += ' L' + (i + 0.5).toFixed(2) + ',0 L' + (i + 1).toFixed(2) + ',' + (hh * 0.6).toFixed(2);
      d += ' L' + n + ',' + hh + ' Z';
    }
    var vb = vertical ? '0 0 ' + hh + ' ' + n : '0 0 ' + n + ' ' + hh;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" preserveAspectRatio="none">' +
      '<path d="' + d + '" fill="' + fill + '"/></svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  function drawPeelHTML(board, d) {
    var no = ('00' + d.n).slice(-3);
    return '<div class="peel-stage" id="peelStage">' +
      '<p class="result-kicker">TICKET #' + no + ' · ' + h(board.title) + '</p>' +
      '<h2 class="modal-title" id="modalTitle" style="padding-right:0">절취선을 따라 찢어서 열어주세요</h2>' +
      '<p class="modal-sub">아래로 찢으면 종이가 펼쳐지며 등급이 나와요. 중간에 놓으면 다시 덮여서 살짝 엿볼 수 있어요.</p>' +
      '<div class="peel-card" id="peelCard" role="group" aria-label="쿠지 종이 티켓">' +
        '<div class="peel-inner" aria-hidden="true">' +
          '<div class="peel-rays"></div>' +
          '<div class="peel-aura"></div>' +
          '<span class="peel-q">?</span>' +
          '<div class="peel-inner-tag"><span>MYSTERY</span><b>개봉하면 등급이 나와요</b></div>' +
        '</div>' +
        '<div class="peel-stub" aria-hidden="true">' +
          '<span class="peel-stripe"></span>' +
          '<span class="peel-stub-row"><b>쿠지킹</b><em>KUJIKING</em><span class="peel-tearlabel">✂ 절취선</span></span>' +
          '<span class="peel-stub-teeth" id="peelStubTeeth"></span>' +
        '</div>' +
        '<div class="peel-flap" id="peelFlap" role="button" tabindex="0" aria-label="종이를 아래로 찢어 개봉">' +
          '<span class="peel-teeth" id="peelTeeth" aria-hidden="true"></span>' +
          '<span class="peel-shade" aria-hidden="true"></span>' +
          '<span class="peel-seal" aria-hidden="true">미개봉</span>' +
          '<span class="peel-jp">一番くじ</span>' +
          '<span class="peel-no">#' + no + '</span>' +
          '<span class="peel-line">ONLINE KUJI · 1매 한정</span>' +
          '<span class="peel-barcode" aria-hidden="true"></span>' +
          '<span class="peel-tiny">개봉 후 교환·환불 불가 · NO. ' + no + '</span>' +
          '<span class="peel-grip"><span class="peel-grip-arrow">↓</span><span class="peel-grip-text">찢어서 열기</span></span>' +
          '<span class="peel-edge" aria-hidden="true"></span>' +
        '</div>' +
        '<span class="peel-dust" id="peelDust" aria-hidden="true"></span>' +
      '</div>' +
      '<div class="peel-meter">' +
        '<span class="peel-meter-bar" aria-hidden="true"><i id="peelMeterFill"></i></span>' +
        '<span class="peel-meter-row">' +
          '<span class="peel-meter-text" id="peelMeterText">아래로 찢어서 열기 ↓</span>' +
          '<button class="peel-sound" id="peelSound" type="button" data-action="toggle-sound" aria-pressed="true">🔊 소리 켬</button>' +
        '</span>' +
      '</div>' +
      '<button class="peel-fallback" type="button" data-action="peel-snap">드래그가 안 되면 바로 뜯기</button>' +
      '<p class="result-meta">' + (d.usePoints ? '굿즈 포인트 ' + fmt(board.price) + 'P 사용' : (d.couponId ? '뽑기권 1장 사용' : '사용 코드 ' + h(maskCode(d.code || '')))) + (d.demo ? ' · 체험 모드' : '') + '</p>' +
    '</div>';
  }

  var peelDrag = null;

  /* 뽑기권/코드 확인 직후: 결과를 먼저 뽑아 두고, 종이 뒤에 숨긴 채로 개봉 연출을 보여준다 */
  function enterPeel(opts) {
    var d = ui.draw;
    if (!d) return;
    /* 실제 뽑기 동작이 시작되는 사용자 제스처에서만 효과음 잠금을 푼다 */
    kujiSound.unlock();
    opts = opts || {};
    ui.draw = {
      boardId: d.boardId, n: d.n, step: 'peel',
      couponId: opts.couponId || null,
      code: opts.code || null,
      usePoints: !!opts.usePoints,
      demo: !!opts.demo, busy: true, ready: false, revealing: false, result: null
    };
    renderDrawModal();
    prepareDraw();
  }

  async function prepareDraw() {
    var d = ui.draw;
    if (!d || d.step !== 'peel' || d.ready) return;
    var board = getBoard(d.boardId);
    if (!board) return;
    try {
      var res = await Backend.draw({
        boardId: board.id, n: d.n,
        couponId: d.couponId || null,
        code: d.code || null,
        usePoints: !!d.usePoints
      });
      var tuned = tierOf(board, res.grade);
      if (tuned) { res.tierImage = tuned.image || ''; res.tierDesc = tuned.desc || ''; }
      ui.pendingCode = '';
      if (!ui.draw || ui.draw !== d || d.step !== 'peel') {
        /* 화면이 닫혔거나 다른 단계로 넘어간 경우: 결과는 이미 서버·보관함에 기록됐다 */
        toast('뽑기 완료! ' + res.grade + '상', 'ok');
        try { await Backend.refreshData(); renderAll(); } catch (e0) {}
        return;
      }
      d.result = res;
      d.ready = true;
      d.busy = false;
      paintPeek(d);
      updatePeelText(peelDrag ? peelDrag.p : 0);
    } catch (e) {
      if (!ui.draw || ui.draw !== d || d.step !== 'peel') { toast(errMsg(e), 'err'); return; }
      d.busy = false;
      ui.draw = { boardId: d.boardId, n: d.n, step: 'source', busy: false };
      renderDrawModal();
      toast(errMsg(e), 'err');
      try { await Backend.refreshData(); renderAll(); } catch (e2) {}
    }
  }

  /* ---------- 무작위 연뽑: 실행 ---------- */
  /* 남은 번호 중에서 N개를 무작위로 고른다 (이미 팔린 번호 제외) */
  function randomTicketNumbers(board, count) {
    var sold = {};
    (board.opens || []).forEach(function (o) { sold[o.n] = true; });
    var pool = [];
    for (var n = 1; n <= board.tickets; n++) if (!sold[n]) pool.push(n);
    for (var i = pool.length - 1; i > 0; i--) {
      var j = randInt(i + 1);
      var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
  }

  function startMultiDraw(pay) {
    var d = ui.draw;
    if (!d || !d.batch) return;
    var board = getBoard(d.boardId);
    if (!board) return;
    kujiSound.unlock();
    pay = pay || {};
    d.pay = {
      couponIds: pay.couponIds ? pay.couponIds.slice(0, d.count) : null,
      code: pay.code || null,
      usePoints: !!pay.usePoints,
      demo: !!pay.demo
    };
    d.demo = !!pay.demo;
    d.numbers = randomTicketNumbers(board, d.count);
    d.count = d.numbers.length;           /* 남은 번호가 모자라면 그만큼만 */
    d.results = [];
    d.error = '';
    d.step = 'drawing';
    d.busy = true;
    renderDrawModal();
    if (!d.count) {
      d.step = 'source';
      renderDrawModal();
      toast('남은 번호가 없어 뽑을 수 없어요', 'err');
      return;
    }
    runMultiDraw();
  }

  /* 한 장씩 차례로 뽑는다. 중간에 실패하면 거기서 멈추고 성공한 결과는 그대로 남긴다 */
  async function runMultiDraw() {
    var d = ui.draw;
    if (!d || d.step !== 'drawing') return;
    var board = getBoard(d.boardId);
    if (!board) return;
    var pay = d.pay || {};
    for (var i = d.results.length; i < d.numbers.length; i++) {
      if (!ui.draw || ui.draw !== d || d.step !== 'drawing') return;  /* 창을 닫으면 중단 */
      var no = d.numbers[i];
      try {
        var res = await Backend.draw({
          boardId: board.id, n: no,
          couponId: pay.couponIds ? (pay.couponIds[i] || null) : null,
          code: pay.code || null,
          usePoints: !!pay.usePoints
        });
        var tuned = tierOf(board, res.grade);
        if (tuned) { res.tierImage = tuned.image || ''; res.tierDesc = tuned.desc || ''; }
        res.n = no;
        d.results.push(res);
        syncPointsBalance(res);
      } catch (e) {
        d.error = errMsg(e);
        break;
      }
      updateMultiProgress();
      await waitMs(140);
    }
    d.busy = false;
    await finishMultiDraw();
  }

  async function finishMultiDraw() {
    var d = ui.draw;
    if (!d || !d.batch) return;
    try { await Backend.refreshData(); } catch (e) {}
    renderAll();
    /* 창이 닫혔거나 다른 화면으로 이동한 경우: 결과는 이미 서버·보관함에 기록됐다 */
    if (!ui.draw || ui.draw !== d) {
      if (d.results.length) toast('무작위 연뽑 완료 · ' + d.results.length + '장', 'ok');
      return;
    }
    if (!d.results.length) {
      d.step = 'source';
      renderDrawModal();
      toast(d.error || '뽑기에 실패했어요', 'err');
      return;
    }

    /* 결과는 바로 보여 주지 않는다 — 봉인된 티켓 그리드에서 직접 한 장씩 개봉한다 */
    d.revealed = {};
    d.revealDelay = null;
    d.glowIdx = -1;
    d.promoIdx = -1;
    d.promoReturn = null;
    d.promoStarted = false;
    d.charging = false;
    d.result = null;
    d.best = null;
    d.n = null;
    d.step = 'reveal';
    d.revealing = false;
    renderDrawModal();
    renderAll();
    kujiSound.snap(0);          /* 티켓이 도착하는 짧고 경쾌한 소리 */
    toast(d.error
      ? (d.count + '연뽑 · ' + d.results.length + '장만 도착했어요')
      : (d.results.length + '장 도착! 카드를 눌러 개봉하세요'), d.error ? 'err' : 'ok');
  }

  function peelColor(grade) {
    var g = String(grade || '');
    if (g.toUpperCase() === 'LAST') return 'var(--gold)';
    if (/^[A-L]$/i.test(g)) return 'var(--grade-' + g.toLowerCase() + ')';
    return 'var(--yellow)';
  }

  /* 결과가 준비돼도 속지에는 아무 힌트도 주지 않는다 (상품·등급 스포일러 방지) */
  function paintPeek(d) {
    var card = $('#peelCard');
    if (!card) return;
    card.classList.add('is-ready');
    var aura = card.querySelector('.peel-aura');
    var rays = card.querySelector('.peel-rays');
    if (aura) aura.style.setProperty('--peel-glow', 'var(--gold)');
    if (rays) rays.style.setProperty('--peel-glow', 'var(--gold)');
  }

  function updatePeelText(p) {
    var fill = $('#peelMeterFill'), text = $('#peelMeterText'), card = $('#peelCard');
    var grip = $('.peel-grip-text');
    var pct = Math.round(Math.min(1, p / 0.75) * 100);
    if (fill) fill.style.width = pct + '%';
    if (text) {
      text.textContent = p >= 0.75 ? '놓으면 종이가 활짝 열려요!'
        : (p >= PEEL_TEAR ? '종이가 펼쳐지는 중 · ' + Math.round(p * 100) + '%'
        : (p > 0.02 ? '절취선을 찢는 중 · ' + Math.round(p * 100) + '%' : '아래로 찢어서 열기 ↓'));
      text.classList.toggle('is-armed', p >= 0.75);
    }
    if (card) card.classList.toggle('is-armed', p >= 0.75);
    if (grip) grip.textContent = p >= 0.75 ? '놓으면 열림!' : (p > 0.02 ? '계속 찢기' : '찢어서 열기');
  }

  function bindPeel() {
    var card = $('#peelCard'), flap = $('#peelFlap');
    if (!card || !flap) return;

    var teethEl = $('#peelTeeth'), stubTeethEl = $('#peelStubTeeth');
    if (teethEl) teethEl.style.backgroundImage = teethURL('#fffdf7', 26);
    if (stubTeethEl) stubTeethEl.style.backgroundImage = teethURL('#ffeec2', 26);
    kujiSound.refreshToggle();

    var st = { dragging: false, src: null, startX: 0, startY: 0, base: 0, p: 0, max: 1, height: 420, armed: false, tooth: 0 };
    st.height = card.getBoundingClientRect().height || 420;
    st.max = Math.max(130, st.height * 0.62);
    peelDrag = st;

    function angleOf(p) {
      if (p <= PEEL_TEAR) return 0;
      var q = (p - PEEL_TEAR) / (1 - PEEL_TEAR);
      return Math.pow(q, 0.88) * PEEL_MAX_ANGLE;
    }
    function tearOf(p) {
      return PEEL_TEAR_PX * Math.min(1, p / PEEL_TEAR);
    }

    function applyPeel(p, animate) {
      st.p = p;
      var t = tearOf(p), a = angleOf(p);
      flap.style.transition = animate ? '' : 'none';
      flap.style.transform = 'translate3d(0,' + t.toFixed(1) + 'px,0) rotateX(' + a.toFixed(2) + 'deg)';
      card.style.setProperty('--peel', p.toFixed(3));
      card.style.setProperty('--tear', Math.min(1, p / PEEL_TEAR).toFixed(3));
      card.style.setProperty('--fold', Math.min(1, a / PEEL_MAX_ANGLE).toFixed(3));
      card.style.setProperty('--peel-blur', (22 - 19 * p).toFixed(1) + 'px');
      card.style.setProperty('--peel-alpha', (0.16 + 0.84 * p).toFixed(2));
      card.style.setProperty('--peel-zoom', (1 + 0.06 * p).toFixed(3));
    }
    st.apply = applyPeel;
    applyPeel(0, false);
    updatePeelText(0);

    /* 절취선 한 칸이 끊어질 때: 종이 부스러기 + 지직 소리 */
    function dustAtTear(count, spread) {
      var layer = document.getElementById('peelDust');
      if (!layer) return;
      for (var i = 0; i < count; i++) {
        var bit = document.createElement('i');
        bit.style.left = (4 + Math.random() * 92).toFixed(1) + '%';
        bit.style.top = (46 + Math.random() * 18).toFixed(0) + 'px';
        bit.style.setProperty('--dx', ((Math.random() - 0.5) * (spread || 70)).toFixed(0) + 'px');
        bit.style.setProperty('--dy', (-4 - Math.random() * 24).toFixed(0) + 'px');
        bit.style.setProperty('--rot', ((Math.random() - 0.5) * 280).toFixed(0) + 'deg');
        bit.style.opacity = (0.5 + Math.random() * 0.5).toFixed(2);
        layer.appendChild(bit);
        (function (el) {
          setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 760);
        })(bit);
      }
    }
    st.dust = dustAtTear;

    /* --- 포인터·터치 공통 제스처 (iOS Safari 는 touch 이벤트로도 잡아 준다) --- */
    function start(x, y) {
      if (st.dragging) return false;
      if (ui.draw && ui.draw.revealing) return false;
      st.height = card.getBoundingClientRect().height || st.height;
      st.max = Math.max(130, st.height * 0.62);
      st.dragging = true;
      st.startX = x; st.startY = y; st.base = st.p;
      st.tooth = Math.floor(st.p / 0.02);
      flap.classList.add('is-dragging');
      card.classList.add('is-dragging');
      kujiSound.tear(0.2);
      return true;
    }
    function move(x, y) {
      if (!st.dragging) return;
      var dy = y - st.startY;
      var dx = x - st.startX;
      var travel = Math.max(dy, dx * 0.55);   /* 대각선으로 당겨도 찢긴다 */
      var p = Math.min(1, Math.max(0, (st.base * st.max + travel) / st.max));
      applyPeel(p, false);
      updatePeelText(p);
      var tooth = Math.floor(p / 0.02);
      if (tooth !== st.tooth) {
        st.tooth = tooth;
        kujiSound.tear(p);
        if (p < PEEL_TEAR + 0.12) dustAtTear(p < PEEL_TEAR ? 2 : 1, 60);
      }
      if (p >= 0.75 && !st.armed) {
        st.armed = true;
        try { navigator.vibrate && navigator.vibrate(14); } catch (err) {}
      }
      if (p < 0.72) st.armed = false;
    }
    function end(x, y) {
      if (!st.dragging) return;
      st.dragging = false;
      st.src = null;
      st.armed = false;
      flap.classList.remove('is-dragging');
      card.classList.remove('is-dragging');
      if (st.p >= 0.75) { peelSnap(); return; }
      if (Math.abs(y - st.startY) < 8 && Math.abs(x - st.startX) < 8) {
        /* 그냥 톡 눌렀을 때: 손잡이를 흔들어 "찢어서 열기"를 알려준다 */
        card.classList.add('is-hinting');
        setTimeout(function () { card.classList.remove('is-hinting'); }, 720);
      }
      applyPeel(0, true);
      updatePeelText(0);
      try { navigator.vibrate && navigator.vibrate(4); } catch (err) {}
    }

    card.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!start(e.clientX, e.clientY)) return;
      st.src = 'pointer';
      try { card.setPointerCapture(e.pointerId); } catch (err) {}
      if (e.cancelable) e.preventDefault();
    });
    card.addEventListener('pointermove', function (e) {
      if (st.src !== 'pointer') return;
      move(e.clientX, e.clientY);
      if (e.cancelable) e.preventDefault();
    });
    function pointerEnd(e) {
      if (st.src !== 'pointer') return;
      end(e.clientX, e.clientY);
      try { card.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    card.addEventListener('pointerup', pointerEnd);
    card.addEventListener('pointercancel', function (e) {
      /* 스크롤 제스처로 뺏겨도 찢긴 만큼은 남긴다 */
      if (st.src !== 'pointer') return;
      if (st.p >= 0.75) { peelSnap(); return; }
      pointerEnd(e);
    });

    /* iOS Safari 대비: 터치 이벤트에서 스크롤을 막고, 포인터가 없으면 이쪽이 직접 찢는다 */
    card.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      if (e.cancelable) e.preventDefault();
      if (st.src === 'pointer') return;
      var t = e.touches[0];
      if (start(t.clientX, t.clientY)) st.src = 'touch';
    }, { passive: false });
    card.addEventListener('touchmove', function (e) {
      if (e.cancelable) e.preventDefault();
      if (st.src !== 'touch' || e.touches.length !== 1) return;
      move(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    card.addEventListener('touchend', function (e) {
      if (e.cancelable) e.preventDefault();
      if (st.src !== 'touch') return;
      var t = e.changedTouches[0] || { clientX: st.startX, clientY: st.startY };
      end(t.clientX, t.clientY);
    }, { passive: false });
    card.addEventListener('touchcancel', function (e) {
      if (st.src !== 'touch') return;
      if (st.p >= 0.75) { peelSnap(); return; }
      end(st.startX, st.startY);
    }, { passive: false });

    flap.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); peelSnap(); }
    });
  }

  /* 75% 이상 당겨 놓으면 종이가 쫙 찢기며 결과가 나온다 */
  async function peelSnap() {
    var d = ui.draw;
    if (!d || d.step !== 'peel' || d.revealing) return;
    kujiSound.unlock();
    d.revealing = true;
    var card = $('#peelCard'), flap = $('#peelFlap');
    if (card) {
      card.classList.remove('is-dragging');
      card.classList.add('is-tearing');
      card.style.setProperty('--peel', '1');
      card.style.setProperty('--peel-blur', '0px');
      card.style.setProperty('--peel-alpha', '1');
      card.style.setProperty('--peel-zoom', '1.1');
      card.style.setProperty('--fold', '1');
    }
    if (flap) {
      var hgt = card ? (card.getBoundingClientRect().height || 420) : 420;
      flap.classList.remove('is-dragging');
      flap.style.transition = 'transform .34s cubic-bezier(.32,.9,.4,1), opacity .3s ease';
      flap.style.transform = 'translate3d(0,' + (PEEL_TEAR_PX + hgt * 0.05).toFixed(0) + 'px,0) rotateX(122deg)';
      flap.style.opacity = '0';
    }
    if (peelDrag && peelDrag.dust) peelDrag.dust(28, 180);
    var fill = $('#peelMeterFill');
    if (fill) fill.style.width = '100%';
    updatePeelText(1);
    var snapLv = gradeLevel(d.result && d.result.grade);
    kujiSound.snap(snapLv);
    /* 봉인·상위상은 종이가 뜯기는 순간 카드 전체가 황금빛으로 번쩍인다 */
    if (card && snapLv >= 1) {
      card.classList.add('is-boom');
      setTimeout(function () { if (card) card.classList.remove('is-boom'); }, 760);
    }

    var waited = 0;
    while (ui.draw === d && !d.ready && waited < 9000) { await waitMs(120); waited += 120; }
    await waitMs(340);
    if (!ui.draw || ui.draw !== d || d.step !== 'peel') return;
    if (!d.result) {
      d.revealing = false;
      toast('결과를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.', 'err');
      return;
    }
    d.busy = false;
    /* B상 이상은 한 번 더 봉인을 까는 2단계 연출로 넘어간다 */
    syncPointsBalance(d.result);
    if (isSealGrade(d.result.grade)) {
      d.step = 'seal';
      d.revealing = false;
      renderDrawModal();
      renderAll();
      kujiSound.sealCharge();
      return;
    }
    d.step = 'result';
    kujiSound.fanfare(d.result.lastOneWon ? 3 : gradeLevel(d.result.grade));
    renderDrawModal();
    renderAll();
    toast(d.result.demo ? '체험 뽑기 완료!' : '뽑기 완료! ' + d.result.grade + '상', 'ok');
  }

  /* =========================================================
     2단계: 황금 봉인 (B상 · A상 · 라스트원상 전용)
     ========================================================= */
  var sealDrag = null;

  /* C상 이상은 모두 2단계 황금 봉인을 한 번 더 깐다 (C/B/A/라스트원) */
  function isSealGrade(grade) {
    return gradeLevel(grade) >= 1;
  }

  function drawSealHTML(board, d) {
    var no = ('00' + d.n).slice(-3);
    var sealLv = gradeLevel(d.result && d.result.grade) >= 3 ? 3 : 2;
    var batchKicker = d.batch ? ((d.count || 1) + '장 중 상위상 감지') : '상위상 기운 감지';
    var sealSub = d.batch
      ? '이번 ' + (d.count || 1) + '장 중 <b>가장 높은 등급</b>이 황금 봉인 속에 있어요. 봉인을 찢어야 진짜 등급이 나옵니다.'
      : '종이 속에서 <b>황금 봉인</b>이 나왔어요. 봉인을 찢어야 진짜 등급이 나옵니다.';
    var sealMeta = d.batch
      ? h(board.title) + ' · #' + d.n + '번 포함 ' + (d.count || 1) + '장 · 봉인 개봉 전에는 등급이 공개되지 않아요'
      : h(board.title) + ' · ' + d.n + '번 · 봉인 개봉 전에는 등급이 공개되지 않아요';
    return '<div class="seal-stage seal-lv' + sealLv + '" id="sealStage">' +
      '<div class="seal-banner">' +
        '<p class="seal-kicker"><span class="seal-bolt">⚡</span> ' + h(batchKicker) + '</p>' +
        '<h2 class="modal-title seal-title" id="modalTitle">C상 이상 확정!</h2>' +
      '</div>' +
      '<p class="modal-sub">' + sealSub + '</p>' +
      '<div class="seal-card" id="sealCard">' +
        '<div class="seal-halo" aria-hidden="true"></div>' +
        '<div class="seal-box" id="sealBox" role="button" tabindex="0" aria-label="황금 봉인을 아래로 찢어 열기">' +
          '<span class="seal-half left" aria-hidden="true"><span class="seal-teeth" id="sealTeethL"></span></span>' +
          '<span class="seal-half right" aria-hidden="true"><span class="seal-teeth" id="sealTeethR"></span></span>' +
          '<span class="seal-seam" aria-hidden="true"></span>' +
          '<span class="seal-flash" aria-hidden="true"></span>' +
          '<span class="seal-mark" aria-hidden="true"><b>쿠지킹</b><em>SEALED</em><i>?</i></span>' +
          '<span class="seal-ticket" aria-hidden="true">NO. ' + no + '</span>' +
          '<span class="seal-dust" id="sealDust" aria-hidden="true"></span>' +
        '</div>' +
        '<span class="seal-grip"><span class="seal-grip-arrow">↓</span><span class="seal-grip-text" id="sealGripText">찢어서 열기</span></span>' +
      '</div>' +
      '<div class="seal-meter">' +
        '<span class="seal-meter-bar" aria-hidden="true"><i id="sealMeterFill"></i></span>' +
        '<span class="seal-meter-text" id="sealMeterText">아래로 찢어서 봉인을 깨세요</span>' +
      '</div>' +
      '<button class="seal-fallback" type="button" data-action="seal-snap">드래그가 안 되면 바로 열기</button>' +
      '<p class="result-meta">' + (d.demo ? '체험 모드 · ' : '') + sealMeta + '</p>' +
    '</div>';
  }

  function bindSeal() {
    var card = $('#sealCard'), box = $('#sealBox');
    if (!card || !box) return;
    var tl = $('#sealTeethL'), tr = $('#sealTeethR');
    var stage = document.getElementById('sealStage');
    var platinum = !!(stage && stage.className.indexOf('seal-lv3') >= 0);
    var toothFill = platinum ? '#8b93a8' : '#b8871f';
    if (tl) tl.style.backgroundImage = teethURL(toothFill, 30, true);
    if (tr) tr.style.backgroundImage = teethURL(toothFill, 30, true);

    var st = { p: 0, dragging: false, src: null, startX: 0, startY: 0, base: 0, max: 190, armed: false, holdTimer: null, raf: 0 };
    st.max = Math.max(120, (card.getBoundingClientRect().height || 340) * 0.55);
    sealDrag = st;

    function apply(p) {
      st.p = p;
      box.style.setProperty('--seal', p.toFixed(3));
      box.style.setProperty('--shk', (1 + p * 2.6).toFixed(2));
      var fill = $('#sealMeterFill');
      if (fill) fill.style.width = Math.round(Math.min(1, p / 0.7) * 100) + '%';
      var txt = $('#sealMeterText');
      if (txt) {
        txt.textContent = p >= 0.7 ? '놓으면 봉인이 깨져요!'
          : (p > 0.02 ? '봉인이 갈라지는 중… ' + Math.round(p * 100) + '%' : '아래로 찢어서 봉인을 깨세요');
        txt.classList.toggle('is-armed', p >= 0.7);
      }
      var grip = $('#sealGripText');
      if (grip) grip.textContent = p >= 0.7 ? '놓으면 열림!' : (p > 0.02 ? '계속 찢기' : '찢어서 열기');
      if (p >= 0.7 && !st.armed) {
        st.armed = true;
        kujiSound.tear(1);
        try { navigator.vibrate && navigator.vibrate(16); } catch (e) {}
      }
      if (p < 0.68) st.armed = false;
    }
    st.apply = apply;
    apply(0);

    function clearHold() { if (st.holdTimer) { clearTimeout(st.holdTimer); st.holdTimer = null; } }

    /* 누르고 있으면 봉인이 스스로 갈라진다 */
    function charge() {
      st.holdTimer = null;
      if (ui.draw && ui.draw.revealing) return;
      var t0 = 0;
      function step() {
        st.raf = 0;
        if (!ui.draw || ui.draw.step !== 'seal' || ui.draw.revealing) return;
        t0 += 16;
        var q = Math.min(1, t0 / 640);
        apply(q);
        kujiSound.tear(q);
        if (q < 1) st.raf = requestAnimationFrame(step);
        else sealSnap();
      }
      st.raf = requestAnimationFrame(step);
    }

    function start(x, y, arm) {
      if (st.dragging) return false;
      if (ui.draw && ui.draw.revealing) return false;
      st.dragging = true;
      st.startX = x; st.startY = y; st.base = st.p;
      box.classList.add('is-straining');
      kujiSound.tear(0.3);
      clearHold();
      if (arm !== false) st.holdTimer = setTimeout(charge, 620);
      return true;
    }
    function move(x, y) {
      if (!st.dragging) return;
      var dy = y - st.startY, dx = x - st.startX;
      if (Math.abs(dy) > 6 || Math.abs(dx) > 6) clearHold();
      var travel = Math.max(dy, dx * 0.4);
      var p = Math.min(1, Math.max(0, (st.base * st.max + travel) / st.max));
      if (Math.abs(p - st.p) > 0.01) kujiSound.tear(p);
      apply(p);
    }
    function end(x, y) {
      if (!st.dragging) return;
      st.dragging = false;
      st.src = null;
      box.classList.remove('is-straining');
      clearHold();
      if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
      if (st.p >= 0.7) { sealSnap(); return; }
      if (Math.abs(y - st.startY) < 8 && Math.abs(x - st.startX) < 8) {
        box.classList.add('is-hinting');
        setTimeout(function () { box.classList.remove('is-hinting'); }, 700);
      }
      apply(0);
    }

    box.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!start(e.clientX, e.clientY)) return;
      st.src = 'pointer';
      try { box.setPointerCapture(e.pointerId); } catch (err) {}
      if (e.cancelable) e.preventDefault();
    });
    box.addEventListener('pointermove', function (e) {
      if (st.src !== 'pointer') return;
      move(e.clientX, e.clientY);
      if (e.cancelable) e.preventDefault();
    });
    function pointerEnd(e) {
      if (st.src !== 'pointer') return;
      end(e.clientX, e.clientY);
      try { box.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    box.addEventListener('pointerup', pointerEnd);
    box.addEventListener('pointercancel', function (e) {
      if (st.src !== 'pointer') return;
      if (st.p >= 0.7) { sealSnap(); return; }
      pointerEnd(e);
    });

    box.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      if (e.cancelable) e.preventDefault();
      if (st.src === 'pointer') return;
      var t = e.touches[0];
      if (start(t.clientX, t.clientY)) st.src = 'touch';
    }, { passive: false });
    box.addEventListener('touchmove', function (e) {
      if (e.cancelable) e.preventDefault();
      if (st.src !== 'touch' || e.touches.length !== 1) return;
      move(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    box.addEventListener('touchend', function (e) {
      if (e.cancelable) e.preventDefault();
      if (st.src !== 'touch') return;
      var t = e.changedTouches[0] || { clientX: st.startX, clientY: st.startY };
      end(t.clientX, t.clientY);
    }, { passive: false });
    box.addEventListener('touchcancel', function (e) {
      if (st.src !== 'touch') return;
      if (st.p >= 0.7) { sealSnap(); return; }
      end(st.startX, st.startY);
    }, { passive: false });

    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sealSnap(); }
    });
  }

  async function sealSnap() {
    var d = ui.draw;
    if (!d || d.step !== 'seal' || d.revealing) return;
    kujiSound.unlock();
    d.revealing = true;
    if (sealDrag && sealDrag.raf) { cancelAnimationFrame(sealDrag.raf); sealDrag.raf = 0; }
    var box = $('#sealBox');
    if (box) {
      box.classList.add('is-burst');
      box.classList.remove('is-straining');
    }
    var fill = $('#sealMeterFill');
    if (fill) fill.style.width = '100%';
    var txt = $('#sealMeterText');
    if (txt) { txt.textContent = '봉인 해제!'; txt.classList.add('is-armed'); }
    kujiSound.snap(3);
    var stage3 = document.getElementById('sealStage');
    if (stage3) {
      stage3.classList.add('is-burst');
      setTimeout(function () { if (stage3) stage3.classList.remove('is-burst'); }, 900);
    }
    await waitMs(620);
    if (!ui.draw || ui.draw !== d || d.step !== 'seal') return;
    if (!d.result) { d.revealing = false; return; }
    /* C·B·A·라스트원은 승격 연출(3단계)로 넘긴다 — 배지가 C → B → A 로 올라간다 */
    syncPointsBalance(d.result);
    d.step = 'promote';
    d.revealing = false;
    d.promoStarted = false;
    d.promoSkip = false;
    renderDrawModal();
    renderAll();
  }

  /* =========================================================
     3단계: 승격 연출 — C → B → A · 라스트원 대역전
     승격 중에는 등급 배지와 빛만 보여 주고, 상품 이미지는
     최종 등급의 결과 화면에서 처음 공개한다 (스포일러 없음)
     ========================================================= */
  var promoRun = null;

  function promoLabel(grade) {
    var g = String(grade || '').toUpperCase();
    if (g === 'LAST') return { letter: 'L', unit: 'LAST', name: '라스트원' };
    return { letter: g, unit: '상', name: g + '상' };
  }

  function drawPromoteHTML(board, d) {
    var lv = gradeLevel(d.result && d.result.grade);
    var no = ('00' + d.n).slice(-3);
    return '<div class="promo-stage" id="promoStage" data-mood="c">' +
      '<div class="promo-bg" aria-hidden="true"></div>' +
      '<div class="promo-rays" aria-hidden="true"></div>' +
      '<div class="promo-fx" id="promoFx1" aria-hidden="true"></div>' +
      '<div class="promo-fx promo-fx-2" id="promoFx2" aria-hidden="true"></div>' +
      '<div class="promo-bolts" id="promoBolts" aria-hidden="true"></div>' +
      '<div class="promo-stars" id="promoStars" aria-hidden="true"></div>' +
      '<div class="promo-flash" id="promoFlash" aria-hidden="true"></div>' +
      '<p class="promo-kicker"><span>⚡</span> 상위상 봉인 해제 · 등급 확인</p>' +
      '<div class="promo-slot">' +
        '<div class="promo-aura" aria-hidden="true"></div>' +
        '<div class="promo-ring" id="promoRing" aria-hidden="true"><i></i><i></i><i></i></div>' +
        '<div class="promo-badge is-pop" id="promoBadge" data-mood="c"><b id="promoLetter">C</b><i id="promoUnit">상</i></div>' +
      '</div>' +
      '<p class="promo-impact" id="promoImpact" role="status" aria-live="polite"></p>' +
      '<p class="promo-foot">화면을 누르면 빨리 볼 수 있어요 · ' + h(board.title) + ' ' + (d.batch ? ('무작위 ' + (d.count || 1) + '연뽑') : (no + '번')) + (d.demo ? ' · 체험 모드' : '') + '</p>' +
    '</div>';
  }

  /* 승격 대기 — 화면을 누르면(promoSkip) 지금 기다리는 간격부터 바로 줄인다 */
  function promoWait(d, ms) {
    var t = 0;
    return new Promise(function (resolve) {
      function tick() {
        if (!ui.draw || ui.draw !== d || d.step !== 'promote') { resolve(false); return; }
        var target = d.promoSkip ? Math.min(140, ms) : ms;
        if (t >= target) { resolve(true); return; }
        t += 50;
        setTimeout(tick, 50);
      }
      tick();
    });
  }

  function promoMood(mood) {
    var stage = document.getElementById('promoStage');
    if (stage) stage.setAttribute('data-mood', mood);
  }

  function promoBadge(letter, unit, mood) {
    var b = document.getElementById('promoBadge');
    var l = document.getElementById('promoLetter');
    var u = document.getElementById('promoUnit');
    var ring = document.getElementById('promoRing');
    if (l) l.textContent = letter;
    if (u) u.textContent = unit;
    if (b) {
      b.setAttribute('data-mood', mood);
      b.classList.toggle('is-last', String(unit || '').toUpperCase() === 'LAST');
      b.classList.remove('is-pop');
      void b.offsetWidth;
      b.classList.add('is-pop');
    }
    if (ring) {
      ring.classList.remove('is-on');
      void ring.offsetWidth;
      ring.classList.add('is-on');
    }
  }

  /* 화면 번쩍임 + 모달 흔들림 (zap: 1차 승격 · mega: 2차 대역전) */
  function promoFlash(kind) {
    var f = document.getElementById('promoFlash');
    if (f) {
      f.className = 'promo-flash ' + kind;
      void f.offsetWidth;
      f.classList.add('is-on');
    }
    if (modalShell) {
      modalShell.style.setProperty('--quake', kind === 'mega' ? '2' : '1.15');
      modalShell.classList.remove('is-quake');
      void modalShell.offsetWidth;
      modalShell.classList.add('is-quake');
    }
  }

  function promoBolts(n) {
    var host = document.getElementById('promoBolts');
    if (!host) return;
    for (var i = 0; i < n; i++) {
      var s = document.createElement('span');
      s.className = 'promo-bolt';
      s.style.left = (8 + Math.random() * 84).toFixed(1) + '%';
      s.style.top = (-8 + Math.random() * 42).toFixed(1) + '%';
      s.style.setProperty('--rot', (-28 + Math.random() * 56).toFixed(0) + 'deg');
      s.style.setProperty('--len', (60 + Math.random() * 120).toFixed(0) + 'px');
      s.style.animationDelay = (Math.random() * 0.16).toFixed(2) + 's';
      host.appendChild(s);
      (function (el) {
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 900);
      })(s);
    }
  }

  function promoImpact(icon, text, mood) {
    var el = document.getElementById('promoImpact');
    if (!el) return;
    el.innerHTML = (icon ? '<span class="pi-icon" aria-hidden="true">' + icon + '</span>' : '') +
      '<span class="pi-txt">' + h(text) + '</span>';
    el.setAttribute('data-mood', mood);
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');
  }

  function promoConfetti(layerId, count, colors, opt) {
    var el = document.getElementById(layerId);
    if (!el) return;
    var o = opt || {};
    el.insertAdjacentHTML('beforeend', confettiHTML(count, {
      drop: o.drop || 340, drift: o.drift || 160, spread: o.spread || .5, colors: colors
    }));
  }

  function promoStars(n) {
    var el = document.getElementById('promoStars');
    if (el) el.insertAdjacentHTML('beforeend', sparkleHTML(n, 'promo-star'));
  }

  function promoClearFx() {
    ['promoFx1', 'promoFx2', 'promoStars'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
  }

  function finishPromotion(d) {
    if (!ui.draw || ui.draw !== d || d.step !== 'promote') return;
    promoRun = null;
    d.revealing = false;
    /* 연뽑 그리드에서 넘어온 승격: 클라이맥스 뒤에 당첨 상품(피규어 사진·상품명)을 확실히 보여 준다 */
    if (d.batch && d.promoReturn === 'reveal') {
      var gi = d.promoIdx;
      if (!d.revealed) d.revealed = {};
      if (gi != null && gi >= 0) { d.revealed[gi] = true; d.glowIdx = gi; d.lastOpenIdx = gi; }
      if (d.result) d.n = d.result.n;
      d.promoReturn = null;
      d.promoIdx = -1;
      d.promoStarted = false;
      d.charging = false;
      d.spotlight = true;
      d.step = 'spotlight';
      renderDrawModal();
      renderAll();
      return;
    }
    d.step = 'result';
    renderDrawModal();
    renderAll();
    if (d.batch) {
      toast(d.error ? (d.count + '연뽑 · ' + d.results.length + '장만 완료') : (d.count + '연뽑 완료!'), d.error ? 'err' : 'ok');
      return;
    }
    var g = String((d.result && d.result.grade) || '').toUpperCase();
    toast(d.result && d.result.demo ? '체험 뽑기 완료!' : '뽑기 완료! ' + (g === 'LAST' ? '라스트원' : (d.result.grade + '상')), 'ok');
  }

  async function runPromotion(d) {
    var stage = document.getElementById('promoStage');
    if (!stage || !d.result) return;
    var lv = gradeLevel(d.result.grade);
    var fin = promoLabel(d.result.grade);
    var alive = function () { return !!(ui.draw === d && d.step === 'promote'); };

    /* 1막 — C상 확인 (실제 C상이면 여기서 끝, B·A 는 승격을 위한 속임수 단계) */
    promoMood('c');
    promoBadge('C', '상', 'c');
    promoConfetti('promoFx1', lv >= 2 ? 14 : 24, ['#8b7cff', '#5b8bff', '#b7a6ff', '#8ee3ff', '#ffd8ff', '#ffffff'], { drop: 320, drift: 130, spread: .38 });
    promoStars(lv >= 2 ? 6 : 11);
    kujiSound.cBeat();

    if (lv <= 1) {
      if (!(await promoWait(d, 240)) || !alive()) return;
      promoImpact('✨', 'C상!', 'c');
      promoConfetti('promoFx1', 20, ['#a99cff', '#5b8bff', '#8ee3ff', '#ffffff'], { drop: 360, drift: 170, spread: .5 });
      kujiSound.fanfare(1);
      if (!(await promoWait(d, 1250)) || !alive()) return;
      return finishPromotion(d);
    }

    /* v3.9.7 — C상으로 한 번 더 곱씹는 텀 ("어? C상인가?") */
    if (!(await promoWait(d, 1300)) || !alive()) return;

    /* 2막 — C → B 승격 */
    promoMood('b');
    kujiSound.promote(1);
    promoFlash('zap');
    promoBolts(lv >= 3 ? 5 : 4);
    promoImpact('⚡', '승격! B상!', 'b');
    /* v3.9.7 — B상 승격이 몸에 익을 때까지 버티는 텀 */
    if (!(await promoWait(d, 1400)) || !alive()) return;
    promoBadge('B', '상', 'b');
    promoConfetti('promoFx1', 24, ['#ff8a3d', '#ff2d20', '#ffb703', '#fff3c4', '#ffffff'], { drop: 350, drift: 170, spread: .5 });
    promoConfetti('promoFx2', 16, ['#ffd166', '#ff7a1a', '#ff3b30', '#ffffff'], { drop: 400, drift: 200, spread: .55 });
    promoStars(10);
    kujiSound.fanfare(2);

    if (lv <= 2) {
      if (!(await promoWait(d, 1450)) || !alive()) return;
      return finishPromotion(d);
    }

    if (!(await promoWait(d, 460)) || !alive()) return;

    /* 3막 — B → A · 라스트원 대역전 */
    promoMood('a');
    kujiSound.promote(2);
    promoFlash('mega');
    promoBolts(10);
    promoImpact('🔥', fin.unit === 'LAST' ? '대역전!! 라스트원!' : '대역전!! A상!', 'a');
    /* v3.9.7 — 대역전 임팩트는 짧게 끊고, 결과 카드 전에 길게 잡아둔다 */
    if (!(await promoWait(d, 350)) || !alive()) return;
    promoClearFx();
    promoBadge(fin.letter, fin.unit, 'a');
    promoConfetti('promoFx1', 30, ['#ffd51e', '#f5b800', '#ff3b30', '#12a87a', '#3d7bfd', '#a855f7', '#ffffff'], { drop: 380, drift: 190, spread: .55 });
    promoConfetti('promoFx2', 26, ['#ffe9a8', '#ffffff', '#ff7ac8', '#8ee3ff', '#ffd51e'], { drop: 430, drift: 220, spread: .6 });
    promoStars(30);
    kujiSound.fanfare(3);
    if (!(await promoWait(d, 1700)) || !alive()) return;
    return finishPromotion(d);
  }

  function bindPromote(d) {
    var stage = document.getElementById('promoStage');
    if (!stage || !d) return;
    if (!d.promoStarted) {
      d.promoStarted = true;
      d.promoSkip = false;
      stage.addEventListener('click', function () {
        if (ui.draw === d && d.step === 'promote') d.promoSkip = true;
      });
      promoRun = d;
      runPromotion(d);
      return;
    }
    /* 다시 그려졌을 때(회전·재렌더) 는 타임라인을 새로 시작하지 않는다 */
  }

  /* =========================================================
     당첨 연출 — 상위 등급은 빛줄기·후광·폭죽, 하위 등급은 깔끔한 팝인
     ========================================================= */
  /* 0: D~L 깔끔 · 1: C 블루/바이올렛 · 2: B 골드 · 3: A·라스트원 플래티넘/무지개 */
  function gradeLevel(grade) {
    var g = String(grade || '').toUpperCase();
    if (g === 'LAST' || g === 'A') return 3;
    if (g === 'B') return 2;
    if (g === 'C') return 1;
    return 0;
  }
  function isEpicGrade(grade) { return gradeLevel(grade) >= 1; }
  var REVEAL_CONF = [0, 20, 72, 120];
  var REVEAL_SPARK = [4, 10, 34, 56];

  function confettiHTML(count, opts) {
    opts = opts || {};
    var colors = opts.colors || ['#ffd51e', '#ff7a1a', '#ef3b2d', '#12a87a', '#3d7bfd', '#f5b800'];
    var n = count || 26;
    var out = '';
    for (var i = 0; i < n; i++) {
      out += '<span class="confetti" style="left:' + Math.round(Math.random() * 100) + '%;background:' + colors[i % colors.length] +
        ';width:' + (6 + Math.round(Math.random() * 6)) + 'px;height:' + (10 + Math.round(Math.random() * 8)) + 'px' +
        ';animation-delay:' + (Math.random() * (opts.spread || .5)).toFixed(2) + 's;animation-duration:' + (2.4 + Math.random() * 1.3).toFixed(2) + 's' +
        ';--dx:' + Math.round((Math.random() - .5) * (opts.drift || 160)) + 'px;--h:' + Math.round(opts.drop || 340) + 'px;--rot:' + Math.round(360 + Math.random() * 540) + 'deg"></span>';
    }
    return out;
  }

  function sparkleHTML(n, cls) {
    var out = '';
    for (var i = 0; i < n; i++) {
      out += '<span class="' + (cls || 'rv-spark') + '" style="left:' + (4 + Math.random() * 92).toFixed(1) + '%;top:' + (3 + Math.random() * 66).toFixed(1) +
        '%;font-size:' + (9 + Math.random() * 13).toFixed(0) + 'px;animation-delay:' + (Math.random() * 1.8).toFixed(2) + 's">✦</span>';
    }
    return out;
  }

  function isPointPrize(r) {
    if (!r) return false;
    return String(r.grade || '').toUpperCase() === 'P' || r.itemStatus === '포인트지급';
  }

  /* 결제·당첨으로 바뀜 포인트 잔액을 서버 응답값으로 맞춘다 (헤더·마이페이지에 바로 반영) */
  function syncPointsBalance(r) {
    if (!r || r.pointsBalance == null) return;
    var u = me();
    if (!u) return;
    var next = Number(r.pointsBalance);
    if (isNaN(next)) return;
    var prev = Number(u.points) || 0;
    u.points = next;
    var pEl = $('#userPoints');
    if (pEl) {
      pEl.textContent = fmt(next) + 'P';
      if (next !== prev) {
        pEl.classList.remove('is-bump');
        void pEl.offsetWidth;
        pEl.classList.add('is-bump');
        setTimeout(function () { try { pEl.classList.remove('is-bump'); } catch (e) {} }, 1200);
      }
    }
    var mp = $('#myPointsStat');
    if (mp) mp.textContent = fmt(next) + 'P';
  }

  /* P상 당첨 카드: 실물 배송이 없으므로 보관함 안내 대신 포인트 적립 안내를 보여준다 */
  function pointResultHTML(board, d, r) {
    var pts = Number(r.points) || 0;
    var user = me();
    var bal = user ? (Number(user.points) || 0) : 0;
    var price = Math.max(1000, Number(board.price) || 12000);
    var perFree = pts > 0 ? Math.max(1, Math.round(price / pts)) : 10;
    var pct = Math.min(100, Math.round(bal / price * 100));
    var need = Math.max(0, price - bal);
    var full = bal >= price;

    var sparks = '';
    for (var i = 0; i < 12; i++) {
      sparks += '<span class="pc-spark" style="left:' + (6 + Math.random() * 88).toFixed(1) + '%;top:' + (4 + Math.random() * 70).toFixed(1) +
        '%;font-size:' + (8 + Math.random() * 10).toFixed(0) + 'px;animation-delay:' + (Math.random() * 1.4).toFixed(2) + 's">✦</span>';
    }

    var wallet = user
      ? '<div class="pc-wallet"><span>보유 포인트</span><b>' + fmt(bal) + 'P</b></div>' +
        '<div class="pc-progress' + (full ? ' is-full' : '') + '">' +
          '<div class="pc-progress-head"><span>' + (full ? '한 판 무료 준비 완료!' : '한 판 무료까지 ' + fmt(need) + 'P') + '</span>' +
            '<b>' + fmt(bal) + ' / ' + fmt(price) + 'P</b></div>' +
          '<span class="pc-bar"><i style="width:' + pct + '%"></i></span>' +
          '<small>P상 ' + perFree + '번 = ' + fmt(price) + 'P = 한 판 무료</small>' +
        '</div>'
      : '<div class="pc-guest">로그인하지 않아 포인트가 계정에 쌓이지 않았어요. 로그인하고 뽑으면 적립된 포인트로 다음 뽑기가 가능합니다.</div>';

    return '<div class="result-wrap is-point">' +
      '<div class="pc-stage" id="revealStage">' +
        '<span class="pc-sparks" aria-hidden="true">' + sparks + '</span>' +
        '<div class="pc-coin" aria-hidden="true"><b>P</b><i>상</i></div>' +
        '<p class="pc-kicker">POINT PRIZE · P상</p>' +
        '<h3 class="pc-title">굿즈 포인트 <em>+' + fmt(pts) + 'P</em> 적립!</h3>' +
        '<p class="pc-desc">보유 포인트에 바로 적립됐어요!<br>모아서 다시 뽑기에 사용할 수 있어요.</p>' +
        wallet +
        '<p class="remaining-line">남은 번호 <b>' + fmt(r.remaining) + '</b>장' + (r.remaining === 0 ? ' · 이 판은 전량 소진되었습니다' : '') + '</p>' +
        lastOneBannerHTML(r, board) +
        '<p class="result-meta">' + h(board.title) + ' · ' + d.n + '번' + (r.demo ? ' · 체험 코드 사용' : (r.source === 'points' ? ' · 굿즈 포인트 사용' : '')) + '</p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-dark" data-action="close-modal">확인</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* =========================================================
     라스트원상(LAST ONE) — 판의 마지막 1장을 뽑은 사람에게 추가 지급되는 상
     ========================================================= */
  function lastOneOf(r, board) {
    if (!r) return null;
    var won = !!r.lastOneWon || String(r.grade || '').toUpperCase() === 'LAST' || !!r.isLast;
    if (!won) return null;
    return {
      label: r.lastOneLabel || (board && board.lastOneLabel) || '라스트원상',
      image: r.lastOneImage || (board && board.lastOneImage) || '',
      desc: r.lastOneDesc || (board && board.lastOneDesc) || '',
      name: r.lastOneWinnerName || ''
    };
  }

  function lastOneBannerHTML(r, board, opt) {
    var lo = lastOneOf(r, board);
    if (!lo) return '';
    opt = opt || {};
    var img = lo.image
      ? '<img src="' + h(coverSrc(lo.image)) + '" alt="' + h(lo.label) + '" loading="lazy" decoding="async">'
      : '<span class="lw-thumb-empty">★</span>';
    return '<div class="last-win' + (opt.big ? ' is-big' : '') + '">' +
        '<span class="lw-crown" aria-hidden="true">🏆</span>' +
        '<span class="lw-body">' +
          '<span class="lw-kicker">LAST ONE BONUS · 라스트원상 당첨</span>' +
          '<b class="lw-label">' + h(lo.label) + '</b>' +
          (lo.desc ? '<small>' + h(lo.desc) + '</small>' : '') +
          '<small class="lw-hold">' + (me() ? '내 보관함에 함께 담겼어요 · 배송 신청은 내 보관함에서' : '로그인 후 뽑았다면 보관함에 함께 담겼어요') + '</small>' +
        '</span>' +
        '<span class="lw-media">' + img + '</span>' +
      '</div>';
  }

  /* 라스트원 당첨 순간 한 번만 폭죽을 터뜨린다 (재렌더마다 반복하지 않도록) */
  function lastConfettiBurst(count) {
    if (!modalPanel) return;
    var host = document.createElement('div');
    host.className = 'last-burst';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML = confettiHTML(count || 34, {
      drop: 460, drift: 250, spread: .9,
      colors: ['#ffd51e', '#f5b800', '#fff3b0', '#ffffff', '#ff7ac8', '#8ee3ff']
    });
    modalPanel.appendChild(host);
    setTimeout(function () { if (host.parentNode) host.parentNode.removeChild(host); }, 4200);
  }

  function lastOneCelebrate(d) {
    if (!d || d.lastFxDone) return;
    var lo = lastOneOf(d.result, getBoard(d.boardId));
    if (!lo) return;
    d.lastFxDone = true;
    lastConfettiBurst(36);
    toast('🏆 라스트원상 당첨! 마지막 1장의 주인공입니다', 'ok');
  }

  function drawResultHTML(board, d) {
    var r = d.result || {};
    if (isPointPrize(r)) return pointResultHTML(board, d, r);
    var tier = tierOf(board, r.grade) || {};
    var img = r.tierImage || tier.image || '';
    var g = String(r.grade || '').toUpperCase();
    var lv = gradeLevel(g);
    var epic = lv >= 1;
    var gkey = g === 'LAST' ? 'last' : String(r.grade || '').toLowerCase();
    var label = r.tierLabel || tier.label || '';
    var desc = r.tierDesc || tier.desc || '';
    var gradeName = g === 'LAST' ? '라스트원' : r.grade + '상';

    var kicker = lv >= 3 ? (g === 'LAST' ? 'LAST ONE · FINAL' : 'GRAND PRIZE · FINAL')
      : (lv === 2 ? 'BIG HIT · GOLD' : (lv === 1 ? 'HIGH RANK · BLUE' : 'DRAW RESULT'));
    if (r.demo) kicker = '체험 결과 · ' + kicker;

    var confColors = lv >= 3
      ? ['#ffd51e', '#f5b800', '#ff3b30', '#12a87a', '#3d7bfd', '#a855f7', '#ffffff']
      : (lv === 2 ? ['#ffd51e', '#f5b800', '#ff7a1a', '#fff3b0', '#ffffff']
        : ['#6d5bff', '#3d7bfd', '#8ee3ff', '#c7b6ff', '#ffffff']);

    var hero = img
      ? '<img class="rv-figure" src="' + h(coverSrc(img)) + '" alt="' + h(label) + '">'
      : '<span class="rv-figure rv-figure-empty">' + h(g === 'LAST' ? 'L' : String(r.grade || '')) + '</span>';

    var emblem = '<span class="rv-emblem' + (g === 'LAST' ? ' is-last' : '') + '">' +
      (g === 'LAST' ? '<b>L</b><i>LAST</i>' : '<b>' + h(r.grade) + '</b><i>상</i>') + '</span>';

    var stage = epic
      ? '<div class="reveal-stage is-epic lv' + lv + ' grade-' + h(gkey) + '" id="revealStage">' +
          '<div class="rv-sky" aria-hidden="true"></div>' +
          '<div class="rv-beams" aria-hidden="true"></div>' +
          (lv >= 2 ? '<div class="rv-beams rv-beams-alt" aria-hidden="true"></div><div class="rv-spot" aria-hidden="true"></div>' : '') +
          '<div class="rv-rings" aria-hidden="true"><i></i><i></i>' + (lv >= 2 ? '<i></i>' : '') + '</div>' +
          '<div class="rv-sparks" aria-hidden="true">' + sparkleHTML(REVEAL_SPARK[lv]) + '</div>' +
          '<div class="rv-confetti" aria-hidden="true">' + confettiHTML(REVEAL_CONF[lv], { drop: 380 + lv * 40, drift: 150 + lv * 40, spread: .55 + lv * .1, colors: confColors }) + '</div>' +
          '<div class="rv-flash" aria-hidden="true"></div>' +
          (lv >= 2 ? '<div class="rv-boom" aria-hidden="true"></div>' : '') +
          '<div class="rv-hero">' +
            '<span class="rv-halo" aria-hidden="true"></span>' +
            '<span class="rv-burst" aria-hidden="true"></span>' +
            (lv >= 2 ? '<span class="rv-frame" aria-hidden="true"></span>' : '') +
            hero +
            emblem +
          '</div>' +
          '<p class="rv-kicker">' + h(kicker) + '</p>' +
          '<h3 class="rv-grade">' + h(gradeName) + ' <em>당첨!</em></h3>' +
          '<p class="rv-prize">' + h(label) + '</p>' +
          (desc ? '<p class="rv-desc">' + h(desc) + '</p>' : '') +
        '</div>'
      : '<div class="reveal-stage is-standard grade-' + h(gkey) + '" id="revealStage">' +
          '<div class="st-glow" aria-hidden="true"></div>' +
          '<div class="st-sparks" aria-hidden="true">' + sparkleHTML(REVEAL_SPARK[0], 'st-spark') + '</div>' +
          '<div class="st-confetti" aria-hidden="true">' + confettiHTML(8, { drop: 240, drift: 110, spread: .4 }) + '</div>' +
          '<div class="st-hero">' +
            '<div class="st-media">' +
              (img ? '<img src="' + h(coverSrc(img)) + '" alt="' + h(label) + '">' : '<span class="st-empty">' + h(String(r.grade || '')) + '</span>') +
              '<span class="rank-badge grade-' + h(gkey) + ' lg">' + h(g === 'LAST' ? 'LAST ONE' : r.grade + '상') + '</span>' +
            '</div>' +
          '</div>' +
          '<p class="result-kicker">' + h(kicker) + '</p>' +
          '<h3 class="st-grade">' + h(gradeName) + ' 당첨!</h3>' +
          '<p class="st-prize">' + h(label) + '</p>' +
          (desc ? '<p class="result-desc">' + h(desc) + '</p>' : '') +
        '</div>';

    var html = stage +
      (r.itemStatus === '포인트지급' || r.itemStatus === '포인트전환'
        ? '<span class="result-points">' + icon('gift') + ' 굿즈 포인트 ' + fmt(r.points) + 'P 지급</span>'
        : '') +
      (r.isLast || r.lastOneWon
        ? lastOneBannerHTML(r, board, { big: true })
        : '') +
      (r.itemStatus === '보관중' ? '<p class="result-hold">' + icon('box') + ' <b>내 보관함</b>에 담겼어요. 배송 신청은 내 보관함에서.</p>' : '') +
      (!me() && r.itemStatus !== '포인트지급' ? '<p class="result-meta">로그인하지 않아 보관함에 담기지 않았어요. 로그인 후 뽑으면 배송 신청까지 한 번에 됩니다.</p>' : '') +
      '<p class="remaining-line">남은 번호 <b>' + fmt(r.remaining) + '</b>장' + (r.remaining === 0 ? ' · 이 판은 전량 소진되었습니다' : '') + '</p>' +
      '<p class="result-meta">' + h(board.title) + ' · ' + d.n + '번' + (r.demo ? ' · 체험 코드 사용' : (r.source === 'points' ? ' · 굿즈 포인트 사용' : '')) + '</p>' +
      '<div class="modal-actions">' +
        (d.spotlight ? '<button class="btn btn-gold" data-action="reveal-back">티켓 더 열기</button>' : '') +
        (me() && r.itemStatus === '보관중' ? '<button class="btn btn-outline" data-action="go-my">내 보관함 보기</button>' : '') +
        (d.spotlight ? '' : '<button class="btn btn-dark" data-action="close-modal">확인</button>') +
      '</div>';

    return '<div class="result-wrap' + (epic ? ' is-epic lv' + lv : '') + '">' + html + '</div>';
  }

  function showTicketInfo(n) {
    var board = getBoard(ui.boardId);
    if (!board) return;
    var o = (board.opens || []).filter(function (x) { return x.n === n; })[0];
    if (!o) return;
    var tier = tierOf(board, o.grade) || { label: '', points: 0 };
    openModal('' +
      '<h2 class="modal-title" id="modalTitle">' + n + '번 · 판매 완료</h2>' +
      '<p class="modal-sub">이미 뽑힌 번호입니다. 결과는 변경되지 않아요.</p>' +
      '<div class="result-stage">' +
        (tier.image ? '<div class="result-media"><img src="' + h(coverSrc(tier.image)) + '" alt=""></div>' : '') +
        '<div class="result-badge" style="background:' + gradeColor(o.grade) + '">' + h(o.grade) + '</div>' +
        '<p class="result-grade">' + h(o.grade) + '상</p>' +
        '<p class="result-prize">' + h(tier.label || '') + '</p>' +
        (tier.desc ? '<p class="result-desc">' + h(tier.desc) + '</p>' : '') +
        (o.last ? '<div class="result-lastone"><span>LAST ONE BONUS</span><b>' + h(board.lastOneLabel || '라스트원상') + '</b></div>' : '') +
        '<p class="result-meta">' + formatDateTime(o.at) + ' · ' + h(o.name) + (o.demo ? ' · 체험' : '') + '</p>' +
        '<div class="modal-actions"><button class="btn btn-dark" data-action="close-modal">확인</button></div>' +
      '</div>');
  }

  /* =========================================================
     10. 내 보관함
     ========================================================= */
  function renderMy() {
    var gate = $('#myGate');
    var body = $('#myBody');
    var user = me();
    if (gate) gate.hidden = !!user;
    if (body) body.hidden = !user;
    if (!user) return;

    var coupons = availableCoupons();
    var items = (state.myDraws || []).filter(function (d) { return d.itemStatus && d.itemStatus !== '포인트지급'; });

    var el = $('#myProfile');
    if (el) {
      el.innerHTML = '<div class="profile-main">' +
          '<span class="profile-avatar">' + h((user.nickname || '쿠').charAt(0)) + '</span>' +
          '<div class="profile-info">' +
            '<h2>' + h(user.nickname) + ' 님 <span class="badge badge-live">회원</span></h2>' +
            '<p class="muted">' + h(user.email || '') + ' · ' + h(user.phone || '연락처 미등록') + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="profile-stats">' +
          '<div class="pstat"><span>보유 쿠폰</span><strong>' + fmt(coupons.length) + '장</strong></div>' +
          '<div class="pstat"><span>굿즈 포인트</span><strong id="myPointsStat">' + fmt(user.points || 0) + 'P</strong></div>' +
          '<div class="pstat"><span>뽑기</span><strong>' + fmt((state.myDraws || []).filter(function (d) { return String(d.grade || '').toUpperCase() !== 'LAST'; }).length) + '회</strong></div>' +
          '<div class="pstat"><span>보관중</span><strong>' + fmt((state.myDraws || []).filter(function (d) { return d.itemStatus === '보관중'; }).length) + '개</strong></div>' +
        '</div>' +
        '<div class="profile-actions">' +
          '<button class="btn btn-outline btn-sm" data-action="go-claim">구매확인 요청</button>' +
          '<button class="btn btn-ghost btn-sm" data-action="logout">로그아웃</button>' +
        '</div>';
    }

    var cc = $('#myCouponCount');
    if (cc) cc.textContent = coupons.length;
    var ic = $('#myItemCount');
    if (ic) ic.textContent = (state.myDraws || []).filter(function (d) { return d.itemStatus === '보관중'; }).length;

    $$('.my-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-my-tab') === ui.myTab);
    });
    $$('[data-my-panel]').forEach(function (p) {
      p.hidden = p.getAttribute('data-my-panel') !== ui.myTab;
    });

    renderMyCoupons();
    renderMyInventory();
    renderMyClaims();
    renderMyHistory();
  }

  function renderMyCoupons() {
    var el = $('#myCoupons');
    if (!el) return;
    var list = (state.myCoupons || []);
    if (!list.length) {
      el.innerHTML = '<div class="card empty"><span class="empty-icon">' + icon('ticket2') + '</span>' +
        '<p>아직 받은 쿠폰이 없어요.<br>스마트스토어에서 구매한 뒤 구매확인을 요청하면 뽑기권이 지급됩니다.</p>' +
        '<button class="btn btn-primary" data-action="go-claim">구매확인 요청하기</button></div>';
      return;
    }
    el.innerHTML = list.map(function (c) {
      var board = c.boardId ? getBoard(c.boardId) : null;
      var used = !!c.usedAt;
      var target = board ? '#/board/' + board.id : '#/board';
      return '<div class="coupon-card' + (used ? ' is-used' : '') + '">' +
        '<div class="coupon-cut" aria-hidden="true"></div>' +
        '<div class="coupon-body">' +
          '<span class="coupon-kind">' + (c.boardId ? h(board ? board.category : '판 전용') + ' 전용' : '모든 판 사용') + '</span>' +
          '<strong class="coupon-title">' + h(board ? board.title : '쿠지 뽑기권 1장') + '</strong>' +
          '<span class="coupon-note">' + h(c.note || '') + ' · ' + formatDate(c.grantedAt) + '</span>' +
        '</div>' +
        '<div class="coupon-side">' +
          (used
            ? '<span class="coupon-status is-used">사용 완료</span><span class="coupon-when">' + formatDateTime(c.usedAt) + '</span>'
            : '<span class="coupon-status">사용 가능</span>' +
              (board || true ? '<a class="btn btn-primary btn-sm" href="' + (board ? target : (state.boards.length ? '#/board/' + state.boards[0].id : '#/board')) + '">뽑으러 가기</a>' : '')) +
        '</div>' +
      '</div>';
    }).join('');
  }

  function statusLabel(s) {
    return { '보관중': '보관중', '배송신청': '배송 신청', '출고완료': '출고 완료', '포인트지급': '포인트 지급', '포인트전환': '포인트 전환' }[s] || s || '-';
  }
  function statusClass(s) {
    return { '보관중': 'st-hold', '배송신청': 'st-request', '출고완료': 'st-shipped', '포인트지급': 'st-point', '포인트전환': 'st-point' }[s] || '';
  }

  function renderMyInventory() {
    var el = $('#myInventory');
    if (!el) return;
    var head = shipNoticeBoxHTML('ship-note-panel');
    var items = (state.myDraws || []).filter(function (d) { return d.itemStatus !== '포인트지급'; });
    if (!items.length) {
      el.innerHTML = head + '<div class="card empty"><span class="empty-icon">' + icon('box') + '</span>' +
        '<p>보관 중인 상품이 없어요.<br>뽑기판에서 당첨되면 이곳에 담깁니다.</p>' +
        '<a class="btn btn-primary" href="#/board">뽑기판 열기</a></div>';
      return;
    }
    el.innerHTML = head + items.map(function (d) {
      var board = getBoard(d.boardId);
      var tier = board ? tierOf(board, d.grade) : null;
      var dl = (state.myDeliveries || []).filter(function (x) { return x.drawId === d.id; })[0];
      var canAct = d.itemStatus === '보관중';
      var isLastOne = String(d.grade || '').toUpperCase() === 'LAST' || !!d.lastOne;
      var points = tier ? Number(tier.points || 0) : 0;
      var boardLastImg = (isLastOne && board && board.lastOneImage) ? board.lastOneImage : '';
      return '<article class="inv-card card' + (isLastOne ? ' is-lastone' : '') + '">' +
        (isLastOne
          ? '<div class="inv-thumb is-last">' + (boardLastImg
              ? '<img src="' + h(coverSrc(boardLastImg)) + '" alt="' + h(d.tierLabel || '라스트원상') + '" loading="lazy">'
              : '<b>L</b><i>LAST</i>') + '</div>'
          : '<div class="inv-thumb" style="background:' + gradeColor(d.grade) + '">' + h(d.grade) + '</div>') +
        '<div class="inv-body">' +
          '<div class="inv-top"><span class="inv-board">' + h(board ? board.category : '') + ' · ' + h(board ? board.title : '삭제된 판') + '</span>' +
            '<span class="status-pill ' + statusClass(d.itemStatus) + '">' + statusLabel(d.itemStatus) + '</span></div>' +
          '<h3>' + (isLastOne ? '<span class="lw-tag">🏆 라스트원</span> ' : '') + h(d.tierLabel || (tier ? tier.label : '') || '당첨 상품') + '</h3>' +
          '<p class="inv-meta">' + drawNoLabel(d) + ' · ' + formatDateTime(d.at) + (isLastOne ? '' : (d.last ? ' · 마지막 1장' : '')) + '</p>' +
          (dl ? '<p class="inv-meta">' + icon('truck') + ' ' + h(dl.recipient) + ' · ' + h(dl.address) + '</p>' : '') +
          (dl && dl.tracking ? '<p class="inv-track">' + h(dl.carrier || '택배') + ' <b>' + h(dl.tracking) + '</b></p>' : '') +
          '<div class="inv-actions">' +
            (canAct ? '<button class="btn btn-primary btn-sm" data-action="open-delivery" data-id="' + h(d.id) + '">배송 신청</button>' : '') +
            (canAct && points > 0 ? '<button class="btn btn-outline btn-sm" data-action="convert-points" data-id="' + h(d.id) + '">포인트 전환 +' + fmt(points) + 'P</button>' : '') +
            (d.itemStatus === '배송신청' ? '<span class="muted small">출고 준비 중이에요</span>' : '') +
            (d.itemStatus === '출고완료' ? '<span class="muted small">배송이 시작되었어요</span>' : '') +
            (d.itemStatus === '포인트전환' ? '<span class="muted small">' + fmt(d.points) + 'P로 전환 완료</span>' : '') +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  function renderMyClaims() {
    var sel = $('#claimBoardSelect');
    if (sel) {
      var open = state.boards.filter(function (b) { return b.status === 'open'; });
      sel.innerHTML = open.length
        ? open.map(function (b) { return '<option value="' + h(b.id) + '">' + h(b.title) + ' · ' + won(b.price) + '</option>'; }).join('')
        : '<option value="">진행 중인 판이 없어요</option>';
    }
    var list = $('#myClaimList');
    if (!list) return;
    var rows = state.myClaims || [];
    if (!rows.length) {
      list.innerHTML = '<div class="card empty"><p>아직 구매확인 요청이 없어요.<br>왼쪽에서 주문 정보를 남겨 주세요.</p></div>';
      return;
    }
    list.innerHTML = '<h3 class="claim-history-title">내 요청 내역</h3>' + rows.map(function (c) {
      var board = getBoard(c.boardId);
      var cls = c.status === 'approved' ? 'ok' : c.status === 'rejected' ? 'no' : 'wait';
      var label = c.status === 'approved' ? '승인 완료 · ' + c.granted + '장 지급' : c.status === 'rejected' ? '반려' : '확인 대기 중';
      return '<div class="claim-card ' + cls + '">' +
        '<div class="claim-card-head"><span class="claim-status ' + cls + '">' + h(label) + '</span>' +
          '<span class="muted small">' + formatDateTime(c.at) + '</span></div>' +
        '<b>' + h(board ? board.title : '판 미지정') + '</b>' +
        '<p class="muted small">' + h(c.channel) + ' · ' + h(c.orderNo) + ' · ' + fmt(c.qty) + '장 · ' + won(c.amount) + '</p>' +
        (c.memo ? '<p class="claim-memo">' + h(c.memo) + '</p>' : '') +
      '</div>';
    }).join('');
  }

  function renderMyHistory() {
    var tbody = $('#myHistoryTable tbody');
    var empty = $('#myHistoryEmpty');
    var table = $('#myHistoryTable');
    if (!tbody) return;
    var rows = (state.myDraws || []).slice();
    if (!rows.length) {
      tbody.innerHTML = '';
      if (empty) empty.hidden = false;
      if (table) table.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (table) table.hidden = false;
    tbody.innerHTML = rows.map(function (d) {
      var board = getBoard(d.boardId);
      return '<tr>' +
        '<td class="num">' + formatDateTime(d.at) + '</td>' +
        '<td>' + (board ? '<a href="#/board/' + h(board.id) + '" class="inline-link">' + h(board.title) + '</a>' : '삭제된 판') + '</td>' +
        '<td class="num">' + drawNoLabel(d) + '</td>' +
        '<td><span class="grade-badge' + (String(d.grade || '').toUpperCase() === 'LAST' ? ' grade-last' : '') + '" style="background:' + gradeColor(d.grade) + ';width:28px;height:28px;font-size:12px">' + h(gradeLetter(d.grade)) + '</span></td>' +
        '<td>' + h(d.tierLabel || '') + (d.last || d.lastOne ? ' <span class="badge" style="font-size:10px">' + icon('crown') + ' 라스트원</span>' : '') + '</td>' +
        '<td><span class="status-pill ' + statusClass(d.itemStatus) + '">' + statusLabel(d.itemStatus) + '</span></td>' +
      '</tr>';
    }).join('');
  }

  /* =========================================================
     11. 당첨 내역
     ========================================================= */
  function renderWinners() {
    var select = $('#winnersBoardFilter');
    if (select) {
      var current = ui.winnersBoardId;
      select.innerHTML = '<option value="all">전체 판</option>' + state.boards.map(function (b) {
        return '<option value="' + h(b.id) + '">' + h(b.title) + '</option>';
      }).join('');
      if (!state.boards.some(function (b) { return b.id === current; })) current = 'all';
      select.value = current;
      ui.winnersBoardId = current;
    }

    var rows = (state.myDraws || []).filter(function (d) {
      return ui.winnersBoardId === 'all' || d.boardId === ui.winnersBoardId;
    });

    var stats = $('#winnersStats');
    if (stats) {
      var byGrade = {};
      rows.forEach(function (r) { byGrade[r.grade] = (byGrade[r.grade] || 0) + 1; });
      var grades = [];
      state.boards.forEach(function (b) {
        b.tiers.forEach(function (t) { if (grades.indexOf(t.grade) === -1) grades.push(t.grade); });
      });
      grades.sort();
      if (!grades.length) grades = GRADES.slice(0, 5);
      stats.innerHTML = '<div class="stat is-highlight"><span>총 뽑은 수</span><strong>' + fmt(rows.length) + '장</strong></div>' +
        grades.map(function (g) {
          return '<div class="stat"><span>' + g + '상</span><strong>' + fmt(byGrade[g] || 0) + '개</strong></div>';
        }).join('') +
        '<div class="stat"><span>라스트원</span><strong>' + fmt(rows.filter(function (r) { return r.lastOne || r.last; }).length) + '개</strong></div>';
    }

    var tbody = $('#winnersTable tbody');
    var empty = $('#winnersEmpty');
    var table = $('#winnersTable');
    if (tbody) {
      if (!rows.length) {
        tbody.innerHTML = '';
        if (empty) empty.hidden = false;
        if (table) table.hidden = true;
      } else {
        if (empty) empty.hidden = true;
        if (table) table.hidden = false;
        tbody.innerHTML = rows.map(function (r) {
          var board = getBoard(r.boardId);
          return '<tr>' +
            '<td class="num">' + formatDateTime(r.at) + '</td>' +
            '<td>' + (board ? '<a href="#/board/' + h(board.id) + '" class="inline-link">' + h(board.title) + '</a>' : '삭제된 판') + '</td>' +
            '<td class="num">' + drawNoLabel(r) + '</td>' +
            '<td><span class="grade-badge' + (String(r.grade || '').toUpperCase() === 'LAST' ? ' grade-last' : '') + '" style="background:' + gradeColor(r.grade) + ';width:28px;height:28px;font-size:12px">' + h(gradeLetter(r.grade)) + '</span></td>' +
            '<td>' + h(r.tierLabel || '') + (r.last || r.lastOne ? ' <span class="badge" style="font-size:10px">' + icon('crown') + ' 라스트원</span>' : '') + '</td>' +
            '<td><span class="status-pill ' + statusClass(r.itemStatus) + '">' + statusLabel(r.itemStatus) + '</span></td>' +
          '</tr>';
        }).join('');
      }
    }

    var notice = $('#winnersNotice');
    if (notice) {
      notice.innerHTML = '<h3>당첨 상품 수령 안내</h3><ul>' +
        '<li>당첨 상품은 <b>내 보관함</b>에 보관됩니다. 배송 신청 시 입력한 주소로 발송됩니다.</li>' +
        '<li>배송 신청 후에는 포인트 전환으로 바꿀 수 없어요.</li>' +
        '<li>굿즈 포인트는 하위 등급 당첨 시 자동 지급되며, 상품을 포인트로 전환해 받을 수도 있습니다.</li>' +
        '<li>결과에 문제가 있다고 느껴지면 공정성 검증 페이지에서 봉인 해시를 확인해 주세요.</li>' +
        '</ul>';
    }
  }

  /* =========================================================
     12. 공정성 검증
     ========================================================= */
  function fairnessNoticeHTML() {
    return '<h2>확률 · 이용 안내</h2>' +
      '<h3>1. 무작위 추첨 상품</h3>' +
      '<p>쿠지킹의 쿠지판은 판매 전 공개된 등급별 수량과 확률에 따라 번호별 결과가 무작위로 배정되는 상품입니다. 배정 결과는 판이 열리기 전 SHA-256 해시로 봉인되며, 결제·개봉 과정에서 변경되지 않습니다.</p>' +
      '<h3>2. 청약철회 제한</h3>' +
      '<p>「전자상거래 등에서의 소비자보호에 관한 법률」 제17조 제2항 제2호에 따라, 소비자의 사용 또는 일부 소비로 재판매가 곤란한 경우 청약철회가 제한됩니다. 교환 코드를 사용해 개봉한 경우가 이에 해당하며, 개봉 전에는 주문 취소가 가능합니다.</p>' +
      '<h3>3. 쿠폰(뽑기권)과 교환 코드</h3>' +
      '<p>뽑기권은 구매확인 승인 후 회원 계정에 지급되는 1회용 쿠폰입니다. 교환 코드는 구매 1건당 1개가 발급되는 1회용 코드입니다. 모두 사용 후에는 재사용할 수 없습니다.</p>' +
      '<h3>4. 등급 및 상품</h3>' +
      '<p>등급별 상품 구성과 수량은 판마다 다르며, 판 화면에 공개됩니다. 하위 등급은 굿즈 포인트로 대체 지급될 수 있습니다. 라스트원상은 확률 추첨이 아니라 판의 마지막 1장을 뽑은 분께 추가로 지급되는 상입니다.</p>' +
      '<h3>5. 상품 수령</h3>' +
      '<p>당첨 상품은 내 보관함에서 배송 신청한 주소로 발송됩니다. 주소 오류로 인한 반송은 재발송 비용이 발생할 수 있습니다.</p>' +
      '<h3>6. 배송비 · 합배송</h3>' +
      '<p><span data-ship-notice>' + h(shippingNotice()) + '</span></p>' +
      '<p class="fair-hint">배송비·합배송·교환 코드 문의는 카카오톡 채널 1:1 상담으로 받고 있습니다.</p>' +
      kakaoPillHTML('kakao-pill-sm') +
      '<h3>7. 미성년자 이용</h3>' +
      '<p>미성년자는 법정대리인의 동의를 받은 후 이용할 수 있습니다. 만 14세 미만은 이용할 수 없습니다.</p>' +
      '<h3>8. 결과 검증</h3>' +
      '<p>판 종료 후 공개되는 시드와 이 페이지의 검증 도구로 누구나 결과를 다시 계산해 볼 수 있습니다. 계산 규칙은 아래와 같습니다.</p>' +
      '<p style="font-family:var(--font-mono);font-size:11.5px;background:#fff;border:1px solid var(--line-strong);border-radius:8px;padding:10px;margin-top:6px">' +
      'for n in 1..N: h(n) = SHA-256(seed + ":" + n)<br>' +
      'sort tickets by h(n) ascending<br>' +
      'assign prizes in order: A상 → B상 → … (수량만큼)' +
      '</p>' +
      '<p class="muted" style="margin-top:10px;font-size:11.5px">※ 본 안내 문구는 판매 개시 전 최종 검토를 거쳐 확정됩니다.</p>';
  }

  function renderFairness() {
    var board = getBoard(ui.fairnessBoardId) || state.boards[0];
    var select = $('#fairBoardSelect');
    if (!board) return;
    ui.fairnessBoardId = board.id;
    if (select) {
      select.innerHTML = state.boards.map(function (b) {
        return '<option value="' + h(b.id) + '">' + h(b.title) + '</option>';
      }).join('');
      select.value = board.id;
    }
    var meta = $('#fairBoardMeta');
    if (meta) meta.textContent = fmt(board.tickets) + '장 · 판매 ' + fmt(openedCount(board)) + '장 · ' + (board.status === 'open' ? '판매 중' : '종료');

    var hashEl = $('#fairHash');
    if (hashEl) hashEl.textContent = board.seedHash || '—';

    var revealed = isRevealed(board);
    var badge = $('#fairSealBadge');
    if (badge) {
      badge.textContent = revealed ? '시드 공개 완료' : '봉인 중';
      badge.className = 'badge ' + (revealed ? 'badge-live' : '');
    }
    var hint = $('#fairSealHint');
    if (hint) {
      hint.textContent = revealed
        ? '판이 종료되어 시드가 공개되었습니다. 아래 시드로 해시와 번호별 배치를 직접 검증해 보세요.'
        : '판매 중에는 시드가 공개되지 않습니다. 위 해시는 판매 전에 공개된 값이며, 판 종료 후 시드가 공개됩니다.';
    }
    var seedBox = $('#fairSeedReveal');
    if (seedBox) {
      seedBox.hidden = !revealed;
      var seedEl = $('#fairSeed');
      if (seedEl) seedEl.textContent = revealed ? board.seed : '—';
    }
    var metaList = $('#fairMeta');
    if (metaList) {
      metaList.innerHTML =
        '<dt>봉인 시각</dt><dd>' + formatDateTime(board.sealedAt || board.createdAt) + '</dd>' +
        '<dt>판매 상태</dt><dd>' + (board.status === 'open' ? '판매 중' : '종료') + '</dd>' +
        '<dt>전체 장수</dt><dd>' + fmt(board.tickets) + '장</dd>' +
        '<dt>판매</dt><dd>' + fmt(openedCount(board)) + '장</dd>' +
        '<dt>남은 번호</dt><dd>' + fmt(remaining(board)) + '장</dd>';
    }
    var probBody = $('#probTable tbody');
    if (probBody) {
      var maxPct = Math.max.apply(null, board.tiers.map(function (t) { return t.count / board.tickets * 100; }).concat([1]));
      probBody.innerHTML = board.tiers.map(function (t) {
        var pct = t.count / board.tickets * 100;
        return '<tr>' +
          '<td><span class="grade-badge" style="background:' + gradeColor(t.grade) + ';width:28px;height:28px;font-size:12px">' + h(t.grade) + '</span></td>' +
          '<td>' + h(t.label) + '</td>' +
          '<td class="num">' + fmt(t.count) + '개</td>' +
          '<td><span class="prob-bar"><span class="prob-bar-track"><span class="prob-bar-fill" style="width:' + Math.max(4, pct / maxPct * 100) + '%"></span></span>' +
          '<b style="font-variant-numeric:tabular-nums">' + pct.toFixed(1).replace(/\.0$/, '') + '%</b></span></td>' +
        '</tr>';
      }).join('');
    }
    var totalEl = $('#fairProbTotal');
    if (totalEl) totalEl.textContent = '합계 ' + fmt(tierSum(board)) + ' / ' + fmt(board.tickets) + '장';
    var legal = $('#fairnessNotice');
    if (legal) legal.innerHTML = fairnessNoticeHTML();
  }

  function verifyHash(seed) {
    var board = getBoard(ui.fairnessBoardId) || state.boards[0];
    var box = $('#verifyResult');
    if (!box || !board) return;
    var value = String(seed || '').trim();
    if (!value) {
      box.hidden = false;
      box.className = 'verify-result fail';
      box.innerHTML = '<div class="vr-title">' + icon('alert') + ' 시드를 입력해 주세요</div>';
      return;
    }
    sha256Hex(value).then(function (computed) {
      var match = computed === board.seedHash;
      box.hidden = false;
      box.className = 'verify-result ' + (match ? 'ok' : 'fail');
      box.innerHTML = '<div class="vr-title">' + icon(match ? 'check' : 'x') + ' ' + (match ? '봉인 해시와 일치합니다' : '봉인 해시와 일치하지 않습니다') + '</div>' +
        '<span class="muted">계산된 해시</span>' +
        '<code data-role="computed">' + h(computed) + '</code>' +
        '<span class="muted">공개된 봉인 해시</span>' +
        '<code>' + h(board.seedHash) + '</code>';
    });
  }

  function verifyTicket(seed, ticketNo) {
    var board = getBoard(ui.fairnessBoardId) || state.boards[0];
    var box = $('#verifyTicketResult');
    if (!box || !board) return;
    var value = String(seed || '').trim();
    var n = Number(ticketNo);
    box.hidden = false;
    if (!value) {
      box.className = 'verify-result fail';
      box.innerHTML = '<div class="vr-title">' + icon('alert') + ' 시드를 입력해 주세요</div>';
      return;
    }
    if (!Number.isInteger(n) || n < 1 || n > board.tickets) {
      box.className = 'verify-result fail';
      box.innerHTML = '<div class="vr-title">' + icon('alert') + ' 번호를 확인해 주세요</div><p>1 ~ ' + fmt(board.tickets) + ' 사이의 번호를 입력해 주세요.</p>';
      return;
    }
    computeMapping(value, board.tickets, board.tiers).then(function (map) {
      var grade = map[n];
      var tier = tierOf(board, grade) || { label: '', points: 0 };
      var recorded = (board.opens || []).filter(function (o) { return o.n === n; })[0];
      var agreement = recorded
        ? (recorded.grade === grade ? '기록된 결과와 일치합니다.' : '기록된 결과(' + recorded.grade + '상)와 다릅니다.')
        : '아직 판매되지 않은 번호입니다.';
      box.className = 'verify-result ' + (recorded && recorded.grade !== grade ? 'fail' : 'ok');
      box.innerHTML = '<div class="vr-title">' + n + '번 → ' + h(grade) + '상</div>' +
        '<p>' + h(tier.label || '') + (tier.points ? ' · ' + (tier.pointOnly ? '굿즈 포인트 ' + fmt(tier.points) + 'P' : '포인트 전환 ' + fmt(tier.points) + 'P') : '') + '</p>' +
        '<p class="muted" style="margin-top:6px">' + h(agreement) + '</p>';
    });
  }

  /* =========================================================
     13. 관리자
     ========================================================= */
  function isAdminUnlocked() {
    if (Backend.mode === 'supabase') return !!(state.me && state.me.isAdmin);
    return !!ui.adminUnlocked;
  }

  function renderAdmin() {
    var gate = $('#adminGate');
    var panel = $('#adminPanel');
    if (!gate || !panel) return;

    if (Backend.mode === 'supabase') {
      if (!state.me) {
        gate.hidden = false;
        panel.hidden = true;
        gate.innerHTML = '<span class="gate-icon">' + icon('alert') + '</span>' +
          '<h2>관리자 로그인이 필요합니다</h2>' +
          '<p class="muted">Supabase 모드에서는 관리자 계정으로 로그인하면 바로 관리자 화면이 열립니다.</p>' +
          '<div class="btn-row" style="justify-content:center"><button class="btn btn-primary" data-action="open-auth">로그인</button></div>';
        return;
      }
      if (!state.me.isAdmin) {
        gate.hidden = false;
        panel.hidden = true;
        gate.innerHTML = '<span class="gate-icon">' + icon('alert') + '</span>' +
          '<h2>관리자 권한이 없습니다</h2>' +
          '<p class="muted">' + h(state.me.email || '') + ' 계정에는 관리자 권한이 없어요.<br>' +
          'Supabase SQL Editor 에서 <code>update public.profiles set is_admin = true where email = \'' + h(state.me.email || '') + '\';</code> 를 실행해 주세요.</p>';
        return;
      }
      gate.hidden = true;
      panel.hidden = false;
    } else {
      if (!ui.adminUnlocked) {
        gate.hidden = false;
        panel.hidden = true;
        if (!gate.innerHTML || !gate.querySelector('form')) {
          gate.innerHTML = '<span class="gate-icon">' + icon('alert') + '</span>' +
            '<h2>PIN을 입력해 주세요</h2>' +
            '<p class="muted">초기 PIN은 <code>0000</code>입니다.</p>' +
            '<form class="pin-form" data-form="admin-login" novalidate>' +
            '<input id="adminPin" name="pin" class="pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="••••">' +
            '<button class="btn btn-primary" type="submit">들어가기</button></form>' +
            '<p class="form-error" id="adminPinError" role="alert"></p>';
        }
        var hint = $('#adminPinHint');
        if (hint) hint.hidden = !!state.settings.pinChanged;
        return;
      }
      gate.hidden = true;
      panel.hidden = false;
    }

    renderAdminTabs();
    ensureAdminData();
  }

  function renderAdminTabs() {
    $$('.admin-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-admin-tab') === ui.adminTab);
    });
    $$('.admin-tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-admin-panel') === ui.adminTab);
    });

    if (ui.adminTab === 'members') renderMembersTab();
    if (ui.adminTab === 'boards') renderBoardsTab();
    if (ui.adminTab === 'shipping') renderShippingTab();
    if (ui.adminTab === 'codes') renderCodesTab();
    if (ui.adminTab === 'settings') renderSettingsTab();
  }

  /* Supabase 모드에서는 관리자 데이터(회원·요청·배송·코드)를 한 번 받아옵니다. */
  function ensureAdminData(force) {
    if (Backend.mode !== 'supabase' || ui.adminBusy) return;
    ui.adminBusy = true;
    if (force) {
      state.adminLoaded = false;
      state.adminError = null;
    }
    renderAdminTabs();
    Backend.loadAdmin().then(function () {
      ui.adminBusy = false;
      renderAdminTabs();
    }).catch(function (e) {
      ui.adminBusy = false;
      state.adminLoaded = true;
      state.adminError = errMsg(e);
      renderAdminTabs();
      toast(errMsg(e), 'err');
    });
  }

  function renderMembersTab() {
    var stats = $('#adminStats');
    var members = state.adminMembers || [];
    var claims = state.adminClaims || [];
    var pending = claims.filter(function (c) { return c.status === 'pending'; }).length;
    var couponsLeft = members.reduce(function (s, m) { return s + (m.couponCount || 0); }, 0);
    var deliveries = (state.adminDeliveries || []).filter(function (d) { return d.status !== '출고완료'; }).length;
    var notLoaded = Backend.mode === 'supabase' && !state.adminLoaded;
    if (stats) {
      stats.innerHTML = '<div class="astat"><span>회원</span><strong>' + (notLoaded ? '…' : fmt(members.length) + '명') + '</strong></div>' +
        '<div class="astat is-alert"><span>대기 중 구매확인</span><strong>' + (notLoaded ? '…' : fmt(pending) + '건') + '</strong></div>' +
        '<div class="astat"><span>미사용 쿠폰</span><strong>' + (notLoaded ? '…' : fmt(couponsLeft) + '장') + '</strong></div>' +
        '<div class="astat"><span>출고 대기</span><strong>' + (notLoaded ? '…' : fmt(deliveries) + '건') + '</strong></div>';
    }

    var tbody = $('#claimsTable tbody');
    var empty = $('#claimsEmpty');
    var table = $('#claimsTable');
    if (tbody) {
      if (!claims.length) {
        tbody.innerHTML = '';
        if (empty) empty.hidden = false;
        if (table) table.hidden = true;
      } else {
        if (empty) empty.hidden = true;
        if (table) table.hidden = false;
        tbody.innerHTML = claims.map(function (c) {
          var board = getBoard(c.boardId);
          var st = c.status === 'approved' ? '<span class="badge" style="background:#d9ffe9">승인 ' + (c.granted || 0) + '장</span>'
            : c.status === 'rejected' ? '<span class="badge badge-closed">반려</span>'
            : '<span class="badge" style="background:#fff3ba">대기</span>';
          return '<tr>' +
            '<td><b>' + h(c.nickname || '회원') + '</b><br><span class="muted small">' + h(c.phone || '') + '</span></td>' +
            '<td>' + h(board ? board.title : '판 미지정') + '</td>' +
            '<td>' + h(c.channel) + ' · <span class="code-cell">' + h(c.orderNo) + '</span></td>' +
            '<td class="num">' + fmt(c.qty) + '장</td>' +
            '<td class="num">' + won(c.amount) + '</td>' +
            '<td>' + st + '<br><span class="muted small">' + formatDateTime(c.at) + '</span></td>' +
            '<td style="white-space:nowrap;text-align:right">' +
              (c.status === 'pending'
                ? '<button class="btn btn-primary btn-sm" data-action="claim-approve" data-id="' + h(c.id) + '">승인 · 지급</button> ' +
                  '<button class="btn btn-danger-ghost btn-sm" data-action="claim-reject" data-id="' + h(c.id) + '">반려</button>'
                : (c.status === 'approved' && Number(c.granted || 0) > 0
                    ? '<button class="btn btn-danger-ghost btn-sm" data-action="revoke-open-claim" data-id="' + h(c.id) + '">쿠폰 회수</button>'
                    : '—')) +
            '</td>' +
          '</tr>';
        }).join('');
      }
    }

    var q = (ui.memberQuery || '').toLowerCase();
    var rows = members.filter(function (m) {
      if (!q) return true;
      return (m.nickname || '').toLowerCase().indexOf(q) !== -1 ||
        (m.email || '').toLowerCase().indexOf(q) !== -1 ||
        String(m.phone || '').replace(/[^0-9]/g, '').indexOf(q.replace(/[^0-9]/g, '')) !== -1;
    });
    var mb = $('#membersTable tbody');
    var mEmpty = $('#membersEmpty');
    var mTable = $('#membersTable');
    if (mEmpty) mEmpty.innerHTML = '<p>조건에 맞는 회원이 없어요.</p>';
    if (mb) {
      if (notLoaded) {
        mb.innerHTML = '';
        if (mTable) mTable.hidden = true;
        if (mEmpty) {
          mEmpty.hidden = false;
          mEmpty.innerHTML = '<p>회원 목록을 불러오는 중이에요…</p>';
        }
        return;
      }
      if (state.adminError && !rows.length) {
        mb.innerHTML = '';
        if (mTable) mTable.hidden = true;
        if (mEmpty) {
          mEmpty.hidden = false;
          mEmpty.innerHTML = '<p>회원 목록을 불러오지 못했어요.</p>' +
            '<p class="small muted">' + h(state.adminError) + '</p>' +
            '<button type="button" class="btn btn-outline btn-sm" data-action="admin-reload">다시 불러오기</button>';
        }
        return;
      }
      if (!rows.length) {
        mb.innerHTML = '';
        if (mEmpty) mEmpty.hidden = false;
        if (mTable) mTable.hidden = true;
      } else {
        if (mEmpty) mEmpty.hidden = true;
        if (mTable) mTable.hidden = false;
        mb.innerHTML = rows.map(function (m) {
          return '<tr>' +
            '<td><b>' + h(m.nickname) + '</b>' + (m.isAdmin ? ' <span class="badge" style="font-size:10px">관리자</span>' : '') + '<br><span class="muted small">' + h(m.email || '') + '</span></td>' +
            '<td class="num">' + h(m.phone || '-') + '</td>' +
            '<td class="num"><b>' + fmt(m.couponCount || 0) + '</b>장</td>' +
            '<td class="num">' + fmt(m.points || 0) + 'P</td>' +
            '<td class="num">' + fmt(m.drawCount || 0) + '회</td>' +
            '<td class="num">' + formatDate(m.createdAt) + '</td>' +
            '<td style="text-align:right;white-space:nowrap"><button class="btn btn-outline btn-sm" data-action="grant-open" data-id="' + h(m.id) + '">쿠폰 지급</button>' +
              (Number(m.couponCount || 0) > 0
                ? ' <button class="btn btn-danger-ghost btn-sm" data-action="revoke-open" data-id="' + h(m.id) + '">쿠폰 회수</button>'
                : '') +
            '</td>' +
          '</tr>';
        }).join('');
      }
    }
  }

  function renderBoardsTab() {
    var list = $('#adminBoardList');
    if (!list) return;
    if (!state.boards.length) {
      list.innerHTML = '<div class="empty"><p>아직 만든 판이 없어요.<br><span class="muted small">+ 새 판 만들기로 첫 판을 만들어 보세요.</span></p>' +
        '<div class="btn-row" style="justify-content:center;margin-top:10px"><button type="button" class="btn btn-primary btn-sm" data-action="new-board">+ 새 판 만들기</button></div></div>';
      return;
    }
    list.innerHTML = state.boards.map(function (b) {
      return '<div class="admin-board">' +
        '<div class="admin-board-thumb ' + categoryClass(b.category) + '">' +
          (b.cover ? '<img src="' + h(b.cover) + '" alt="">' : '<span>' + h(b.category) + '</span>') +
        '</div>' +
        '<div class="admin-board-info">' +
          '<h3>' + h(b.title) + '</h3>' +
          '<p>' + h(b.category) + ' · ' + won(b.price) + ' · ' + fmt(b.tickets) + '장 · 판매 ' + fmt(openedCount(b)) + '/' + fmt(b.tickets) +
          ' · ' + (b.status === 'open' ? '판매 중' : '종료') + '</p>' +
          '<p style="font-family:var(--font-mono);font-size:11px;word-break:break-all">hash ' + h(String(b.seedHash || '').slice(0, 24)) + '…</p>' +
        '</div>' +
        '<div class="admin-board-actions">' +
          '<button class="btn btn-outline btn-sm" data-action="edit-board" data-id="' + h(b.id) + '">수정</button>' +
          '<button class="btn btn-outline btn-sm" data-action="duplicate-board" data-id="' + h(b.id) + '">📋 복제</button>' +
          '<button class="btn btn-outline btn-sm" data-action="reset-board" data-id="' + h(b.id) + '">🔄 판매 초기화</button>' +
          '<button class="btn btn-danger-ghost btn-sm" data-action="delete-board" data-id="' + h(b.id) + '">삭제</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderShippingTab() {
    var el = $('#deliveryList');
    if (!el) return;
    var rows = (state.adminDeliveries || []).slice().sort(function (a, b) {
      if (a.status === b.status) return new Date(b.requestedAt) - new Date(a.requestedAt);
      return a.status === '출고완료' ? 1 : -1;
    });
    if (!rows.length) {
      el.innerHTML = '<div class="empty"><p>배송 요청이 없어요. 회원이 보관함에서 배송 신청하면 이곳에 표시됩니다.</p></div>';
      return;
    }
    el.innerHTML = rows.map(function (d) {
      var board = getBoard(d.boardId);
      var done = d.status === '출고완료';
      return '<article class="delivery-card' + (done ? ' is-done' : '') + '">' +
        '<div class="delivery-head">' +
          '<span class="status-pill ' + statusClass(done ? '출고완료' : '배송신청') + '">' + (done ? '출고 완료' : '출고 대기') + '</span>' +
          '<b>' + h(d.itemLabel || '당첨 상품') + '</b>' +
          (d.grade ? '<span class="grade-badge sm' + (String(d.grade).toUpperCase() === 'LAST' ? ' grade-last' : '') + '" style="background:' + gradeColor(d.grade) + '">' + h(String(d.grade).toUpperCase() === 'LAST' ? 'LAST' : d.grade) + '</span>' : '') +
          '<span class="muted small">' + h(board ? board.category : '') + ' · ' + formatDateTime(d.requestedAt) + '</span>' +
        '</div>' +
        '<div class="delivery-body">' +
          '<div><span class="muted small">받는 사람</span><p><b>' + h(d.recipient) + '</b> · ' + h(d.phone) + '</p></div>' +
          '<div><span class="muted small">주소</span><p>' + (d.postcode ? '(' + h(d.postcode) + ') ' : '') + h(d.address) + '</p></div>' +
          (d.memo ? '<div><span class="muted small">요청사항</span><p>' + h(d.memo) + '</p></div>' : '') +
          '<div><span class="muted small">신청자</span><p>' + h(d.nickname || '') + '</p></div>' +
        '</div>' +
        (done
          ? '<p class="delivery-track">' + icon('truck') + ' ' + h(d.carrier || '택배') + ' <b>' + h(d.tracking || '') + '</b> · ' + formatDateTime(d.shippedAt) + '</p>'
          : '<form class="delivery-form" data-form="ship" data-id="' + h(d.id) + '">' +
              '<select name="carrier" class="input input-sm">' +
                ['CJ대한통운', '우체국택배', '한진택배', '롯데택배', '로젠택배', 'GS25 편의점택배'].map(function (c) {
                  return '<option>' + c + '</option>';
                }).join('') +
              '</select>' +
              '<input name="tracking" class="input input-sm" type="text" placeholder="운송장 번호" required>' +
              '<button class="btn btn-primary btn-sm" type="submit">출고 완료</button>' +
            '</form>') +
      '</article>';
    }).join('');
  }

  function renderCodesTab() {
    var genBoard = $('#genBoard');
    if (genBoard) {
      var prev = genBoard.value;
      genBoard.innerHTML = '<option value="">모든 판</option>' + state.boards.map(function (b) {
        return '<option value="' + h(b.id) + '">' + h(b.title) + '</option>';
      }).join('');
      genBoard.value = prev && (prev === '' || getBoard(prev)) ? prev : (ui.boardId || '');
    }
    var box = $('#genResult');
    if (box) {
      if (!ui.lastGen) box.hidden = true;
      else {
        box.hidden = false;
        box.innerHTML = '<div class="gen-result-head"><strong>' + fmt(ui.lastGen.codes.length) + '개 코드 발급 완료</strong>' +
          '<span class="muted" style="font-size:12px">' + formatDateTime(ui.lastGen.at) + '</span></div>' +
          '<div class="code-list">' + ui.lastGen.codes.map(function (c) {
            return '<span class="code-item">' + h(c) + '<button data-action="copy-code" data-code="' + h(c) + '" aria-label="' + h(c) + ' 복사">' + icon('copy') + '</button></span>';
          }).join('') + '</div>' +
          '<div class="btn-row tight">' +
            '<button class="btn btn-outline btn-sm" data-action="copy-gen-all">전체 복사</button>' +
            '<button class="btn btn-outline btn-sm" data-action="copy-gen-sms">문자 발송용 복사</button>' +
            '<button class="btn btn-outline btn-sm" data-action="download-gen">CSV 다운로드</button>' +
          '</div>';
      }
    }
    renderCodesTable();
  }

  function renderCodesTable() {
    var tbody = $('#codesTable tbody');
    var empty = $('#codesEmpty');
    var table = $('#codesTable');
    if (!tbody) return;
    var filter = ($('#codeFilter') || {}).value || 'all';
    var q = normalizeCode(($('#codeSearch') || {}).value || '');
    var rows = state.codes.slice().sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    rows = rows.filter(function (c) {
      if (filter === 'unused' && c.usedAt) return false;
      if (filter === 'used' && !c.usedAt) return false;
      if (q && normalizeCode(c.code).indexOf(q) === -1) return false;
      return true;
    });
    if (!rows.length) {
      tbody.innerHTML = '';
      if (empty) { empty.hidden = false; empty.querySelector('p').textContent = state.codes.length ? '조건에 맞는 코드가 없어요.' : '발급된 코드가 없어요. 위에서 바로 발급해 보세요.'; }
      if (table) table.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (table) table.hidden = false;
    tbody.innerHTML = rows.map(function (c) {
      var b = c.boardId ? getBoard(c.boardId) : null;
      var status = c.usedAt ? '<span class="badge badge-closed">사용</span>' : '<span class="badge" style="background:#d9ffe9">미사용</span>';
      return '<tr>' +
        '<td><span class="code-cell">' + h(c.code) + '</span></td>' +
        '<td>' + h(b ? b.title : '모든 판') + '</td>' +
        '<td>' + status + '</td>' +
        '<td class="num">' + formatDateTime(c.createdAt) + '</td>' +
        '<td class="num">' + (c.usedAt ? formatDateTime(c.usedAt) + ' · ' + c.usedN + '번' : '—') + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn btn-outline btn-sm" data-action="copy-code" data-code="' + h(c.code) + '">복사</button>' +
          (!c.usedAt ? ' <button class="btn btn-danger-ghost btn-sm" data-action="revoke-code" data-code="' + h(c.code) + '">폐기</button>' : '') +
        '</td>' +
      '</tr>';
    }).join('');
  }

  function supabaseProjectRef(url) {
    var m = String(url || '').match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
    return m ? m[1] : '';
  }

  function fallbackBoxHTML(cfg) {
    if (!Backend.justFellBack) return '';
    var ref = supabaseProjectRef(cfg && cfg.SUPABASE_URL);
    var sqlUrl = ref ? 'https://supabase.com/dashboard/project/' + ref + '/sql/new' : 'https://supabase.com/dashboard';
    var title = Backend.fallbackReason === 'missing_tables'
      ? 'Supabase는 연결됐지만 테이블이 아직 없습니다'
      : Backend.fallbackReason === 'network' ? 'Supabase 서버에 연결하지 못했습니다' : 'Supabase 설정을 확인하지 못했습니다';
    var desc = Backend.fallbackReason === 'missing_tables'
      ? '아래 SQL Editor에서 <code>supabase/schema.sql</code> 전체를 붙여넣고 Run 하면, 새로고침만으로 실시간 서버 모드로 바뀝니다. 그 전까지는 이 브라우저의 데모 데이터로 정상 동작합니다.'
      : '잠시 후 새로고침하거나, URL·Publishable 키·프로젝트 상태를 확인해 주세요. 그 전까지는 데모 모드로 정상 동작합니다.';
    return '<div class="fallback-box">' +
      '<strong>' + h(title) + '</strong>' +
      '<p>' + desc + '</p>' +
      '<div class="btn-row tight">' +
        '<a class="btn btn-primary btn-sm" href="' + sqlUrl + '" target="_blank" rel="noopener">SQL Editor 열기</a>' +
        '<a class="btn btn-outline btn-sm" href="https://github.com/pkn8238-source/Kujiking/blob/main/supabase/schema.sql" target="_blank" rel="noopener">schema.sql 보기</a>' +
      '</div>' +
      (Backend.fallbackDetail ? '<p class="fallback-detail">' + h(Backend.fallbackDetail) + '</p>' : '') +
    '</div>';
  }

  /* 서버 판이 아직 P상 없이 실물만으로 차 있으면, 관리자에게 업그레이드 SQL을 안내한다 */
  function pointUpgradeNoticeHTML(cfg, live) {
    if (!live) return '';
    var needP = (state.boards || []).some(function (b) { return !hasPointTier(b) && (b.tiers || []).length >= 3; });
    if (!needP) return '';
    var ref = supabaseProjectRef(cfg && cfg.SUPABASE_URL);
    var sqlUrl = ref ? 'https://supabase.com/dashboard/project/' + ref + '/sql/new' : 'https://supabase.com/dashboard';
    return '<div class="fallback-box" style="margin-top:12px">' +
      '<strong>P상(포인트 꽝) 업그레이드가 아직입니다</strong>' +
      '<p>지금 서버의 판은 실물 상품만으로 채워져 있어, 실물에 당첨되지 않은 번호는 아무것도 지급되지 않습니다. ' +
      'SQL Editor 에 <code>supabase/upgrade_point_kkwang.sql</code> 전체를 붙여넣고 Run 하면 4개 판이 <b>실물 각 1개 + P상(굿즈 포인트 1,200P)</b> 구성으로 바뀝니다.</p>' +
      '<div class="btn-row tight">' +
        '<a class="btn btn-primary btn-sm" href="' + sqlUrl + '" target="_blank" rel="noopener">SQL Editor 열기</a>' +
        '<a class="btn btn-outline btn-sm" href="https://github.com/pkn8238-source/Kujiking/blob/main/supabase/upgrade_point_kkwang.sql" target="_blank" rel="noopener">upgrade_point_kkwang.sql 보기</a>' +
      '</div>' +
    '</div>';
  }

  function renderSettingsTab() {
    var card = $('#backendCard');
    if (card) {
      var cfg = Backend.config || {};
      var live = Backend.mode === 'supabase';
      card.innerHTML = '<div class="admin-card-head"><h2>Supabase 연결</h2>' +
        (live ? '<span class="badge badge-live">실시간 서버 연결됨</span>' : '<span class="badge" style="background:#fff3ba">데모 모드</span>') + '</div>' +
        (live
          ? '<p class="muted">회원·판매·쿠폰 데이터를 Supabase 에서 실시간으로 주고받고 있습니다. 이 기기뿐 아니라 다른 기기에서도 같은 계정으로 이어집니다.</p>'
          : '<p class="muted">지금은 <b>데모 모드</b>입니다. 모든 데이터가 이 브라우저(localStorage)에만 저장되고, 다른 기기와 공유되지 않습니다. ' +
            'Supabase 키를 넣으면 새로고침만으로 실시간 서버 모드로 바뀝니다.</p>') +
        '<ol class="setup-steps">' +
          '<li><b>supabase.com</b> 에서 새 프로젝트를 만듭니다.</li>' +
          '<li>SQL Editor 에 <code>supabase/schema.sql</code> 전체를 붙여넣고 Run 합니다.</li>' +
          '<li>Project Settings → API 의 <b>URL</b> 과 <b>anon public key</b> 를 복사합니다.</li>' +
          '<li><code>assets/config.js</code> 의 <code>SUPABASE_URL</code>, <code>SUPABASE_ANON_KEY</code> 에 붙여넣습니다.</li>' +
          '<li>회원가입 후 SQL Editor 에서 <code>update public.profiles set is_admin = true where email = \'내 이메일\';</code> 를 실행합니다.</li>' +
        '</ol>' +
        '<p class="storage-info">현재 설정 · URL <code>' + (cfg.SUPABASE_URL ? h(cfg.SUPABASE_URL) : '비어 있음') + '</code> · KEY <code>' + (cfg.SUPABASE_ANON_KEY ? '입력됨' : '비어 있음') + '</code></p>' +
        fallbackBoxHTML(cfg) +
        pointUpgradeNoticeHTML(cfg, live);
    }

    var info = $('#storageInfo');
    if (info && Backend.mode === 'local') {
      var bytes = 0;
      try { bytes = new Blob([localStorage.getItem(STATE_KEY) || '']).size; } catch (e) {}
      info.innerHTML = '저장된 판 ' + fmt(state.boards.length) + '개 · 회원 ' + fmt(state.users.length) + '명 · 쿠폰 ' + fmt(state.coupons.length) + '장 · 뽑기 ' +
        fmt(state.draws.length) + '건<br>브라우저 저장소 사용량 약 ' + (bytes / 1024).toFixed(1) + 'KB · 마지막 저장 ' + formatDateTime(state.updatedAt);
    } else if (info && Backend.mode === 'supabase') {
      info.textContent = 'Supabase 서버에 저장 중입니다. 백업(JSON)은 서버 데이터가 아니라 현재 화면 데이터 기준입니다.';
    }
    var demoInput = $('form[data-form="change-demo"] input[name="demo"]');
    if (demoInput && !demoInput.value) demoInput.value = state.settings.demoCode;
    renderYoutubeSettings();
    renderCsSettings();
  }

  /* ---------- 관리자 동작 ---------- */
  function openGrantModal(userId) {
    var m = (state.adminMembers || []).filter(function (x) { return x.id === userId; })[0];
    if (!m) return;
    ui.grantUserId = userId;
    openModal('<h2 class="modal-title" id="modalTitle">쿠폰(뽑기권) 지급</h2>' +
      '<p class="modal-sub">' + h(m.nickname) + ' · ' + h(m.email || m.phone || '') + ' 님에게 뽑기권을 지급합니다.</p>' +
      '<form data-form="grant" novalidate>' +
        '<label class="field"><span>사용 범위</span>' +
          '<select name="boardId" class="input">' +
            '<option value="">모든 판에서 사용 가능</option>' +
            state.boards.map(function (b) { return '<option value="' + h(b.id) + '">' + h(b.title) + ' 전용</option>'; }).join('') +
          '</select>' +
        '</label>' +
        '<label class="field"><span>지급 수량</span><input name="qty" type="number" min="1" max="100" step="1" value="1" required></label>' +
        '<label class="field"><span>메모 (선택)</span><input name="note" type="text" maxlength="80" placeholder="예: 스마트스토어 11/23 주문 확인"></label>' +
        '<p class="form-error" data-role="grant-error" role="alert"></p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" data-action="close-modal">취소</button>' +
          '<button type="submit" class="btn btn-primary">지급하기</button>' +
        '</div>' +
      '</form>');
  }

  /* ---------- 쿠폰 회수 (미사용 쿠폰 삭제) ---------- */
  function openRevokeModal(userId, presetQty, info) {
    info = info || {};
    var m = (state.adminMembers || []).filter(function (x) { return x.id === userId; })[0];
    var nickname = (m && m.nickname) || info.nickname || '회원';
    var contact = (m && (m.email || m.phone)) || info.email || '';
    ui.revoke = { userId: userId, nickname: nickname, contact: contact, coupons: [], qty: 1 };
    openModal('<h2 class="modal-title" id="modalTitle">쿠폰(뽑기권) 회수</h2>' +
      '<p class="modal-sub">' + h(nickname) + ' 님의 미사용 쿠폰을 불러오는 중이에요…</p>' +
      '<p class="revoke-loading">잠시만 기다려 주세요.</p>', { noAutofocus: true });
    Backend.fetchUserCoupons(userId).then(function (list) {
      if (!ui.revoke || ui.revoke.userId !== userId) return;
      ui.revoke.coupons = list;
      if (!list.length) { renderRevokeEmpty(); return; }
      ui.revoke.qty = Math.max(1, Math.min(list.length, Number(presetQty) || 1));
      renderRevokePicker();
    }).catch(function (e) {
      ui.revoke = null;
      closeModal();
      toast(errMsg(e), 'err');
    });
  }

  function revokeScopeLabel(c) {
    if (c.kind === 'universal' || !c.boardId) return '모든 판';
    var board = getBoard(c.boardId);
    return board ? board.title : '판 전용';
  }

  function revokeItemHTML(c, i, picked) {
    var scope = revokeScopeLabel(c);
    return '<li class="revoke-item' + (picked ? ' is-picked' : '') + '">' +
      '<span class="revoke-no">' + (i + 1) + '</span>' +
      '<span class="revoke-main">' +
        '<b>' + h(c.label || scope) + '</b>' +
        '<span class="muted small">' + h(scope) + ' · ' + formatDate(c.grantedAt) + ' 지급' +
          (c.note ? ' · ' + h(c.note) : '') + '</span>' +
      '</span>' +
      '<span class="revoke-tag">' + (picked ? '회수' : '유지') + '</span>' +
    '</li>';
  }

  function revokeSummaryText(qty, total) {
    if (qty >= total) return '미사용 쿠폰 <b>' + fmt(total) + '장 전체</b>를 회수합니다.';
    return '최근 지급분부터 <b>' + fmt(qty) + '장</b>을 회수하고, 나머지 ' + fmt(total - qty) + '장은 그대로 둡니다.';
  }

  function renderRevokeEmpty() {
    var r = ui.revoke || {};
    openModal('<h2 class="modal-title" id="modalTitle">쿠폰(뽑기권) 회수</h2>' +
      '<p class="modal-sub">' + h(r.nickname || '회원') + ' 님은 지금 회수할 <b>미사용 쿠폰이 없어요</b>.</p>' +
      '<p class="revoke-order">이미 사용했거나 보유하지 않은 쿠폰은 회수 목록에 나오지 않습니다.</p>' +
      '<div class="modal-actions"><button type="button" class="btn btn-outline" data-action="close-modal">닫기</button></div>');
  }

  function renderRevokePicker() {
    var r = ui.revoke;
    if (!r || !r.coupons.length) return;
    var total = r.coupons.length;
    var qty = Math.max(1, Math.min(total, Math.round(Number(r.qty) || 1)));
    r.qty = qty;
    var presets = [1, 2, 3, 5, 10].filter(function (n) { return n < total; });
    var quick = total < 2 ? '' : '<div class="qty-row" style="margin:10px 0 2px">' +
      '<button type="button" class="btn ' + (qty === total ? 'btn-dark' : 'btn-outline') + ' btn-sm" data-action="revoke-preset" data-qty="' + total + '">전체 ' + fmt(total) + '장</button>' +
      presets.map(function (n) {
        return '<button type="button" class="btn ' + (qty === n ? 'btn-dark' : 'btn-outline') + ' btn-sm" data-action="revoke-preset" data-qty="' + n + '">' + n + '장</button>';
      }).join('') + '</div>';
    openModal('<h2 class="modal-title" id="modalTitle">' + h(r.nickname) + ' 님 쿠폰 회수</h2>' +
      '<p class="modal-sub">미사용 쿠폰 <b>' + fmt(total) + '장</b> · 최근에 지급한 쿠폰부터 회수합니다.' +
        (r.contact ? '<br><span class="muted small">' + h(r.contact) + '</span>' : '') + '</p>' +
      '<label class="field" style="max-width:220px"><span>회수 수량 (1 ~ ' + fmt(total) + '장)</span>' +
        '<input id="revokeQty" type="number" min="1" max="' + total + '" step="1" value="' + qty + '" inputmode="numeric"></label>' +
      quick +
      '<p class="revoke-order" id="revokeSummary">' + revokeSummaryText(qty, total) + '</p>' +
      '<ul class="revoke-list">' + r.coupons.map(function (c, i) { return revokeItemHTML(c, i, i < qty); }).join('') + '</ul>' +
      '<p class="revoke-warn">회수한 쿠폰은 즉시 삭제되며 되돌릴 수 없어요. 다음 단계에서 한 번 더 확인합니다.</p>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" data-action="close-modal">취소</button>' +
        '<button type="button" class="btn btn-danger" data-action="revoke-next">미사용 쿠폰 ' + fmt(qty) + '장 회수</button>' +
      '</div>', { noAutofocus: true, resetScroll: true });
  }

  function refreshRevokePicks(value) {
    var r = ui.revoke;
    if (!r || !r.coupons.length) return;
    var total = r.coupons.length;
    var qty = Math.max(1, Math.min(total, Math.round(Number(value) || 1)));
    r.qty = qty;
    var box = $('#revokeQty');
    if (box) {
      var raw = String(value == null ? '' : value).trim();
      if (raw !== '' && (Number(raw) > total || Number(raw) < 1)) box.value = qty;
    }
    $$('.revoke-item').forEach(function (li, i) {
      var picked = i < qty;
      li.classList.toggle('is-picked', picked);
      var tag = li.querySelector('.revoke-tag');
      if (tag) tag.textContent = picked ? '회수' : '유지';
    });
    var sum = $('#revokeSummary');
    if (sum) sum.innerHTML = revokeSummaryText(qty, total);
    var next = $('[data-action="revoke-next"]');
    if (next) next.textContent = '미사용 쿠폰 ' + fmt(qty) + '장 회수';
    $$('[data-action="revoke-preset"]').forEach(function (b) {
      var n = Number(b.getAttribute('data-qty')) || 1;
      b.classList.toggle('btn-dark', n === qty);
      b.classList.toggle('btn-outline', n !== qty);
    });
  }

  function renderRevokeConfirm() {
    var r = ui.revoke;
    if (!r || !r.coupons.length) return;
    var qty = Math.max(1, Math.min(r.coupons.length, Math.round(Number(r.qty) || 1)));
    r.qty = qty;
    var picked = r.coupons.slice(0, qty);
    openModal('<h2 class="modal-title" id="modalTitle">쿠폰 회수 확인</h2>' +
      '<p class="modal-sub">' + h(r.nickname) + ' 님의 미사용 쿠폰 <b>' + fmt(qty) + '장</b>을 삭제합니다.</p>' +
      '<ul class="revoke-list is-confirm">' + picked.map(function (c, i) { return revokeItemHTML(c, i, true); }).join('') + '</ul>' +
      '<p class="revoke-warn">삭제한 쿠폰은 복구할 수 없어요. 다시 지급하려면 [쿠폰 지급]을 사용해 주세요.</p>' +
      '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" data-action="revoke-back">← 다시 고르기</button>' +
        '<button type="button" class="btn btn-danger" data-action="revoke-confirm">회수 확정</button>' +
      '</div>', { noAutofocus: true, resetScroll: true });
  }

  function runRevoke() {
    var r = ui.revoke;
    if (!r || !r.coupons.length) return;
    var qty = Math.max(1, Math.min(r.coupons.length, Math.round(Number(r.qty) || 1)));
    var ids = r.coupons.slice(0, qty).map(function (c) { return c.id; });
    var name = r.nickname || '회원';
    var btn = $('[data-action="revoke-confirm"]');
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.textContent = '회수 중…'; }
    Backend.revokeCoupons(r.userId, ids).then(function (n) {
      ui.revoke = null;
      closeModal();
      renderAdmin();
      if (!n) { toast('회수된 쿠폰이 없어요 — 이미 사용된 쿠폰일 수 있습니다.', 'err'); return; }
      toast(name + '님 미사용 쿠폰 ' + fmt(n) + '장 회수 완료', 'ok');
      if (n < qty) toast('나머지 ' + fmt(qty - n) + '장은 이미 사용되어 회수하지 못했어요.', 'err');
    }).catch(function (e) {
      if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = '회수 확정'; }
      toast(errMsg(e), 'err');
    });
  }

  function openClaimModal(claimId) {
    var c = (state.adminClaims || []).filter(function (x) { return x.id === claimId; })[0];
    if (!c) return;
    var board = getBoard(c.boardId);
    openModal('<h2 class="modal-title" id="modalTitle">구매확인 승인</h2>' +
      '<p class="modal-sub">' + h(c.nickname || '회원') + ' 님 · ' + h(board ? board.title : '판 미지정') + '<br>' +
      h(c.channel) + ' ' + h(c.orderNo) + ' · 신청 ' + fmt(c.qty) + '장 · ' + won(c.amount) + '</p>' +
      (c.memo ? '<p class="claim-memo">' + h(c.memo) + '</p>' : '') +
      '<form data-form="claim-approve" novalidate>' +
        '<label class="field"><span>지급할 뽑기권 수량</span><input name="qty" type="number" min="1" max="100" step="1" value="' + fmt(c.qty) + '" required></label>' +
        '<p class="muted small">지급 범위: ' + (board ? h(board.title) + ' 전용' : '모든 판 사용') + '</p>' +
        '<p class="form-error" data-role="approve-error" role="alert"></p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" data-action="close-modal">취소</button>' +
          '<button type="submit" class="btn btn-primary">승인하고 지급</button>' +
        '</div>' +
      '</form>');
    ui.approveClaimId = claimId;
  }

  function openDeliveryModal(drawId) {
    var d = (state.myDraws || []).filter(function (x) { return x.id === drawId; })[0];
    if (!d) return;
    var user = me();
    openModal('<h2 class="modal-title" id="modalTitle">배송 신청</h2>' +
      '<p class="modal-sub">' + (String(d.grade || '').toUpperCase() === 'LAST' ? '🏆 ' : '') + h(d.tierLabel || '당첨 상품') + ' · ' + drawNoLabel(d) + '</p>' +
      '<form data-form="delivery" novalidate data-id="' + h(d.id) + '">' +
        '<label class="field"><span>받는 사람</span><input name="recipient" type="text" maxlength="20" required value="' + h(user ? user.nickname : '') + '"></label>' +
        '<label class="field"><span>연락처</span><input name="phone" type="tel" inputmode="numeric" maxlength="20" required value="' + h(user ? user.phone : '') + '" placeholder="010-0000-0000"></label>' +
        '<div class="field field-postcode"><span>우편번호 (선택)</span>' +
          '<div class="postcode-row">' +
            '<input name="postcode" type="text" inputmode="numeric" maxlength="6" placeholder="예: 05510" autocomplete="postal-code">' +
            '<button type="button" class="btn btn-outline btn-sm postcode-btn" data-action="open-postcode">🔍 주소 검색</button>' +
          '</div>' +
        '</div>' +
        '<label class="field"><span>주소</span><input name="address" type="text" maxlength="120" required placeholder="🔍 주소 검색을 누르거나 직접 입력" autocomplete="street-address"></label>' +
        '<label class="field"><span>상세 주소 (선택)</span><input name="detail" type="text" maxlength="60" placeholder="예: 101동 1004호" autocomplete="address-line2"></label>' +
        '<label class="field"><span>배송 요청사항 (선택)</span><input name="memo" type="text" maxlength="80" placeholder="예: 문 앞에 놓아주세요"></label>' +
        shipNoticeBoxHTML('ship-note-modal') +
        '<p class="form-error" data-role="delivery-error" role="alert"></p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" data-action="close-modal">취소</button>' +
          '<button type="submit" class="btn btn-primary">배송 신청</button>' +
        '</div>' +
      '</form>');
  }

  /* =========================================================
     13-0. 사진 올리기 · 1kuji 자동 채우기 (관리자 판 편집 도우미)
     ========================================================= */
  var IMG_BUCKET = 'board-images';
  var IMG_MAX_SIDE = 1200;
  var IMG_QUALITY = 0.88;
  var IMG_MAX_BYTES = 12 * 1024 * 1024;

  function boardFormOf(el) {
    return (el && el.closest) ? el.closest('form[data-form="board-form"]') : null;
  }

  function uploadTarget(form, key, el) {
    if (!form) return null;
    if (key === 'cover') return form.querySelector('input[name="cover"]');
    if (key === 'lastone') return form.querySelector('input[name="lastOneImage"]');
    if (key === 'lineup') return form.querySelector('input[name="manualImage"]');
    if (key === 'tier') {
      var row = (el && el.closest) ? el.closest('.tier-row') : null;
      return row ? row.querySelector('input[name="image"]') : null;
    }
    return null;
  }

  function loadImageFromBlob(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없어요')); };
      img.src = url;
    });
  }

  /* 긴 변 1200px · JPEG 0.88 로 줄인다 (아이폰 원본은 3~5MB라 그대로 올리면 느리고 무겁다) */
  function shrinkImage(blob, maxSide, quality) {
    return loadImageFromBlob(blob).then(function (img) {
      var w = img.naturalWidth || img.width;
      var hh = img.naturalHeight || img.height;
      if (!w || !hh) throw new Error('이미지를 읽을 수 없어요');
      var scale = Math.min(1, (maxSide || IMG_MAX_SIDE) / Math.max(w, hh));
      var tw = Math.max(1, Math.round(w * scale));
      var th = Math.max(1, Math.round(hh * scale));
      var canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(img, 0, 0, tw, th);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (out) {
          if (out) resolve(out);
          else reject(new Error('사진을 변환할 수 없어요'));
        }, 'image/jpeg', quality || IMG_QUALITY);
      });
    });
  }

  function isBucketMissing(err) {
    var m = String((err && (err.message || err.error_description)) || err || '');
    return /bucket/i.test(m) && /not\s*found|not\s*exist|no\s*such/i.test(m);
  }

  function uploadImageBlob(blob) {
    var sb = Backend.sb;
    if (Backend.mode !== 'supabase' || !sb || !sb.storage) return Promise.reject(new Error('no-supabase'));
    var name = 'boards/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
    return sb.storage.from(IMG_BUCKET)
      .upload(name, blob, { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' })
      .then(function (res) {
        if (res.error) throw res.error;
        var pub = sb.storage.from(IMG_BUCKET).getPublicUrl(name);
        if (!pub || !pub.data || !pub.data.publicUrl) throw new Error('사진 주소를 만들지 못했어요');
        return pub.data.publicUrl;
      });
  }

  function imageErrorToast(err) {
    if (err && err.message === 'no-supabase') { toast('사진 올리기는 서버 연결에서만 됩니다. 주소를 직접 입력해 주세요.', 'err'); return; }
    if (isBucketMissing(err)) { toast('SQL을 먼저 실행해 주세요 (board-images 버킷 필요)', 'err'); return; }
    var m = String((err && err.message) || err || '');
    if (/row-level security|policy|permission|not authorized|403/i.test(m)) { toast('사진 저장 권한이 없어요. 관리자 로그인을 확인해 주세요', 'err'); return; }
    toast('사진을 올리지 못했어요. ' + errMsg(err), 'err');
  }

  /* 입력칸에 들어 있는 주소로 미리보기를 다시 그린다 */
  function refreshBoardImages(form) {
    if (!form) return;
    updateCoverPreview(form);
    [['lastOneImage', 'lastOnePreview'], ['manualImage', 'lineupPreview']].forEach(function (pair) {
      var input = form.querySelector('input[name="' + pair[0] + '"]');
      var box = form.querySelector('#' + pair[1]);
      if (!input || !box) return;
      var img = box.querySelector('img');
      var v = input.value.trim();
      box.hidden = !v;
      if (img) { if (v) img.src = v; else img.removeAttribute('src'); }
    });
    $$('input[name="image"]', form).forEach(function (input) {
      var row = input.closest('.tier-row');
      var prev = row ? row.querySelector('[data-role="tier-thumb"]') : null;
      if (!prev) return;
      var v = input.value.trim();
      prev.innerHTML = v ? '<img src="' + h(v) + '" alt="">' : '';
    });
  }

  function handleUploadFile(el) {
    var file = el.files && el.files[0];
    el.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type || '')) { toast('사진 파일만 올릴 수 있어요', 'err'); return; }
    if (file.size > IMG_MAX_BYTES) { toast('사진이 너무 커요 (12MB 이하로 골라주세요)', 'err'); return; }
    var form = boardFormOf(el);
    var key = el.getAttribute('data-upload');
    var target = uploadTarget(form, key, el);
    if (!target) return;
    var wrap = el.closest('.upload-wrap') || el.closest('.cover-row') || el.closest('.field');
    var btn = wrap ? wrap.querySelector('.upload-btn') : null;
    var label = btn ? btn.textContent : '';
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.textContent = '올리는 중…'; }
    shrinkImage(file).then(uploadImageBlob).then(function (url) {
      target.value = url;
      refreshBoardImages(form);
      toast('사진을 올렸어요', 'ok');
    }).catch(imageErrorToast).then(function () {
      if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = label || '📷 올리기'; }
    });
  }

  /* ---------- 1kuji.com 링크로 판 자동 채우기 ----------
     브라우저에서 1kuji.com 을 직접 부를 수 없어(CORS) 공개 프록시를 차례로 시도한다.
     · r.jina.ai — x-respond-with: html 로 원본 HTML 을 받는다 (CORS 허용 확인)
     · allorigins / codetabs / cors.lol — 예비 (막힐 때가 있어 순서대로) */
  var KUJI_PROXY = [
    { make: function (u) { return 'https://r.jina.ai/' + u; }, headers: { 'x-respond-with': 'html' } },
    { make: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { make: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } },
    { make: function (u) { return 'https://api.cors.lol/?url=' + encodeURIComponent(u); } }
  ];

  function fetchWithTimeout(url, ms, headers) {
    return new Promise(function (resolve, reject) {
      var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctl) { try { ctl.abort(); } catch (e) { /* 무시 */ } }
        reject(new Error('시간 초과'));
      }, ms || 14000);
      fetch(url, { credentials: 'omit', cache: 'no-store', headers: headers || {}, signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(function (t) { clearTimeout(timer); resolve(t); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function fetchKujiHtml(target) {
    var i = 0;
    function attempt() {
      if (i >= KUJI_PROXY.length) return Promise.reject(new Error('proxy'));
      var proxy = KUJI_PROXY[i++];
      return fetchWithTimeout(proxy.make(target), 16000, proxy.headers).then(function (txt) {
        /* 공식 사이트 점검 공지 — 다른 프록시를 더 돌려도 같으므로 바로 알린다 */
        if (/メンテナンス|maintenance/i.test(txt) && !/itemCol|aboutCol/i.test(txt)) {
          var mErr = new Error('maintenance');
          mErr.fatal = true;
          throw mErr;
        }
        if (!txt || txt.length < 500 || !/itemCol|aboutCol|1kuji/i.test(txt)) throw new Error('empty');
        return txt;
      }).catch(function (err) {
        if (err && err.fatal) throw err;
        return attempt();
      });
    }
    return attempt();
  }

  function absImageUrl(u, base) {
    var v = String(u || '').trim();
    if (!v) return '';
    if (v.indexOf('//') === 0) return 'https:' + v;
    if (v.charAt(0) === '/') return 'https://1kuji.com' + v;
    if (!/^https?:/i.test(v)) {
      try { return new URL(v, base || 'https://1kuji.com/').href; } catch (e) { return v; }
    }
    return v;
  }

  function parseKujiHtml(html, baseUrl) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    function tx(el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
    function meta(sel) { var m = doc.querySelector(sel); return m ? (m.getAttribute('content') || '') : ''; }

    var title = tx(doc.querySelector('#aboutCol h2')) || tx(doc.querySelector('.aboutCol h2')) ||
      meta('meta[property="og:title"]') || tx(doc.querySelector('title'));
    title = title.replace(/｜.*$/, '').replace(/^一番くじ\s*/, '').trim();

    var coverEl = doc.querySelector('.mvCol img') || doc.querySelector('section.mvCol img') || doc.querySelector('.mainVisual img');
    var cover = absImageUrl(coverEl && (coverEl.getAttribute('src') || coverEl.getAttribute('data-src')), baseUrl);

    var about = doc.querySelector('#aboutCol .detail') || doc.querySelector('.aboutCol .detail');
    var aboutText = about ? String(about.textContent || '') : '';
    var priceHit = /1回\s*([0-9,]+)\s*円/.exec(aboutText);
    var price = priceHit ? priceHit[1].replace(/,/g, '') : '';
    var dateHit = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(aboutText);
    var release = dateHit
      ? (dateHit[1] + '.' + ('0' + dateHit[2]).slice(-2) + '.' + ('0' + dateHit[3]).slice(-2))
      : '';

    var items = $$('.itemColList', doc).map(function (box) {
      var name = tx(box.querySelector('.itemColDetailHead h4.name')) || tx(box.querySelector('h4.name'));
      var imgEl = box.querySelector('.itemColGallery ul.slider-item img') || box.querySelector('.itemColGallery img');
      var img = absImageUrl(imgEl && (imgEl.getAttribute('src') || imgEl.getAttribute('data-src')), baseUrl);
      var data = $$('ul.data li', box).map(tx).filter(Boolean);
      var desc = tx(box.querySelector('p.detail'));
      var gradeHit = /^([A-Z])賞/.exec(name);
      var isLast = /ラストワン/.test(name);
      var label = name.replace(/^ラストワン賞\s*/, '').replace(/^[A-Z]賞\s*/, '').trim();
      return { name: name, grade: gradeHit ? gradeHit[1] : '', isLast: isLast, label: label, image: img, data: data, desc: desc };
    }).filter(function (it) { return it.name; });

    return {
      title: title,
      cover: cover,
      price: price,
      release: release,
      items: items,
      tiers: items.filter(function (it) { return it.grade && !it.isLast; }),
      lastOne: items.filter(function (it) { return it.isLast; })[0] || null
    };
  }

  var KUJI_CATEGORY_HINTS = [
    ['원피스', /ワンピース|ONE\s*PIECE/i],
    ['귀멸의 칼날', /鬼滅|キメツ/i],
    ['주술회전', /呪術|ジュジュツ/i],
    ['나의 히어로 아카데미아', /ヒロアカ|僕のヒーローアカデミア/i],
    ['치이카와', /ちいかわ|チイカワ/i],
    ['드래곤볼', /ドラゴンボール|DRAGON\s*BALL/i],
    ['헌터×헌터', /HUNTER|ハンター/i],
    ['죠죠의 기묘한 모험', /ジョジョ|JOJO/i],
    ['약사의 혼잣말', /薬屋|薬師/i],
    ['산리오', /サンリオ|SANRIO/i]
  ];
  function guessKujiCategory(text) {
    var s = String(text || '');
    for (var i = 0; i < KUJI_CATEGORY_HINTS.length; i++) {
      if (KUJI_CATEGORY_HINTS[i][1].test(s)) return KUJI_CATEGORY_HINTS[i][0];
    }
    return '';
  }

  function setKujiStatus(text, bad) {
    var el = $('#kujiStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-bad', !!bad);
  }

  function kujiSizeOf(it) {
    var data = it.data || [];
    for (var i = 0; i < data.length; i++) {
      var mm = /サイズ[:：]\s*(.+)$/.exec(String(data[i]));
      if (mm) return mm[1].trim();
    }
    return '';
  }
  function kujiItemSummary(it) {
    var size = kujiSizeOf(it);
    return (it.label + (size ? ' (' + size + ')' : '')).trim();
  }

  /* 파싱 결과를 폼에 채운다 — 실물 등급은 각 1장, 전체 장수는 등급 수×20장, 나머지는 P상 */
  function applyKujiToForm(form, parsed) {
    if (!form) return;
    var cat = guessKujiCategory(parsed.title + ' ' + parsed.items.map(function (i) { return i.label; }).join(' '));
    var titleEl = form.querySelector('input[name="title"]');
    if (titleEl && parsed.title) {
      var nice = cat ? ('[' + cat + '] ' + parsed.title) : parsed.title;
      titleEl.value = nice.slice(0, 60);
    }

    var catEl = form.querySelector('select[name="category"]');
    if (catEl && cat) catEl.value = cat;

    var priceEl = form.querySelector('input[name="price"]');
    if (priceEl) priceEl.value = 12000;

    if (parsed.cover) {
      var coverEl = form.querySelector('input[name="cover"]');
      if (coverEl) coverEl.value = parsed.cover;
      var preset = form.querySelector('[data-role="cover-preset"]');
      if (preset) preset.value = '';
    }

    if (parsed.lastOne) {
      var lo = parsed.lastOne;
      var loLabel = form.querySelector('input[name="lastOneLabel"]');
      if (loLabel) loLabel.value = ('라스트원상 · ' + lo.label).slice(0, 60);
      var loImg = form.querySelector('input[name="lastOneImage"]');
      if (loImg) loImg.value = lo.image || '';
      var loDesc = form.querySelector('input[name="lastOneDesc"]');
      if (loDesc) loDesc.value = (kujiSizeOf(lo) || lo.desc || '').slice(0, 60);
    }

    var real = parsed.tiers.slice(0, GRADES.length);
    var total = Math.min(MAX_TICKETS, Math.max(real.length, real.length * 20));
    var tiers = real.map(function (it) {
      var size = kujiSizeOf(it);
      var descText = size || (it.data || []).map(function (d) { return String(d).replace(/^■/, ''); }).join(' · ');
      return {
        grade: it.grade,
        label: String(it.label || '').slice(0, 40),
        count: 1,
        points: 0,
        image: it.image,
        desc: String(descText || it.desc || '').slice(0, 60)
      };
    });
    var pCount = total - real.length;
    if (pCount > 0) tiers.push({ grade: 'P', label: '굿즈 포인트 1,200P', count: pCount, points: 1200, pointOnly: true });

    var ticketsEl = form.querySelector('input[name="tickets"]');
    if (ticketsEl) ticketsEl.value = total;
    var rows = form.querySelector('#tierRows');
    if (rows) rows.innerHTML = tierRowsHTML(tiers);

    var specs = [{ k: '제조사', v: '반다이 스피리츠 (BANDAI SPIRITS)' }];
    if (parsed.release) specs.push({ k: '일본 발매', v: parsed.release });
    if (parsed.price) specs.push({ k: '일본 가격', v: '1회 ' + parsed.price + '엔' });
    specs.push({ k: '등급', v: real.map(function (t) { return t.grade; }).join('·') + '상 ' + real.length + '종 + 라스트원' });
    var specEl = form.querySelector('textarea[name="manualSpecs"]');
    if (specEl) specEl.value = specs.map(function (s) { return s.k + ': ' + s.v; }).join('\n');

    var lineupEl = form.querySelector('textarea[name="manualLineup"]');
    if (lineupEl) {
      lineupEl.value = parsed.items.slice(0, 20).map(function (it) {
        return (it.isLast ? '라스트원상 ' : it.grade + '상 ') + kujiItemSummary(it);
      }).join('\n');
    }

    refreshBoardImages(form);
    updateTierSummary();
  }

  async function kujiImportFlow() {
    var form = $('form[data-form="board-form"]');
    var input = $('#kujiSrc');
    if (!form || !input) return;
    var raw = String(input.value || '').trim();
    if (!raw) { setKujiStatus('1kuji.com 상품 주소를 붙여넣어 주세요.', 1); return; }
    var target = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw.replace(/^\/+/, '');
    var host = '';
    try { host = new URL(target).hostname.toLowerCase(); } catch (e) { host = ''; }
    if (!/(^|\.)1kuji\.com$/.test(host)) {
      setKujiStatus('1kuji.com 상품 주소만 불러올 수 있어요. 예: https://1kuji.com/products/chiikawa4', 1);
      return;
    }
    input.value = target;
    var btn = $('[data-action="kuji-import"]');
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.textContent = '불러오는 중…'; }
    setKujiStatus('공식 페이지를 불러오는 중이에요…');
    try {
      var html = await fetchKujiHtml(target);
      var parsed = parseKujiHtml(html, target);
      if (!parsed.tiers.length) throw new Error('no-tiers');
      applyKujiToForm(form, parsed);
      if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = '불러오기'; }
      setKujiStatus('등급 ' + parsed.tiers.length + '종 + 라스트원을 채웠어요. 사진은 1kuji 공식 이미지 주소로 연결됩니다. 내용을 확인하고 저장을 눌러주세요.');
    } catch (e) {
      if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = '불러오기'; }
      if (e && e.message === 'maintenance') {
        setKujiStatus('1kuji.com이 지금 점검 중이에요. 점검이 끝난 뒤 다시 시도하거나, 아래 칸을 직접 채워 주세요.', 1);
        return;
      }
      setKujiStatus('불러오지 못했어요. 1kuji.com이 점검 중이거나 주소가 달라졌을 수 있어요. 잠시 후 다시 시도하거나 직접 입력해 주세요.', 1);
    }
  }

  /* ---------- 판 편집 ---------- */
  function tierRowsHTML(tiers) {
    return tiers.map(function (t) {
      return '<div class="tier-row">' +
        '<div class="tier-main">' +
          '<select name="grade">' + TIER_GRADES.map(function (g) {
            return '<option value="' + g + '"' + (g === t.grade ? ' selected' : '') + '>' + (g === 'P' ? 'P상 (포인트)' : g + '상') + '</option>';
          }).join('') + '</select>' +
          '<input name="label" type="text" maxlength="40" value="' + h(t.label || '') + '" placeholder="상품명">' +
          '<input name="count" type="number" min="0" step="1" value="' + Number(t.count || 0) + '">' +
          '<input name="points" type="number" min="0" step="500" value="' + Number(t.points || 0) + '">' +
          '<label class="tier-point-only" title="이 등급은 실물 대신 포인트로 지급"><input type="checkbox" name="pointOnly"' + (t.pointOnly ? ' checked' : '') + '><span>P상</span></label>' +
          '<button type="button" class="tier-del" data-action="tier-remove" aria-label="등급 삭제">✕</button>' +
        '</div>' +
        '<div class="tier-extra">' +
          '<span class="tier-thumb-prev" data-role="tier-thumb">' +
            (t.image ? '<img src="' + h(coverSrc(t.image)) + '" alt="">' : '') +
          '</span>' +
          '<div class="upload-wrap">' +
            '<input name="image" type="text" value="' + h(t.image || '') + '" placeholder="사진 올리기 또는 주소 입력" data-role="tier-image">' +
            '<button type="button" class="btn btn-outline btn-sm upload-btn" data-action="pick-image" data-upload="tier">📷 올리기</button>' +
            '<input type="file" accept="image/*" class="upload-file" data-upload="tier" hidden>' +
          '</div>' +
          '<input name="desc" type="text" maxlength="60" value="' + h(t.desc || '') + '" placeholder="상품 설명 (약 20cm · MASTERLISE 피규어)">' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function updateCoverPreview(form) {
    var box = form.querySelector('#coverPreview');
    if (!box) return;
    var input = form.querySelector('input[name="cover"]');
    var img = box.querySelector('img');
    var v = input ? input.value.trim() : '';
    if (!v) { box.hidden = true; if (img) img.removeAttribute('src'); return; }
    box.hidden = false;
    if (img) img.src = v;
  }

  function openBoardEditor(boardId, opts) {
    opts = opts || {};
    var editing = boardId ? getBoard(boardId) : null;
    var board = editing;
    if (!board && opts.duplicate) {
      try { board = JSON.parse(JSON.stringify(opts.duplicate)); } catch (e) { board = Object.assign({}, opts.duplicate); }
      board.id = null;
      board.seed = '';
      board.seedHash = '';
      board.status = 'open';
      board.opens = [];
      board.lastOneWinnerId = '';
      board.lastOneWinnerName = '';
      board.lastOneWonAt = '';
      board.title = (String(board.title || '') + ' 복사').slice(0, 60);
    }
    var dupMode = !!board && !editing;
    ui.editingBoardId = editing ? editing.id : null;
    var tiers = (board && board.tiers && board.tiers.length) ? board.tiers : [
      { grade: 'A', label: '', count: 1, points: 0 },
      { grade: 'B', label: '', count: 1, points: 0 },
      { grade: 'C', label: '', count: 1, points: 0 },
      { grade: 'D', label: '', count: 1, points: 0 },
      { grade: 'E', label: '', count: 1, points: 0 },
      { grade: 'P', label: '굿즈 포인트 1,200P', count: 95, points: 1200, pointOnly: true }
    ];
    var m = board ? manualOf(board) : {};
    var html = '' +
      '<h2 class="modal-title" id="modalTitle">' + (editing ? '판 수정' : (dupMode ? '판 복제' : '새 판 만들기')) + '</h2>' +
      '<p class="modal-sub">' + (editing
        ? '내용을 고치면 손님 화면에 바로 반영됩니다. 진행 중인 판의 장수·등급은 바꿀 수 없어요.'
        : '카테고리와 금액을 정하고, 등급 수량의 합계를 전체 장수와 맞춰 주세요.') + '</p>' +
      (editing ? '' :
        '<div class="kuji-import">' +
          '<div class="kuji-import-head"><b>🔗 일본 공식 링크 자동 채우기</b>' +
            '<span>1kuji.com 상품 주소를 붙여넣으면 제목·등급·사진·라스트원을 자동으로 채웁니다.</span></div>' +
          '<div class="kuji-import-row">' +
            '<input id="kujiSrc" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://1kuji.com/products/…">' +
            '<button type="button" class="btn btn-primary btn-sm" data-action="kuji-import">불러오기</button>' +
          '</div>' +
          '<p class="kuji-import-status" id="kujiStatus"></p>' +
        '</div>') +
      '<form data-form="board-form" novalidate>' +
        '<div class="form-grid">' +
          '<label class="field span-2"><span>판 제목</span><input name="title" type="text" maxlength="60" required value="' + h(board ? board.title : '') + '" placeholder="예: [원피스] 루피 기어5 피규어 쿠지"></label>' +
          '<label class="field"><span>카테고리</span><select name="category">' +
            CATEGORIES.map(function (c) { return '<option' + ((board ? board.category : '원피스') === c ? ' selected' : '') + '>' + h(c) + '</option>'; }).join('') +
          '</select></label>' +
          '<label class="field"><span>1장 가격 (원)</span><input name="price" type="number" min="100" step="100" value="' + Number(board ? board.price : 12000) + '"></label>' +
          '<label class="field"><span>전체 장수</span><input name="tickets" type="number" min="1" max="' + MAX_TICKETS + '" step="1" value="' + Number(board ? board.tickets : 100) + '"></label>' +
          '<label class="field"><span>판매 상태</span><select name="status">' +
            '<option value="open"' + (!board || board.status === 'open' ? ' selected' : '') + '>판매 중</option>' +
            '<option value="closed"' + (board && board.status === 'closed' ? ' selected' : '') + '>종료</option>' +
          '</select></label>' +
          '<label class="field span-2"><span>라스트원상</span><input name="lastOneLabel" type="text" maxlength="60" value="' + h(board ? board.lastOneLabel : '라스트원상 · 메탈릭 컬러 피규어') + '"></label>' +
          '<div class="field span-2">' +
            '<span>라스트원 이미지</span>' +
            '<div class="upload-wrap">' +
              '<input name="lastOneImage" type="text" value="' + h(board ? (board.lastOneImage || '') : '') + '" placeholder="📷 올리기 또는 주소 입력">' +
              '<button type="button" class="btn btn-outline btn-sm upload-btn" data-action="pick-image" data-upload="lastone">📷 올리기</button>' +
              '<input type="file" accept="image/*" class="upload-file" data-upload="lastone" hidden>' +
            '</div>' +
            '<div class="cover-preview" id="lastOnePreview" hidden><img alt="라스트원 미리보기"></div>' +
          '</div>' +
          '<label class="field span-2"><span>라스트원 설명</span><input name="lastOneDesc" type="text" maxlength="60" value="' + h(board ? (board.lastOneDesc || '') : '') + '" placeholder="약 21cm · 근두운에 오른 부자 피규어"></label>' +
          '<div class="field span-2">' +
            '<span>커버 이미지</span>' +
            '<div class="cover-row">' +
              '<input name="cover" type="text" value="' + h(board ? (board.cover || '') : '') + '" placeholder="📷 올리기 또는 주소 입력">' +
              '<button type="button" class="btn btn-outline btn-sm upload-btn" data-action="pick-image" data-upload="cover">📷 올리기</button>' +
              '<input type="file" accept="image/*" class="upload-file" data-upload="cover" hidden>' +
            '</div>' +
            '<div class="cover-row" style="margin-top:8px">' +
              '<select class="input input-sm" data-role="cover-preset" aria-label="커버 이미지 선택">' +
                '<option value="">기본(카테고리 컬러)</option>' +
                COVER_PRESETS.map(function (c) {
                  return '<option value="' + h(c.url) + '"' + (board && board.cover === c.url ? ' selected' : '') + '>' + h(c.label) + '</option>';
                }).join('') +
                '<option value="__url">직접 URL 입력…</option>' +
              '</select>' +
            '</div>' +
            '<span class="field-hint">비워두면 카테고리 색상 커버가 표시됩니다. 3:4 세로형이 가장 잘 맞아요.</span>' +
            '<div class="cover-preview" id="coverPreview" hidden><img alt="커버 미리보기"></div>' +
          '</div>' +
        '</div>' +
        '<div class="tier-editor" id="tierEditor">' +
          '<div class="tier-editor-head"><span>등급</span><span>상품명</span><span>수량</span><span>지급 포인트(P)</span><span>구분</span><span></span></div>' +
          '<div id="tierRows">' + tierRowsHTML(tiers) + '</div>' +
          '<div class="tier-summary"><span>등급 수량 합계 <b id="tierSumLabel">0</b> / <b id="ticketTotalLabel">0</b>장</span><span id="tierSumState"></span></div>' +
        '</div>' +
        '<div class="btn-row tight">' +
          '<button type="button" class="btn btn-outline btn-sm" data-action="tier-add">+ 등급 추가</button>' +
          '<button type="button" class="btn btn-outline btn-sm" data-action="tier-add-point">+ P상(포인트) 추가</button>' +
          '<button type="button" class="btn btn-outline btn-sm" data-action="tier-fill-point">P상 자동 계산</button>' +
        '</div>' +
        '<div class="manual-editor">' +
          '<div class="manual-editor-head"><span>상품 설명서</span><small>판 상세 하단에 그대로 표시됩니다.</small></div>' +
          '<div class="field">' +
            '<span>세트 라인업 이미지 (선택)</span>' +
            '<div class="upload-wrap">' +
              '<input name="manualImage" type="text" value="' + h(m.image || '') + '" placeholder="비우면 등급 이미지에서 자동">' +
              '<button type="button" class="btn btn-outline btn-sm upload-btn" data-action="pick-image" data-upload="lineup">📷 올리기</button>' +
              '<input type="file" accept="image/*" class="upload-file" data-upload="lineup" hidden>' +
            '</div>' +
            '<div class="cover-preview" id="lineupPreview" hidden><img alt="라인업 미리보기"></div>' +
          '</div>' +
          '<label class="field"><span>요약</span><textarea name="manualSummary" rows="2" placeholder="상품 소개 2~3문장">' + h(m.summary || '') + '</textarea></label>' +
          '<label class="field"><span>사양 (한 줄에 “항목: 값”)</span><textarea name="manualSpecs" rows="4" placeholder="제조사: 반다이 스피리츠&#10;일본 발매: 2026.10.17">' + h((m.specs || []).map(function (x) { return x.k + ': ' + x.v; }).join('\n')) + '</textarea></label>' +
          '<label class="field"><span>실제 라인업 (한 줄에 1개)</span><textarea name="manualLineup" rows="4" placeholder="A상 손오공 MASTERLISE (약 20cm)">' + h((m.lineup || []).join('\n')) + '</textarea></label>' +
          '<label class="field"><span>유의사항 (한 줄에 1개)</span><textarea name="manualNotes" rows="3" placeholder="랜덤 지급 안내 등">' + h((m.notes || []).join('\n')) + '</textarea></label>' +
        '</div>' +
        '<label class="field" style="margin-top:14px"><span>시드 (비우면 자동 생성)</span>' +
          '<div class="seed-row"><input name="seed" type="text" value="' + h(editing ? editing.seed : '') + '" placeholder="자동 생성">' +
          '<button type="button" class="btn btn-outline btn-sm" data-action="seed-regen">새로 생성</button></div>' +
        '</label>' +
        '<p class="field-error" data-role="board-error" role="alert"></p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-outline" data-action="close-modal">취소</button>' +
          '<button type="submit" class="btn btn-primary">저장</button>' +
        '</div>' +
      '</form>';
    openModal(html, { wide: true });
    updateTierSummary();
    refreshBoardImages($('form[data-form="board-form"]'));
  }

  function readTierRows() {
    return $$('#tierRows .tier-row').map(function (row) {
      var chk = $('input[name="pointOnly"]', row);
      var imgEl = $('input[name="image"]', row);
      var descEl = $('input[name="desc"]', row);
      return {
        grade: $('select[name="grade"]', row).value,
        label: $('input[name="label"]', row).value.trim(),
        count: Number($('input[name="count"]', row).value),
        points: Number($('input[name="points"]', row).value || 0),
        pointOnly: !!(chk && chk.checked),
        image: imgEl ? imgEl.value.trim() : '',
        desc: descEl ? descEl.value.trim() : ''
      };
    });
  }
  function readManualForm(form) {
    var lines = function (name) {
      return fieldValue(form, name).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    };
    var specs = lines('manualSpecs').map(function (l) {
      var i = l.search(/[:：]/);
      if (i <= 0) return null;
      return { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() };
    }).filter(function (x) { return x && x.k && x.v; });
    var manual = {
      summary: fieldValue(form, 'manualSummary').trim(),
      specs: specs,
      lineup: lines('manualLineup'),
      notes: lines('manualNotes'),
      image: fieldValue(form, 'manualImage').trim()
    };
    if (!manual.summary && !specs.length && !manual.lineup.length && !manual.notes.length && !manual.image) return null;
    return manual;
  }

  function updateTierSummary() {
    if (!$('#tierRows')) return;
    var rows = readTierRows();
    var sum = rows.reduce(function (s, r) { return s + (isNaN(r.count) ? 0 : r.count); }, 0);
    var total = Number(($('input[name="tickets"]') || {}).value || 0);
    var sumEl = $('#tierSumLabel');
    var totalEl = $('#ticketTotalLabel');
    var stateEl = $('#tierSumState');
    if (sumEl) sumEl.textContent = fmt(sum);
    if (totalEl) totalEl.textContent = fmt(total);
    if (stateEl) {
      var ok = sum === total && total > 0;
      stateEl.className = ok ? 'ok' : 'bad';
      stateEl.textContent = ok ? '✓ 일치' : (sum > total ? '초과 ' + fmt(sum - total) + '장' : '부족 ' + fmt(total - sum) + '장');
    }
  }

  async function saveBoardForm(form) {
    var errEl = $('[data-role="board-error"]', form);
    var fail = function (msg) {
      if (errEl) errEl.textContent = msg;
      var editor = $('#tierEditor');
      if (editor) { editor.classList.remove('shake'); void editor.offsetWidth; editor.classList.add('shake'); }
    };
    var data = {
      title: fieldValue(form, 'title').trim(),
      category: fieldValue(form, 'category'),
      price: Number(fieldValue(form, 'price')),
      tickets: Number(fieldValue(form, 'tickets')),
      status: fieldValue(form, 'status'),
      lastOneLabel: fieldValue(form, 'lastOneLabel').trim() || '라스트원상',
      lastOneImage: fieldValue(form, 'lastOneImage').trim(),
      lastOneDesc: fieldValue(form, 'lastOneDesc').trim(),
      cover: fieldValue(form, 'cover').trim(),
      manual: readManualForm(form),
      tiers: readTierRows(),
      seed: fieldValue(form, 'seed').trim()
    };
    if (!data.title) return fail('판 제목을 입력해 주세요.');
    if (!(data.price > 0)) return fail('가격을 확인해 주세요.');
    if (!(data.tickets >= 1 && data.tickets <= MAX_TICKETS)) return fail('전체 장수는 1 ~ ' + MAX_TICKETS + '장 사이로 입력해 주세요.');
    if (!data.tiers.length) return fail('등급을 하나 이상 추가해 주세요.');
    var grades = {};
    for (var i = 0; i < data.tiers.length; i++) {
      var t = data.tiers[i];
      if (!t.label) return fail((i + 1) + '번째 등급의 상품명을 입력해 주세요.');
      if (!(t.count >= 0) || !Number.isInteger(t.count)) return fail('등급 수량은 0 이상의 정수여야 합니다.');
      if (grades[t.grade]) return fail(t.grade + '상 등급이 중복되었습니다.');
      grades[t.grade] = true;
    }
    var sum = data.tiers.reduce(function (s, x) { return s + x.count; }, 0);
    if (sum !== data.tickets) return fail('등급 수량 합계(' + fmt(sum) + '장)가 전체 장수(' + fmt(data.tickets) + '장)와 같아야 합니다.');

    var existing = ui.editingBoardId ? getBoard(ui.editingBoardId) : null;
    var structureChanged = !existing || existing.tickets !== data.tickets ||
      tierStructureKey(existing.tiers) !== tierStructureKey(data.tiers) ||
      (!!data.seed && data.seed !== existing.seed);

    if (Backend.mode === 'supabase' && existing && structureChanged) {
      return fail('서버 모드에서는 진행 중인 판의 구조(장수·등급)를 바꿀 수 없어요. 새 판을 만들어 주세요.');
    }

    var proceed = async function () {
      try {
        var saved = await Backend.saveBoard(Object.assign({ id: ui.editingBoardId }, data));
        ui.editingBoardId = null;
        closeModal();
        renderAll();
        toast(existing ? '판을 수정했어요' : '새 판을 만들었어요', 'ok');
        if (ui.view === 'admin') renderAdmin();
      } catch (e) {
        fail(errMsg(e));
      }
    };

    if (existing && structureChanged && (existing.opens || []).length && Backend.mode === 'local') {
      confirmDialog({
        title: '판매 내역이 초기화됩니다',
        message: '번호 구성(장수·등급·시드)이 바뀌면 기존 판매 내역 <b>' + fmt(existing.opens.length) + '건</b>이 초기화됩니다. 계속할까요?',
        confirmLabel: '초기화하고 저장',
        danger: true
      }).then(function (ok) {
        if (ok) proceed();
        else openBoardEditor(existing.id);
      });
    } else {
      proceed();
    }
  }

  /* =========================================================
     14. 인증 모달
     ========================================================= */
  function openAuthModal(tab) {
    ui.authTab = tab || ui.authTab || 'login';
    openModal(authModalHTML());
  }
  function authModalHTML() {
    var isLogin = ui.authTab !== 'signup';
    return '<div class="auth-modal">' +
      '<div class="auth-tabs">' +
        '<button class="auth-tab' + (isLogin ? ' active' : '') + '" data-action="auth-tab" data-tab="login">로그인</button>' +
        '<button class="auth-tab' + (!isLogin ? ' active' : '') + '" data-action="auth-tab" data-tab="signup">회원가입</button>' +
      '</div>' +
      (isLogin
        ? '<h2 class="modal-title" id="modalTitle">다시 만나서 반가워요</h2>' +
          '<p class="modal-sub">구매확인으로 받은 뽑기권과 당첨 상품은 계정에 보관됩니다.</p>' +
          '<form data-form="login" novalidate>' +
            '<label class="field"><span>이메일</span><input name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>' +
            '<label class="field"><span>비밀번호</span><input name="password" type="password" autocomplete="current-password" required placeholder="6자 이상"></label>' +
            '<p class="form-error" data-role="auth-error" role="alert"></p>' +
            '<button class="btn btn-primary btn-block" type="submit">로그인</button>' +
          '</form>'
        : '<h2 class="modal-title" id="modalTitle">쿠지킹 회원가입</h2>' +
          '<p class="modal-sub">배송·주문 확인을 위해 닉네임과 연락처를 받습니다. 닉네임은 판매 내역에 마스킹되어 표시돼요.</p>' +
          '<form data-form="signup" novalidate>' +
            '<label class="field"><span>이메일</span><input name="email" type="email" autocomplete="email" required placeholder="you@naver.com">' +
              '<span class="field-hint" data-role="signup-email-note">' + h(SIGNUP_EMAIL_NOTE) + '</span>' +
            '</label>' +
            '<div class="form-grid two">' +
              '<label class="field"><span>비밀번호</span><input name="password" type="password" autocomplete="new-password" required placeholder="6자 이상"></label>' +
              '<label class="field"><span>비밀번호 확인</span><input name="password2" type="password" autocomplete="new-password" required></label>' +
            '</div>' +
            '<div class="form-grid two">' +
              '<label class="field"><span>닉네임</span><input name="nickname" type="text" maxlength="12" required placeholder="예: 쿠지러버"></label>' +
              '<label class="field"><span>휴대폰 번호</span><input name="phone" type="tel" inputmode="numeric" maxlength="20" required placeholder="010-0000-0000"></label>' +
            '</div>' +
            '<p class="auth-privacy">주문 확인과 배송을 위해서만 사용하며, 판매 내역에는 닉네임이 <b>박*남</b>처럼 마스킹되어 표시됩니다.</p>' +
            '<p class="form-error" data-role="auth-error" role="alert"></p>' +
            '<button class="btn btn-primary btn-block" type="submit">가입하고 시작하기</button>' +
          '</form>') +
      '<div class="auth-demo demo-only">' +
        '<p>처음이신가요? 체험 계정으로 바로 둘러볼 수 있어요.</p>' +
        '<button class="btn btn-outline btn-sm" type="button" data-action="demo-login">체험 계정으로 시작 (쿠지러버)</button>' +
      '</div>' +
    '</div>';
  }

  async function doSignup(form) {
    var errEl = $('[data-role="auth-error"]', form);
    var email = fieldValue(form, 'email').trim().toLowerCase();
    var pw = fieldValue(form, 'password');
    var pw2 = fieldValue(form, 'password2');
    var nickname = fieldValue(form, 'nickname').trim();
    var phone = fieldValue(form, 'phone').trim();

    var fail = function (m) { if (errEl) errEl.textContent = m; };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('이메일 형식을 확인해 주세요.');
    if (!isAllowedSignupEmail(email)) return fail(SIGNUP_EMAIL_ERROR);
    if (pw.length < 6) return fail('비밀번호는 6자 이상으로 정해 주세요.');
    if (pw !== pw2) return fail('비밀번호 확인이 일치하지 않습니다.');
    if (nickname.length < 2) return fail('닉네임은 2자 이상 입력해 주세요.');
    if (!/^[0-9+\-\s]{9,20}$/.test(phone)) return fail('휴대폰 번호를 확인해 주세요.');

    var btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.textContent = '가입 중…'; }
    try {
      await Backend.signUp({ email: email, password: pw, nickname: nickname, phone: phone });
      closeModal();
      renderAll();
      toast(nickname + ' 님, 환영합니다! 뽑기권은 구매확인 후 지급됩니다.', 'ok');
      location.hash = '#/my';
    } catch (e) {
      if (errEl) errEl.textContent = errMsg(e);
      if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = '가입하고 시작하기'; }
    }
  }

  async function doLogin(form) {
    var errEl = $('[data-role="auth-error"]', form);
    var email = fieldValue(form, 'email').trim().toLowerCase();
    var pw = fieldValue(form, 'password');
    if (!email || !pw) { if (errEl) errEl.textContent = '이메일과 비밀번호를 입력해 주세요.'; return; }
    var btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.textContent = '로그인 중…'; }
    try {
      var user = await Backend.signIn(email, pw);
      closeModal();
      renderAll();
      toast((user && user.nickname ? user.nickname + ' 님, ' : '') + '다시 오셨네요!', 'ok');
      if (ui.view === 'my') renderMy();
    } catch (e) {
      if (errEl) errEl.textContent = errMsg(e);
      if (btn) { btn.removeAttribute('aria-disabled'); btn.textContent = '로그인'; }
    }
  }

  async function demoLogin() {
    try {
      closeModal();
      if (Backend.mode === 'local') {
        var user = state.users.filter(function (u) { return u.id === 'u-demo'; })[0];
        if (!user) throw new Error('체험 계정이 없습니다.');
        state.session = { userId: user.id, at: nowISO() };
        persist();
        buildLocalViews();
      } else {
        await Backend.signIn('demo@kujiking.co.kr', 'demo1234');
      }
      renderAll();
      toast('체험 계정(쿠지러버)으로 로그인했어요 · 뽑기권 3장 지급됨', 'ok');
      if (ui.view === 'my') renderMy();
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  }

  async function logout() {
    await Backend.signOut();
    renderAll();
    if (ui.view === 'admin') {
      if (Backend.mode === 'supabase') ui.adminUnlocked = false;
      renderAdmin();
    }
    toast('로그아웃했어요');
  }

  /* =========================================================
     15. 이벤트
     ========================================================= */
  function bindEvents() {
    document.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-admin-tab]');
      if (tab) {
        ui.adminTab = tab.getAttribute('data-admin-tab');
        renderAdmin();
        return;
      }
      var myTab = e.target.closest('[data-my-tab]');
      if (myTab) {
        ui.myTab = myTab.getAttribute('data-my-tab');
        renderMy();
        return;
      }
      var bTab = e.target.closest('[data-board-tab]');
      if (bTab) {
        ui.boardTab = bTab.getAttribute('data-board-tab');
        renderBoard();
        return;
      }

      var el = e.target.closest('[data-action]');
      if (!el) {
        var navLink = e.target.closest('.main-nav a');
        if (navLink) setMenu(false);
        return;
      }
      var action = el.getAttribute('data-action');
      var id = el.getAttribute('data-id');
      var n = Number(el.getAttribute('data-n'));

      switch (action) {
        case 'close-modal': closeModal(); break;
        case 'confirm-yes': if (confirmResolve) { var yes = confirmResolve; confirmResolve = null; closeModal(); yes(true); } break;
        case 'confirm-no': if (confirmResolve) { var no = confirmResolve; confirmResolve = null; closeModal(); no(false); } break;

        case 'open-auth': openAuthModal(); break;
        case 'auth-tab': ui.authTab = el.getAttribute('data-tab'); openModal(authModalHTML()); break;
        case 'demo-login': demoLogin(); break;
        case 'logout': logout(); break;
        case 'go-my': closeModal(); location.hash = '#/my'; break;
        case 'go-claim':
          closeModal();
          ui.myTab = 'claims';
          if (location.hash !== '#/my') location.hash = '#/my';
          else renderMy();
          break;
        case 'open-code-modal': openCodeModal(); break;
        case 'open-youtube-live': openYoutubeLive(); break;
        case 'open-kakao': openKakaoInquiry(); break;
        case 'test-kakao': {
          var csForm = $('form[data-form="save-cs"]');
          var csInput = csForm ? csForm.querySelector('input[name="kakao"]') : null;
          var csTyped = csInput ? csInput.value.trim() : '';
          if (csTyped && !kakaoTarget(csTyped)) { toast('주소를 확인해 주세요. 예: https://pf.kakao.com/_xnxhmvX/chat', 'err'); break; }
          if (!csTyped && !kakaoOpenchatUrl()) { toast('먼저 카카토톡 채널 상담 주소를 입력해 주세요', 'err'); break; }
          openKakaoInquiry(csTyped);
          break;
        }
        case 'copy-cs-sql': {
          var csSqlForm = $('form[data-form="save-cs"]');
          var csSqlInput = csSqlForm ? csSqlForm.querySelector('input[name="kakao"]') : null;
          var csSqlNote = csSqlForm ? csSqlForm.querySelector('textarea[name="shipping"]') : null;
          copyText(csSettingsSql(
            csSqlInput ? csSqlInput.value.trim() : (state.settings.kakaoOpenchatUrl || ''),
            csSqlNote ? csSqlNote.value.replace(/\s+/g, ' ').trim() : (state.settings.shippingFeeNotice || '')
          ), 'SQL을 복사했어요');
          break;
        }
        case 'test-youtube-live': {
          var ytInput = $('form[data-form="save-youtube"] input[name="url"]');
          var ytTyped = ytInput ? ytInput.value.trim() : '';
          var ytTarget = youtubeLiveTarget(ytTyped) || youtubeLiveUrl();
          if (!ytTarget) { toast('먼저 유튜브 주소를 입력해 주세요', 'err'); break; }
          openInNewTab(ytTarget);
          break;
        }
        case 'copy-youtube-sql': {
          var ytSqlInput = $('form[data-form="save-youtube"] input[name="url"]');
          var ytSqlCheck = $('form[data-form="save-youtube"] input[name="enabled"]');
          copyText(youtubeLiveSql(ytSqlInput ? ytSqlInput.value.trim() : (state.settings.youtubeLiveUrl || ''), ytSqlCheck ? ytSqlCheck.checked : youtubeLiveEnabled()), 'SQL을 복사했어요');
          break;
        }
        case 'fill-demo-code': {
          var input = $('#multiCodeInput') || $('#drawCodeInput') || $('#quickCodeInput');
          if (input) { input.value = state.settings.demoCode; input.focus(); }
          break;
        }
        case 'scroll-grid': {
          if (ui.boardTab !== 'main') { ui.boardTab = 'main'; renderBoard(); }
          var grid = $('#ticketGrid');
          if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
        case 'pick-ticket': pickTicket(n); break;
        case 'multi-draw': openMultiDraw(Number(el.getAttribute('data-count')) || MULTI_COUNTS[0]); break;
        case 'reveal-card': {
          var rIdx = Number(el.getAttribute('data-idx'));
          if (!isNaN(rIdx)) openRevealCard(rIdx);
          break;
        }
        case 'reveal-all': revealAllCards(); break;
        case 'reveal-back': {
          var rbd = ui.draw;
          if (!rbd || !rbd.batch) break;
          rbd.spotlight = false;
          rbd.result = null;
          rbd.best = null;
          rbd.n = null;
          rbd.step = 'reveal';
          renderDrawModal();
          renderAll();
          break;
        }
        case 'reveal-summary': {
          var rsd = ui.draw;
          if (!rsd || !rsd.batch) break;
          if (rsd.step === 'promote') { rsd.promoSkip = true; break; }
          if (!rsd.revealed) rsd.revealed = {};
          /* 건너뛰고 요약으로 — 열지 않은 티켓은 공개 처리하고 결과 정리 화면으로 */
          (rsd.results || []).forEach(function (r, i) { if (!rsd.revealed[i]) rsd.revealed[i] = true; });
          rsd.promoReturn = null;
          rsd.promoIdx = -1;
          rsd.glowIdx = -1;
          rsd.step = 'result';
          renderDrawModal();
          renderAll();
          break;
        }
        case 'multi-coupon': {
          if (!ui.draw || !ui.draw.batch) break;
          var mBoard = getBoard(ui.draw.boardId);
          var mCoupons = mBoard ? couponsFor(mBoard) : [];
          if (mCoupons.length < ui.draw.count) { toast('뽑기권이 부족해요 (필요 ' + ui.draw.count + '장)', 'err'); break; }
          startMultiDraw({ couponIds: mCoupons.slice(0, ui.draw.count).map(function (c) { return c.id; }) });
          break;
        }
        case 'multi-points': {
          if (!ui.draw || !ui.draw.batch) break;
          startMultiDraw({ usePoints: true });
          break;
        }
        case 'zoom-tier': showTierZoom(el.getAttribute('data-grade')); break;
        case 'zoom-last': showTierZoom('LAST'); break;
        case 'ticket-info': showTicketInfo(n); break;
        case 'draw-pull': peelSnap(); break;
        case 'peel-snap': peelSnap(); break;
        case 'seal-snap': sealSnap(); break;
        case 'toggle-sound': {
          kujiSound.toggle();
          kujiSound.refreshToggle(true);
          if (!kujiSound.isMuted()) { kujiSound.unlock(); kujiSound.test(false); }
          break;
        }
        case 'draw-coupon': {
          if (!ui.draw) break;
          enterPeel({ couponId: id });
          break;
        }
        case 'draw-points': {
          if (!ui.draw) break;
          enterPeel({ usePoints: true });
          break;
        }
        case 'go-my-points': {
          closeModal();
          ui.myTab = 'inventory';
          if (location.hash !== '#/my') location.hash = '#/my';
          else renderMy();
          break;
        }

        case 'filter-cat': ui.filters.category = el.getAttribute('data-value'); renderHome(); break;
        case 'filter-price': ui.filters.price = el.getAttribute('data-value'); renderHome(); break;
        case 'reset-filter': ui.filters = { category: '전체', price: 'all', sort: 'recommend' }; renderHome(); break;

        case 'open-delivery': openDeliveryModal(id); break;
        case 'open-postcode': openPostcodeLayer(document.querySelector('form[data-form="delivery"]')); break;
        case 'close-postcode': closePostcodeLayer(); break;
        case 'convert-points': convertPointsFlow(id); break;

        case 'grant-open': openGrantModal(id); break;
        case 'admin-reload': ensureAdminData(true); break;
        case 'revoke-open': openRevokeModal(id, 0); break;
        case 'revoke-open-claim': {
          var rc = (state.adminClaims || []).filter(function (x) { return x.id === id; })[0];
          if (rc) openRevokeModal(rc.userId, Number(rc.granted) || 0, { nickname: rc.nickname, email: '' });
          break;
        }
        case 'revoke-preset':
          if (ui.revoke) { ui.revoke.qty = Number(el.getAttribute('data-qty')) || 1; renderRevokePicker(); }
          break;
        case 'revoke-next': renderRevokeConfirm(); break;
        case 'revoke-back': renderRevokePicker(); break;
        case 'revoke-confirm': runRevoke(); break;
        case 'claim-approve': openClaimModal(id); break;
        case 'claim-reject': rejectClaim(id); break;

        case 'new-board': openBoardEditor(null); break;
        case 'edit-board': openBoardEditor(id); break;
        case 'duplicate-board': openBoardEditor(null, { duplicate: getBoard(id) }); break;
        case 'reset-board': resetBoardFlow(id); break;
        case 'delete-board': deleteBoardFlow(id); break;
        case 'clear-all-boards': clearAllBoardsFlow(); break;
        case 'pick-image': {
          var form0 = boardFormOf(el);
          var scope = el.closest('.field') || el.closest('.tier-row') || form0;
          var fileInput = scope ? scope.querySelector('input[type="file"][data-upload="' + el.getAttribute('data-upload') + '"]') : null;
          if (fileInput) fileInput.click();
          break;
        }
        case 'kuji-import': kujiImportFlow(); break;
        case 'tier-fill-point': fillPointTier(); break;
        case 'reconnect-backend': reconnectBackend(); break;

        case 'copy-hash': { var b = getBoard(ui.fairnessBoardId) || state.boards[0]; if (b) copyText(b.seedHash, '봉인 해시를 복사했어요'); break; }
        case 'copy-seed': { var b2 = getBoard(ui.fairnessBoardId) || state.boards[0]; if (b2) copyText(b2.seed, '시드를 복사했어요'); break; }
        case 'fill-seed': {
          var b3 = getBoard(ui.fairnessBoardId) || state.boards[0];
          var seedInput = $('#verifySeed');
          if (b3 && seedInput) { seedInput.value = b3.seed; seedInput.focus(); toast('공개된 시드를 넣었어요. 계산을 눌러보세요.'); }
          break;
        }
        case 'copy-code': copyText(el.getAttribute('data-code'), '코드를 복사했어요'); break;
        case 'copy-reset-sql': copyText(RESET_BOARD_SQL, 'SQL을 복사했어요. Supabase SQL Editor 에 붙여넣고 Run 해 주세요.'); break;
        case 'copy-gen-all': if (ui.lastGen) copyText(ui.lastGen.codes.join('\n'), fmt(ui.lastGen.codes.length) + '개 코드를 복사했어요'); break;
        case 'copy-gen-sms':
          if (ui.lastGen) copyText(ui.lastGen.codes.map(function (c) {
            return '[쿠지킹] 교환 코드 ' + c + ' — kujiking.co.kr 에서 번호를 선택하고 코드를 입력해 주세요.';
          }).join('\n'), '문자 발송용 문구를 복사했어요');
          break;
        case 'download-gen':
          if (ui.lastGen) download('kujiking-codes-' + Date.now() + '.csv', '\ufeffcode\r\n' + ui.lastGen.codes.join('\r\n'), 'text/csv;charset=utf-8');
          break;
        case 'download-codes': {
          var rows = ['code,board,status,created_at,used_at,ticket'];
          state.codes.forEach(function (c) {
            var bb = c.boardId ? getBoard(c.boardId) : null;
            rows.push([c.code, (bb ? bb.title : '모든 판'), (c.usedAt ? 'used' : 'unused'), c.createdAt, c.usedAt || '', c.usedN || ''].join(','));
          });
          download('kujiking-codes-all-' + Date.now() + '.csv', '\ufeff' + rows.join('\r\n'), 'text/csv;charset=utf-8');
          break;
        }
        case 'gen-codes': generateCodesFlow(Number(el.getAttribute('data-count')) || 1); break;
        case 'revoke-code': revokeCodeFlow(el.getAttribute('data-code')); break;

        case 'tier-add': {
          var rowsBox = $('#tierRows');
          if (!rowsBox) break;
          var used = readTierRows().map(function (r) { return r.grade; });
          var next = GRADES.filter(function (g) { return used.indexOf(g) === -1; })[0] || 'H';
          rowsBox.insertAdjacentHTML('beforeend', tierRowsHTML([{ grade: next, label: '', count: 0, points: 0 }]));
          updateTierSummary();
          break;
        }
        case 'tier-add-point': {
          var pBox = $('#tierRows');
          if (!pBox) break;
          if (readTierRows().some(function (r) { return String(r.grade).toUpperCase() === 'P'; })) {
            toast('P상은 이미 있어요. 수량만 고치면 됩니다.', 'err');
            break;
          }
          var rows = readTierRows();
          var sum = rows.reduce(function (s, r) { return s + (isNaN(r.count) ? 0 : r.count); }, 0);
          var totalT = Number(($('input[name="tickets"]') || {}).value || 0);
          var rest = Math.max(0, totalT - sum);
          pBox.insertAdjacentHTML('beforeend', tierRowsHTML([{ grade: 'P', label: '굿즈 포인트 1,200P', count: rest, points: 1200, pointOnly: true }]));
          updateTierSummary();
          break;
        }
        case 'tier-remove': {
          var row = el.closest('.tier-row');
          if (row) row.remove();
          updateTierSummary();
          break;
        }
        case 'seed-regen': {
          var seedField = $('form[data-form="board-form"] input[name="seed"]');
          if (seedField) { seedField.value = randomSeed(); toast('새 시드를 만들었어요. 저장하면 기존 내역이 초기화됩니다.'); }
          break;
        }
        case 'export-data': exportData(); break;
        case 'wipe-data': wipeData(); break;
        case 'admin-logout':
          ui.adminUnlocked = false;
          try { sessionStorage.removeItem(ADMIN_KEY); } catch (e) {}
          if (Backend.mode === 'supabase') { logout(); }
          renderAdmin();
          toast('로그아웃했어요');
          break;
        default: break;
      }
    });

    /* ---------- 폼 ---------- */
    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form || !form.getAttribute) return;
      var type = form.getAttribute('data-form');
      if (!type) return;
      e.preventDefault();

      if (type === 'code-strip') {
        var board = getBoard(ui.boardId) || firstBoard();
        var value = fieldValue(form, 'code');
        if (!board) { toast('판매 중인 판이 없어요', 'err'); return; }
        var key = normalizeCode(value);
        var demoOk = key && key === normalizeCode(state.settings.demoCode);
        var codeOk = demoOk || state.codes.some(function (c) { return normalizeCode(c.code) === key && !c.usedAt; });
        if (!codeOk) {
          if (!key) toast('교환 코드를 입력해 주세요', 'err');
          else if (state.codes.some(function (c) { return normalizeCode(c.code) === key; })) toast('이미 사용된 코드예요', 'err');
          else toast('등록되지 않은 코드예요. 코드를 다시 확인해 주세요.', 'err');
          return;
        }
        ui.pendingCode = value;
        closeModal();
        if (location.hash !== '#/board/' + board.id) location.hash = '#/board/' + board.id;
        else renderBoard();
        setTimeout(function () {
          toast('코드 확인 완료! 번호를 선택하세요.', 'ok');
        }, 120);
        return;
      }

      if (type === 'login') { doLogin(form); return; }
      if (type === 'signup') { doSignup(form); return; }

      if (type === 'draw-code') {
        var d = ui.draw;
        if (!d) return;
        var board2 = getBoard(d.boardId);
        if (!board2) return;
        var raw = fieldValue(form, 'code');
        var k = normalizeCode(raw);
        var err2 = form.querySelector('[data-role="code-error"]');
        if (!k) { if (err2) err2.textContent = '교환 코드를 입력해 주세요.'; return; }
        var isDemo = k === normalizeCode(state.settings.demoCode);
        if (!isDemo) {
          var rec = state.codes.filter(function (c) { return normalizeCode(c.code) === k; })[0];
          if (Backend.mode === 'local') {
            if (!rec) { if (err2) err2.textContent = '등록되지 않은 코드예요. 코드를 다시 확인해 주세요.'; return; }
            if (rec.usedAt) { if (err2) err2.textContent = '이미 사용된 코드예요 (' + formatDateTime(rec.usedAt) + ').'; return; }
            if (rec.boardId && rec.boardId !== board2.id) { if (err2) err2.textContent = '이 코드는 다른 판 전용이에요.'; return; }
          }
        }
        enterPeel({ code: raw, demo: isDemo });
        return;
      }

      if (type === 'multi-code') {
        var md = ui.draw;
        if (!md || !md.batch) return;
        var mBoard2 = getBoard(md.boardId);
        if (!mBoard2) return;
        var mErr = form.querySelector('[data-role="code-error"]');
        var mRaw = fieldValue(form, 'code');
        var mKey = normalizeCode(mRaw);
        if (!mKey) { if (mErr) mErr.textContent = '교환 코드를 입력해 주세요.'; return; }
        if (mKey !== normalizeCode(state.settings.demoCode)) {
          if (mErr) mErr.textContent = '교환 코드는 1장 전용이에요. ' + md.count + '장 연뽑은 보유 쿠폰·포인트·체험 코드로 할 수 있어요.';
          return;
        }
        startMultiDraw({ code: mRaw, demo: true });
        return;
      }

      if (type === 'verify-hash') { verifyHash(fieldValue(form, 'seed')); return; }
      if (type === 'verify-ticket') { verifyTicket(fieldValue(form, 'seed'), fieldValue(form, 'ticket')); return; }

      if (type === 'admin-login') {
        adminLogin(fieldValue(form, 'pin'), $('#adminPinError'));
        return;
      }

      if (type === 'change-pin') {
        var errEl = $('#pinFormError');
        if (errEl) errEl.textContent = '';
        var cur = fieldValue(form, 'current').trim();
        var next = fieldValue(form, 'next').trim();
        var conf = fieldValue(form, 'confirm').trim();
        if (!/^\d{4,8}$/.test(next)) { if (errEl) errEl.textContent = '새 PIN은 숫자 4~8자리로 정해 주세요.'; return; }
        if (next !== conf) { if (errEl) errEl.textContent = '새 PIN 확인이 일치하지 않습니다.'; return; }
        sha256Hex(cur).then(function (hash) {
          if (hash !== state.settings.pinHash) { if (errEl) errEl.textContent = '현재 PIN이 맞지 않습니다.'; return; }
          sha256Hex(next).then(function (newHash) {
            state.settings.pinHash = newHash;
            state.settings.pinChanged = true;
            persist();
            form.reset();
            toast('PIN을 변경했어요', 'ok');
          });
        });
        return;
      }

      if (type === 'change-demo') {
        var demoErr = $('#demoFormError');
        if (demoErr) demoErr.textContent = '';
        var demoVal = fieldValue(form, 'demo').trim().toUpperCase();
        if (!/^[A-Z0-9-]{4,24}$/.test(demoVal)) { if (demoErr) demoErr.textContent = '영문·숫자·하이픈 4~24자로 입력해 주세요.'; return; }
        if (state.codes.some(function (c) { return normalizeCode(c.code) === normalizeCode(demoVal); })) {
          if (demoErr) demoErr.textContent = '실제 발급된 코드와 겹칩니다.';
          return;
        }
        state.settings.demoCode = demoVal;
        persist();
        toast('체험 코드를 변경했어요', 'ok');
        return;
      }

      if (type === 'save-youtube') {
        var ytErr = $('#ytLiveError');
        if (ytErr) ytErr.textContent = '';
        var ytUrl = fieldValue(form, 'url').trim();
        var ytCheckbox = form.querySelector('input[name="enabled"]');
        var ytEnabled = !!(ytCheckbox && ytCheckbox.checked);
        if (ytUrl && !youtubeLiveTarget(ytUrl)) {
          if (ytErr) ytErr.textContent = '주소를 확인해 주세요. 예: @kujiking 또는 https://www.youtube.com/@kujiking/live';
          return;
        }
        var ytSaveBtn = form.querySelector('button[type="submit"]');
        if (ytSaveBtn) { ytSaveBtn.setAttribute('aria-disabled', 'true'); ytSaveBtn.textContent = '저장 중…'; }
        saveYoutubeLive(ytUrl, ytEnabled).then(function (where) {
          if (ytSaveBtn) { ytSaveBtn.removeAttribute('aria-disabled'); ytSaveBtn.textContent = '저장'; }
          renderHeader();
          renderYoutubeSettings();
          toast(where === 'server' ? '유튜브 라이브 설정을 저장했어요 · 모든 방문자에게 바로 적용됩니다' : '유튜브 라이브 설정을 저장했어요', 'ok');
        }).catch(function (e7) {
          if (ytSaveBtn) { ytSaveBtn.removeAttribute('aria-disabled'); ytSaveBtn.textContent = '저장'; }
          if (ytErr) ytErr.textContent = '서버에 저장하지 못했어요: ' + errMsg(e7) + ' 아래 SQL을 Supabase SQL Editor에서 실행해 주세요.';
          var sqlBox = $('#ytLiveSql');
          if (sqlBox) { sqlBox.open = true; renderYoutubeSettings(); }
        });
        return;
      }

      if (type === 'save-cs') {
        var csErr = $('#csError');
        if (csErr) csErr.textContent = '';
        var csUrl = fieldValue(form, 'kakao').trim();
        var csNotice = fieldValue(form, 'shipping').replace(/\s+/g, ' ').trim();
        if (csUrl && !kakaoTarget(csUrl)) {
          if (csErr) csErr.textContent = '카카오톡 채널 주소를 확인해 주세요. 예: https://pf.kakao.com/_xnxhmvX/chat';
          return;
        }
        if (csNotice.length > 160) {
          if (csErr) csErr.textContent = '배송비 안내는 160자 이내로 적어 주세요.';
          return;
        }
        var csSaveBtn = form.querySelector('button[type="submit"]');
        if (csSaveBtn) { csSaveBtn.setAttribute('aria-disabled', 'true'); csSaveBtn.textContent = '저장 중…'; }
        saveCsSettings(csUrl, csNotice).then(function (where) {
          if (csSaveBtn) { csSaveBtn.removeAttribute('aria-disabled'); csSaveBtn.textContent = '저장'; }
          renderHeader();
          renderCsSettings();
          if (ui.view === 'my') renderMy();
          if (ui.view === 'board') renderView();
          if (ui.view === 'fairness') renderView();
          toast(where === 'server' ? '고객센터·배송비 설정을 저장했어요 · 모든 방문자에게 바로 적용됩니다' : '고객센터·배송비 설정을 저장했어요', 'ok');
        }).catch(function (e8) {
          if (csSaveBtn) { csSaveBtn.removeAttribute('aria-disabled'); csSaveBtn.textContent = '저장'; }
          if (csErr) csErr.textContent = '서버에 저장하지 못했어요: ' + errMsg(e8) + ' 아래 SQL을 Supabase SQL Editor에서 실행해 주세요.';
          var csSqlBox = $('#csSql');
          if (csSqlBox) { csSqlBox.open = true; renderCsSettings(); }
        });
        return;
      }

      if (type === 'board-form') { saveBoardForm(form); return; }
      if (type === 'claim') {
        var cerr = form.querySelector('[data-role="claim-error"]');
        var boardId = fieldValue(form, 'boardId');
        var qty = Number(fieldValue(form, 'qty'));
        var orderNo = fieldValue(form, 'orderNo').trim();
        var amount = Number(fieldValue(form, 'amount')) || 0;
        if (!boardId) { if (cerr) cerr.textContent = '구매한 판을 선택해 주세요.'; return; }
        if (!(qty >= 1 && qty <= 100)) { if (cerr) cerr.textContent = '수량은 1~100장 사이로 입력해 주세요.'; return; }
        if (!orderNo) { if (cerr) cerr.textContent = '주문번호 또는 입금자명을 입력해 주세요.'; return; }
        var btnC = form.querySelector('button[type="submit"]');
        if (btnC) { btnC.setAttribute('aria-disabled', 'true'); btnC.textContent = '보내는 중…'; }
        Backend.submitClaim({
          boardId: boardId, channel: fieldValue(form, 'channel'), orderNo: orderNo,
          qty: qty, amount: amount, memo: fieldValue(form, 'memo').trim()
        }).then(function () {
          form.reset();
          if (btnC) { btnC.removeAttribute('aria-disabled'); btnC.textContent = '구매확인 요청 보내기'; }
          renderMy();
          toast('구매확인 요청을 보냈어요. 확인 후 뽑기권이 지급됩니다.', 'ok');
        }).catch(function (e2) {
          if (cerr) cerr.textContent = errMsg(e2);
          if (btnC) { btnC.removeAttribute('aria-disabled'); btnC.textContent = '구매확인 요청 보내기'; }
        });
        return;
      }

      if (type === 'delivery') {
        var derr = form.querySelector('[data-role="delivery-error"]');
        var info = {
          recipient: fieldValue(form, 'recipient').trim(),
          phone: fieldValue(form, 'phone').trim(),
          postcode: fieldValue(form, 'postcode').trim(),
          address: [fieldValue(form, 'address').trim(), fieldValue(form, 'detail').trim()].filter(Boolean).join(' '),
          memo: fieldValue(form, 'memo').trim()
        };
        if (!info.recipient || !info.phone || !info.address) {
          if (derr) derr.textContent = '받는 사람·연락처·주소를 모두 입력해 주세요.';
          return;
        }
        var btnD = form.querySelector('button[type="submit"]');
        if (btnD) { btnD.setAttribute('aria-disabled', 'true'); btnD.textContent = '신청 중…'; }
        Backend.requestDelivery(form.getAttribute('data-id'), info).then(function () {
          closeModal();
          ui.myTab = 'inventory';
          renderAll();
          toast('배송 신청을 접수했어요. 출고되면 운송장이 표시됩니다.', 'ok');
        }).catch(function (e3) {
          if (derr) derr.textContent = errMsg(e3);
          if (btnD) { btnD.removeAttribute('aria-disabled'); btnD.textContent = '배송 신청'; }
        });
        return;
      }

      if (type === 'grant') {
        var gerr = form.querySelector('[data-role="grant-error"]');
        var qtyG = Number(fieldValue(form, 'qty'));
        if (!(qtyG >= 1 && qtyG <= 100)) { if (gerr) gerr.textContent = '지급 수량은 1~100장 사이입니다.'; return; }
        var btnG = form.querySelector('button[type="submit"]');
        if (btnG) { btnG.setAttribute('aria-disabled', 'true'); btnG.textContent = '지급 중…'; }
        Backend.grantCoupons(ui.grantUserId, fieldValue(form, 'boardId') || null, qtyG, fieldValue(form, 'note').trim())
          .then(function () {
            closeModal();
            renderAdmin();
            renderHeader();
            toast(qtyG + '장의 뽑기권을 지급했어요', 'ok');
          })
          .catch(function (e4) {
            if (gerr) gerr.textContent = errMsg(e4);
            if (btnG) { btnG.removeAttribute('aria-disabled'); btnG.textContent = '지급하기'; }
          });
        return;
      }

      if (type === 'claim-approve') {
        var aerr = form.querySelector('[data-role="approve-error"]');
        var qtyA = Number(fieldValue(form, 'qty'));
        if (!(qtyA >= 1 && qtyA <= 100)) { if (aerr) aerr.textContent = '지급 수량은 1~100장 사이입니다.'; return; }
        var btnA = form.querySelector('button[type="submit"]');
        if (btnA) { btnA.setAttribute('aria-disabled', 'true'); btnA.textContent = '승인 중…'; }
        Backend.decideClaim(ui.approveClaimId, true, qtyA)
          .then(function () {
            closeModal();
            renderAdmin();
            renderHeader();
            toast('승인하고 ' + qtyA + '장을 지급했어요', 'ok');
          })
          .catch(function (e5) {
            if (aerr) aerr.textContent = errMsg(e5);
            if (btnA) { btnA.removeAttribute('aria-disabled'); btnA.textContent = '승인하고 지급'; }
          });
        return;
      }

      if (type === 'ship') {
        var carrier = fieldValue(form, 'carrier');
        var tracking = fieldValue(form, 'tracking').trim();
        if (!tracking) { toast('운송장 번호를 입력해 주세요', 'err'); return; }
        var btnS = form.querySelector('button[type="submit"]');
        if (btnS) { btnS.setAttribute('aria-disabled', 'true'); btnS.textContent = '처리 중…'; }
        Backend.shipDelivery(form.getAttribute('data-id'), carrier, tracking)
          .then(function () {
            renderAdmin();
            renderHeader();
            toast('출고 완료로 처리했어요', 'ok');
          })
          .catch(function (e6) {
            toast(errMsg(e6), 'err');
            if (btnS) { btnS.removeAttribute('aria-disabled'); btnS.textContent = '출고 완료'; }
          });
        return;
      }
    });

    document.addEventListener('input', function (e) {
      if (e.target.closest('form[data-form="signup"]') && e.target.name === 'email') {
        var noteEl = e.target.closest('form').querySelector('[data-role="signup-email-note"]');
        if (noteEl) {
          var bad = e.target.value.indexOf('@') !== -1 && !isAllowedSignupEmail(e.target.value);
          noteEl.classList.toggle('is-bad', bad);
          noteEl.textContent = bad ? SIGNUP_EMAIL_ERROR : SIGNUP_EMAIL_NOTE;
        }
      }
      if (e.target.closest('form[data-form="save-youtube"]')) updateYoutubePreview();
      if (e.target.closest('form[data-form="save-cs"]')) updateCsPreview();
      if (e.target.closest('#tierRows') || (e.target.name === 'tickets' && e.target.closest('form[data-form="board-form"]'))) updateTierSummary();
      if (e.target.getAttribute('data-role') === 'tier-image') {
        var prev = e.target.closest('.tier-extra') && e.target.closest('.tier-extra').querySelector('[data-role="tier-thumb"]');
        if (prev) { var v = e.target.value.trim(); prev.innerHTML = v ? '<img src="' + escapeHtml(v) + '" alt="">' : ''; }
      }
      if (e.target.name === 'cover' && e.target.closest('form[data-form="board-form"]')) updateCoverPreview(e.target.closest('form'));
      if (e.target.id === 'codeSearch') renderCodesTable();
      if (e.target.id === 'revokeQty') refreshRevokePicks(e.target.value);
      if (e.target.id === 'memberSearch') {
        ui.memberQuery = e.target.value;
        clearTimeout(ui._memberTimer);
        ui._memberTimer = setTimeout(function () {
          if (Backend.mode === 'supabase') {
            Backend.loadAdmin().then(renderMembersTab).catch(function () {});
          } else {
            renderMembersTab();
          }
        }, 250);
      }
      if (e.target.id === 'claimAmount') return;
      if (e.target.closest('form[data-form="claim"]') && (e.target.name === 'qty' || e.target.name === 'boardId')) {
        autoClaimAmount();
      }
    });

    document.addEventListener('change', function (e) {
      if (e.target && e.target.matches && e.target.matches('input[type="file"][data-upload]')) {
        handleUploadFile(e.target);
        return;
      }
      if (e.target.id === 'fairBoardSelect') {
        ui.fairnessBoardId = e.target.value;
        var vr = $('#verifyResult'); if (vr) vr.hidden = true;
        var vt = $('#verifyTicketResult'); if (vt) vt.hidden = true;
        renderFairness();
        history.replaceState(null, '', '#/fairness/' + e.target.value);
      }
      if (e.target.id === 'winnersBoardFilter') { ui.winnersBoardId = e.target.value; renderWinners(); }
      if (e.target.id === 'boardSort') { ui.filters.sort = e.target.value; renderHome(); }
      if (e.target.id === 'codeFilter') renderCodesTable();
      if (e.target.id === 'revokeQty' && ui.revoke) e.target.value = ui.revoke.qty;
      if (e.target.id === 'claimBoardSelect') autoClaimAmount();
      if (e.target.matches && e.target.matches('[data-role="cover-preset"]')) {
        var cform = e.target.closest('form');
        var cinput = cform ? cform.querySelector('input[name="cover"]') : null;
        if (cinput) {
          if (e.target.value === '__url') { cinput.value = ''; cinput.focus(); }
          else cinput.value = e.target.value;
          updateCoverPreview(cform);
        }
      }
      if (e.target.closest('form[data-form="claim"]') && e.target.name === 'qty') autoClaimAmount();
      if (e.target.id === 'importFile') {
        if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
        e.target.value = '';
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.id === 'kujiSrc') {
        e.preventDefault();
        kujiImportFlow();
        return;
      }
      if (e.key === 'Escape' && modalRoot && !modalRoot.hidden) {
        if (document.getElementById('postcodeLayer')) { closePostcodeLayer(); return; }
        if (confirmResolve) { var r = confirmResolve; confirmResolve = null; closeModal(); r(false); }
        else closeModal();
      }
    });

    var navToggle = $('#navToggle');
    if (navToggle) navToggle.addEventListener('click', function () {
      setMenu(!$('#mainNav').classList.contains('open'));
    });

    window.addEventListener('hashchange', route);

    /* 두 탭/창을 동시에 열어도 실시간처럼 동기화 */
    try {
      if (!channel && typeof BroadcastChannel === 'function') channel = new BroadcastChannel('kujiking-v2');
      if (channel) channel.onmessage = function () {
        if (Backend.mode !== 'local') return;
        var fresh = loadLocalStateSync();
        if (!fresh) return;
        state = normalizeLocalState(fresh);
        buildLocalViews();
        renderAll();
      };
    } catch (e) {}
    window.addEventListener('storage', function (e) {
      if (Backend.mode !== 'local' || e.key !== STATE_KEY) return;
      var fresh = loadLocalStateSync();
      if (!fresh) return;
      state = normalizeLocalState(fresh);
      buildLocalViews();
      renderAll();
    });
  }

  function autoClaimAmount() {
    var form = $('form[data-form="claim"]');
    if (!form) return;
    var boardId = fieldValue(form, 'boardId');
    var qty = Number(fieldValue(form, 'qty')) || 1;
    var board = getBoard(boardId);
    var amountEl = form.querySelector('#claimAmount') || form.querySelector('input[name="amount"]');
    if (board && amountEl) amountEl.value = board.price * qty;
  }

  async function convertPointsFlow(drawId) {
    var d = (state.myDraws || []).filter(function (x) { return x.id === drawId; })[0];
    if (!d) return;
    var board = getBoard(d.boardId);
    var tier = board ? tierOf(board, d.grade) : null;
    var points = tier ? Number(tier.points || 0) : 0;
    var ok = await confirmDialog({
      title: '굿즈 포인트로 전환할까요?',
      message: '<b>' + h(d.tierLabel || '당첨 상품') + '</b>을(를) 배송 대신 <b>' + fmt(points) + 'P</b>로 바꿉니다.<br>전환 후에는 상품으로 받을 수 없어요.',
      confirmLabel: fmt(points) + 'P 전환'
    });
    if (!ok) return;
    try {
      await Backend.convertPoints(drawId);
      renderAll();
      toast(fmt(points) + 'P를 적립했어요', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function rejectClaim(claimId) {
    var ok = await confirmDialog({
      title: '구매확인 요청을 반려할까요?',
      message: '회원에게 뽑기권이 지급되지 않습니다. 주문 정보를 다시 확인해 주세요.',
      confirmLabel: '반려',
      danger: true
    });
    if (!ok) return;
    try {
      await Backend.decideClaim(claimId, false, 0);
      renderAdmin();
      renderHeader();
      toast('요청을 반려했어요');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function resetBoardFlow(id) {
    var b = getBoard(id);
    if (!b) return;
    var sold = openedCount(b);
    var ok = await confirmDialog({
      title: '🔄 판매 초기화',
      message: '<b>' + h(b.title) + '</b><br><br>정말 이 판의 모든 판매 기록(티켓·보관함·배송요청)을 0건으로 초기화할까요?' +
        '<br><span class="muted small">지금 판매 ' + fmt(sold) + '/' + fmt(b.tickets) + '장 · 등급 배치와 시드는 그대로 남습니다.</span>',
      confirmLabel: '판매 초기화',
      danger: true
    });
    if (!ok) return;
    try {
      var res = await Backend.resetBoard(id);
      mapCache.clear();
      buildLocalViews();
      renderAll();
      renderAdmin();
      toast('판매 기록을 0건으로 초기화했어요', 'ok');
      if (res && res.rpcMissing) showResetSqlFallback();
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  /* 서버 함수 admin_reset_board 가 아직 없을 때: 한 번만 설치하면 되는 SQL 안내 */
  function showResetSqlFallback() {
    var cfg = Backend.config || {};
    var ref = supabaseProjectRef(cfg.SUPABASE_URL);
    var sqlUrl = ref ? 'https://supabase.com/dashboard/project/' + ref + '/sql/new' : 'https://supabase.com/dashboard';
    openModal(
      '<h2 class="modal-title" id="modalTitle">초기화는 완료했어요</h2>' +
      '<p class="modal-sub">관리자 권한으로 <b>이미 0건으로 초기화</b>했습니다. 앞으로도 버튼 한 번으로 안전하게 처리되도록, Supabase SQL Editor 에 아래 함수를 한 번만 설치해 주세요.</p>' +
      '<pre class="reset-sql">' + h(RESET_BOARD_SQL) + '</pre>' +
      '<div class="btn-row tight">' +
        '<button class="btn btn-primary btn-sm" data-action="copy-reset-sql">SQL 복사</button>' +
        '<a class="btn btn-outline btn-sm" href="' + sqlUrl + '" target="_blank" rel="noopener">SQL Editor 열기</a>' +
        '<a class="btn btn-outline btn-sm" href="https://github.com/pkn8238-source/Kujiking/blob/main/supabase/schema.sql" target="_blank" rel="noopener">schema.sql 보기</a>' +
      '</div>',
      { wide: true }
    );
  }

  /* P상 수량 자동 계산 — 전체 장수 − 실물 등급 합계 (1,200P) */
  function fillPointTier() {
    if (!$('#tierRows')) return;
    var total = Number(($('form[data-form="board-form"] input[name="tickets"]') || {}).value || 0);
    var rows = readTierRows();
    var realSum = rows.filter(function (r) { return String(r.grade).toUpperCase() !== 'P' && !r.pointOnly; })
      .reduce(function (s, r) { return s + (isNaN(r.count) ? 0 : r.count); }, 0);
    if (!(total > 0)) { toast('전체 장수를 먼저 입력해 주세요.', 'err'); return; }
    var need = total - realSum;
    if (need < 0) { toast('실물 등급 합계(' + fmt(realSum) + '장)가 전체 장수보다 많아요.', 'err'); return; }
    var pRow = $$('#tierRows .tier-row').filter(function (row) {
      var sel = row.querySelector('select[name="grade"]');
      return sel && String(sel.value).toUpperCase() === 'P';
    })[0];
    if (pRow) {
      var cnt = pRow.querySelector('input[name="count"]');
      if (cnt) cnt.value = need;
      var pts = pRow.querySelector('input[name="points"]');
      if (pts && !Number(pts.value)) pts.value = 1200;
      var chk = pRow.querySelector('input[name="pointOnly"]');
      if (chk) chk.checked = true;
    } else if (need > 0) {
      $('#tierRows').insertAdjacentHTML('beforeend', tierRowsHTML([{ grade: 'P', label: '굿즈 포인트 1,200P', count: need, points: 1200, pointOnly: true }]));
    }
    updateTierSummary();
    toast(need > 0 ? ('P상 ' + fmt(need) + '장(1,200P)으로 맞췄어요') : 'P상이 필요 없어요 (남는 장수 0장)', 'ok');
  }

  /* 🗑️ 모든 판 전체 비우기 — 두 번 확인 후 실행 */
  async function clearAllBoardsFlow() {
    var ok1 = await confirmDialog({
      title: '🗑️ 모든 판 전체 비우기',
      message: '<b>판 ' + fmt(state.boards.length) + '개</b>와 판매 기록·보관함·배송 요청·구매확인 요청을 모두 지웁니다.' +
        '<br><span class="muted small">회원 계정과 굿즈 포인트는 그대로 남습니다. 이 작업은 되돌릴 수 없어요.</span>',
      confirmLabel: '계속',
      danger: true
    });
    if (!ok1) return;
    var ok2 = await confirmDialog({
      title: '정말 전부 지울까요?',
      message: '손님 화면에서도 판이 모두 사라집니다.<br><br><b>정말로 전체 비우기를 실행할까요?</b>' +
        '<br><span class="muted small">마지막 확인입니다. 되돌릴 수 없어요.</span>',
      confirmLabel: '전체 비우기 실행',
      danger: true
    });
    if (!ok2) return;
    try {
      toast('전체 비우는 중…');
      await Backend.clearAllBoards();
      mapCache.clear();
      buildLocalViews();
      renderAll();
      renderAdmin();
      toast('모든 판과 기록을 비웠어요. 이제 새 판을 만들면 됩니다.', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  /* 서버에 다시 연결 (빈 화면에서 재시도) */
  async function reconnectBackend() {
    var btn = $('[data-action="reconnect-backend"]');
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.textContent = '다시 연결 중…'; }
    try {
      await Backend.init();
      if (Backend.mode === 'supabase') {
        state = emptyState();
        await Backend.refreshData();
        Backend.fallbackReason = '';
        Backend.fallbackDetail = '';
        Backend.justFellBack = false;
        state.loadError = '';
        renderAll();
        route();
        toast('서버에 연결했어요', 'ok');
      } else {
        state.loadError = '아직 서버에 연결하지 못했어요. 잠시 후 다시 눌러주세요.';
        renderAll();
        toast('아직 연결하지 못했어요', 'err');
      }
    } catch (e) {
      state.loadError = errMsg(e);
      renderAll();
      toast(errMsg(e), 'err');
    }
  }

  async function deleteBoardFlow(id) {    var b = getBoard(id);
    if (!b) return;
    var linked = state.codes.filter(function (c) { return c.boardId === b.id; }).length;
    var ok = await confirmDialog({
      title: '판을 삭제할까요?',
      message: '<b>' + h(b.title) + '</b>와 연결된 코드 ' + fmt(linked) + '개가 함께 삭제됩니다. 이 작업은 되돌릴 수 없어요.',
      confirmLabel: '삭제',
      danger: true
    });
    if (!ok) return;
    try {
      await Backend.deleteBoard(id);
      renderAll();
      renderAdmin();
      toast('판을 삭제했어요', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function generateCodesFlow(count) {
    var target = $('#genBoard') ? $('#genBoard').value : '';
    try {
      var codes = await Backend.generateCodes(target || null, count);
      ui.lastGen = { batch: uid('batch'), codes: codes, boardId: target || null, at: nowISO() };
      renderCodesTab();
      toast(count + '개 코드를 발급했어요', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  async function revokeCodeFlow(codeVal) {
    var ok = await confirmDialog({
      title: '코드를 폐기할까요?',
      message: '<b>' + h(codeVal) + '</b> 코드를 삭제합니다. 아직 사용하지 않은 코드만 폐기할 수 있어요.',
      confirmLabel: '폐기',
      danger: true
    });
    if (!ok) return;
    try {
      await Backend.revokeCode(codeVal);
      renderCodesTab();
      toast('코드를 폐기했어요', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  }

  function adminLogin(pin, errorEl) {
    var value = String(pin || '').trim();
    if (!/^\d{4,8}$/.test(value)) {
      if (errorEl) errorEl.textContent = 'PIN은 숫자 4~8자리입니다.';
      return;
    }
    sha256Hex(value).then(function (hash) {
      if (hash === state.settings.pinHash) {
        ui.adminUnlocked = true;
        try { sessionStorage.setItem(ADMIN_KEY, '1'); } catch (e) {}
        if (errorEl) errorEl.textContent = '';
        renderAdmin();
        toast('관리자로 들어왔어요', 'ok');
      } else {
        if (errorEl) errorEl.textContent = 'PIN이 맞지 않습니다.';
        var gate = $('#adminGate');
        if (gate) { gate.classList.remove('shake'); void gate.offsetWidth; gate.classList.add('shake'); }
        var input = $('#adminPin');
        if (input) { input.value = ''; input.focus(); }
      }
    });
  }

  function openCodeModal() {
    var board = getBoard(ui.boardId) || firstBoard();
    openModal('<h2 class="modal-title" id="modalTitle">교환 코드 입력</h2>' +
      '<p class="modal-sub">구매 후 받은 1회용 코드를 넣으면 뽑기판에서 바로 사용할 수 있어요. 코드는 한 번만 쓸 수 있습니다.</p>' +
      '<form class="code-form" data-form="code-strip" novalidate>' +
        '<label class="sr-only" for="quickCodeInput">교환 코드</label>' +
        '<input id="quickCodeInput" class="code-input" name="code" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="24" placeholder="KJ-XXXX-XXXX" value="' + h(ui.pendingCode || '') + '">' +
        '<p class="field-error" data-role="code-error" role="alert"></p>' +
        '<button class="btn btn-primary" type="submit">코드 확인</button>' +
      '</form>' +
      '<div class="demo-box demo-only">' +
        '<p><strong>체험용 무료 코드</strong>' + h(state.settings.demoCode) + ' — 결제 없이 뽑기를 미리 체험해 볼 수 있어요.</p>' +
        '<button class="btn btn-outline btn-sm" type="button" data-action="fill-demo-code">' + h(state.settings.demoCode) + ' 넣기</button>' +
      '</div>' +
      (board ? '<p class="result-meta">사용할 판 · ' + h(board.title) + '</p>' : ''));
  }

  /* ---------- 백업 ---------- */
  function exportData() {
    var payload = {
      app: APP_TAG, v: STATE_VERSION, exportedAt: nowISO(),
      note: '쿠지킹 v2 백업 — 관리자에서 가져오기로 복원할 수 있습니다.',
      data: {
        settings: state.settings, boards: state.boards, users: state.users, coupons: state.coupons,
        draws: state.draws, claims: state.claims, deliveries: state.deliveries, codes: state.codes
      }
    };
    var d = new Date();
    var stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
    download('kujiking-backup-' + stamp + '.json', JSON.stringify(payload, null, 2));
    toast('백업 파일을 내려받았어요', 'ok');
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { toast('JSON 파일을 읽을 수 없어요', 'err'); return; }
      var incoming = parsed && parsed.app === APP_TAG ? parsed.data : parsed;
      if (!incoming || !Array.isArray(incoming.boards)) {
        toast('쿠지킹 백업 파일이 아니에요', 'err');
        return;
      }
      confirmDialog({
        title: '백업을 가져올까요?',
        message: '현재 판 ' + fmt(state.boards.length) + '개, 회원 ' + fmt((state.users || []).length) + '명이 백업 파일의 내용으로 바뀝니다.',
        confirmLabel: '가져오기',
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        if (Backend.mode !== 'local') { toast('Supabase 모드에서는 JSON 복원을 사용할 수 없어요', 'err'); return; }
        state = Object.assign(emptyState(), incoming);
        state.settings = Object.assign({ demoCode: 'DEMO-KUJI', pinHash: '' }, state.settings || {});
        normalizeLocalState(state);
        var jobs = state.boards.map(function (b) {
          if (!b.seed) b.seed = randomSeed();
          if (!b.seedHash) return sha256Hex(b.seed).then(function (hash) { b.seedHash = hash; });
        });
        Promise.all(jobs).then(function () {
          persist();
          buildLocalViews();
          mapCache.clear();
          renderAll();
          renderAdmin();
          toast('백업을 복원했어요', 'ok');
        });
      });
    };
    reader.readAsText(file);
  }

  function wipeData() {
    confirmDialog({
      title: '전체 데이터를 초기화할까요?',
      message: '모든 판, 회원, 쿠폰, 뽑기 내역이 삭제되고 샘플 데이터로 되돌아갑니다. 이 작업은 되돌릴 수 없어요.',
      confirmLabel: '초기화',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      if (Backend.mode !== 'local') { toast('Supabase 모드에서는 전체 초기화를 사용할 수 없어요', 'err'); return; }
      seedState().then(function (fresh) {
        state = fresh;
        ui.lastGen = null;
        persist();
        buildLocalViews();
        mapCache.clear();
        renderAll();
        renderAdmin();
        toast('초기화했어요', 'ok');
      });
    });
  }

  /* =========================================================
     16. 시작
     ========================================================= */
  async function init() {
    modalRoot = $('#modalRoot');
    modalPanel = $('#modalPanel');
    modalShell = $('.modal-shell');

    try { ui.adminUnlocked = sessionStorage.getItem(ADMIN_KEY) === '1'; } catch (e) {}

    bindEvents();
    window.KUJIKING = { version: '2.0', mode: 'local' };

    var mode = 'local';
    try {
      mode = await Backend.init();
    } catch (e) {
      console.warn('[쿠지킹] 백엔드 초기화 실패', e);
      Backend.mode = 'local';
    }
    window.KUJIKING.mode = Backend.mode;

    if (Backend.mode === 'local') {
      state = await loadLocalState();
      var sid = null;
      try { sid = localStorage.getItem(SESSION_KEY); } catch (e) {}
      /* 세션은 state.session 으로 관리 (별도 키는 v1 호환용) */
      if (!state.session && sid) state.session = { userId: sid, at: nowISO() };
      if (state.session && state.session.userId && !userById(state.session.userId)) state.session = null;
      buildLocalViews();
    } else {
      state = emptyState();
      try {
        await Backend.refreshData();
      } catch (e) {
        console.warn('[쿠지킹] 서버 데이터 로드 실패', e);
        if (Backend.config && Backend.config.SUPABASE_URL && Backend.config.SUPABASE_ANON_KEY) {
          /* 서버는 설정돼 있는데 데이터만 못 읽은 경우 —
             가짜 데모 판 8개를 되살리지 않고 빈 화면 + 다시 연결 버튼을 보여준다. */
          state.loadError = errMsg(e);
          Backend.fallbackReason = Backend.fallbackReason || Backend.classify(e);
          Backend.fallbackDetail = Backend.fallbackDetail || ((e && e.message) || String(e || ''));
        } else {
          Backend.mode = 'local';
          Backend.justFellBack = true;
          Backend.fallbackReason = Backend.fallbackReason || Backend.classify(e);
          Backend.fallbackDetail = Backend.fallbackDetail || ((e && e.message) || String(e || ''));
          window.KUJIKING.mode = 'local';
          state = await loadLocalState();
          buildLocalViews();
        }
      }
    }

    window.KUJIKING.mode = Backend.mode;
    window.KUJIKING.backend = { reason: Backend.fallbackReason, detail: Backend.fallbackDetail };

    /* 기존 hash 가 없으면 홈으로 */
    if (!location.hash) history.replaceState(null, '', '#/');
    ui.ready = true;
    renderAll();
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
