/* 쿠지킹 v3.5 미리보기용 자동 드라이버 (배포 검토 전용, 검증 후 삭제)
   사용: preview-v35.html?auto=tear&p=0.55&grade=A
        preview-v35.html?auto=seal&p=0.5&grade=B
        preview-v35.html?auto=reveal&grade=A
        preview-v35.html?auto=reveal&grade=D   (1단계) */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var auto = q.get('auto');
  if (!auto) return;

  var logEl = document.createElement('div');
  logEl.id = 'devlog';
  logEl.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,.82);' +
    'color:#6f6;font:11px/1.45 ui-monospace,monospace;padding:4px 8px;max-height:38vh;overflow:auto;white-space:pre-wrap';
  function say(m) { if (!logEl.parentNode) return; logEl.textContent += m + '\n'; }
  function mount() { document.body.appendChild(logEl); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  window.addEventListener('error', function (e) {
    say('ERR ' + e.message + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    say('REJ ' + ((e.reason && e.reason.message) || e.reason));
  });

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  /* http(비보안 컨텍스트)에서는 crypto.subtle 이 없으므로 순수 JS SHA-256 사용 */
  function shaHex(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var mathPow = Math.pow, maxWord = mathPow(2, 32), result = '', words = [], bitLen = ascii.length * 8;
    var hash = shaHex.h = shaHex.h || [];
    var k = shaHex.k = shaHex.k || [];
    var counter = k.length, isC = {};
    for (var c = 2; counter < 64; c++) {
      if (!isC[c]) {
        for (var i = 0; i < 313; i += c) isC[i] = c;
        hash[counter] = (mathPow(c, .5) * maxWord) | 0;
        k[counter++] = (mathPow(c, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      var j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (bitLen / maxWord) | 0;
    words[words.length] = bitLen;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
        var temp1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ ((~e) & hash[6])) + k[i] +
          (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var temp2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? 0 : '') + b.toString(16);
      }
    }
    return result;
  }

  async function findTarget(want) {
    var st = JSON.parse(localStorage.getItem('kujiking.state.v2'));
    for (var bi = 0; bi < st.boards.length; bi++) {
      var b = st.boards[bi];
      var opened = {};
      (b.opens || []).forEach(function (o) { opened[o.n] = 1; });
      var hashes = [];
      for (var n = 1; n <= b.tickets; n++) hashes.push({ n: n, hash: shaHex(b.seed + ':' + n) });
      hashes.sort(function (a, c) { return a.hash < c.hash ? -1 : a.hash > c.hash ? 1 : 0; });
      var map = {}, i = 0;
      b.tiers.forEach(function (t) {
        for (var k = 0; k < Number(t.count || 0) && i < hashes.length; k++) { map[hashes[i].n] = t.grade; i++; }
      });
      for (var key in map) {
        if (String(map[key]).toUpperCase() === want && !opened[key]) return { boardId: b.id, n: Number(key) };
      }
    }
    return null;
  }

  async function openDraw(want) {
    for (var w = 0; w < 60 && !window.KUJIKING; w++) await sleep(100);
    var t = await findTarget(want);
    if (!t) { say('FAIL: ' + want + ' 등급 티켓 없음'); return null; }
    location.hash = '#/board/' + t.boardId;
    await sleep(700);
    var cell = document.querySelector('.ticket[data-n="' + t.n + '"]');
    if (!cell) { say('FAIL: 티켓 셀 없음'); return null; }
    cell.click();
    await sleep(500);
    var inp = document.getElementById('drawCodeInput');
    var btn = document.querySelector('form[data-form="draw-code"] button[type="submit"]');
    if (!inp || !btn) { say('FAIL: 코드 입력 폼 없음 (mode=' + (window.KUJIKING && window.KUJIKING.mode) + ')'); return null; }
    inp.value = 'DEMO-KUJI';
    btn.click();
    await sleep(1000);
    if (!document.getElementById('peelCard')) { say('FAIL: 종이 티켓 안 뜸'); return null; }
    say('OPEN ' + t.boardId + ' #' + t.n + ' (' + want + ')');
    return t;
  }

  function pev(el, type, x, y, id) {
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerId: id, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1
    }));
  }

  async function dragPeel(toP, release) {
    var card = document.getElementById('peelCard');
    var b = card.getBoundingClientRect();
    var max = Math.max(130, b.height * 0.62);
    var x = b.left + b.width / 2, y = b.top + b.height * 0.3;
    var dist = max * toP;
    pev(card, 'pointerdown', x, y, 7);
    for (var i = 1; i <= 16; i++) { pev(card, 'pointermove', x, y + dist * i / 16, 7); await sleep(28); }
    if (release) pev(card, 'pointerup', x, y + dist, 7);
    return { x: x, y: y + dist };
  }

  function stagePeel(p) {
    var card = document.getElementById('peelCard');
    var flap = document.getElementById('peelFlap');
    var TEAR = 0.30, TEAR_PX = 34, MAXA = 92;
    var t = TEAR_PX * Math.min(1, p / TEAR);
    var a = p <= TEAR ? 0 : Math.pow((p - TEAR) / (1 - TEAR), 0.88) * MAXA;
    flap.style.transition = 'none';
    flap.style.transform = 'translate3d(0,' + t.toFixed(1) + 'px,0) rotateX(' + a.toFixed(2) + 'deg)';
    card.style.setProperty('--peel', String(p));
    card.style.setProperty('--tear', String(Math.min(1, p / TEAR)));
    card.style.setProperty('--fold', String(Math.min(1, a / MAXA)));
    card.style.setProperty('--peel-blur', (22 - 19 * p).toFixed(1) + 'px');
    card.style.setProperty('--peel-alpha', (0.16 + 0.84 * p).toFixed(2));
    card.style.setProperty('--peel-zoom', (1 + 0.06 * p).toFixed(3));
    var fill = document.getElementById('peelMeterFill');
    if (fill) fill.style.width = Math.round(Math.min(1, p / 0.75) * 100) + '%';
    var txt = document.getElementById('peelMeterText');
    if (txt) txt.textContent = p >= TEAR ? '종이가 펼쳐지는 중 · ' + Math.round(p * 100) + '%' : '절취선을 찢는 중 · ' + Math.round(p * 100) + '%';
  }

  async function dragSeal(toP, release) {
    var box = document.getElementById('sealBox');
    var b = box.getBoundingClientRect();
    var max = Math.max(120, b.height * 0.55);
    var x = b.left + b.width / 2, y = b.top + b.height * 0.3;
    var dist = max * Math.min(1, toP);
    pev(box, 'pointerdown', x, y, 8);
    for (var i = 1; i <= 14; i++) { pev(box, 'pointermove', x, y + dist * i / 14, 8); await sleep(30); }
    if (release) pev(box, 'pointerup', x, y + dist, 8);
    return { x: x, y: y + dist };
  }

  function stageSeal(p) {
    var box = document.getElementById('sealBox');
    box.style.setProperty('--seal', String(p));
    box.style.setProperty('--shk', String(1 + p * 2.6));
    var fill = document.getElementById('sealMeterFill');
    if (fill) fill.style.width = Math.round(Math.min(1, p / 0.7) * 100) + '%';
    var txt = document.getElementById('sealMeterText');
    if (txt) { txt.textContent = '봉인이 갈라지는 중… ' + Math.round(p * 100) + '%'; txt.classList.toggle('is-armed', p >= 0.7); }
    var grip = document.getElementById('sealGripText');
    if (grip) grip.textContent = p >= 0.7 ? '놓으면 열림!' : '계속 찢기';
  }

  async function run() {
    var grade = (q.get('grade') || 'A').toUpperCase();
    var p = parseFloat(q.get('p') || '');
    await openDraw(grade);
    if (!auto) return;

    if (auto === 'tear') {
      stagePeel(isNaN(p) ? 0.55 : p);
      say('STAGED peel p=' + (isNaN(p) ? 0.55 : p));
      return;
    }
    if (auto === 'seal') {
      await dragPeel(0.9, true);
      for (var w = 0; w < 60 && !document.getElementById('sealBox'); w++) await sleep(100);
      if (!document.getElementById('sealBox')) { say('FAIL: 봉인 단계 안 뜸'); return; }
      await sleep(400);
      stageSeal(isNaN(p) ? 0.5 : p);
      say('STAGED seal p=' + (isNaN(p) ? 0.5 : p));
      return;
    }
    if (auto === 'reveal') {
      await dragPeel(0.9, true);
      await sleep(600);
      var hasSeal = !!document.getElementById('sealBox');
      say('seal stage: ' + hasSeal);
      if (hasSeal) {
        await sleep(300);
        await dragSeal(0.85, true);
      }
      for (var k = 0; k < 80 && !document.getElementById('revealStage'); k++) await sleep(100);
      if (!document.getElementById('revealStage')) { say('FAIL: 결과 화면 안 뜸'); return; }
      await sleep(1400);
      var rs = document.getElementById('revealStage');
      say('REVEAL ' + rs.className + ' | confetti=' + rs.querySelectorAll('.confetti').length +
          ' sparks=' + rs.querySelectorAll('.rv-spark,.st-spark').length +
          ' wrap=' + (document.querySelector('.result-wrap') || {}).className);
      return;
    }
  }

  run().catch(function (e) { say('RUN ERR ' + (e && e.message)); });
})();
