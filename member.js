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
    var res = await fetch('portal.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('net');
    var data = await res.json();
    var d = await FG.derive(code, data && data.i);
    var rec = data && data.r && data.r[d.id];
    if (!rec) throw new Error('nocode');
    try { var out = await FG.decrypt(rec, d.key); out.__id = d.id; return out; } catch (e) { throw new Error('nocode'); }
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
    var av = $('#meAv');
    if (okPhoto(p.ph)) av.innerHTML = '<img alt="" src="' + p.ph + '">';
    else av.innerHTML = '<b>' + esc(String(p.n || '?').trim().charAt(0).toUpperCase()) + '</b>';
    kgLoad(p.__id); kgRender();
    setPV('card');

    var today = parseISO(todayISO());
    var end = parseISO(p.e), start = parseISO(p.s);
    var left = dayDiff(today, end);
    var total = Math.max(1, dayDiff(start, end));
    var expired = left < 0;
    var soon = !expired && left <= 5;

    var card = $('#pcard');
    card.className = 'pcard' + (expired ? ' bad' : soon ? ' soon' : '');
    countUp($('#pcDays'), expired ? Math.abs(left) : left);
    $('#pcLabel').textContent = expired ? 'ڕۆژ بەری نوکە ب دوماهی هاتیە' : (left === 0 ? 'ئەڤرو ب دوماهی دهێت' : 'ڕۆژ ماینە');
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
    else if (soon) { warn.hidden = false; warn.textContent = 'ماوەیا ئەندامەتیا تە ب زوی دێ ب دوماهی هێت. بۆ نویکرنێ سەرەدانا قاعێ بکە.'; }
    else warn.hidden = true;

    var plan = p.w || [], dow = (new Date().getDay() + 1) % 7;   /* Saturday = 0 ... Thursday = 5, Friday = 6 */
    var openAt = plan.findIndex(function (d) { return d.k === dow; });
    if (openAt < 0) openAt = 0;
    $('#days').innerHTML = plan.length ? plan.map(function (d, i) {
      var ex = (d.e || []).map(function (z, n) {
        var img = okImg(z.g)
          ? '<button type="button" class="exi" data-src="' + esc(z.g) + '" aria-label="' + esc(z.n || 'وێنە') + '"><img src="' + esc(z.g) + '" alt="' + esc(z.n || '') + '" loading="lazy"></button>'
          : '<span class="exi none">' + (n + 1) + '</span>';
        return '<div class="ex">' + img + '<div class="ext"><b dir="auto">' + esc(z.n) + '</b>' + (z.s ? '<span>' + esc(z.s) + '</span>' : '') + '</div></div>';
      }).join('');
      return '<details class="day-card"' + (i === openAt ? ' open' : '') + '><summary><span>' + esc(d.t || ('ڕۆژا ' + (i + 1))) + (d.f ? '<em>' + esc(d.f) + '</em>' : '') + '</span>' +
        (d.k === dow ? '<i class="tdy">ئەڤرو</i>' : '') + '</summary>' +
        (ex ? '<div class="exs">' + ex + '</div>' : '') +
        (d.x ? '<p class="dnote">' + esc(d.x) + '</p>' : '') +
        (!ex && !d.x ? '<p class="muted">ڕاهێنان نەهاتینە دانان.</p>' : '') +
        '</details>';
    }).join('') : '<div class="empty"><h3>هێشتا بەرنامەیا ڕاهێنانێ نەهاتیە دانان</h3><p>ڕاهێنەرێ تە دێ ئەڤێ بۆ تە زێدە کەت.</p></div>';
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

  function okPhoto(s) { return /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(s || '') && s.length < 40000; }
  function okImg(g) { return /^img\/[A-Za-z0-9._-]+\.jpg$/.test(g || ''); }
  /* tap an exercise picture to see it big */
  $('#days').addEventListener('click', function (e) {
    var b = e.target.closest('.exi[data-src]'); if (!b) return;
    $('#lbImg').src = b.dataset.src; $('#lb').hidden = false;
  });
  $('#lb').addEventListener('click', function () { this.hidden = true; $('#lbImg').removeAttribute('src'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#lb').hidden) $('#lb').click(); });

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

  /* سێ بەش: ئەندامەتی، خشتەیا ڕاهێنانێ و کێشا من، هەر ئێک لاپەڕەکا جودایە */
  function setPV(v) {
    document.querySelectorAll('[data-pv]').forEach(function (el) { el.hidden = el.dataset.pv !== v; });
    document.querySelectorAll('#ptabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.p === v); });
  }
  $('#ptabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setPV(b.dataset.p); });

  /* دۆخێ قاعێ (ڤەکری / گرتی) ژ status.json دهێت، خودان ژ پانێلی دگوهۆڕیت.
     پێشتر ڤێ بەشێ چ کار نەدکر ژ بەر کو چ کۆدەکێ نەدخواند */
  (async function () {
    try {
      var r = await fetch('status.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      var j = await r.json(), open = !!j.o, g = $('#gstat');
      g.className = 'gstat ' + (open ? 'open' : 'closed');
      $('#gstatT').textContent = open ? 'قاعە نوکە ڤەکریە' : 'قاعە نوکە گرتیە';
      $('#gstatM').textContent = j.m || '';
      $('#gstatM').hidden = !j.m;
      g.hidden = false;
    } catch (e) { /* ئەگەر status.json نەبیت، بانەر ڤەشارتی دمینیت */ }
  })();


  /* ===== کێشا من: یاریزان ڕۆژانە کێشا خۆ دنڤیسیت و هەمیشە دبینیت چەند گوهۆڕیە =====
     داتا تنێ ل سەر ئامێرێ یاریزانی دمینیت (localStorage)، بۆ هەر یاریزانەکی ب جودا */
  var KG = { id: '', d: { h: 0, g: 0, l: [] } };
  function kgLoad(id) {
    KG.id = id || '';
    var j = null;
    try { j = JSON.parse(read('forge_kg_' + KG.id) || 'null'); } catch (e) {}
    KG.d = j && Array.isArray(j.l) ? j : { h: 0, g: 0, l: [] };
    KG.d.l = KG.d.l.filter(function (x) { return x && /^\d{4}-\d\d-\d\d$/.test(x.d) && isFinite(x.w); }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    $('#kgGoal').value = KG.d.g ? String(KG.d.g) : '';
    $('#kgH').value = KG.d.h ? String(KG.d.h) : '';
    $('#kgIn').value = ''; $('#kgErr').textContent = '';
  }
  function kgSave() { if (KG.id) store('forge_kg_' + KG.id, JSON.stringify(KG.d)); }
  function num(v) { var x = parseFloat(String(v).replace(/[٠-٩]/g, function (c) { return c.charCodeAt(0) - 1632; }).replace(',', '.').replace('٫', '.')); return isFinite(x) ? x : NaN; }
  function f1(x) { return String(Math.round(x * 10) / 10); }
  function sg(x) { var r = Math.round(x * 10) / 10; return r === 0 ? '0' : (r > 0 ? '+' : '−') + f1(Math.abs(r)); }
  function kgRender() {
    var L = KG.d.l, n = L.length, st = $('#kgStats'), ch = $('#kgChart'), li = $('#kgList');
    var t = todayISO(), hasToday = n && L[n - 1].d === t;
    $('#kgBtn').textContent = hasToday ? 'نویکرن' : 'تۆمارکرن';
    $('#kgIn').placeholder = hasToday ? f1(L[n - 1].w) : '72.5';
    if (!n) {
      st.innerHTML = ''; ch.innerHTML = '';
      li.innerHTML = '<div class="empty"><h3>هێشتا چ کێش نەهاتیە تۆمارکرن</h3><p>کێشا خۆ یا ئەڤرو بنڤیسە دا هەمی گوهۆڕین ببینی.</p></div>';
      return;
    }
    var first = L[0], last = L[n - 1], prev = n > 1 ? L[n - 2] : null, g = KG.d.g, h = KG.d.h;
    var fromStart = last.w - first.w, fromPrev = prev ? last.w - prev.w : 0;
    var dir = g ? Math.sign(g - first.w) : 0;
    function cls(df) { if (!df || Math.abs(df) < 0.05) return ''; if (dir) return Math.sign(df) === dir ? 'good' : 'bad'; return df < 0 ? 'dn' : 'up'; }
    var cells = '<div class="kgs"><b>' + f1(last.w) + '</b><small>کێشا نوکە (کگم)</small></div>' +
      '<div class="kgs ' + cls(fromStart) + '"><b>' + (n > 1 ? sg(fromStart) : '0') + '</b><small>ژ دەستپێکێ (کگم)</small></div>' +
      '<div class="kgs ' + cls(fromPrev) + '"><b>' + (prev ? sg(fromPrev) : '0') + '</b><small>ژ جارا بوری (کگم)</small></div>';
    var extra = '';
    if (g) {
      var left = g - last.w, total = g - first.w, done = total ? Math.max(0, Math.min(100, Math.round((last.w - first.w) / total * 100))) : 100;
      extra += '<div class="kgbar"><div><span>ئارمانج: ' + f1(g) + ' کگم</span><span>' + (Math.abs(left) < 0.05 ? 'گەهشتیە ئارمانجێ 🎯' : 'مایە ' + f1(Math.abs(left)) + ' کگم') + '</span></div><i><s style="width:' + done + '%"></s></i></div>';
    }
    if (h >= 100 && h <= 250) {
      var bmi = last.w / Math.pow(h / 100, 2);
      extra += '<div class="kgbar"><div><span>BMI</span><b dir="ltr">' + f1(bmi) + '</b></div></div>';
    }
    st.innerHTML = '<div class="kgstats">' + cells + '</div>' + extra;

    /* chart: the last 30 records */
    var pts = L.slice(-30), W = 320, H = 130, px = 34, py = 14;
    var ws = pts.map(function (x) { return x.w; }); if (g) ws.push(g);
    var lo = Math.min.apply(null, ws), hi = Math.max.apply(null, ws);
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    var X = function (i) { return pts.length === 1 ? W / 2 : px + (W - px - 10) * i / (pts.length - 1); };
    var Y = function (w) { return py + (H - 2 * py) * (1 - (w - lo) / (hi - lo)); };
    var line = pts.map(function (x, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x.w).toFixed(1); }).join('');
    var area = line + 'L' + X(pts.length - 1).toFixed(1) + ' ' + (H - py) + 'L' + X(0).toFixed(1) + ' ' + (H - py) + 'Z';
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="چارتا کێشێ"><defs><linearGradient id="kgg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6a1f" stop-opacity=".35"/><stop offset="1" stop-color="#ff6a1f" stop-opacity="0"/></linearGradient></defs>' +
      '<text x="2" y="' + (py + 4) + '" fill="#97a0ac" font-size="11">' + f1(hi) + '</text><text x="2" y="' + (H - py + 4) + '" fill="#97a0ac" font-size="11">' + f1(lo) + '</text>' +
      '<line x1="' + px + '" x2="' + W + '" y1="' + (H - py) + '" y2="' + (H - py) + '" stroke="#2b323c"/>' +
      (g ? '<line x1="' + px + '" x2="' + W + '" y1="' + Y(g).toFixed(1) + '" y2="' + Y(g).toFixed(1) + '" stroke="#5fd39a" stroke-dasharray="4 4" opacity=".8"/>' : '') +
      (pts.length > 1 ? '<path d="' + area + '" fill="url(#kgg)"/><path d="' + line + '" fill="none" stroke="#ff6a1f" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' : '') +
      pts.map(function (x, i) { return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(x.w).toFixed(1) + '" r="' + (i === pts.length - 1 ? 5 : 3) + '" fill="#ffd28c"/>'; }).join('') + '</svg>';
    ch.innerHTML = '<div class="kgchart">' + svg + '</div>';

    li.innerHTML = '<div class="kgl">' + L.slice().reverse().map(function (x, i, arr) {
      var older = arr[i + 1], df = older ? x.w - older.w : null;
      return '<div><span>' + esc(x.d) + '</span><b>' + f1(x.w) + '</b><em class="' + (df == null ? '' : df < -0.04 ? 'dn' : df > 0.04 ? 'up' : '') + '">' + (df == null ? '' : sg(df)) + '</em><button type="button" data-kgdel="' + esc(x.d) + '" aria-label="ژێبرنا ڤێ تۆمارێ">✕</button></div>';
    }).join('') + '</div>';
  }
  $('#kgForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var w = num($('#kgIn').value), err = $('#kgErr');
    if (!(w >= 20 && w <= 400)) { err.textContent = 'ژمارەکا دروست بنڤیسە (ژ 20 هەتا 400 کگم).'; return; }
    err.textContent = '';
    var t = todayISO(), L = KG.d.l, i = L.findIndex(function (x) { return x.d === t; });
    var rec = { d: t, w: Math.round(w * 10) / 10 };
    if (i >= 0) L[i] = rec; else L.push(rec);
    kgSave(); $('#kgIn').value = ''; kgRender();
  });
  $('#kgSet').addEventListener('submit', function (e) {
    e.preventDefault();
    var g = num($('#kgGoal').value), h = num($('#kgH').value);
    KG.d.g = g >= 20 && g <= 400 ? Math.round(g * 10) / 10 : 0;
    KG.d.h = h >= 100 && h <= 250 ? Math.round(h) : 0;
    kgSave(); kgRender(); $('#kgSetBox').open = false;
  });
  $('#kgList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-kgdel]'); if (!b) return;
    if (!confirm('ئەڤ تۆمارە ژێببەم؟')) return;
    KG.d.l = KG.d.l.filter(function (x) { return x.d !== b.dataset.kgdel; });
    kgSave(); kgRender();
  });

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
