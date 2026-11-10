/* Forge Gym: member portal. Reads portal.json, finds the record that matches the member's code, decrypts it in the browser.
   v2: codes can be chosen freely by the owner (8 to 24 letters/digits), so no fixed length and no forced hyphen. */
(function () {
  var KEY = 'forge_member_code';
  var MIN_LEN = 8;
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var todayISO = function () { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var parseISO = function (s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  var dayDiff = function (a, b) { return Math.round((b - a) / 86400000); };

  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  async function fetchRecord(code) {
    var d = await FG.derive(code);
    var res = await fetch('portal.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('net');
    var data = await res.json();
    var rec = data && data.r && data.r[d.id];
    if (!rec) throw new Error('nocode');
    try { return await FG.decrypt(rec, d.key); } catch (e) { throw new Error('nocode'); }
  }

  function countUp(el, to) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || to < 2) { el.textContent = to; return; }
    var t0 = performance.now(), dur = 900;
    (function tick(t) {
      var k = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  }

  function showLogin() {
    $('#login').hidden = false;
    $('#me').hidden = true;
    $('#btnOut').hidden = true;
  }

  function render(p) {
    $('#login').hidden = true;
    $('#me').hidden = false;
    $('#btnOut').hidden = false;
    $('#hello').textContent = 'سلاڤ، ' + p.n;

    var today = parseISO(todayISO());
    var end = parseISO(p.e), start = parseISO(p.s);
    var left = dayDiff(today, end);
    var total = Math.max(1, dayDiff(start, end));
    var expired = left < 0;
    var soon = !expired && left <= 5;

    var card = $('#pcard');
    card.className = 'pcard' + (expired ? ' bad' : soon ? ' soon' : '');
    countUp($('#pcDays'), expired ? Math.abs(left) : left);
    $('#pcLabel').textContent = expired ? 'ڕۆژ بەری ئێستا ب دوماهی هاتیە' : (left === 0 ? 'ئەڤرو ب دوماهی دهێت' : 'ڕۆژ ماینە');
    var pct = (expired ? 0 : Math.min(100, Math.round(left / total * 100))) + '%';
    $('#pcBar').style.width = '0';
    requestAnimationFrame(function () { requestAnimationFrame(function () { $('#pcBar').style.width = pct; }); });
    $('#pcStart').textContent = p.s;
    $('#pcEnd').textContent = p.e;

    var tag = $('#pcTag');
    tag.textContent = expired ? 'ئەندامەتی ب دوماهی هاتیە' : soon ? 'نێزیکە ب دوماهی بهێت' : 'ئەندامەتی چالاکە';
    tag.className = 'tag ' + (expired ? 'red' : soon ? 'warn' : 'ok');
    var paid = $('#pcPaid');
    paid.textContent = p.p ? 'پارە دایە' : 'پارە نەدایە';
    paid.className = 'tag ' + (p.p ? 'ok' : 'red');

    var warn = $('#pcWarn');
    if (expired) { warn.hidden = false; warn.textContent = 'ماوەیا ئەندامەتیا تە ب دوماهی هاتیە. بۆ نویکرنێ سەرەدانا قاعێ بکە.'; }
    else if (soon) { warn.hidden = false; warn.textContent = 'ماوەیا ئەندامەتیا تە ب زوویی دێ ب دوماهی هێت. بۆ نویکرنێ سەرەدانا قاعێ بکە.'; }
    else warn.hidden = true;

    var plan = (p.w || []);
    $('#days').innerHTML = plan.length ? plan.map(function (d, i) {
      var lines = String(d.x || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      return '<details class="day-card"' + (i === 0 ? ' open' : '') + '><summary><span>' + esc(d.t || ('ڕۆژا ' + (i + 1))) + '</span></summary>' +
        (lines.length ? '<ol>' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ol>' : '<p class="muted">ڕاهێنان نەهاتینە دانان.</p>') +
        '</details>';
    }).join('') : '<div class="empty"><h3>هێشتا خشتەیا ڕاهێنانێ نەهاتیە دانان</h3><p>ڕاهێنەرێ تە دێ ئەڤێ بۆ تە زێدە کەت.</p></div>';
  }

  async function login(code, remember) {
    var err = $('#loginErr'), btn = $('#loginBtn');
    err.textContent = '';
    if (FG.normCode(code).length < MIN_LEN) { err.textContent = 'کۆدێ ب تەمامی بنڤیسە (کێم ' + MIN_LEN + ' پیت و ژمارە).'; return false; }
    btn.disabled = true; btn.textContent = 'چاڤەڕێ بە…';
    try {
      var p = await fetchRecord(code);
      store(KEY, remember ? code : null);
      render(p);
      btn.disabled = false; btn.textContent = 'چوونە ژوورڤە';
      return true;
    } catch (e) {
      err.textContent = e.message === 'net'
        ? 'نەشێین داتایان بخوینین. ئینتەرنێتا خۆ بپشکنە.'
        : 'کۆد خەلەتە، یان هێشتا بۆ تە نەهاتیە بەلاڤکرن.';
      btn.disabled = false; btn.textContent = 'چوونە ژوورڤە';
      return false;
    }
  }

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    login($('#code').value, $('#remember').checked);
  });
  /* free-form codes: uppercase, keep only A-Z, 0-9 and "-" (no forced hyphen position any more) */
  $('#code').addEventListener('input', function (e) {
    var v = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (v !== e.target.value) e.target.value = v;
  });
  $('#btnOut').addEventListener('click', function () {
    store(KEY, null);
    $('#code').value = '';
    showLogin();
  });

  /* gym open / closed, set by the owner (status.json is public) */
  async function showStatus() {
    try {
      var r = await fetch('status.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      var j = await r.json(), el = $('#gstat');
      el.className = 'gstat ' + (j.o ? 'open' : 'closed');
      $('#gstatT').textContent = j.o ? 'قاعە ئێستا کراوەیە' : 'قاعە ئێستا گرتیە';
      $('#gstatM').textContent = j.m || ''; $('#gstatM').hidden = !j.m;
      el.hidden = false;
    } catch (e) {}
  }
  showStatus(); setInterval(showStatus, 60000);

  /* start: link with #CODE, or the code saved on this device */
  (async function () {
    var fromHash = FG.normCode(location.hash.slice(1));
    if (fromHash.length >= MIN_LEN) {
      $('#code').value = fromHash;
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      var ok = await login(fromHash, $('#remember').checked);
      if (ok) return;
    }
    var saved = read(KEY);
    if (saved) {
      $('#code').value = saved;
      var ok2 = await login(saved, true);
      if (!ok2) store(KEY, null);
    }
  })();
})();
