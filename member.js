/* Forge Gym: member portal. Reads portal.json, finds the record that matches the member's code, decrypts it in the browser. */
(function () {
  var KEY = 'forge_member_code';
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

  function showLogin() {
    $('#login').hidden = false;
    $('#me').hidden = true;
    $('#btnOut').hidden = true;
  }

  function render(p) {
    $('#login').hidden = true;
    $('#me').hidden = false;
    $('#btnOut').hidden = false;
    $('#hello').textContent = 'سڵاو، ' + p.n;

    var today = parseISO(todayISO());
    var end = parseISO(p.e), start = parseISO(p.s);
    var left = dayDiff(today, end);
    var total = Math.max(1, dayDiff(start, end));
    var expired = left < 0;
    var soon = !expired && left <= 5;

    var card = $('#pcard');
    card.className = 'pcard' + (expired ? ' bad' : soon ? ' soon' : '');
    $('#pcDays').textContent = expired ? Math.abs(left) : left;
    $('#pcLabel').textContent = expired ? 'ڕۆژ لەمەوبەر بەسەرچووە' : (left === 0 ? 'ئەمڕۆ کۆتایی دێت' : 'ڕۆژ ماوە');
    $('#pcBar').style.width = (expired ? 0 : Math.min(100, Math.round(left / total * 100))) + '%';
    $('#pcStart').textContent = p.s;
    $('#pcEnd').textContent = p.e;

    var tag = $('#pcTag');
    tag.textContent = expired ? 'ئەندامێتی بەسەرچووە' : soon ? 'نزیکە تەواو بێت' : 'ئەندامێتی چالاکە';
    tag.className = 'tag ' + (expired ? 'red' : soon ? 'warn' : 'ok');
    var paid = $('#pcPaid');
    paid.textContent = p.p ? 'پارەی داوە' : 'پارەی نەداوە';
    paid.className = 'tag ' + (p.p ? 'ok' : 'red');

    var warn = $('#pcWarn');
    if (expired) { warn.hidden = false; warn.textContent = 'ماوەی ئەندامێتیت تەواو بووە. بۆ نوێکردنەوە سەردانی قاعەکە بکە.'; }
    else if (soon) { warn.hidden = false; warn.textContent = 'ماوەی ئەندامێتیت بەم زووانە تەواو دەبێت. بۆ نوێکردنەوە سەردانی قاعەکە بکە.'; }
    else warn.hidden = true;

    var plan = (p.w || []);
    $('#days').innerHTML = plan.length ? plan.map(function (d, i) {
      var lines = String(d.x || '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      return '<details class="day-card"' + (i === 0 ? ' open' : '') + '><summary><span>' + esc(d.t || ('ڕۆژی ' + (i + 1))) + '</span></summary>' +
        (lines.length ? '<ol>' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ol>' : '<p class="muted">وەرزش دانەنراوە.</p>') +
        '</details>';
    }).join('') : '<div class="empty"><h3>هێشتا خشتەی راهێنان دانەنراوە</h3><p>مەربیەکەت ئەمە بۆ تۆ زیاد دەکات.</p></div>';
  }

  async function login(code, remember) {
    var err = $('#loginErr'), btn = $('#loginBtn');
    err.textContent = '';
    if (FG.normCode(code).length < 10) { err.textContent = 'کۆدەکە تەواو بنووسە (10 پیت و ژمارە).'; return false; }
    btn.disabled = true; btn.textContent = 'چاوەڕێ بە…';
    try {
      var p = await fetchRecord(code);
      store(KEY, remember ? code : null);
      render(p);
      btn.disabled = false; btn.textContent = 'چوونەژوورەوە';
      return true;
    } catch (e) {
      err.textContent = e.message === 'net'
        ? 'ناتوانرێت داتا بخوێنرێتەوە. ئینتەرنێتەکەت بپشکنە.'
        : 'کۆدەکە هەڵەیە، یان هێشتا بۆ تۆ بڵاو نەکراوەتەوە.';
      btn.disabled = false; btn.textContent = 'چوونەژوورەوە';
      return false;
    }
  }

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    login($('#code').value, $('#remember').checked);
  });
  $('#code').addEventListener('input', function (e) {
    var c = FG.normCode(e.target.value).slice(0, 10);
    e.target.value = c.length > 5 ? c.slice(0, 5) + '-' + c.slice(5) : c;
  });
  $('#btnOut').addEventListener('click', function () {
    store(KEY, null);
    $('#code').value = '';
    showLogin();
  });

  /* start: link with #CODE, or the code saved on this device */
  (async function () {
    var fromHash = FG.normCode(location.hash.slice(1));
    if (fromHash.length === 10) {
      var c = fromHash.slice(0, 5) + '-' + fromHash.slice(5);
      $('#code').value = c;
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      var ok = await login(c, $('#remember').checked);
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
