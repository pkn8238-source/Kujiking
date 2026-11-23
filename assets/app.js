/* =========================================================
   쿠지킹 KUJIKING — app.js (vanilla, static, no build step)
   - Hash routing: #/  #/board/:id  #/winners  #/fairness  #/admin
   - State in localStorage + JSON export/import (Admin)
   - Real SHA-256 commitments via Web Crypto
   ========================================================= */
(function () {
  'use strict';

  var STORAGE_KEY = 'kujiking.state.v1';
  var ADMIN_SESSION_KEY = 'kujiking.admin.session.v1';
  var APP_TAG = 'kujiking';
  var STATE_VERSION = 1;
  var MAX_TICKETS = 300;

  var state = null;
  var mapCache = new Map();
  var ui = {
    view: 'home',
    boardId: null,
    pendingCode: '',
    adminUnlocked: false,
    adminTab: 'codes',
    fairnessBoardId: null,
    winnersBoardId: 'all',
    draw: null,
    lastGen: null,
    editingBoardId: null
  };

  /* ---------------- utilities ---------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function fieldValue(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value : '';
  }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var h = escapeHtml;
  var ICONS = {
    ticket: '<path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4V7z"/><path d="M14 7v10"/>',
    crown: '<path d="M3 8l4.5 4L12 4l4.5 8L21 8l-2 11H5L3 8z"/><path d="M5 19h14"/>',
    gift: '<rect x="3" y="8" width="18" height="13" rx="2.2"/><path d="M3 12.5h18M12 8v13"/><path d="M12 8S10 3.5 7.6 3.5 6.4 8 12 8zM12 8s2-4.5 4.4-4.5S17.6 8 12 8z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H16"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.6 2.6L16 9.6"/>',
    x: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    alert: '<path d="M12 3.2l9.2 16.3H2.8L12 3.2z"/><path d="M12 9.2v4.6M12 17h.01"/>'
  };
  function icon(name, cls) {
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }
  function fmt(n) { return Number(n || 0).toLocaleString('ko-KR'); }
  function won(n) { return fmt(n) + '원'; }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function nowISO() { return new Date().toISOString(); }
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }
  function normalizeCode(v) { return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function maskCode(code) {
    var c = String(code || '');
    if (c.length <= 6) return c.slice(0, 2) + '••';
    return c.slice(0, 5) + '••••' + c.slice(-2);
  }
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

  function sha256Hex(text) {
    var data = new TextEncoder().encode(String(text));
    return crypto.subtle.digest('SHA-256', data).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }
  function randomSeed() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function randomCode() {
    var chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    var bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < 8; i++) out += chars[bytes[i] % chars.length];
    return 'KJ-' + out.slice(0, 4) + '-' + out.slice(4);
  }

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
    }, 2400);
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

  /* ---------------- state ---------------- */
  function defaultTiers() {
    return [
      { grade: 'A', label: '스페셜 컬러 피규어', count: 2, points: 0 },
      { grade: 'B', label: '피규어 (노멀)', count: 4, points: 0 },
      { grade: 'C', label: '아크릴 스탠드', count: 8, points: 0 },
      { grade: 'D', label: '캔배지 3종 세트', count: 16, points: 0 },
      { grade: 'E', label: '굿즈 포인트 교환권', count: 50, points: 3000 }
    ];
  }

  function newBoardObject(input) {
    var seed = input.seed || randomSeed();
    return sha256Hex(seed).then(function (seedHash) {
      return {
        id: input.id || uid('board'),
        title: input.title || '새 쿠지판',
        tag: input.tag || '자체쿠지',
        price: Number(input.price) || 9900,
        tickets: Number(input.tickets) || 80,
        tiers: input.tiers || defaultTiers(),
        lastOneLabel: input.lastOneLabel || '라스트원상 · 메탈릭 컬러 피규어',
        status: input.status || 'open',
        seed: seed,
        seedHash: seedHash,
        opens: [],
        createdAt: nowISO(),
        sealedAt: nowISO()
      };
    });
  }

  function makeDefaultState() {
    return newBoardObject({
      id: 'b-open-1',
      title: '[자체쿠지] 오픈 기념 피규어 스페셜 1탄',
      tag: '자체쿠지',
      price: 9900,
      tickets: 80,
      tiers: defaultTiers(),
      lastOneLabel: '라스트원상 · 메탈릭 컬러 피규어'
    }).then(function (board) {
      return {
        v: STATE_VERSION,
        settings: { demoCode: 'DEMO-KUJI', pinHash: '', pinChanged: false, storeName: '쿠지통령' },
        boards: [board],
        codes: [],
        createdAt: nowISO(),
        updatedAt: nowISO()
      };
    });
  }

  function loadState() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.boards)) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function save() {
    state.updatedAt = nowISO();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { toast('저장 공간이 부족해 저장하지 못했어요', 'err'); }
  }

  function getBoard(id) {
    for (var i = 0; i < state.boards.length; i++) if (state.boards[i].id === id) return state.boards[i];
    return null;
  }
  function firstBoard() {
    var open = state.boards.filter(function (b) { return b.status === 'open'; });
    return open[0] || state.boards[0] || null;
  }
  function remaining(board) { return Math.max(0, board.tickets - board.opens.length); }
  function openedCount(board) { return board.opens.length; }
  function tierOf(board, grade) {
    for (var i = 0; i < board.tiers.length; i++) if (board.tiers[i].grade === grade) return board.tiers[i];
    return null;
  }
  function gradeColor(grade) { return 'var(--grade-' + String(grade || 'e').toLowerCase() + ')'; }
  function tierSum(board) {
    return board.tiers.reduce(function (s, t) { return s + Number(t.count || 0); }, 0);
  }
  function isRevealed(board) { return remaining(board) === 0 || board.status === 'closed'; }

  /* ---------------- deterministic mapping ---------------- */
  function computeMapping(seed, tickets, tiers) {
    var jobs = [];
    for (var n = 1; n <= tickets; n++) {
      jobs.push(sha256Hex(seed + ':' + n));
    }
    return Promise.all(jobs).then(function (hashes) {
      var ranks = hashes.map(function (hash, idx) { return { n: idx + 1, hash: hash }; });
      ranks.sort(function (a, b) { return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0; });
      var map = {};
      var i = 0;
      tiers.forEach(function (t) {
        for (var k = 0; k < Number(t.count || 0) && i < ranks.length; k++) {
          map[ranks[i].n] = t.grade;
          i++;
        }
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

  function gradeCounts(board) {
    return getMapping(board).then(function (map) {
      var opened = {};
      board.opens.forEach(function (o) { opened[o.grade] = (opened[o.grade] || 0) + 1; });
      return board.tiers.map(function (t) {
        return {
          grade: t.grade,
          label: t.label,
          count: Number(t.count),
          points: Number(t.points || 0),
          opened: opened[t.grade] || 0,
          left: Number(t.count) - (opened[t.grade] || 0)
        };
      });
    });
  }

  function pointsRemaining(board, counts) {
    return counts.reduce(function (sum, c) { return sum + c.left * c.points; }, 0);
  }

  /* ---------------- modal ---------------- */
  var modalRoot, modalPanel, modalShell;
  var lastFocused = null;

  function openModal(html, opts) {
    opts = opts || {};
    modalRoot.hidden = false;
    modalShell.classList.toggle('wide', !!opts.wide);
    modalPanel.innerHTML = html;
    document.body.style.overflow = 'hidden';
    if (!opts.keepFocus) {
      var focusable = modalPanel.querySelector('input,select,button');
      if (focusable) setTimeout(function () { focusable.focus(); }, 40);
    }
    lastFocused = document.activeElement;
  }

  function closeModal() {
    if (!modalRoot || modalRoot.hidden) return;
    modalRoot.hidden = true;
    modalPanel.innerHTML = '';
    document.body.style.overflow = '';
    ui.draw = null;
    if (ui.confirmResolve) { var pending = ui.confirmResolve; ui.confirmResolve = null; pending(false); }
    if (lastFocused && lastFocused.focus) { try { lastFocused.focus(); } catch (e) {} }
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
      ui.confirmResolve = resolve;
    });
  }

  /* ---------------- router ---------------- */
  function parseRoute() {
    var raw = (location.hash || '#/').replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean);
    var seg = parts[0] || 'home';
    if (seg === 'board') return { view: 'board', id: parts[1] || null };
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
      if (!board) { ui.view = 'home'; }
      else ui.boardId = board.id;
    }
    if (r.view === 'fairness' && r.id && getBoard(r.id)) ui.fairnessBoardId = r.id;
    if (r.view === 'winners' && r.id) ui.winnersBoardId = r.id;

    $$('[data-view]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-view') === ui.view);
    });
    var navKey = ui.view === 'board' ? 'board' : ui.view;
    $$('.main-nav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === navKey);
    });
    setMenu(false);
    if (!modalRoot.hidden) closeModal();
    ui.draw = null;

    window.scrollTo({ top: 0, behavior: 'auto' });
    renderView();
  }

  function renderView() {
    if (ui.view === 'home') { renderHome(); return; }
    if (ui.view === 'board') { renderBoard(); return; }
    if (ui.view === 'winners') { renderWinners(); return; }
    if (ui.view === 'fairness') { renderFairness(); return; }
    if (ui.view === 'admin') { renderAdmin(); }
  }

  /* ---------------- home ---------------- */
  function gradeChipsHTML(board) {
    return board.tiers.map(function (t) {
      return '<span class="grade-chip"><i style="background:' + gradeColor(t.grade) + '"></i>' +
        h(t.grade) + ' <b>' + fmt(t.count) + '</b></span>';
    }).join('');
  }

  function boardCardHTML(board) {
    var left = remaining(board);
    var pct = board.tickets ? Math.round(openedCount(board) / board.tickets * 100) : 0;
    var soldout = left === 0;
    var statusBadge = soldout
      ? '<span class="badge badge-closed cover-status">전량 소진</span>'
      : board.status === 'open'
        ? '<span class="badge badge-live cover-status">진행 중</span>'
        : '<span class="badge badge-closed cover-status">종료</span>';
    return '' +
      '<article class="board-card">' +
        '<a class="board-card-cover" href="#/board/' + h(board.id) + '" aria-label="' + h(board.title) + ' 열기">' +
          '<span class="badge cover-tag">' + h(board.tag || '자체쿠지') + '</span>' +
          statusBadge +
          '<img src="assets/logo-760.png" alt="">' +
        '</a>' +
        '<div class="board-card-body">' +
          '<h3><a href="#/board/' + h(board.id) + '">' + h(board.title) + '</a></h3>' +
          '<div class="board-card-meta">' +
            '<span>총 <b>' + fmt(board.tickets) + '</b>장</span><span>·</span>' +
            '<span>1장 <b>' + won(board.price) + '</b></span><span>·</span>' +
            '<span>라스트원상 포함</span>' +
          '</div>' +
          '<div class="progress">' +
            '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="progress-labels"><span>개봉 ' + fmt(openedCount(board)) + '장</span><span>남은 번호 <b>' + fmt(left) + '</b>장</span></div>' +
          '</div>' +
          '<div class="grade-chips">' + gradeChipsHTML(board) + '</div>' +
          '<div class="board-card-foot">' +
            '<div class="price-tag"><strong>' + fmt(board.price) + '</strong><span>원 / 1장</span></div>' +
            (soldout
              ? '<span class="btn btn-outline" aria-disabled="true">전량 소진</span>'
              : '<a class="btn btn-primary" href="#/board/' + h(board.id) + '">뽑기 시작</a>') +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderHome() {
    var openBoards = state.boards.filter(function (b) { return b.status === 'open' && remaining(b) > 0; });
    var totalLeft = state.boards.reduce(function (s, b) { return s + remaining(b); }, 0);
    var factBoards = $('#factBoards');
    if (factBoards) factBoards.textContent = fmt(openBoards.length);
    var factRemaining = $('#factRemaining');
    if (factRemaining) factRemaining.textContent = fmt(totalLeft);

    var first = openBoards[0] || state.boards[0];
    var heroLink = $('#heroBoardLink');
    if (heroLink) heroLink.href = first ? '#/board/' + first.id : '#/board';

    var list = $('#boardList');
    if (!list) return;
    list.classList.toggle('is-single', state.boards.length === 1);
    if (!state.boards.length) {
      list.innerHTML = '<div class="card empty" style="grid-column:1/-1"><span class="empty-icon">' + icon('ticket') + '</span><p>아직 열린 판이 없어요. 관리자에서 새 판을 만들어 보세요.</p><a class="btn btn-outline" href="#/admin">관리자로 이동</a></div>';
      return;
    }
    list.classList.toggle('is-single', state.boards.length === 1);
    list.innerHTML = state.boards.map(boardCardHTML).join('');
  }

  /* ---------------- board view ---------------- */
  function renderBoard() {
    var board = getBoard(ui.boardId) || firstBoard();
    if (!board) {
      var hero = $('#boardHero');
      if (hero) hero.innerHTML = '<div class="empty" style="padding:40px"><p>열린 쿠지판이 없어요.</p><a class="btn btn-primary" href="#/admin">판 만들기</a></div>';
      return;
    }
    ui.boardId = board.id;
    renderBoardHero(board);
    renderTicketGrid(board);
    renderBoardAside(board);
    renderBoardNotice(board);
    gradeCounts(board).then(function (counts) {
      renderBoardAside(board, counts);
      renderBoardHero(board, counts);
    });
  }

  function renderBoardHero(board, counts) {
    var el = $('#boardHero');
    if (!el) return;
    var left = remaining(board);
    var pct = board.tickets ? Math.round(openedCount(board) / board.tickets * 100) : 0;
    el.innerHTML = '' +
      '<div class="board-cover"><img src="assets/logo-760.png" alt="쿠지킹"></div>' +
      '<div class="board-hero-body">' +
        '<span class="pill pill-cream">' + h(board.tag || '자체쿠지') + ' · ' + fmt(board.tickets) + '장 한 판</span>' +
        '<h1>' + h(board.title) + '</h1>' +
        '<div class="board-meta">' +
          '<span>1장 <b>' + won(board.price) + '</b></span>' +
          '<span>총 <b>' + fmt(board.tickets) + '</b>장</span>' +
          '<span>남은 번호 <b>' + fmt(left) + '</b>장</span>' +
          '<span>라스트원상 포함</span>' +
        '</div>' +
        '<div class="progress">' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="progress-labels"><span>개봉 ' + fmt(openedCount(board)) + ' / ' + fmt(board.tickets) + '</span><span>' + pct + '% 진행</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="board-hero-cta">' +
        '<div class="price-tag"><strong>' + fmt(board.price) + '</strong><span>원 / 1장</span></div>' +
        (left === 0
          ? '<span class="btn btn-outline" aria-disabled="true">전량 소진</span>'
          : '<button class="btn btn-primary" data-action="open-code-modal">교환 코드 입력</button>') +
        '<small>' + (left === 0 ? '이 판은 전량 소진되었습니다' : '번호를 고르면 바로 개봉할 수 있어요') + '</small>' +
      '</div>';
  }

  function renderBoardAside(board, counts) {
    var el = $('#boardStatus');
    if (!el) return;
    var rows = '';
    if (counts) {
      rows = counts.map(function (c) {
        var out = c.left === 0;
        return '' +
          '<div class="grade-row' + (out ? ' is-out' : '') + '">' +
            '<span class="grade-badge" style="background:' + gradeColor(c.grade) + '">' + h(c.grade) + '</span>' +
            '<span class="grade-name"><b>' + h(c.label) + '</b><span>' + (c.points ? '굿즈 포인트 ' + fmt(c.points) + 'P' : '실물 상품') + '</span></span>' +
            '<span class="grade-count">' + (out ? '소진' : '<em>' + fmt(c.left) + '</em> / ' + fmt(c.count)) + '</span>' +
          '</div>';
      }).join('');
    }
    var points = counts ? pointsRemaining(board, counts) : 0;
    el.innerHTML = '' +
      '<h2>등급 현황 <span class="badge badge-live">실시간</span></h2>' +
      '<div class="grade-rows">' + (rows || '<p class="muted" style="font-size:13px">등급 정보를 불러오는 중…</p>') + '</div>' +
      '<div class="point-card"><span>남은 굿즈 포인트</span><strong>' + fmt(points) + 'P</strong></div>' +
      '<div class="lastone-card"><span>LAST ONE</span><b>' + h(board.lastOneLabel || '라스트원상') + '</b></div>';
  }

  function renderBoardNotice(board) {
    var el = $('#boardNotice');
    if (!el) return;
    var probs = board.tiers.map(function (t) {
      return t.grade + ' ' + (t.count / board.tickets * 100).toFixed(1).replace(/\.0$/, '') + '%';
    }).join(' · ');
    el.innerHTML = '' +
      '<h3>' + h(board.title) + ' 안내</h3>' +
      '<ul>' +
        '<li>1장 ' + won(board.price) + ' · 총 ' + fmt(board.tickets) + '장 · 라스트원상 별도 지급</li>' +
        '<li>등급별 확률: ' + h(probs) + '</li>' +
        '<li>교환 코드는 1회용이며, 개봉(코드 사용) 후에는 재사용할 수 없습니다.</li>' +
        '<li>개봉 후에는 청약철회가 제한됩니다. (전자상거래법 제17조 제2항 제2호)</li>' +
        '<li>하위 등급은 굿즈 포인트로 지급되며, 포인트는 쿠지통령 스마트스토어에서 사용할 수 있습니다.</li>' +
        '<li>당첨 상품은 주문 시 입력한 배송지로 발송됩니다.</li>' +
      '</ul>' +
      '<p class="fine">봉인 해시(SHA-256): <code>' + h(board.seedHash) + '</code><br>' +
      '결과는 판이 열리기 전 봉인되었으며, <a href="#/fairness/' + h(board.id) + '" style="text-decoration:underline">공정성 검증</a>에서 직접 확인할 수 있습니다.</p>';
  }

  function renderTicketGrid(board) {
    var grid = $('#ticketGrid');
    if (!grid) return;
    var opened = new Map();
    board.opens.forEach(function (o) { opened.set(o.n, o); });
    var html = '';
    for (var n = 1; n <= board.tickets; n++) {
      var o = opened.get(n);
      if (o) {
        html += '<button class="ticket is-open" style="--ticket-color:' + gradeColor(o.grade) + '" ' +
          'data-action="ticket-info" data-n="' + n + '" ' +
          'aria-label="' + n + '번, ' + h(o.grade) + '상 개봉 완료">' +
          '<span class="ticket-grade">' + h(o.grade) + '</span>' +
          '<span class="ticket-num">' + n + '</span>' +
          (o.last ? '<span class="last-flag" aria-hidden="true">' + icon('crown') + '</span>' : '') +
          '</button>';
      } else {
        html += '<button class="ticket" data-action="pick-ticket" data-n="' + n + '" aria-label="' + n + '번 선택">' +
          '<span class="ticket-num">' + pad2(n) + '</span>' +
          '<span class="ticket-hint">뽑기</span>' +
          '</button>';
      }
    }
    grid.innerHTML = html;
    var summary = $('#gridSummary');
    if (summary) summary.textContent = fmt(board.tickets) + '장 중 ' + fmt(remaining(board)) + '장 남음';
  }

  /* ---------------- codes ---------------- */
  function codeStatus(raw, board) {
    var key = normalizeCode(raw);
    if (!key) return { ok: false, msg: '교환 코드를 입력해 주세요.' };
    if (key === normalizeCode(state.settings.demoCode)) {
      return { ok: true, demo: true, code: state.settings.demoCode };
    }
    var rec = null;
    for (var i = 0; i < state.codes.length; i++) {
      if (normalizeCode(state.codes[i].code) === key) { rec = state.codes[i]; break; }
    }
    if (!rec) return { ok: false, msg: '등록되지 않은 코드예요. 코드를 다시 확인해 주세요.' };
    if (rec.usedAt) {
      return { ok: false, msg: '이미 사용된 코드예요 (' + formatDateTime(rec.usedAt) + ' · ' + rec.usedN + '번)' };
    }
    if (rec.boardId && rec.boardId !== board.id) {
      var other = getBoard(rec.boardId);
      return { ok: false, msg: '이 코드는 다른 판(' + (other ? other.title : '삭제된 판') + ') 전용이에요.' };
    }
    return { ok: true, demo: false, code: rec.code, rec: rec };
  }

  /* ---------------- draw flow ---------------- */
  function pickTicket(n) {
    var board = getBoard(ui.boardId);
    if (!board) return;
    if (remaining(board) === 0) { toast('이 판은 전량 소진되었어요', 'err'); return; }
    var existing = board.opens.filter(function (o) { return o.n === n; })[0];
    if (existing) { showTicketInfo(n); return; }

    ui.draw = { boardId: board.id, n: n, step: 'code', code: '', demo: false };
    if (ui.pendingCode) {
      var st = codeStatus(ui.pendingCode, board);
      if (st.ok) {
        ui.draw.step = 'pull';
        ui.draw.code = st.code;
        ui.draw.demo = st.demo;
        ui.draw.rec = st.rec || null;
      } else {
        ui.draw.code = ui.pendingCode;
        ui.pendingCode = '';
      }
    }
    renderDrawModal();
  }

  function renderDrawModal() {
    var d = ui.draw;
    if (!d) return;
    var board = getBoard(d.boardId);
    if (!board) return;
    var html;
    if (d.step === 'code') html = codeStageHTML(board, d);
    else if (d.step === 'pull') html = pullStageHTML(board, d);
    else html = resultStageHTML(board, d);
    openModal(html, { closeGuard: true });
    var input = $('#drawCodeInput');
    if (input) { input.focus(); input.select && input.select(); }
  }

  function codeStageHTML(board, d) {
    var t = tierOf(board, 'A');
    return '' +
      '<h2 class="modal-title" id="modalTitle">' + d.n + '번 뽑기</h2>' +
      '<p class="modal-sub">이 번호를 개봉하려면 교환 코드가 필요해요. 코드는 개봉 시 1회 사용됩니다.</p>' +
      '<form class="code-form" data-form="draw-code" novalidate>' +
        '<label class="sr-only" for="drawCodeInput">교환 코드</label>' +
        '<input id="drawCodeInput" class="code-input" name="code" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="24" placeholder="KJ-XXXX-XXXX" value="' + h(d.code || '') + '">' +
        '<p class="field-error" data-role="code-error" role="alert"></p>' +
        '<button class="btn btn-primary" type="submit">코드 확인</button>' +
      '</form>' +
      '<div class="demo-box">' +
        '<p><strong>체험용 무료 코드</strong>DEMO-KUJI — 실제 결제 없이 뽑기를 미리 체험해 볼 수 있어요.</p>' +
        '<button class="btn btn-outline btn-sm" type="button" data-action="fill-demo-code">DEMO-KUJI 넣기</button>' +
      '</div>' +
      '<p class="result-meta">' + h(board.title) + '</p>';
  }

  function pullStageHTML(board, d) {
    return '' +
      '<div class="draw-stage">' +
        '<p class="result-kicker">TICKET ' + pad2(d.n) + '</p>' +
        '<h2 class="modal-title" id="modalTitle" style="padding-right:0">종이를 당겨주세요</h2>' +
        '<p class="modal-sub">번호 ' + d.n + '번의 결과가 준비됐어요. 아래 종이를 눌러 개봉하세요.</p>' +
        '<div class="draw-ticket shake-me" role="button" tabindex="0" aria-label="종이 당겨서 개봉" data-action="draw-pull">' +
          '<span class="draw-ticket-label">KUJIKING KUJI</span>' +
          '<span class="draw-ticket-num">' + pad2(d.n) + '</span>' +
          '<span class="draw-ticket-label">TAP TO OPEN</span>' +
        '</div>' +
        '<p class="pull-hint">한 번 개봉하면 되돌릴 수 없어요.</p>' +
        '<p class="result-meta">사용 코드 ' + h(maskCode(d.code)) + (d.demo ? ' · 체험 모드' : '') + '</p>' +
      '</div>';
  }

  function confettiHTML() {
    var colors = ['#ffd51e', '#ff7a1a', '#ef3b2d', '#12a87a', '#3d7bfd', '#f5b800'];
    var out = '';
    for (var i = 0; i < 26; i++) {
      var left = Math.round(Math.random() * 100);
      var delay = (Math.random() * .5).toFixed(2);
      var dx = Math.round((Math.random() - .5) * 160);
      var color = colors[i % colors.length];
      out += '<span class="confetti" style="left:' + left + '%;background:' + color + ';animation-delay:' + delay + 's;--dx:' + dx + 'px"></span>';
    }
    return out;
  }

  function resultStageHTML(board, d) {
    var tier = d.tier || tierOf(board, d.grade) || { label: '', points: 0 };
    var left = remaining(board);
    return '' +
      '<div class="result-stage">' +
        confettiHTML() +
        '<div class="result-badge" style="background:' + gradeColor(d.grade) + '">' + h(d.grade) + '</div>' +
        '<p class="result-kicker">' + (d.demo ? '체험 결과' : 'DRAW RESULT') + '</p>' +
        '<p class="result-grade">' + h(d.grade) + '상 당첨!</p>' +
        '<p class="result-prize">' + h(tier.label || '') + '</p>' +
        (tier.points ? '<span class="result-points">' + icon('gift') + ' 굿즈 포인트 ' + fmt(tier.points) + 'P</span>' : '') +
        (d.isLast
          ? '<div class="result-lastone"><span>LAST ONE BONUS</span><b>' + h(board.lastOneLabel || '라스트원상') + '</b></div>'
          : '') +
        '<p class="remaining-line">남은 번호 <b>' + fmt(left) + '</b>장' + (left === 0 ? ' · 이 판은 전량 소진되었습니다' : '') + '</p>' +
        '<p class="result-meta">' + h(board.title) + ' · ' + d.n + '번' + (d.demo ? ' · 체험 코드 사용' : '') + '</p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-dark" data-action="close-modal">확인</button>' +
          (d.demo && left > 0 ? '<button class="btn btn-outline" data-action="demo-again">한 장 더 체험</button>' : '') +
        '</div>' +
      '</div>';
  }

  function performPull() {
    var d = ui.draw;
    if (!d || d.busy) return;
    var board = getBoard(d.boardId);
    if (!board) return;

    var already = board.opens.filter(function (o) { return o.n === d.n; })[0];
    if (already) { toast('이미 개봉된 번호예요', 'err'); closeModal(); return; }

    var st = codeStatus(d.code, board);
    if (!st.ok) {
      toast(st.msg, 'err');
      d.step = 'code';
      renderDrawModal();
      return;
    }
    d.busy = true;

    getMapping(board).then(function (map) {
      var grade = map[d.n] || board.tiers[board.tiers.length - 1].grade;
      var tier = tierOf(board, grade) || { label: '', points: 0 };
      var isLast = remaining(board) === 1;

      if (!st.demo && st.rec) {
        st.rec.usedAt = nowISO();
        st.rec.usedN = d.n;
      }
      board.opens.push({
        n: d.n,
        grade: grade,
        at: nowISO(),
        code: st.demo ? state.settings.demoCode : st.code,
        demo: !!st.demo,
        last: isLast
      });
      save();

      ui.pendingCode = st.demo ? state.settings.demoCode : '';
      ui.draw = {
        boardId: board.id,
        n: d.n,
        step: 'result',
        grade: grade,
        tier: tier,
        demo: !!st.demo,
        isLast: isLast
      };
      renderDrawModal();
      renderBoard();
      renderHome();
      toast(st.demo ? '체험 뽑기 완료!' : '뽑기 완료! 결과는 당첨 내역에 저장됐어요', 'ok');
    });
  }

  function showTicketInfo(n) {
    var board = getBoard(ui.boardId);
    if (!board) return;
    var o = board.opens.filter(function (x) { return x.n === n; })[0];
    if (!o) return;
    var tier = tierOf(board, o.grade) || { label: '', points: 0 };
    openModal('' +
      '<h2 class="modal-title" id="modalTitle">' + n + '번 · 개봉 완료</h2>' +
      '<p class="modal-sub">이미 개봉된 번호입니다. 결과는 변경되지 않아요.</p>' +
      '<div class="result-stage">' +
        '<div class="result-badge" style="background:' + gradeColor(o.grade) + '">' + h(o.grade) + '</div>' +
        '<p class="result-grade">' + h(o.grade) + '상</p>' +
        '<p class="result-prize">' + h(tier.label || '') + '</p>' +
        (tier.points ? '<span class="result-points">' + icon('gift') + ' 굿즈 포인트 ' + fmt(tier.points) + 'P</span>' : '') +
        (o.last ? '<div class="result-lastone"><span>LAST ONE BONUS</span><b>' + h(board.lastOneLabel || '라스트원상') + '</b></div>' : '') +
        '<p class="result-meta">' + formatDateTime(o.at) + ' · ' + h(maskCode(o.code)) + (o.demo ? ' · 체험' : '') + '</p>' +
        '<div class="modal-actions"><button class="btn btn-dark" data-action="close-modal">확인</button></div>' +
      '</div>');
  }

  /* ---------------- winners ---------------- */
  function allOpens(filterBoardId) {
    var rows = [];
    state.boards.forEach(function (b) {
      if (filterBoardId && filterBoardId !== 'all' && b.id !== filterBoardId) return;
      b.opens.forEach(function (o) {
        rows.push({ board: b, open: o });
      });
    });
    rows.sort(function (a, b) { return new Date(b.open.at) - new Date(a.open.at); });
    return rows;
  }

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

    var rows = allOpens(ui.winnersBoardId);
    var stats = $('#winnersStats');
    if (stats) {
      var byGrade = {};
      rows.forEach(function (r) { byGrade[r.open.grade] = (byGrade[r.open.grade] || 0) + 1; });
      var grades = [];
      state.boards.forEach(function (b) {
        b.tiers.forEach(function (t) { if (grades.indexOf(t.grade) === -1) grades.push(t.grade); });
      });
      grades.sort();
      if (!grades.length) grades = ['A', 'B', 'C', 'D', 'E'];
      stats.innerHTML = '<div class="stat is-highlight"><span>총 뽑은 수</span><strong>' + fmt(rows.length) + '장</strong></div>' +
        grades.map(function (g) {
          return '<div class="stat"><span>' + g + '상</span><strong>' + fmt(byGrade[g] || 0) + '개</strong></div>';
        }).join('') +
        '<div class="stat"><span>라스트원</span><strong>' + fmt(rows.filter(function (r) { return r.open.last; }).length) + '개</strong></div>';
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
          var tier = tierOf(r.board, r.open.grade) || { label: '', points: 0 };
          return '<tr>' +
            '<td class="num">' + formatDateTime(r.open.at) + '</td>' +
            '<td><a href="#/board/' + h(r.board.id) + '" style="text-decoration:underline">' + h(r.board.title) + '</a></td>' +
            '<td class="num">' + r.open.n + '번</td>' +
            '<td><span class="grade-badge" style="background:' + gradeColor(r.open.grade) + ';width:28px;height:28px;font-size:12px">' + h(r.open.grade) + '</span></td>' +
            '<td>' + h(tier.label || '-') + (tier.points ? ' <span class="muted">(' + fmt(tier.points) + 'P)</span>' : '') + (r.open.last ? ' <span class="badge" style="font-size:10px">' + icon('crown') + ' 라스트원</span>' : '') + '</td>' +
            '<td><span class="code-cell">' + h(maskCode(r.open.code)) + '</span>' + (r.open.demo ? ' <span class="muted" style="font-size:11px">체험</span>' : '') + '</td>' +
            '</tr>';
        }).join('');
      }
    }

    var notice = $('#winnersNotice');
    if (notice) {
      notice.innerHTML = '<h3>당첨 상품 수령 안내</h3><ul>' +
        '<li>이 내역은 현재 브라우저에 저장됩니다. 브라우저 기록을 지우면 함께 사라지니 관리자에서 백업해 두세요.</li>' +
        '<li>상품은 쿠지통령 스마트스토어 주문의 배송지로 발송됩니다. 주문 후 7일 이내에 배송 정보를 확인해 주세요.</li>' +
        '<li>굿즈 포인트는 판 종료 후 일괄 지급되며, 포인트 사용처는 스토어 공지에서 안내합니다.</li>' +
        '<li>결과에 문제가 있다고 느껴지면 공정성 검증 페이지에서 봉인 해시를 확인해 주세요.</li>' +
        '</ul>';
    }
  }

  /* ---------------- fairness ---------------- */
  function fairnessNoticeHTML() {
    return '' +
      '<h2>확률 · 이용 안내</h2>' +
      '<h3>1. 무작위 추첨 상품</h3>' +
      '<p>쿠지킹의 쿠지판은 판매 전 공개된 등급별 수량과 확률에 따라 번호별 결과가 무작위로 배정되는 상품입니다. 배정 결과는 판이 열리기 전 SHA-256 해시로 봉인되며, 결제·개봉 과정에서 변경되지 않습니다.</p>' +
      '<h3>2. 청약철회 제한</h3>' +
      '<p>「전자상거래 등에서의 소비자보호에 관한 법률」 제17조 제2항 제2호에 따라, 소비자의 사용 또는 일부 소비로 재판매가 곤란한 경우 청약철회가 제한됩니다. 교환 코드를 사용해 개봉한 경우가 이에 해당하며, 개봉 전에는 주문 취소가 가능합니다.</p>' +
      '<h3>3. 교환 코드</h3>' +
      '<p>교환 코드는 구매 1건당 1개가 발급되는 1회용 코드입니다. 타인에게 양도할 수 있으며, 사용 후에는 재사용할 수 없습니다. 코드를 분실한 경우 고객센터로 문의해 주세요.</p>' +
      '<h3>4. 등급 및 상품</h3>' +
      '<p>등급별 상품 구성과 수량은 판마다 다르며, 판 화면에 공개됩니다. 하위 등급은 굿즈 포인트로 대체 지급될 수 있습니다. 라스트원상은 확률 추첨이 아니라 판의 마지막 1장을 뽑은 분께 추가로 지급되는 상입니다.</p>' +
      '<h3>5. 상품 수령</h3>' +
      '<p>당첨 상품은 쿠지통령 스마트스토어 주문의 배송지로 발송됩니다. 주소 오류로 인한 반송은 재발송 비용이 발생할 수 있습니다.</p>' +
      '<h3>6. 미성년자 이용</h3>' +
      '<p>미성년자는 법정대리인의 동의를 받은 후 이용할 수 있습니다. 만 14세 미만은 이용할 수 없습니다.</p>' +
      '<h3>7. 결과 검증</h3>' +
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
    if (meta) meta.textContent = fmt(board.tickets) + '장 · 개봉 ' + fmt(openedCount(board)) + '장 · ' + (board.status === 'open' ? '판매 중' : '종료');

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
        '<dt>개봉</dt><dd>' + fmt(openedCount(board)) + '장</dd>' +
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
        '<code>' + h(computed) + '</code>' +
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
      var recorded = board.opens.filter(function (o) { return o.n === n; })[0];
      var agreement = recorded ? (recorded.grade === grade ? '기록된 결과와 일치합니다.' : '기록된 결과(' + recorded.grade + '상)와 다릅니다.') : '아직 개봉되지 않은 번호입니다.';
      box.className = 'verify-result ' + (recorded && recorded.grade !== grade ? 'fail' : 'ok');
      box.innerHTML = '<div class="vr-title">' + n + '번 → ' + h(grade) + '상</div>' +
        '<p>' + h(tier.label || '') + (tier.points ? ' · 굿즈 포인트 ' + fmt(tier.points) + 'P' : '') + '</p>' +
        '<p class="muted" style="margin-top:6px">' + h(agreement) + '</p>';
    });
  }

  /* ---------------- admin ---------------- */
  function renderAdmin() {
    var gate = $('#adminGate');
    var panel = $('#adminPanel');
    if (!gate || !panel) return;
    if (!ui.adminUnlocked) {
      gate.hidden = false;
      panel.hidden = true;
      var hint = $('#adminPinHint');
      if (hint) hint.hidden = !!state.settings.pinChanged;
      var pin = $('#adminPin');
      if (pin) pin.value = '';
      return;
    }
    gate.hidden = true;
    panel.hidden = false;
    $$('.admin-tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-admin-tab') === ui.adminTab);
    });
    $$('.admin-tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.getAttribute('data-admin-panel') === ui.adminTab);
    });
    if (ui.adminTab === 'codes') renderCodesTab();
    if (ui.adminTab === 'boards') renderBoardsTab();
    if (ui.adminTab === 'settings') renderSettingsTab();
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
    renderGenResult();
    renderCodesTable();
  }

  function renderGenResult() {
    var box = $('#genResult');
    if (!box) return;
    if (!ui.lastGen) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="gen-result-head">' +
        '<strong>' + fmt(ui.lastGen.codes.length) + '개 코드 발급 완료</strong>' +
        '<span class="muted" style="font-size:12px">' + formatDateTime(ui.lastGen.at) + '</span>' +
      '</div>' +
      '<div class="code-list">' + ui.lastGen.codes.map(function (c) {
        return '<span class="code-item">' + h(c) + '<button data-action="copy-code" data-code="' + h(c) + '" aria-label="' + h(c) + ' 복사">' + icon('copy') + '</button></span>';
      }).join('') + '</div>' +
      '<div class="btn-row tight">' +
        '<button class="btn btn-outline btn-sm" data-action="copy-gen-all">전체 복사</button>' +
        '<button class="btn btn-outline btn-sm" data-action="copy-gen-sms">문자 발송용 복사</button>' +
        '<button class="btn btn-outline btn-sm" data-action="download-gen">CSV 다운로드</button>' +
      '</div>';
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
      if (filter === 'demo' && !c.demo) return false;
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
      var status = c.demo ? '<span class="badge" style="background:#e8e2d8">체험</span>'
        : c.usedAt ? '<span class="badge badge-closed">사용</span>'
        : '<span class="badge" style="background:#d9ffe9">미사용</span>';
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

  function renderBoardsTab() {
    var list = $('#adminBoardList');
    if (!list) return;
    if (!state.boards.length) {
      list.innerHTML = '<div class="empty"><p>아직 만든 판이 없어요.</p></div>';
      return;
    }
    list.innerHTML = state.boards.map(function (b) {
      return '<div class="admin-board">' +
        '<div class="admin-board-thumb"><img src="assets/logo-760.png" alt=""></div>' +
        '<div class="admin-board-info">' +
          '<h3>' + h(b.title) + '</h3>' +
          '<p>' + h(b.tag || '자체쿠지') + ' · ' + fmt(b.tickets) + '장 · ' + won(b.price) + ' · 개봉 ' + fmt(openedCount(b)) + '/' + fmt(b.tickets) +
          ' · ' + (b.status === 'open' ? '판매 중' : '종료') + '</p>' +
          '<p style="font-family:var(--font-mono);font-size:11px;word-break:break-all">hash ' + h(String(b.seedHash || '').slice(0, 24)) + '…</p>' +
        '</div>' +
        '<div class="admin-board-actions">' +
          '<button class="btn btn-outline btn-sm" data-action="edit-board" data-id="' + h(b.id) + '">수정</button>' +
          '<button class="btn btn-outline btn-sm" data-action="reset-board" data-id="' + h(b.id) + '">판 초기화</button>' +
          '<button class="btn btn-danger-ghost btn-sm" data-action="delete-board" data-id="' + h(b.id) + '">삭제</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderSettingsTab() {
    var info = $('#storageInfo');
    if (!info) return;
    var bytes = 0;
    try { bytes = new Blob([localStorage.getItem(STORAGE_KEY) || '']).size; } catch (e) {}
    info.innerHTML = '저장된 판 ' + fmt(state.boards.length) + '개 · 코드 ' + fmt(state.codes.length) + '개 · 개봉 ' +
      fmt(state.boards.reduce(function (s, b) { return s + b.opens.length; }, 0)) + '건<br>' +
      '브라우저 저장소 사용량 약 ' + (bytes / 1024).toFixed(1) + 'KB · 마지막 저장 ' + formatDateTime(state.updatedAt);
    var demoInput = $('form[data-form="change-demo"] input[name="demo"]');
    if (demoInput && !demoInput.value) demoInput.value = state.settings.demoCode;
  }

  function generateCodes(count) {
    var target = $('#genBoard') ? $('#genBoard').value : '';
    var boardId = target || null;
    var made = [];
    for (var i = 0; i < count; i++) {
      var code;
      var guard = 0;
      do { code = randomCode(); guard++; } while (guard < 50 && state.codes.some(function (c) { return normalizeCode(c.code) === normalizeCode(code); }));
      var rec = { code: code, boardId: boardId, createdAt: nowISO(), usedAt: null, usedN: null, demo: false };
      state.codes.unshift(rec);
      made.push(code);
    }
    save();
    ui.lastGen = { batch: uid('batch'), codes: made, boardId: boardId, at: nowISO() };
    renderCodesTab();
    toast(count + '개 코드를 발급했어요', 'ok');
  }

  /* ---------------- board editor ---------------- */
  function tierRowsHTML(tiers) {
    return tiers.map(function (t) {
      return '<div class="tier-row">' +
        '<select name="grade">' + 'ABCDEFGH'.split('').map(function (g) {
          return '<option value="' + g + '"' + (g === t.grade ? ' selected' : '') + '>' + g + '상</option>';
        }).join('') + '</select>' +
        '<input name="label" type="text" maxlength="40" value="' + h(t.label) + '" placeholder="상품명">' +
        '<input name="count" type="number" min="0" step="1" value="' + Number(t.count) + '">' +
        '<input name="points" type="number" min="0" step="1000" value="' + Number(t.points || 0) + '">' +
        '<button type="button" class="tier-del" data-action="tier-remove" aria-label="등급 삭제">✕</button>' +
      '</div>';
    }).join('');
  }

  function openBoardEditor(boardId) {
    var board = boardId ? getBoard(boardId) : null;
    ui.editingBoardId = board ? board.id : null;
    var tiers = board ? board.tiers : defaultTiers();
    var tickets = board ? board.tickets : 80;
    var html = '' +
      '<h2 class="modal-title" id="modalTitle">' + (board ? '판 수정' : '새 판 만들기') + '</h2>' +
      '<p class="modal-sub">번호 구성과 등급 수량의 합계가 전체 장수와 같아야 저장됩니다.</p>' +
      '<form data-form="board-form" novalidate>' +
        '<div class="form-grid">' +
          '<label class="field span-2"><span>판 제목</span><input name="title" type="text" maxlength="60" required value="' + h(board ? board.title : '') + '" placeholder="예: [자체쿠지] 오픈 기념 피규어 스페셜 1탄"></label>' +
          '<label class="field"><span>태그</span><input name="tag" type="text" maxlength="16" value="' + h(board ? board.tag : '자체쿠지') + '"></label>' +
          '<label class="field"><span>1장 가격 (원)</span><input name="price" type="number" min="100" step="100" value="' + Number(board ? board.price : 9900) + '"></label>' +
          '<label class="field"><span>전체 장수</span><input name="tickets" type="number" min="1" max="' + MAX_TICKETS + '" step="1" value="' + Number(tickets) + '"></label>' +
          '<label class="field"><span>판매 상태</span><select name="status">' +
            '<option value="open"' + (!board || board.status === 'open' ? ' selected' : '') + '>판매 중</option>' +
            '<option value="closed"' + (board && board.status === 'closed' ? ' selected' : '') + '>종료</option>' +
          '</select></label>' +
          '<label class="field span-2"><span>라스트원상</span><input name="lastOneLabel" type="text" maxlength="60" value="' + h(board ? board.lastOneLabel : '라스트원상 · 메탈릭 컬러 피규어') + '"></label>' +
        '</div>' +
        '<div class="tier-editor" id="tierEditor">' +
          '<div class="tier-editor-head"><span>등급</span><span>상품명</span><span>수량</span><span>포인트</span><span></span></div>' +
          '<div id="tierRows">' + tierRowsHTML(tiers) + '</div>' +
          '<div class="tier-summary"><span>등급 수량 합계 <b id="tierSumLabel">0</b> / <b id="ticketTotalLabel">0</b>장</span><span id="tierSumState"></span></div>' +
        '</div>' +
        '<div class="btn-row tight"><button type="button" class="btn btn-outline btn-sm" data-action="tier-add">+ 등급 추가</button></div>' +
        '<label class="field" style="margin-top:14px"><span>시드 (비우면 자동 생성)</span>' +
          '<div class="seed-row"><input name="seed" type="text" value="' + h(board ? board.seed : '') + '" placeholder="자동 생성">' +
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
  }

  function readTierRows() {
    return $$('#tierRows .tier-row').map(function (row) {
      return {
        grade: $('select[name="grade"]', row).value,
        label: $('input[name="label"]', row).value.trim(),
        count: Number($('input[name="count"]', row).value),
        points: Number($('input[name="points"]', row).value || 0)
      };
    });
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

  function saveBoardForm(form) {
    var errEl = $('[data-role="board-error"]', form);
    var fail = function (msg) {
      if (errEl) errEl.textContent = msg;
      var editor = $('#tierEditor');
      if (editor) { editor.classList.remove('shake'); void editor.offsetWidth; editor.classList.add('shake'); }
    };
    var data = {
      title: fieldValue(form, 'title').trim(),
      tag: fieldValue(form, 'tag').trim() || '자체쿠지',
      price: Number(fieldValue(form, 'price')),
      tickets: Number(fieldValue(form, 'tickets')),
      status: fieldValue(form, 'status'),
      lastOneLabel: fieldValue(form, 'lastOneLabel').trim() || '라스트원상',
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
    var sum = data.tiers.reduce(function (s, t) { return s + t.count; }, 0);
    if (sum !== data.tickets) return fail('등급 수량 합계(' + fmt(sum) + '장)가 전체 장수(' + fmt(data.tickets) + '장)와 같아야 합니다.');

    var existing = ui.editingBoardId ? getBoard(ui.editingBoardId) : null;
    var structureChanged = !existing
      || existing.tickets !== data.tickets
      || JSON.stringify(existing.tiers.map(function (t) { return [t.grade, t.count, t.label, t.points]; })) !==
         JSON.stringify(data.tiers.map(function (t) { return [t.grade, t.count, t.label, t.points]; }))
      || (!!data.seed && data.seed !== existing.seed);

    var proceed = function () {
      var seed = data.seed || (existing ? existing.seed : '');
      // A changed ticket layout must be re-committed with a fresh seed,
      // otherwise the published hash would no longer describe this board.
      if (existing && structureChanged && seed === existing.seed) seed = randomSeed();
      if (!seed) seed = randomSeed();
      var task = sha256Hex(seed).then(function (hash) {
        if (existing) {
          existing.title = data.title;
          existing.tag = data.tag;
          existing.price = data.price;
          existing.tickets = data.tickets;
          existing.status = data.status;
          existing.lastOneLabel = data.lastOneLabel;
          existing.tiers = data.tiers;
          if (structureChanged) {
            existing.seed = seed;
            existing.seedHash = hash;
            existing.opens = [];
            existing.sealedAt = nowISO();
          }
        }
        return newBoardObject({
          title: data.title,
          tag: data.tag,
          price: data.price,
          tickets: data.tickets,
          status: data.status,
          lastOneLabel: data.lastOneLabel,
          tiers: data.tiers,
          seed: seed
        }).then(function (fresh) {
          if (existing) {
            // keep id + opens from the edited object
            fresh.id = existing.id;
            fresh.createdAt = existing.createdAt;
            fresh.opens = existing.opens;
            var idx = state.boards.indexOf(existing);
            state.boards[idx] = fresh;
          } else {
            state.boards.push(fresh);
          }
          save();
          ui.editingBoardId = null;
          closeModal();
          renderBoardsTab();
          renderHome();
          toast(existing ? '판을 수정했어요' : '새 판을 만들었어요', 'ok');
          if (ui.view === 'board' && ui.boardId === fresh.id) renderBoard();
        });
      });
      return task;
    };

    if (existing && structureChanged && existing.opens.length) {
      confirmDialog({
        title: '개봉 내역이 초기화됩니다',
        message: '번호 구성(장수·등급·시드)이 바뀌면 기존 개봉 내역 <b>' + fmt(existing.opens.length) + '건</b>이 초기화됩니다. 계속할까요?',
        confirmLabel: '초기화하고 저장',
        danger: true
      }).then(function (ok) {
        ui.confirmResolve = null;
        if (ok) proceed();
        else openBoardEditor(existing.id);
      });
    } else {
      proceed();
    }
  }

  /* ---------------- data export / import ---------------- */
  function exportData() {
    var payload = {
      app: APP_TAG,
      v: STATE_VERSION,
      exportedAt: nowISO(),
      note: '쿠지킹 사이트 백업 — 관리자에서 가져오기로 복원할 수 있습니다.',
      data: state
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
      if (!incoming || !Array.isArray(incoming.boards) || !incoming.settings) {
        toast('쿠지킹 백업 파일이 아니에요', 'err');
        return;
      }
      confirmDialog({
        title: '백업을 가져올까요?',
        message: '현재 저장된 판 ' + fmt(state.boards.length) + '개, 코드 ' + fmt(state.codes.length) + '개가 백업 파일의 내용으로 바뀝니다.',
        confirmLabel: '가져오기',
        danger: true
      }).then(function (ok) {
        ui.confirmResolve = null;
        if (!ok) return;
        state = incoming;
        state.settings = Object.assign({ demoCode: 'DEMO-KUJI' }, state.settings);
        Promise.all(state.boards.map(function (b) {
          if (!b.seed) b.seed = randomSeed();
          if (!b.seedHash) return sha256Hex(b.seed).then(function (hash) { b.seedHash = hash; });
        })).then(function () {
          save();
          mapCache.clear();
          renderAdmin();
          renderHome();
          toast('백업을 복원했어요', 'ok');
        });
      });
    };
    reader.readAsText(file);
  }

  function wipeData() {
    confirmDialog({
      title: '전체 데이터를 초기화할까요?',
      message: '모든 판, 코드, 개봉 내역이 삭제되고 기본 판 하나로 되돌아갑니다. 이 작업은 되돌릴 수 없어요.',
      confirmLabel: '초기화',
      danger: true
    }).then(function (ok) {
      ui.confirmResolve = null;
      if (!ok) return;
      makeDefaultState().then(function (fresh) {
        return sha256Hex('0000').then(function (hash) {
          fresh.settings.pinHash = hash;
          state = fresh;
          save();
          mapCache.clear();
          ui.lastGen = null;
          renderAdmin();
          renderHome();
          toast('초기화했어요', 'ok');
        });
      });
    });
  }

  /* ---------------- auth ---------------- */
  function loginAdmin(pin, errorEl) {
    var value = String(pin || '').trim();
    if (!/^\d{4,8}$/.test(value)) {
      if (errorEl) errorEl.textContent = 'PIN은 숫자 4~8자리입니다.';
      return;
    }
    sha256Hex(value).then(function (hash) {
      if (hash === state.settings.pinHash) {
        ui.adminUnlocked = true;
        sessionStorage.setItem(ADMIN_SESSION_KEY, '1');
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

  /* ---------------- events ---------------- */
  function setMenu(open) {
    var nav = $('#mainNav');
    var toggle = $('#navToggle');
    if (!nav || !toggle) return;
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
  }

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-admin-tab]');
      if (tab) {
        ui.adminTab = tab.getAttribute('data-admin-tab');
        renderAdmin();
        return;
      }
      var el = e.target.closest('[data-action]');
      if (!el) {
        var navLink = e.target.closest('.main-nav a');
        if (navLink) setMenu(false);
        return;
      }
      var action = el.getAttribute('data-action');
      var n = Number(el.getAttribute('data-n'));

      switch (action) {
        case 'close-modal':
          closeModal();
          break;
        case 'confirm-yes':
          if (ui.confirmResolve) { var yes = ui.confirmResolve; ui.confirmResolve = null; closeModal(); yes(true); }
          break;
        case 'confirm-no':
          if (ui.confirmResolve) { var no = ui.confirmResolve; ui.confirmResolve = null; closeModal(); no(false); }
          break;
        case 'open-code-modal': openCodeModal(); break;
        case 'fill-demo-code': {
          var input = $('#drawCodeInput') || $('#quickCodeInput');
          if (input) { input.value = state.settings.demoCode; input.focus(); }
          break;
        }
        case 'pick-ticket': pickTicket(n); break;
        case 'ticket-info': showTicketInfo(n); break;
        case 'draw-pull': performPull(); break;
        case 'demo-again':
          ui.draw = null;
          closeModal();
          toast('체험 코드가 유지돼요. 다음 번호를 선택하세요.', 'ok');
          if (ui.view !== 'board') location.hash = '#/board/' + (ui.boardId || '');
          break;
        case 'copy-hash': {
          var b = getBoard(ui.fairnessBoardId) || state.boards[0];
          if (b) copyText(b.seedHash, '봉인 해시를 복사했어요');
          break;
        }
        case 'copy-seed': {
          var b2 = getBoard(ui.fairnessBoardId) || state.boards[0];
          if (b2) copyText(b2.seed, '시드를 복사했어요');
          break;
        }
        case 'fill-seed': {
          var b3 = getBoard(ui.fairnessBoardId) || state.boards[0];
          var seedInput = $('#verifySeed');
          if (b3 && seedInput) {
            seedInput.value = b3.seed;
            seedInput.focus();
            toast('공개된 시드를 넣었어요. 계산을 눌러보세요.');
          }
          break;
        }
        case 'copy-code':
          copyText(el.getAttribute('data-code'), '코드를 복사했어요');
          break;
        case 'copy-gen-all':
          if (ui.lastGen) copyText(ui.lastGen.codes.join('\n'), fmt(ui.lastGen.codes.length) + '개 코드를 복사했어요');
          break;
        case 'copy-gen-sms':
          if (ui.lastGen) copyText(ui.lastGen.codes.map(function (c) {
            return '[쿠지킹] 교환 코드 ' + c + ' — kujiking.co.kr 에서 번호를 선택하고 코드를 입력해 주세요.';
          }).join('\n'), '문자 발송용 문구를 복사했어요');
          break;
        case 'download-gen':
          if (ui.lastGen) {
            download('kujiking-codes-' + Date.now() + '.csv', 'code\r\n' + ui.lastGen.codes.join('\r\n'), 'text/csv;charset=utf-8');
          }
          break;
        case 'download-codes': {
          var rows = ['code,board,status,created_at,used_at,ticket'];
          state.codes.forEach(function (c) {
            var b = c.boardId ? getBoard(c.boardId) : null;
            rows.push([c.code, (b ? b.title : '모든 판'), (c.demo ? 'demo' : c.usedAt ? 'used' : 'unused'), c.createdAt, c.usedAt || '', c.usedN || ''].join(','));
          });
          download('kujiking-codes-all-' + Date.now() + '.csv', '\ufeff' + rows.join('\r\n'), 'text/csv;charset=utf-8');
          break;
        }
        case 'gen-codes': generateCodes(Number(el.getAttribute('data-count')) || 1); break;
        case 'revoke-code': {
          var codeVal = el.getAttribute('data-code');
          confirmDialog({
            title: '코드를 폐기할까요?',
            message: '<b>' + h(codeVal) + '</b> 코드를 삭제합니다. 아직 사용하지 않은 코드만 폐기할 수 있어요.',
            confirmLabel: '폐기',
            danger: true
          }).then(function (ok) {
            ui.confirmResolve = null;
            if (!ok) return;
            state.codes = state.codes.filter(function (c) { return c.code !== codeVal; });
            save();
            renderCodesTable();
            toast('코드를 폐기했어요', 'ok');
          });
          break;
        }
        case 'new-board': openBoardEditor(null); break;
        case 'edit-board': openBoardEditor(el.getAttribute('data-id')); break;
        case 'reset-board': {
          var rb = getBoard(el.getAttribute('data-id'));
          if (!rb) break;
          confirmDialog({
            title: '판을 초기화할까요?',
            message: '<b>' + h(rb.title) + '</b>의 개봉 내역 ' + fmt(rb.opens.length) + '건이 지워집니다. 코드와 시드는 그대로 유지됩니다.',
            confirmLabel: '초기화',
            danger: true
          }).then(function (ok) {
            ui.confirmResolve = null;
            if (!ok) return;
            rb.opens = [];
            save();
            renderBoardsTab();
            renderHome();
            toast('판을 초기화했어요', 'ok');
          });
          break;
        }
        case 'delete-board': {
          var db = getBoard(el.getAttribute('data-id'));
          if (!db) break;
          var linked = state.codes.filter(function (c) { return c.boardId === db.id; }).length;
          confirmDialog({
            title: '판을 삭제할까요?',
            message: '<b>' + h(db.title) + '</b>와 연결된 코드 ' + fmt(linked) + '개가 함께 삭제됩니다. 이 작업은 되돌릴 수 없어요.',
            confirmLabel: '삭제',
            danger: true
          }).then(function (ok) {
            ui.confirmResolve = null;
            if (!ok) return;
            state.boards = state.boards.filter(function (b) { return b.id !== db.id; });
            state.codes = state.codes.filter(function (c) { return c.boardId !== db.id; });
            save();
            renderBoardsTab();
            renderHome();
            toast('판을 삭제했어요', 'ok');
          });
          break;
        }
        case 'tier-add': {
          var rowsBox = $('#tierRows');
          if (!rowsBox) break;
          var used = readTierRows().map(function (r) { return r.grade; });
          var next = 'ABCDEFGH'.split('').filter(function (g) { return used.indexOf(g) === -1; })[0] || 'H';
          rowsBox.insertAdjacentHTML('beforeend', tierRowsHTML([{ grade: next, label: '', count: 0, points: 0 }]));
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
          if (seedField) { seedField.value = randomSeed(); toast('새 시드를 만들었어요. 저장하면 기존 개봉 내역이 초기화됩니다.'); }
          break;
        }
        case 'export-data': exportData(); break;
        case 'wipe-data': wipeData(); break;
        case 'admin-logout':
          ui.adminUnlocked = false;
          sessionStorage.removeItem(ADMIN_SESSION_KEY);
          renderAdmin();
          toast('로그아웃했어요');
          break;
        default: break;
      }
    });

    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form || !form.getAttribute) return;
      var type = form.getAttribute('data-form');
      if (!type) return;
      e.preventDefault();
      if (type === 'code-strip' || type === 'quick-code') {
        var board = getBoard(ui.boardId) || firstBoard();
        if (!board) { toast('판매 중인 판이 없어요', 'err'); return; }
        var value = form.querySelector('input[name="code"]').value;
        var st = codeStatus(value, board);
        var err = form.querySelector('[data-role="code-error"]') || $('#modalPanel [data-role="code-error"]');
        if (!st.ok) {
          if (err) err.textContent = st.msg;
          else toast(st.msg, 'err');
          return;
        }
        ui.pendingCode = st.code;
        closeModal();
        if (ui.view !== 'board' || ui.boardId !== board.id) location.hash = '#/board/' + board.id;
        else renderBoard();
        toast(st.demo ? '체험 코드가 준비됐어요. 번호를 선택하세요!' : '코드 확인 완료! 번호를 선택하세요.', 'ok');
        return;
      }

      if (type === 'draw-code') {
        var b = getBoard(ui.draw ? ui.draw.boardId : ui.boardId);
        if (!b || !ui.draw) return;
        var value2 = form.querySelector('input[name="code"]').value;
        var st2 = codeStatus(value2, b);
        var err2 = form.querySelector('[data-role="code-error"]');
        if (!st2.ok) {
          if (err2) err2.textContent = st2.msg;
          return;
        }
        ui.draw.step = 'pull';
        ui.draw.code = st2.code;
        ui.draw.demo = st2.demo;
        ui.draw.rec = st2.rec || null;
        renderDrawModal();
        return;
      }

      if (type === 'verify-hash') {
        verifyHash(fieldValue(form, 'seed'));
        return;
      }
      if (type === 'verify-ticket') {
        verifyTicket(fieldValue(form, 'seed'), fieldValue(form, 'ticket'));
        return;
      }
      if (type === 'admin-login') {
        loginAdmin(fieldValue(form, 'pin'), $('#adminPinError'));
        return;
      }
      if (type === 'change-pin') {
        var errEl = $('#pinFormError');
        errEl.textContent = '';
        var cur = fieldValue(form, 'current').trim();
        var next = fieldValue(form, 'next').trim();
        var confirm = fieldValue(form, 'confirm').trim();
        if (!/^\d{4,8}$/.test(next)) { errEl.textContent = '새 PIN은 숫자 4~8자리로 정해 주세요.'; return; }
        if (next !== confirm) { errEl.textContent = '새 PIN 확인이 일치하지 않습니다.'; return; }
        sha256Hex(cur).then(function (hash) {
          if (hash !== state.settings.pinHash) { errEl.textContent = '현재 PIN이 맞지 않습니다.'; return; }
          sha256Hex(next).then(function (newHash) {
            state.settings.pinHash = newHash;
            state.settings.pinChanged = true;
            save();
            form.reset();
            toast('PIN을 변경했어요', 'ok');
            sessionStorage.setItem(ADMIN_SESSION_KEY, '1');
          });
        });
        return;
      }
      if (type === 'change-demo') {
        var demoErr = $('#demoFormError');
        demoErr.textContent = '';
        var demoVal = fieldValue(form, 'demo').trim().toUpperCase();
        if (!/^[A-Z0-9-]{4,24}$/.test(demoVal)) { demoErr.textContent = '영문·숫자·하이픈 4~24자로 입력해 주세요.'; return; }
        if (state.codes.some(function (c) { return normalizeCode(c.code) === normalizeCode(demoVal); })) {
          demoErr.textContent = '실제 발급된 코드와 겹칩니다.'; return;
        }
        state.settings.demoCode = demoVal;
        save();
        toast('체험 코드를 변경했어요', 'ok');
        return;
      }
      if (type === 'board-form') {
        saveBoardForm(form);
        return;
      }
    });

    document.addEventListener('input', function (e) {
      if (e.target.closest('#tierRows') || e.target.name === 'tickets') updateTierSummary();
    });

    document.addEventListener('change', function (e) {
      if (e.target.id === 'fairBoardSelect') {
        ui.fairnessBoardId = e.target.value;
        $('#verifyResult').hidden = true;
        $('#verifyTicketResult').hidden = true;
        renderFairness();
        history.replaceState(null, '', '#/fairness/' + e.target.value);
      }
      if (e.target.id === 'winnersBoardFilter') {
        ui.winnersBoardId = e.target.value;
        renderWinners();
      }
      if (e.target.id === 'codeFilter') renderCodesTable();
      if (e.target.id === 'importFile') {
        if (e.target.files && e.target.files[0]) importData(e.target.files[0]);
        e.target.value = '';
      }
    });

    document.addEventListener('input', function (e) {
      if (e.target.id === 'codeSearch') renderCodesTable();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalRoot && !modalRoot.hidden) {
        if (ui.confirmResolve) { var res = ui.confirmResolve; ui.confirmResolve = null; closeModal(); res(false); }
        else closeModal();
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList && e.target.classList.contains('draw-ticket')) {
        e.preventDefault();
        performPull();
      }
    });

    var navToggle = $('#navToggle');
    if (navToggle) navToggle.addEventListener('click', function () {
      setMenu(!$('#mainNav').classList.contains('open'));
    });

    window.addEventListener('hashchange', route);
  }

  /* ---------------- misc UI ---------------- */
  function openCodeModal() {
    var board = getBoard(ui.boardId) || firstBoard();
    var title = board ? board.title : '';
    openModal('' +
      '<h2 class="modal-title" id="modalTitle">교환 코드 입력</h2>' +
      '<p class="modal-sub">구매 후 받은 1회용 코드를 넣으면 뽑기판에서 바로 사용할 수 있어요. 코드는 한 번만 쓸 수 있습니다.</p>' +
      '<form class="code-form" data-form="quick-code" novalidate>' +
        '<label class="sr-only" for="quickCodeInput">교환 코드</label>' +
        '<input id="quickCodeInput" class="code-input" name="code" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="24" placeholder="KJ-XXXX-XXXX" value="' + h(ui.pendingCode || '') + '">' +
        '<p class="field-error" data-role="code-error" role="alert"></p>' +
        '<button class="btn btn-primary" type="submit">코드 확인</button>' +
      '</form>' +
      '<div class="demo-box">' +
        '<p><strong>체험용 무료 코드</strong>DEMO-KUJI — 실제 결제 없이 뽑기를 미리 체험해 볼 수 있어요.</p>' +
        '<button class="btn btn-outline btn-sm" type="button" data-action="fill-demo-code">DEMO-KUJI 넣기</button>' +
      '</div>' +
      (title ? '<p class="result-meta">사용할 판 · ' + h(title) + '</p>' : ''));
    var input = $('#quickCodeInput');
    if (input) setTimeout(function () { input.focus(); }, 60);
  }

  /* ---------------- init ---------------- */
  function init() {
    modalRoot = $('#modalRoot');
    modalPanel = $('#modalPanel');
    modalShell = $('.modal-shell');

    var loaded = loadState();
    if (!loaded) {
      makeDefaultState().then(function (fresh) {
        return sha256Hex('0000').then(function (hash) {
          fresh.settings.pinHash = hash;
          state = fresh;
          save();
          boot();
        });
      });
    } else {
      state = loaded;
      state.settings = Object.assign({ demoCode: 'DEMO-KUJI', pinHash: '' }, state.settings || {});
      var jobs = [];
      state.boards.forEach(function (b) {
        if (!b.seed) b.seed = randomSeed();
        if (!b.seedHash) jobs.push(sha256Hex(b.seed).then(function (hash) { b.seedHash = hash; }));
        if (!Array.isArray(b.opens)) b.opens = [];
      });
      if (!state.settings.pinHash) {
        jobs.push(sha256Hex('0000').then(function (hash) { state.settings.pinHash = hash; }));
      }
      Promise.all(jobs).then(function () {
        save();
        boot();
      });
    }
  }

  function boot() {
    try { ui.adminUnlocked = sessionStorage.getItem(ADMIN_SESSION_KEY) === '1'; } catch (e) {}
    bindEvents();
    if (!location.hash) history.replaceState(null, '', '#/');
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
