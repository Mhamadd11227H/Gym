/* Forge Gym: owner panel (admin.html).
   Members are kept in this browser. Each member gets a private code. When something changes, the member portal data
   (name, expiry, workout plan) is encrypted with the member's code and published to portal.json on GitHub. */
(function () {
  var LS = 'forge_gym_members_v1', LSG = 'forge_gym_github', LSC = 'forge_gym_cache_v1';
  var PLAN = { 1: '1 مانگ', 3: '3 مانگ', 6: '6 مانگ', 12: 'ساڵێک' };
  var members = [], cfg = null, cache = {};
  var q = '', filter = 'all', editingId = null, payVal = 0, confirmId = null;
  var formCode = '', planDraft = [];
  var pubState = 'none', pubTimer = null, pubBusy = false, pubAgain = false, toastT = null;

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return Number(n || 0).toLocaleString('en-US'); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var toISO = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  var todayISO = function () { return toISO(new Date()); };
  var parseISO = function (s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  var addMonths = function (s, n) { var d = parseISO(s), day = d.getDate(); d.setMonth(d.getMonth() + n); if (d.getDate() !== day) d.setDate(0); return d; };
  var dayDiff = function (a, b) { return Math.round((b - a) / 86400000); };

  function info(m) {
    var start = m.start || todayISO();
    var exp = addMonths(start, Number(m.months) || 1);
    var days = dayDiff(parseISO(todayISO()), exp);
    return { days: days, expired: days < 0, iso: toISO(exp) };
  }

  /* ---------- storage ---------- */
  function jget(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function load() {
    members = jget(LS, []);
    if (!Array.isArray(members)) members = [];
    cfg = jget(LSG, null);
    cache = jget(LSC, {});
    var changed = false;
    members.forEach(function (m) {
      if (!m.code) { m.code = FG.genCode(); changed = true; }
      if (!Array.isArray(m.plan)) { m.plan = []; changed = true; }
    });
    members.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    if (changed) persist();
  }
  function persist() {
    if (!jset(LS, members)) toast('پاشەکەوت نەکرا. براوزەرەکەت ڕێگە نادات.', true);
  }
  function newId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function find(id) { return members.find(function (m) { return m.id === id; }); }
  function save(m) {
    var i = members.findIndex(function (x) { return x.id === m.id; });
    if (i < 0) members.unshift(m); else members[i] = m;
    persist(); render(); schedulePublish();
  }
  function removeMember(id) {
    members = members.filter(function (x) { return x.id !== id; });
    persist(); render(); schedulePublish();
  }

  function toast(t, bad) {
    var el = $('#toast'); el.textContent = t; el.className = 'toast' + (bad ? ' bad' : ''); el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { el.hidden = true; }, 3000);
  }

  /* ---------- publishing to GitHub ---------- */
  var PILL = {
    none: ['بڵاو نەکراوەتەوە', 'warn'], idle: ['بڵاوکردنەوە', ''], dirty: ['چاوەڕێی بڵاوکردنەوەیە…', 'warn'],
    busy: ['بڵاودەکرێتەوە…', 'warn'], ok: ['بڵاوکرایەوە ✓', 'ok'], err: ['هەڵە، دووبارە هەوڵبدە', 'bad']
  };
  function setPub(s) {
    pubState = s;
    var p = $('#pill'); p.textContent = PILL[s][0]; p.className = 'pill ' + PILL[s][1];
  }
  function schedulePublish() {
    if (!cfg) { setPub('none'); return; }
    setPub('dirty');
    clearTimeout(pubTimer);
    pubTimer = setTimeout(publish, 1500);
  }

  function portalData(m) {
    return {
      n: m.name, s: m.start || todayISO(), e: info(m).iso, p: m.paid ? 1 : 0,
      w: (m.plan || []).filter(function (d) { return d && (d.t || d.x); }).map(function (d) { return { t: d.t || '', x: d.x || '' }; })
    };
  }

  function ghErr(e) {
    if (e.status === 401) return 'تۆکن هەڵەیە یان بەسەرچووە.';
    if (e.status === 403) return 'تۆکنەکە مافی Contents (Read and write)ی نییە.';
    if (e.status === 404) return 'Repository یان Branch نەدۆزرایەوە.';
    return 'هەڵە ڕوویدا (' + (e.message || e.status) + ').';
  }
  async function gh(path, opt) {
    var r = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/' + path, Object.assign({ cache: 'no-store' }, opt, {
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
    }));
    if (r.status === 404 && opt && opt.allow404) return null;
    if (!r.ok) { var e = new Error(r.status); e.status = r.status; throw e; }
    return r.json();
  }

  async function publish() {
    if (!cfg) { openSettings(); return; }
    if (pubBusy) { pubAgain = true; return; }
    pubBusy = true; clearTimeout(pubTimer); setPub('busy');
    try {
      var records = {}, keep = {};
      for (var i = 0; i < members.length; i++) {
        var m = members[i], data = portalData(m);
        var sig = m.code + '|' + JSON.stringify(data);
        var c = cache[m.id];
        if (!c || c.sig !== sig) {
          var d = await FG.derive(m.code);
          c = { sig: sig, id: d.id, rec: await FG.encrypt(data, d.key) };
          cache[m.id] = c;
        }
        keep[m.id] = 1;
        records[c.id] = c.rec;
      }
      Object.keys(cache).forEach(function (k) { if (!keep[k]) delete cache[k]; });
      jset(LSC, cache);

      var body = JSON.stringify({ v: 1, r: records });
      for (var tries = 0; tries < 3; tries++) {
        var cur = await gh('contents/portal.json?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now(), { allow404: true });
        try {
          await gh('contents/portal.json', {
            method: 'PUT',
            body: JSON.stringify(Object.assign({ message: 'Update member portal', content: btoa(body), branch: cfg.branch }, cur ? { sha: cur.sha } : {}))
          });
          break;
        } catch (e) {
          if ((e.status !== 409 && e.status !== 422) || tries === 2) throw e;
        }
      }
      setPub('ok');
    } catch (e) {
      setPub('err');
      toast(ghErr(e), true);
    }
    pubBusy = false;
    if (pubAgain) { pubAgain = false; schedulePublish(); }
  }

  /* ---------- render ---------- */
  function siteUrl() { return location.origin + location.pathname.replace(/[^\/]*$/, '') + 'index.html'; }
  function waLink(m) {
    var p = String(m.phone || '').replace(/\D/g, '');
    if (p && p.indexOf('964') !== 0) p = p[0] === '0' ? '964' + p.slice(1) : p;
    var text = 'سڵاو ' + m.name + '،\nکۆدی تایبەتی تۆ بۆ بینینی خشتەی راهێنان و ماوەی ئەندامێتی:\n' + m.code + '\n\nلینک: ' + siteUrl() + '#' + m.code;
    return 'https://wa.me/' + p + '?text=' + encodeURIComponent(text);
  }

  function render() {
    var total = members.length;
    var paid = members.filter(function (m) { return m.paid; });
    var sum = paid.reduce(function (s, m) { return s + (Number(m.amount) || 0); }, 0);
    $('#sTotal').textContent = total;
    $('#sPaid').textContent = paid.length;
    $('#sUnpaid').textContent = total - paid.length;
    $('#sSum').innerHTML = fmt(sum) + '<em>د.ع</em>';

    var expiredN = members.filter(function (m) { return info(m).expired; }).length;
    var defs = [['all', 'هەموو', total], ['paid', 'پارەی داوە', paid.length], ['unpaid', 'پارەی نەداوە', total - paid.length], ['expired', 'بەسەرچوو', expiredN]];
    $('#chips').innerHTML = defs.map(function (d) {
      return '<button type="button" class="chip' + (filter === d[0] ? ' on' : '') + '" data-f="' + d[0] + '">' + d[1] + '<b>' + d[2] + '</b></button>';
    }).join('');

    var term = q.trim().toLowerCase();
    var rows = members.filter(function (m) {
      if (filter === 'paid' && !m.paid) return false;
      if (filter === 'unpaid' && m.paid) return false;
      if (filter === 'expired' && !info(m).expired) return false;
      if (!term) return true;
      return String(m.name || '').toLowerCase().indexOf(term) >= 0 ||
        String(m.phone || '').replace(/\s/g, '').indexOf(term.replace(/\s/g, '')) >= 0;
    });

    var list = $('#list');
    if (!members.length) {
      list.innerHTML = '<div class="empty"><h3>هێشتا هیچ ئەندامێک تۆمار نەکراوە</h3><p>یەکەم ئەندام زیاد بکە. کۆدی تایبەتی خۆی و خشتەی راهێنانی بۆ دروست دەکەیت.</p><button class="btn-add" type="button" data-act="add">+ ئەندامی نوێ</button></div>';
    } else if (!rows.length) {
      var hint = term
        ? '<h3>هیچ ناوێک نەدۆزرایەوە</h3><p>ئەم ناوە تۆمار نەکراوە.</p><button class="btn-add" type="button" data-act="add-q">+ تۆمارکردنی «' + esc(q.trim()) + '»</button>'
        : '<h3>لەم بەشەدا کەس نییە</h3><p>فلتەرێکی تر هەڵبژێرە.</p>';
      list.innerHTML = '<div class="empty">' + hint + '</div>';
    } else {
      list.innerHTML = rows.map(card).join('');
    }
    $('#qClear').hidden = !q;
  }

  function card(m) {
    var inf = info(m);
    var tags = '';
    if (inf.expired) tags += '<span class="tag warn">بەسەرچووە ' + Math.abs(inf.days) + ' ڕۆژ لەمەوبەر</span>';
    else if (inf.days <= 5) tags += '<span class="tag warn">' + (inf.days === 0 ? 'ئەمڕۆ تەواو دەبێت' : 'ماوە ' + inf.days + ' ڕۆژ') + '</span>';
    else tags += '<span class="tag">ماوە ' + inf.days + ' ڕۆژ</span>';
    if (m.lastVisit) tags += '<span class="tag">' + (m.lastVisit === todayISO() ? 'ئەمڕۆ هاتووە' : 'دوایین هاتن ' + esc(m.lastVisit)) + '</span>';
    var days = (m.plan || []).filter(function (d) { return d && (d.t || d.x); }).length;
    tags += '<span class="tag">' + (days ? 'خشتە: ' + days + ' ڕۆژ' : 'بێ خشتە') + '</span>';

    var meta = '<span class="tag ' + (m.paid ? 'ok' : 'red') + '">' + (m.paid ? 'پارەی داوە' : 'پارەی نەداوە') + '</span>' +
      '<span>' + esc(PLAN[m.months] || '1 مانگ') + '</span>' +
      (m.phone ? '<span class="ph">' + esc(m.phone) + '</span>' : '') + tags;

    var del = confirmId === m.id
      ? '<span class="confirm">دڵنیایت؟ <button type="button" class="yes" data-act="del-yes" data-id="' + esc(m.id) + '">بەڵێ، بیسڕەوە</button><button type="button" class="no" data-act="del-no">نەخێر</button></span>'
      : '<button type="button" class="del" data-act="del" data-id="' + esc(m.id) + '">سڕینەوە</button>';

    return '<article class="m' + (m.paid ? ' paid' : '') + '">' +
      '<div class="m-head"><div class="m-name">' + esc(m.name) + '</div><div class="m-amt"><b>' + fmt(m.amount) + '</b><small>دینار</small></div></div>' +
      '<div class="m-meta">' + meta + '</div>' +
      (m.note ? '<div class="note">' + esc(m.note) + '</div>' : '') +
      '<div class="seg" role="group" aria-label="دۆخی پارەدان">' +
        '<button type="button" class="no' + (m.paid ? '' : ' on') + '" data-act="unpaid" data-id="' + esc(m.id) + '">پارەی نەداوە</button>' +
        '<button type="button" class="yes' + (m.paid ? ' on' : '') + '" data-act="paid" data-id="' + esc(m.id) + '">پارەی داوە</button>' +
      '</div>' +
      '<div class="codeline"><span>کۆد</span><code dir="ltr">' + esc(m.code) + '</code>' +
        '<button type="button" data-act="copy" data-id="' + esc(m.id) + '">کۆپی</button>' +
        '<a href="' + esc(waLink(m)) + '" target="_blank" rel="noopener">ناردن بە WhatsApp</a></div>' +
      '<div class="acts">' +
        '<button type="button" class="in" data-act="in" data-id="' + esc(m.id) + '">داخڵبوو</button>' +
        (inf.expired ? '<button type="button" data-act="renew" data-id="' + esc(m.id) + '">نوێکردنەوە</button>' : '') +
        '<button type="button" data-act="edit" data-id="' + esc(m.id) + '">دەستکاری</button>' +
        del +
      '</div></article>';
  }

  /* ---------- actions ---------- */
  function setPaid(id, val) {
    var m = find(id); if (!m || !!m.paid === val) return;
    save(Object.assign({}, m, { paid: val, paidAt: val ? todayISO() : null }));
    toast(val ? 'پارەدان تۆمار کرا' : 'وەک پارەنەدراو دانرا');
  }
  function checkIn(id) {
    var m = find(id); if (!m) return;
    var inf = info(m);
    var next = Object.assign({}, m, { lastVisit: todayISO() });
    var i = members.findIndex(function (x) { return x.id === id; });
    members[i] = next; persist(); render();
    if (!m.paid) toast('ئاگاداری: ' + m.name + ' پارەی نەداوە', true);
    else if (inf.expired) toast('ئاگاداری: ماوەی ' + m.name + ' بەسەرچووە', true);
    else toast(m.name + ' داخڵ بوو');
  }
  function renew(id) {
    var m = find(id); if (!m) return;
    save(Object.assign({}, m, { start: todayISO(), paid: false, paidAt: null }));
    toast('نوێکرایەوە. ئێستا پارەدانەکە تۆمار بکە.');
  }
  function copyCode(id) {
    var m = find(id); if (!m) return;
    var done = function () { toast('کۆد کۆپی کرا: ' + m.code); };
    var fail = function () { toast('کۆدەکە: ' + m.code); };
    try { navigator.clipboard.writeText(m.code).then(done, fail); } catch (e) { fail(); }
  }

  /* ---------- member form ---------- */
  function setPay(v) {
    payVal = v;
    document.querySelectorAll('#fPay button').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.v) === v); });
  }
  function renderPlan() {
    $('#fPlan').innerHTML = planDraft.map(function (d, i) {
      return '<div class="day"><div class="day-h"><input data-i="' + i + '" data-k="t" value="' + esc(d.t) + '" placeholder="ڕۆژی ' + (i + 1) + ' (بۆ نموونە: سنگ و ترایسێپس)" aria-label="ناوی ڕۆژ">' +
        '<button type="button" data-rm="' + i + '" aria-label="سڕینەوەی ڕۆژ">✕</button></div>' +
        '<textarea data-i="' + i + '" data-k="x" placeholder="هەر وەرزشێک لە هێڵێکدا بنووسە&#10;Bench Press 4×10&#10;Incline Press 3×12" aria-label="وەرزشەکان">' + esc(d.x) + '</textarea></div>';
    }).join('');
  }
  function renderCopy(exceptId) {
    var opts = members.filter(function (m) { return m.id !== exceptId && (m.plan || []).length; });
    $('#fCopy').innerHTML = '<option value="">کۆپی لە ئەندامێکی تر…</option>' +
      opts.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('');
    $('#fCopy').hidden = !opts.length;
  }
  function openForm(id, presetName) {
    editingId = id || null;
    var m = id ? find(id) : null;
    $('#fTitle').textContent = m ? 'دەستکاریکردنی ئەندام' : 'ئەندامی نوێ';
    $('#fName').value = m ? m.name : (presetName || '');
    $('#fAmount').value = m ? m.amount : '';
    $('#fMonths').value = String(m ? (m.months || 1) : 1);
    $('#fPhone').value = m ? (m.phone || '') : '';
    $('#fStart').value = m ? (m.start || todayISO()) : todayISO();
    $('#fNote').value = m ? (m.note || '') : '';
    formCode = m ? m.code : FG.genCode();
    $('#fCode').value = formCode;
    planDraft = m ? JSON.parse(JSON.stringify(m.plan || [])) : [];
    renderPlan(); renderCopy(id);
    setPay(m && m.paid ? 1 : 0);
    $('#fErr').textContent = '';
    $('#veil').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { (presetName ? $('#fAmount') : $('#fName')).focus(); }, 50);
  }
  function closeForm() { $('#veil').hidden = true; document.body.style.overflow = ''; editingId = null; }

  function submitForm(e) {
    e.preventDefault();
    var name = $('#fName').value.trim();
    var amountRaw = $('#fAmount').value.trim();
    var amount = Number(amountRaw);
    if (!name) { $('#fErr').textContent = 'ناوی ئەندام بنووسە.'; $('#fName').focus(); return; }
    if (amountRaw === '' || isNaN(amount) || amount < 0) { $('#fErr').textContent = 'نرخی دراو بنووسە (ژمارە).'; $('#fAmount').focus(); return; }
    var old = editingId ? find(editingId) : null;
    var paid = payVal === 1;
    var plan = planDraft.map(function (d) { return { t: (d.t || '').trim(), x: (d.x || '').trim() }; })
      .filter(function (d) { return d.t || d.x; });
    save(Object.assign({}, old || {}, {
      id: old ? old.id : newId(),
      name: name, amount: amount,
      months: Number($('#fMonths').value) || 1,
      phone: $('#fPhone').value.trim(),
      start: $('#fStart').value || todayISO(),
      note: $('#fNote').value.trim(),
      code: formCode,
      plan: plan,
      paid: paid,
      paidAt: paid ? ((old && old.paid && old.paidAt) || todayISO()) : null,
      createdAt: old ? (old.createdAt || Date.now()) : Date.now()
    }));
    closeForm();
    toast(old ? 'گۆڕانکارییەکان پاشەکەوت کران' : 'ئەندام تۆمار کرا');
  }

  /* ---------- settings ---------- */
  function openSettings() {
    var c = cfg || {};
    $('#gOwner').value = c.owner || '';
    $('#gRepo').value = c.repo || '';
    $('#gBranch').value = c.branch || 'main';
    $('#gToken').value = c.token || '';
    if (!c.owner && /\.github\.io$/.test(location.hostname)) {
      $('#gOwner').value = location.hostname.split('.')[0];
      var seg = location.pathname.split('/')[1];
      $('#gRepo').value = seg && !/\.html$/.test(seg) ? seg : location.hostname;
    }
    $('#gForget').hidden = !cfg;
    $('#gErr').textContent = '';
    $('#veil2').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSettings() { $('#veil2').hidden = true; document.body.style.overflow = ''; }
  function submitSettings(e) {
    e.preventDefault();
    var c = { owner: $('#gOwner').value.trim(), repo: $('#gRepo').value.trim(), branch: $('#gBranch').value.trim() || 'main', token: $('#gToken').value.trim() };
    if (!c.owner || !c.repo || !c.token) { $('#gErr').textContent = 'هەموو خانەکان پڕ بکەرەوە.'; return; }
    cfg = c; jset(LSG, cfg);
    closeSettings();
    publish();
  }

  /* ---------- backup ---------- */
  function exportData() {
    var blob = new Blob([JSON.stringify(members, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'forge-gym-' + todayISO() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('کۆپی تۆمارەکان دابەزی');
  }
  function importData(file) {
    if (!file) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var list = JSON.parse(r.result);
        if (!Array.isArray(list)) throw new Error('bad');
        var ok = list.filter(function (m) { return m && typeof m === 'object' && m.name; });
        ok.forEach(function (m) {
          m.id = m.id || newId();
          if (!m.code) m.code = FG.genCode();
          if (!Array.isArray(m.plan)) m.plan = [];
          var i = members.findIndex(function (x) { return x.id === m.id; });
          if (i < 0) members.push(m); else members[i] = m;
        });
        members.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        persist(); render(); schedulePublish();
        toast(ok.length + ' ئەندام گەڕێنرایەوە');
      } catch (e) { toast('ئەم فایلە دروست نییە.', true); }
    };
    r.readAsText(file);
  }

  /* ---------- events ---------- */
  $('#btnAdd').addEventListener('click', function () { openForm(); });
  $('#pill').addEventListener('click', function () { if (!cfg) openSettings(); else publish(); });
  $('#q').addEventListener('input', function (e) { q = e.target.value; render(); });
  $('#qClear').addEventListener('click', function () { q = ''; $('#q').value = ''; render(); $('#q').focus(); });
  $('#chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    filter = b.dataset.f; render();
  });
  $('#list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var a = b.dataset.act, id = b.dataset.id;
    if (a === 'add') openForm();
    else if (a === 'add-q') openForm(null, q.trim());
    else if (a === 'paid') setPaid(id, true);
    else if (a === 'unpaid') setPaid(id, false);
    else if (a === 'in') checkIn(id);
    else if (a === 'renew') renew(id);
    else if (a === 'copy') copyCode(id);
    else if (a === 'edit') openForm(id);
    else if (a === 'del') { confirmId = id; render(); }
    else if (a === 'del-no') { confirmId = null; render(); }
    else if (a === 'del-yes') { confirmId = null; removeMember(id); toast('سڕایەوە'); }
  });
  $('#fPay').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setPay(Number(b.dataset.v)); });
  $('#fNewCode').addEventListener('click', function () { formCode = FG.genCode(); $('#fCode').value = formCode; });
  $('#fAddDay').addEventListener('click', function () { planDraft.push({ t: '', x: '' }); renderPlan(); var t = $('#fPlan').querySelectorAll('input'); if (t.length) t[t.length - 1].focus(); });
  $('#fPlan').addEventListener('input', function (e) {
    var el = e.target, i = el.dataset.i;
    if (i != null && planDraft[i]) planDraft[i][el.dataset.k] = el.value;
  });
  $('#fPlan').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm]'); if (!b) return;
    planDraft.splice(Number(b.dataset.rm), 1); renderPlan();
  });
  $('#fCopy').addEventListener('change', function (e) {
    var m = find(e.target.value);
    if (m) { planDraft = JSON.parse(JSON.stringify(m.plan || [])); renderPlan(); }
    e.target.value = '';
  });
  $('#form').addEventListener('submit', submitForm);
  $('#fCancel').addEventListener('click', closeForm);
  $('#veil').addEventListener('click', function (e) { if (e.target === this) closeForm(); });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#gform').addEventListener('submit', submitSettings);
  $('#gCancel').addEventListener('click', closeSettings);
  $('#gForget').addEventListener('click', function () {
    cfg = null; try { localStorage.removeItem(LSG); } catch (e) {}
    closeSettings(); setPub('none'); toast('تۆکن لەم ئامێرە سڕایەوە');
  });
  $('#veil2').addEventListener('click', function (e) { if (e.target === this) closeSettings(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#veil').hidden) closeForm();
    if (!$('#veil2').hidden) closeSettings();
  });
  $('#btnExport').addEventListener('click', exportData);
  $('#btnImport').addEventListener('click', function () { $('#fileImport').click(); });
  $('#fileImport').addEventListener('change', function (e) { importData(e.target.files[0]); e.target.value = ''; });

  load();
  render();
  setPub(cfg ? 'idle' : 'none');
})();
