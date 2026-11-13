/* Forge Gym: owner panel (admin.html).
   Members are kept in this browser. Each member gets a private code (random, or chosen freely by the owner).
   When something changes, the member portal data (name, expiry, workout plan) is encrypted with the member's code
   and published to portal.json on GitHub.
   v2: the whole panel stays hidden behind a GitHub-token gate; nothing is loaded or rendered until the token is verified. */
(function () {
  var LSIT = 'forge_gym_iter', LS = 'forge_gym_members_v1', LSG = 'forge_gym_github', LSC = 'forge_gym_cache_v1', LSB = 'forge_gym_lastbackup', LSCB = 'forge_gym_lastcloudbackup';
  var SKT = 'forge_gym_session_token', LST = 'forge_gym_saved_token';
  var IDLE_MS = 15 * 60 * 1000;
  var PLAN = { 1: '1 هەیڤ', 3: '3 هەیڤ', 6: '6 هەیڤ', 12: 'ساڵەک' };
  var members = [], cfg = null, cache = {};
  var q = '', filter = 'all', editingId = null, payVal = 0, confirmId = null;
  var formCode = '', planDraft = [];
  var LSS = 'forge_gym_status', LSL = 'forge_gym_log_v1', LSLR = 'forge_gym_log_read';
  var gstat = jget(LSS, { open: true, msg: '', t: 0 }), stAsk = null, stSync = 'none', log = jget(LSL, []);
  var pubState = 'none', pubTimer = null, pubBusy = false, pubAgain = false, toastT = null, idleT = null, bkPass = null, pendingOverwrite = false;

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
  function sget(st, k) { try { return window[st].getItem(k); } catch (e) { return null; } }
  function sset(st, k, v) { try { if (v == null) window[st].removeItem(k); else window[st].setItem(k, v); } catch (e) {} }

  function codeTaken(code, exceptId) {
    var n = FG.normCode(code);
    return members.some(function (m) { return m.id !== exceptId && FG.normCode(m.code) === n; });
  }
  function freshCode() {
    var c;
    do { c = FG.genCode(); } while (codeTaken(c));
    return c;
  }

  function load() {
    members = jget(LS, []);
    if (!Array.isArray(members)) members = [];
    cache = jget(LSC, {});
    var changed = false;
    members.forEach(function (m) {
      if (!m.code) { m.code = freshCode(); changed = true; }
      if (!Array.isArray(m.plan)) { m.plan = []; changed = true; }
    });
    members.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    if (changed) persist();
  }
  function persist() {
    if (!jset(LS, members)) toast('پاشەکەفت نەبوو. براوزەرێ تە ڕێ نادەت.', true);
  }
  function newId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function find(id) { return members.find(function (m) { return m.id === id; }); }
  function save(m) {
    m.updatedAt = Date.now();
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

  /* ---------- the token gate ---------- */
  function ghErr(e) {
    if (e.status === 401) return 'تۆکن خەلەتە یان ب دوماهی هاتیە.';
    if (e.status === 403) return 'تۆکنێ ڕێ پێدانا Contents (Read and write) نینە.';
    if (e.status === 404) return 'Repository یان Branch نەهاتە دیتن.';
    if (!e.status) return 'ئینتەرنێتا تە نینە یان گرێدان نەچوو.';
    return 'خەلەتیەک چێبوو (' + (e.message || e.status) + ').';
  }

  async function verify(c) {
    var r = await fetch('https://api.github.com/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo), {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json' }
    });
    if (!r.ok) { var e = new Error(r.status); e.status = r.status; throw e; }
    var j = await r.json();
    if (j && j.permissions && j.permissions.push === false) { var e2 = new Error('perm'); e2.status = 403; throw e2; }
  }

  function gateBusy(b) {
    var btn = $('#gBtn');
    btn.disabled = b;
    btn.textContent = b ? 'چاڤەڕێ بە…' : 'چوونە ژوورڤە';
  }

  function prefillGate() {
    var c = jget(LSG, {}) || {};
    var owner = c.owner || '', repo = c.repo || '';
    if (!owner && /\.github\.io$/.test(location.hostname)) {
      owner = location.hostname.split('.')[0];
      var seg = location.pathname.split('/')[1];
      repo = seg && !/\.html$/.test(seg) ? seg : location.hostname;
    }
    $('#gOwner').value = owner;
    $('#gRepo').value = repo;
    $('#gBranch').value = c.branch || 'main';
    $('#gDetails').open = !(owner && repo);
    $('#gRemember').checked = false;
  }

  async function unlock(c, remember) {
    await verify(c);
    cfg = c;
    jset(LSG, { owner: c.owner, repo: c.repo, branch: c.branch });   /* the token is never stored in this object */
    sset('sessionStorage', SKT, c.token);
    sset('localStorage', LST, remember ? c.token : null);
    enter();
  }

  function enter() {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    $('#gToken').value = '';
    $('#gErr').textContent = '';
    load(); render(); setPub('idle'); armIdle(); loadStatus(); setTab(location.hash.slice(1));
    if (members.length && jget(LSIT, 0) !== FG.ITER) schedulePublish();   /* one-time: publish with the stronger encryption */
  }

  function lock(msg) {
    clearTimeout(pubTimer); clearTimeout(idleT);
    sset('sessionStorage', SKT, null); sset('localStorage', LST, null);
    cfg = null; members = []; cache = {}; bkPass = null;
    editingId = null; confirmId = null; q = ''; filter = 'all'; pubBusy = false; pubAgain = false;
    $('#veil').hidden = true; $('#veil3').hidden = true; $('#veil4').hidden = true; $('#res').hidden = true; document.body.style.overflow = '';
    $('#list').innerHTML = ''; $('#chips').innerHTML = ''; $('#q').value = ''; $('#bkbar').hidden = true;
    $('#sTotal').textContent = '0'; $('#sPaid').textContent = '0'; $('#sUnpaid').textContent = '0'; $('#sSum').innerHTML = '0<em>د.ع</em>';
    $('#app').hidden = true;
    $('#gate').hidden = false;
    prefillGate();
    $('#gToken').value = '';
    $('#gErr').textContent = msg || '';
  }

  /* publish what is still waiting before the token is wiped */
  async function lockSafe(msg) {
    if (pubState === 'dirty') await publish();
    var n = 0;
    while (pubBusy && n++ < 40) await new Promise(function (r) { setTimeout(r, 250); });
    lock(msg);
  }

  function armIdle() {
    clearTimeout(idleT);
    if (!cfg) return;
    idleT = setTimeout(function () {
      if (!$('#veil').hidden || !$('#veil3').hidden) { armIdle(); return; }   /* never lock while a form is open */
      lockSafe('هاتە داخستن ژ بەر نەچالاکییێ. تۆکنێ دووبارە بنڤیسە.');
    }, IDLE_MS);
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, function () { if (cfg) armIdle(); }, { passive: true });
  });

  async function submitGate(e) {
    e.preventDefault();
    var c = {
      owner: $('#gOwner').value.trim(),
      repo: $('#gRepo').value.trim(),
      branch: $('#gBranch').value.trim() || 'main',
      token: $('#gToken').value.replace(/\s/g, '')
    };
    var err = $('#gErr'); err.textContent = '';
    if (!c.token) { err.textContent = 'تۆکنێ بنڤیسە.'; $('#gToken').focus(); return; }
    if (!c.owner || !c.repo) { $('#gDetails').open = true; err.textContent = 'ناڤێ بەکارهێنەرێ GitHub و Repository بنڤیسە.'; return; }
    gateBusy(true);
    try { await unlock(c, $('#gRemember').checked); }
    catch (x) { err.textContent = ghErr(x); }
    gateBusy(false);
  }

  /* ---------- publishing to GitHub ---------- */
  var PILL = {
    none: ['نەهاتیە بەلاڤکرن', 'warn'], idle: ['بەلاڤکرن', ''], dirty: ['چاڤەڕێی بەلاڤکرنێیە…', 'warn'],
    busy: ['دهێتە بەلاڤکرن…', 'warn'], ok: ['هاتە بەلاڤکرن ✓', 'ok'], err: ['خەلەتی، دووبارە هەوڵ بدە', 'bad']
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

  async function gh(path, opt) {
    var r = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/' + path, Object.assign({ cache: 'no-store' }, opt, {
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
    }));
    if (r.status === 404 && opt && opt.allow404) return null;
    if (!r.ok) { var e = new Error(r.status); e.status = r.status; throw e; }
    return r.json();
  }

  async function publish() {
    if (!cfg) return;
    if (pubBusy) { pubAgain = true; return; }
    pubBusy = true; clearTimeout(pubTimer); setPub('busy');
    try {
      var records = {}, keep = {};
      for (var i = 0; i < members.length; i++) {
        var m = members[i], data = portalData(m);
        var sig = FG.ITER + '|' + m.code + '|' + JSON.stringify(data);
        var c = cache[m.id];
        if (!c || c.sig !== sig) {
          var d = await FG.derive(m.code, FG.ITER);
          c = { sig: sig, id: d.id, rec: await FG.encrypt(data, d.key) };
          cache[m.id] = c;
        }
        keep[m.id] = 1;
        records[c.id] = c.rec;
      }
      Object.keys(cache).forEach(function (k) { if (!keep[k]) delete cache[k]; });
      jset(LSC, cache);

      var body = JSON.stringify({ v: 2, i: FG.ITER, r: records });
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
      setPub('ok'); jset(LSIT, FG.ITER);
      if (bkPass) {   /* keep the encrypted cloud backup in step, once the owner has unlocked it this session */
        try { await cloudBackup(bkPass); jset(LSCB, todayISO()); }
        catch (e2) { toast('پاراستنا ل GitHub نەچوو: ' + ghErr(e2), true); }
      }
    } catch (e) {
      setPub('err'); logEv('bad', 'بەلاڤکرنا گوهۆڕینان ل GitHub نەچوو: ' + ghErr(e));
      toast(ghErr(e), true);
    }
    pubBusy = false;
    if (pubAgain) { pubAgain = false; schedulePublish(); }
  }

  /* ---------- member codes: free choice, but strong enough ----------
     portal.json is public, so anyone can try guesses offline. A weak code (a phone number, a name, 1234...) could be
     found that way. These rules keep chosen codes out of that range. */
  var SEQS = ['0123456789', '9876543210', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'ZYXWVUTSRQPONMLKJIHGFEDCBA', 'QWERTYUIOPASDFGHJKLZXCVBNM', 'QWERTYUIOP', 'ASDFGHJKL'];
  var COMMON = ['PASSWORD', 'PASSWORD1', 'FORGEGYM', 'FORGE1234', 'FORGEGYM1', 'ABC12345', 'ABCD1234', 'QWERTY123', 'ILOVEYOU', 'WELCOME1'];

  function codeProblem(raw, selfId, phone, oldMember) {
    var s = String(raw || '');
    if (/[^A-Za-z0-9\s-]/.test(s)) return 'تنێ پیتێن ئینگلیزی (A-Z) و ژمارە (0-9) بکاربینە.';
    var c = FG.normCode(s);
    if (codeTaken(c, selfId)) return 'ئەڤ کۆدە بەری نھا بۆ ئەندامەکێ دی هاتیە بکارئینان.';
    /* a code that was already there before is not blocked from edits, only duplicates are */
    if (oldMember && FG.normCode(oldMember.code) === c) return '';
    if (c.length < 8) return 'کۆد دڤێت کێم ژ 8 پیت و ژمارە بیت.';
    if (c.length > 24) return 'کۆد نابیت ژ 24 پیت و ژمارەیان درێژتر بیت.';
    if (/^(.)\1+$/.test(c)) return 'ئەڤ کۆدە گەلەک ئاسانە (یەک پیت دووبارە بوویە).';
    for (var i = 0; i < SEQS.length; i++) if (SEQS[i].indexOf(c) >= 0) return 'ئەڤ کۆدە گەلەک ئاسانە (ڕیزکرنەکا ئاسانە).';
    if (COMMON.indexOf(c) >= 0) return 'ئەڤ کۆدە گەلەک بەربڵاڤە و ئاسان دهێتە زانین.';
    var ph = String(phone || '').replace(/\D/g, '');
    if (ph.length >= 7 && c.indexOf(ph.slice(-7)) >= 0) return 'ژمارا مۆبایلێ د کۆدی دا بکارنەهینە، ئاسان دهێتە زانین.';
    if (/^[A-Z]{3,}[0-9]{2,6}$/.test(c) || /^[0-9]{2,6}[A-Z]{3,}$/.test(c)) return 'ئەڤ کۆدە ناڤەک + ژمارەیە و ئاسان دهێتە زانین. پیت و ژمارە تێکەل بکە، یان دوگمەیا «کۆدەکێ ڕێکەفتی» بکە.';
    var hasD = /[0-9]/.test(c), hasL = /[A-Z]/.test(c);
    var bits = c.length * Math.log2((hasD ? 10 : 0) + (hasL ? 26 : 0));
    if (bits < 40) return 'کۆد لاوازە. پیت و ژمارە تێکەل بکە و درێژتر بکە (بۆ نموونە 8 پیت و ژمارە).';
    return '';
  }

  function showCodeHint() {
    var h = $('#fCodeHint'), raw = $('#fCode').value;
    if (!raw.trim()) { h.textContent = ''; h.className = 'codehint'; return; }
    var p = codeProblem(raw, editingId, $('#fPhone').value, editingId ? find(editingId) : null);
    h.textContent = p || 'کۆد باشە ✓';
    h.className = 'codehint ' + (p ? 'bad' : 'ok');
  }

  /* ---------- render ---------- */
  function siteUrl() { return location.origin + location.pathname.replace(/[^\/]*$/, '') + 'index.html'; }
  function waLink(m) {
    var p = String(m.phone || '').replace(/\D/g, '').replace(/^00/, '');
    if (p && p.indexOf('964') !== 0) p = '964' + p.replace(/^0/, '');   /* 0750..., 750... and 00964... all become 964750... */
    var text = 'سلاڤ ' + m.name + '،\nکۆدێ تایبەتێ تە بۆ دیتنا خشتەیا ڕاهێنانێ و ماوەیا ئەندامەتیێ:\n' + m.code + '\n\nلینک: ' + siteUrl() + '#' + FG.normCode(m.code);
    return 'https://wa.me/' + p + '?text=' + encodeURIComponent(text);
  }

  function backupBar() {
    var bar = $('#bkbar');
    if (!members.length) { bar.hidden = true; return; }
    var last = lastBackupDate();
    var age = last ? dayDiff(parseISO(last), parseISO(todayISO())) : null;
    if (last && age < 7) { bar.hidden = true; return; }
    $('#bkText').textContent = last
      ? 'ئاگەهداری: ' + age + ' ڕۆژ ژ دوماهیک کۆپیکرنا تۆمارا بوری ینە. داتا تنێ د ڤی ئامێری دایە.'
      : 'ئاگەهداری: هێشتا کۆپیەکا تۆمارا نەهاتیە ڤەگرتن. ئەگەر داتایا ڤی براوزەری بهێتە ژێبرن، هەمی ئەندام دێ ژ دەست چن.';
    bar.hidden = false;
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
    var soonN = members.filter(function (m) { var i = info(m); return !i.expired && i.days <= 5; }).length;
    var defs = [['all', 'هەمی', total], ['paid', 'پارە دایە', paid.length], ['unpaid', 'پارە نەدایە', total - paid.length], ['soon', 'نێزیک ب دوماهی', soonN], ['expired', 'ب دوماهی هاتی', expiredN]];
    $('#chips').innerHTML = defs.map(function (d) {
      return '<button type="button" class="chip' + (filter === d[0] ? ' on' : '') + '" data-f="' + d[0] + '">' + d[1] + '<b>' + d[2] + '</b></button>';
    }).join('');

    var term = q.trim().toLowerCase();
    var rows = members.filter(function (m) {
      if (filter === 'paid' && !m.paid) return false;
      if (filter === 'unpaid' && m.paid) return false;
      if (filter === 'expired' && !info(m).expired) return false;
      if (filter === 'soon' && (info(m).expired || info(m).days > 5)) return false;
      if (!term) return true;
      return String(m.name || '').toLowerCase().indexOf(term) >= 0 ||
        String(m.phone || '').replace(/\s/g, '').indexOf(term.replace(/\s/g, '')) >= 0;
    });

    var list = $('#list');
    if (!members.length) {
      list.innerHTML = '<div class="empty"><h3>هێشتا چ ئەندام نەهاتینە تۆمارکرن</h3><p>ئەندامێ یەکەم زێدە بکە. کۆدێ وی یێ تایبەت و خشتەیا ڕاهێنانێ بۆ چێ دکەی.</p><button class="btn-add" type="button" data-act="add">+ ئەندامێ نوی</button></div>';
    } else if (!rows.length) {
      var hint = term
        ? '<h3>چ ناڤ نەهاتە دیتن</h3><p>ئەڤ ناڤە نەهاتیە تۆمارکرن.</p><button class="btn-add" type="button" data-act="add-q">+ تۆمارکرنا «' + esc(q.trim()) + '»</button>'
        : '<h3>د ڤێ بەشێ دا چ کەس نینن</h3><p>فلتەرەکێ دی هەلبژێرە.</p>';
      list.innerHTML = '<div class="empty">' + hint + '</div>';
    } else {
      list.innerHTML = rows.map(card).join('');
    }
    $('#qClear').hidden = !q;
    backupBar(); renderStatus(); renderAttn(); renderLogBadge(); renderToday(); renderMoney();
  }

  function card(m) {
    var inf = info(m);
    var tags = '';
    if (inf.expired) tags += '<span class="tag warn">ب دوماهی هاتیە ' + Math.abs(inf.days) + ' ڕۆژ بەری ئێستا</span>';
    else if (inf.days <= 5) tags += '<span class="tag warn">' + (inf.days === 0 ? 'ئەڤرو ب دوماهی دهێت' : 'ماینە ' + inf.days + ' ڕۆژ') + '</span>';
    else tags += '<span class="tag">ماینە ' + inf.days + ' ڕۆژ</span>';
    if (m.lastVisit) tags += '<span class="tag">' + (m.lastVisit === todayISO() ? 'ئەڤرو هاتیە' : 'دوماهیک هاتن ' + esc(m.lastVisit)) + '</span>';
    var days = (m.plan || []).filter(function (d) { return d && (d.t || d.x); }).length;
    tags += '<span class="tag">' + (days ? 'خشتە: ' + days + ' ڕۆژ' : 'بێ خشتە') + '</span>';

    var meta = '<span class="tag ' + (m.paid ? 'ok' : 'red') + '">' + (m.paid ? 'پارە دایە' : 'پارە نەدایە') + '</span>' +
      '<span>' + esc(PLAN[m.months] || '1 هەیڤ') + '</span>' +
      (m.phone ? '<span class="ph">' + esc(m.phone) + '</span>' : '') + tags;

    var del = confirmId === m.id
      ? '<span class="confirm">پشت ڕاستی؟ <button type="button" class="yes" data-act="del-yes" data-id="' + esc(m.id) + '">بەلێ، ژێببە</button><button type="button" class="no" data-act="del-no">نەخێر</button></span>'
      : '<button type="button" class="del" data-act="del" data-id="' + esc(m.id) + '">ژێببە</button>';

    return '<article class="m' + (m.paid ? ' paid' : '') + (inf.expired ? ' exp' : inf.days <= 5 ? ' soon' : '') + '">' +
      '<div class="m-head"><div class="m-name">' + esc(m.name) + '</div><div class="m-amt"><b>' + fmt(m.amount) + '</b><small>دینار</small></div></div>' +
      '<div class="m-meta">' + meta + '</div>' +
      (m.note ? '<div class="note">' + esc(m.note) + '</div>' : '') +
      '<div class="seg" role="group" aria-label="دۆخێ پارەدانێ">' +
        '<button type="button" class="no' + (m.paid ? '' : ' on') + '" data-act="unpaid" data-id="' + esc(m.id) + '">پارە نەدایە</button>' +
        '<button type="button" class="yes' + (m.paid ? ' on' : '') + '" data-act="paid" data-id="' + esc(m.id) + '">پارە دایە</button>' +
      '</div>' +
      '<div class="codeline"><span>کۆد</span><code dir="ltr">' + esc(m.code) + '</code>' +
        '<button type="button" data-act="copy" data-id="' + esc(m.id) + '">کۆپی</button>' +
        '<a href="' + esc(waLink(m)) + '" target="_blank" rel="noopener">ناردن ب WhatsApp</a></div>' +
      '<div class="acts">' +
        '<button type="button" class="in" data-act="in" data-id="' + esc(m.id) + '">چووە ژوور</button>' +
        (inf.expired ? '<button type="button" data-act="renew" data-id="' + esc(m.id) + '">نویکرن</button>' : '') +
        '<button type="button" data-act="edit" data-id="' + esc(m.id) + '">دەستکاری</button>' +
        del +
      '</div></article>';
  }

  /* ---------- actions ---------- */
  function setPaid(id, val) {
    var m = find(id); if (!m || !!m.paid === val) return;
    if (val) addPay(m, Number(m.amount) || 0); else dropPay(m);
    save(Object.assign({}, m, { paid: val, paidAt: val ? todayISO() : null }));
    logEv(val ? 'ok' : 'warn', m.name + (val ? ': پارەدان هاتە تۆمارکرن (' + fmt(m.amount) + ' دینار)' : ': وەک پارە نەدایی هاتە دانان'));
    toast(val ? 'پارەدان هاتە تۆمارکرن' : 'وەک پارە نەدایی هاتە دانان');
  }
  function addPay(m, a) { if (pays === null) renderMoney(); pays.push({ d: todayISO(), a: a, n: m.name, i: m.id }); jset(LSP, pays); }
  function dropPay(m) {
    if (pays === null) renderMoney();
    for (var z = pays.length - 1; z >= 0; z--) if (pays[z].i ? pays[z].i === m.id : pays[z].n === m.name) { pays.splice(z, 1); break; }
    jset(LSP, pays);
  }
  function checkIn(id) {
    var m = find(id); if (!m) return;
    var inf = info(m);
    var next = Object.assign({}, m, { lastVisit: todayISO(), updatedAt: Date.now() });
    var i = members.findIndex(function (x) { return x.id === id; });
    members[i] = next; persist(); render();
    if (!m.paid) { showRes('bad', m.name, 'پارە نەدایە. نەهێلە بچیتە ژوور.'); logEv('bad', m.name + ' هاتە ژوور، بەلێ پارە نەدایە'); }
    else if (inf.expired) { showRes('bad', m.name, 'ماوەیا ئەندامەتیێ ب دوماهی هاتیە.'); logEv('bad', m.name + ' هاتە ژوور، بەلێ ماوە ب دوماهی هاتیە'); }
    else if (inf.days <= 5) { showRes('warn', m.name, 'بێت ژوور. ' + (inf.days ? 'تنێ ' + inf.days + ' ڕۆژ ماینە.' : 'ئەڤرو ب دوماهی دهێت.')); logEv('in', m.name + ' چووە ژوور'); }
    else { showRes('ok', m.name, 'بخێر بێت. ' + inf.days + ' ڕۆژ ماینە.'); logEv('in', m.name + ' چووە ژوور'); }
  }
  function renew(id) {
    var m = find(id); if (!m) return;
    save(Object.assign({}, m, { start: todayISO(), paid: false, paidAt: null }));
    logEv('hot', m.name + ': ئەندامەتی هاتە نویکرن');
    toast('هاتە نویکرن. ئێستا پارەدانێ تۆمار بکە.');
  }
  function copyCode(id) {
    var m = find(id); if (!m) return;
    var done = function () { toast('کۆد هاتە کۆپیکرن: ' + m.code); };
    var fail = function () { toast('کۆدێ ئەندامی: ' + m.code); };
    try { navigator.clipboard.writeText(m.code).then(done, fail); } catch (e) { fail(); }
  }

  /* ---------- member form ---------- */
  function setPay(v) {
    payVal = v;
    document.querySelectorAll('#fPay button').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.v) === v); });
  }
  function renderPlan() {
    $('#fPlan').innerHTML = planDraft.map(function (d, i) {
      return '<div class="day"><div class="day-h"><input data-i="' + i + '" data-k="t" value="' + esc(d.t) + '" placeholder="ڕۆژا ' + (i + 1) + ' (بۆ نموونە: سنگ و ترایسێپس)" aria-label="ناڤێ ڕۆژێ">' +
        '<button type="button" data-rm="' + i + '" aria-label="ژێبرنا ڕۆژێ">✕</button></div>' +
        '<textarea data-i="' + i + '" data-k="x" placeholder="هەر ڕاهێنانەکێ د هێلەکێ دا بنڤیسە&#10;Bench Press 4×10&#10;Incline Press 3×12" aria-label="ڕاهێنان">' + esc(d.x) + '</textarea></div>';
    }).join('');
  }
  function renderCopy(exceptId) {
    var opts = members.filter(function (m) { return m.id !== exceptId && (m.plan || []).length; });
    $('#fCopy').innerHTML = '<option value="">کۆپی ژ ئەندامەکێ دی…</option>' +
      opts.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('');
    $('#fCopy').hidden = !opts.length;
  }
  function openForm(id, presetName) {
    editingId = id || null;
    var m = id ? find(id) : null;
    $('#fTitle').textContent = m ? 'دەستکاریکرنا ئەندامی' : 'ئەندامێ نوی';
    $('#fName').value = m ? m.name : (presetName || '');
    $('#fAmount').value = m ? m.amount : '';
    $('#fMonths').value = String(m ? (m.months || 1) : 1);
    $('#fPhone').value = m ? (m.phone || '') : '';
    $('#fStart').value = m ? (m.start || todayISO()) : todayISO();
    $('#fNote').value = m ? (m.note || '') : '';
    formCode = m ? m.code : freshCode();
    $('#fCode').value = formCode;
    showCodeHint();
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
    if (!name) { $('#fErr').textContent = 'ناڤێ ئەندامی بنڤیسە.'; $('#fName').focus(); return; }
    if (amountRaw === '' || isNaN(amount) || amount < 0) { $('#fErr').textContent = 'نرخێ پارەی بنڤیسە (ژمارە).'; $('#fAmount').focus(); return; }
    var old = editingId ? find(editingId) : null;
    var codeRaw = $('#fCode').value.trim().toUpperCase();
    var prob = codeProblem(codeRaw, editingId, $('#fPhone').value, old);
    if (prob) { $('#fErr').textContent = prob; $('#fCode').focus(); return; }
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
      code: codeRaw,
      plan: plan,
      paid: paid,
      paidAt: paid ? ((old && old.paid && old.paidAt) || todayISO()) : null,
      createdAt: old ? (old.createdAt || Date.now()) : Date.now()
    }));
    var sid = old ? old.id : members[0].id;   /* a new member is put first by save() */
    if (paid && !(old && old.paid)) addPay({ id: sid, name: name }, amount);
    else if (!paid && old && old.paid) dropPay({ id: old.id, name: old.name });   /* was missing: un-paying from the form left the income in the report */
    renderMoney();
    logEv(old ? 'hot' : 'ok', old ? 'زانیاریێن ' + name + ' هاتنە گوهۆڕین' : 'ئەندامێ نوی هاتە زێدەکرن: ' + name);
    closeForm();
    toast(old ? 'گوهورین هاتنە پاشەکەفتکرن' : 'ئەندام هاتە تۆمارکرن');
  }

  /* ---------- backup ---------- */
  function lastBackupDate() {
    var x = jget(LSB, null), y = jget(LSCB, null);
    return (x && y) ? (x > y ? x : y) : (x || y);
  }
  function markLocalBackup() { jset(LSB, todayISO()); render(); }

  /* on a phone this opens the share sheet (WhatsApp, Drive, Files...); elsewhere it downloads the file */
  async function exportData() {
    var json = JSON.stringify(members, null, 2), name = 'forge-gym-' + todayISO() + '.json';
    try {
      var file = new File([json], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Forge Gym' });
        markLocalBackup(); toast('کۆپی هاتە ناردن');
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    markLocalBackup();
    toast('کۆپیا تۆمارا هاتە دابەزاندن');
  }

  function mergeMembers(list) {
    var ok = list.filter(function (m) { return m && typeof m === 'object' && m.name; }), applied = 0;
    ok.forEach(function (m) {
      var cur = m.id && find(m.id);
      if (cur && (cur.updatedAt || 0) > (m.updatedAt || 0)) return;   /* what is on this device is newer: keep it */
      applied++;
      m.id = m.id || newId();
      m.name = String(m.name).slice(0, 80);
      m.amount = Math.max(0, Number(m.amount) || 0);
      if (!PLAN[m.months]) m.months = 1;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(m.start || '')) m.start = todayISO();
      if (!m.code || codeTaken(m.code, m.id)) m.code = freshCode();
      if (!Array.isArray(m.plan)) m.plan = [];
      var i = members.findIndex(function (x) { return x.id === m.id; });
      if (i < 0) members.push(m); else members[i] = m;
    });
    members.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return applied;
  }
  function importData(file) {
    if (!file) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var list = JSON.parse(r.result);
        if (!Array.isArray(list)) throw new Error('bad');
        var n = mergeMembers(list);
        persist(); render(); schedulePublish();
        toast(n + ' ئەندام هاتنە ڤەگەڕاندن');
      } catch (e) { toast('ئەڤ فایلە ڕاست نینە.', true); }
    };
    r.readAsText(file);
  }

  /* ---------- encrypted cloud backup (forge-backup.json on GitHub) ---------- */
  async function putFile(path, body, message) {
    for (var tries = 0; tries < 3; tries++) {
      var cur = await gh('contents/' + path + '?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now(), { allow404: true });
      try {
        await gh('contents/' + path, {
          method: 'PUT',
          body: JSON.stringify(Object.assign({ message: message, content: btoa(body), branch: cfg.branch }, cur ? { sha: cur.sha } : {}))
        });
        return;
      } catch (e) {
        if ((e.status !== 409 && e.status !== 422) || tries === 2) throw e;
      }
    }
  }
  async function ghRaw(path) {
    var r = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/' + path, {
      cache: 'no-store',
      headers: { Authorization: 'Bearer ' + cfg.token, Accept: 'application/vnd.github.raw+json' }
    });
    if (r.status === 404) return null;
    if (!r.ok) { var e = new Error(r.status); e.status = r.status; throw e; }
    return r.text();
  }
  async function cloudBackup(pass) {
    var rec = await FG.encryptPass({ v: 1, at: Date.now(), members: members, log: log, exp: expenses, pays: pays }, pass);
    await putFile('forge-backup.json', JSON.stringify(Object.assign({ v: 1 }, rec)), 'Update encrypted backup');
  }
  async function cloudExists() {
    return !!(await gh('contents/forge-backup.json?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now(), { allow404: true }));
  }

  function passProblem(p) {
    if (p.length < 10) return 'پاسۆرد دڤێت کێم ژ 10 پیت و ژمارە بیت.';
    if (/^\d+$/.test(p)) return 'پاسۆرد نابیت تنێ ژمارە بیت.';
    if (/^(.)\1+$/.test(p)) return 'ئەڤ پاسۆردە گەلەک ئاسانە.';
    return '';
  }
  function cloudBusy(b) {
    $('#bSave').disabled = b; $('#bRestore').disabled = b;
    $('#bSave').textContent = b ? 'چاڤەڕێ بە…' : 'پاراستن ئێستا';
  }
  function openCloud() {
    $('#bPass').value = ''; $('#bPass2').value = ''; $('#bErr').textContent = '';
    pendingOverwrite = false;
    $('#bConfirmBox').hidden = !!jget(LSCB, null);
    $('#veil3').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { $('#bPass').focus(); }, 50);
  }
  function closeCloud() { $('#veil3').hidden = true; document.body.style.overflow = ''; }

  async function submitCloud(e) {
    e.preventDefault();
    var p = $('#bPass').value, err = $('#bErr'); err.textContent = '';
    var prob = passProblem(p);
    if (prob) { err.textContent = prob; $('#bPass').focus(); return; }
    if (!$('#bConfirmBox').hidden && p !== $('#bPass2').value) { err.textContent = 'هەردوو پاسۆرد وەک ئێک نینن.'; return; }
    if (!members.length) { err.textContent = 'هێشتا چ ئەندام نینن بۆ پاراستنێ. ئەگەر دخوازی کۆپیەکا کەڤن ڤەگەڕینی، دوگمەیا «ڤەگەڕاندن» بکە.'; return; }
    cloudBusy(true);
    try {
      /* never silently replace an older cloud copy from a device that has not made one yet */
      if (!jget(LSCB, null) && !pendingOverwrite && await cloudExists()) {
        pendingOverwrite = true;
        err.textContent = 'کۆپیەکا کەڤن ل GitHub هەیە. ئەگەر دخوازی ڤەگەڕینی، «ڤەگەڕاندن» بکە. ئەگەر دخوازی ب ڤێ نوی بگوهۆڕی، دووبارە «پاراستن» بکە.';
        cloudBusy(false);
        return;
      }
      await cloudBackup(p);
      bkPass = p; jset(LSCB, todayISO());
      closeCloud(); render();
      logEv('ok', 'کۆپیا کۆدکری ل GitHub هاتە پاراستن');
      toast('تۆمار ل GitHub هاتنە پاراستن ✓');
    } catch (x) { err.textContent = ghErr(x); }
    cloudBusy(false);
  }

  async function restoreCloud() {
    var p = $('#bPass').value, err = $('#bErr'); err.textContent = '';
    if (!p) { err.textContent = 'پاسۆردێ پاراستنێ بنڤیسە.'; $('#bPass').focus(); return; }
    cloudBusy(true);
    try {
      var raw = await ghRaw('contents/forge-backup.json?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now());
      if (raw === null) { err.textContent = 'چ کۆپی ل GitHub نەهاتە دیتن.'; cloudBusy(false); return; }
      var obj;
      try { obj = await FG.decryptPass(JSON.parse(raw), p); }
      catch (x) { err.textContent = 'پاسۆرد خەلەتە، یان فایل خەرابە.'; cloudBusy(false); return; }
      var n = mergeMembers(Array.isArray(obj.members) ? obj.members : []);
      if (Array.isArray(obj.exp)) { expenses = obj.exp; jset(LSX, expenses); }
      if (Array.isArray(obj.pays)) { pays = obj.pays; jset(LSP, pays); }
      if (Array.isArray(obj.log)) { var seen = {}; log.forEach(function (e) { seen[e.t + e.x] = 1; }); obj.log.forEach(function (e) { if (e && !seen[e.t + e.x]) log.push(e); }); log.sort(function (a, b) { return b.t - a.t; }); log.length = Math.min(log.length, 300); jset(LSL, log); }
      logEv('ok', n + ' ئەندام ژ کۆپیا GitHub هاتنە ڤەگەڕاندن');
      persist(); render(); schedulePublish();
      bkPass = p; jset(LSCB, todayISO());
      closeCloud();
      toast(n + ' ئەندام هاتنە ڤەگەڕاندن');
    } catch (x2) { err.textContent = ghErr(x2); }
    cloudBusy(false);
  }

  /* ---------- gym open / closed (status.json is public on purpose: nothing private in it) ---------- */
  function asciiJSON(o) { return JSON.stringify(o).replace(/[\u0080-\uffff]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); }); }
  async function pushStatus() {
    stSync = 'busy'; renderStatus();
    try { await putFile('status.json', asciiJSON({ o: gstat.open ? 1 : 0, m: gstat.msg, t: gstat.t }), 'Update gym status'); stSync = 'ok'; }
    catch (e) { stSync = 'err'; logEv('bad', 'دۆخێ قاعێ نەگەهشتە یاریزانان: ' + ghErr(e)); toast(ghErr(e), true); }
    renderStatus();
  }
  async function loadStatus() {
    try {
      var raw = await ghRaw('contents/status.json?ref=' + encodeURIComponent(cfg.branch) + '&t=' + Date.now());
      if (raw) { var j = JSON.parse(raw); gstat = { open: !!j.o, msg: j.m || '', t: j.t || 0 }; jset(LSS, gstat); stSync = 'ok'; } else stSync = 'none';
    } catch (e) { stSync = 'err'; }
    renderStatus();
  }
  function renderStatus() {
    var el = $('#gs'); if (!el) return;
    el.dataset.s = gstat.open ? 'open' : 'closed';
    $('#gsTxt').textContent = gstat.open ? 'کراوەیە' : 'گرتیە';
    if (document.activeElement !== $('#gsMsg')) $('#gsMsg').value = gstat.msg || '';
    document.querySelectorAll('#gsSeg button').forEach(function (b) { b.classList.toggle('on', (b.dataset.st === 'open') === gstat.open); });
    $('#gsAsk').hidden = stAsk === null;
    if (stAsk !== null) $('#gsAskT').textContent = stAsk ? 'دڤێت یاریزان ببینن قاعە کراوەیە؟' : 'دڤێت یاریزان ببینن قاعە گرتیە؟';
    var S = { busy: ['دهێتە نیشاندان بۆ یاریزانان…', 'warn'], ok: ['یاریزان ئێستا ڤی دۆخی دبینن ✓', 'ok'], err: ['نەگەهشتە یاریزانان. دووبارە هەوڵ بدە.', 'bad'], none: ['هێشتا بۆ یاریزانان نەهاتیە نیشاندان.', ''] }[stSync] || ['', ''];
    $('#gsSync').textContent = S[0]; $('#gsSync').className = 'gs-sync ' + S[1];
  }
  function setStatus(open) {
    stAsk = null;
    gstat = { open: open, msg: $('#gsMsg').value.trim(), t: Date.now() }; jset(LSS, gstat);
    logEv(open ? 'ok' : 'bad', open ? 'قاعە هاتە ڤەکرن: یاریزان دبینن کراوەیە' : 'قاعە هاتە گرتن: یاریزان دبینن گرتیە');
    renderStatus(); pushStatus();
  }
  function renderAttn() {
    var ex = 0, so = 0, un = 0;
    members.forEach(function (m) { var i = info(m); if (i.expired) ex++; else if (i.days <= 5) so++; if (!m.paid) un++; });
    var el = $('#attn');
    if (!members.length) { el.innerHTML = ''; return; }
    if (!ex && !so && !un) { el.innerHTML = '<div class="attn-ok">هەمی تشت ڕێکە ✓ چ ئەندامێن ب دوماهی هاتی یان بێ پارە نینن.</div>'; return; }
    el.innerHTML = [['expired', 'ب دوماهی هاتینە', ex, 'bad'], ['soon', 'نێزیک ب دوماهی (5 ڕۆژ)', so, 'warn'], ['unpaid', 'پارە نەدایە', un, 'bad']].map(function (d) {
      return '<button type="button" class="at ' + d[3] + (d[2] ? ' has' : '') + '" data-f="' + d[0] + '"><b>' + d[2] + '</b><span>' + d[1] + '</span></button>';
    }).join('');
  }

  /* ---------- change log ---------- */
  function logEv(k, x) {
    log.unshift({ t: Date.now(), k: k, x: x }); if (log.length > 300) log.length = 300;
    jset(LSL, log); renderLogBadge();
  }
  function renderLogBadge() {
    var r = jget(LSLR, 0), n = log.filter(function (e) { return e.t > r; }).length, b = $('#logN');
    if (!b) return; b.textContent = n > 99 ? '99+' : n; b.hidden = !n;
  }
  function openLog() {
    var r = jget(LSLR, 0), ic = { ok: '✓', bad: '!', warn: '!', hot: '✎', 'in': '→' }, cl = { ok: 'ok', bad: 'bad', warn: 'warn', hot: 'hot', 'in': '' };
    $('#logList').innerHTML = log.length ? log.map(function (e) {
      var d = new Date(e.t), day = toISO(d) === todayISO() ? 'ئەڤرو' : toISO(d);
      return '<div class="lg lg-' + (cl[e.k] || '') + (e.t > r ? ' new' : '') + '"><i>' + (ic[e.k] || '•') + '</i><div><p>' + esc(e.x) + '</p><time>' + day + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '</time></div></div>';
    }).join('') : '<div class="empty"><h3>هێشتا چ گوهۆڕین نەهاتینە کرن</h3></div>';
    jset(LSLR, Date.now()); renderLogBadge();
    $('#veil4').hidden = false; document.body.style.overflow = 'hidden';
  }
  function closeLog() { $('#veil4').hidden = true; document.body.style.overflow = ''; }
  function showRes(kind, name, text) {
    var r = $('#res'); r.className = 'res ' + kind;
    $('#resI').textContent = kind === 'ok' ? '✓' : kind === 'warn' ? '!' : '✕';
    $('#resN').textContent = name; $('#resT').textContent = text; r.hidden = false;
  }

  /* ---------- events ---------- */
  $('#btnLog').addEventListener('click', openLog);
  $('#logClose').addEventListener('click', closeLog);
  $('#veil4').addEventListener('click', function (e) { if (e.target === this) closeLog(); });
  $('#resX').addEventListener('click', function () { $('#res').hidden = true; });
  $('#attn').addEventListener('click', function (e) { var b = e.target.closest('.at'); if (!b) return; filter = b.dataset.f; render(); setTab('members'); });
  $('#gsSeg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; var o = b.dataset.st === 'open'; if (o === gstat.open) return; stAsk = o; renderStatus(); });
  $('#gsYes').addEventListener('click', function () { setStatus(stAsk); });
  $('#gsNo').addEventListener('click', function () { stAsk = null; renderStatus(); });
  $('#gsMsg').addEventListener('change', function () {
    var v = this.value.trim(); if (v === (gstat.msg || '')) return;
    gstat = { open: gstat.open, msg: v, t: Date.now() }; jset(LSS, gstat); logEv('hot', 'پەیاما قاعێ بۆ یاریزانان هاتە گوهۆڕین'); pushStatus();
  });
  $('#gateForm').addEventListener('submit', submitGate);
  $('#btnLock').addEventListener('click', function () { lockSafe(); });
  $('#bkBtn').addEventListener('click', exportData);
  $('#bkCloud').addEventListener('click', openCloud);
  $('#btnCloud').addEventListener('click', openCloud);
  $('#bform').addEventListener('submit', submitCloud);
  $('#bRestore').addEventListener('click', restoreCloud);
  $('#bClose').addEventListener('click', closeCloud);
  $('#veil3').addEventListener('click', function (e) { if (e.target === this) closeCloud(); });
  $('#btnAdd').addEventListener('click', function () { openForm(); });
  $('#pill').addEventListener('click', function () { publish(); });
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
    else if (a === 'del-yes') { confirmId = null; logEv('bad', 'ئەندام هاتە ژێبرن: ' + ((find(id) || {}).name || '')); removeMember(id); toast('هاتە ژێبرن'); }
  });
  $('#fPay').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setPay(Number(b.dataset.v)); });
  $('#fNewCode').addEventListener('click', function () { formCode = freshCode(); $('#fCode').value = formCode; showCodeHint(); });
  $('#fCode').addEventListener('input', function (e) {
    var v = e.target.value.toUpperCase();
    if (v !== e.target.value) e.target.value = v;
    showCodeHint();
  });
  $('#fPhone').addEventListener('input', showCodeHint);
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
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#veil').hidden) closeForm();
    if (!$('#veil3').hidden) closeCloud();
    if (!$('#veil4').hidden) closeLog();
    if (!$('#res').hidden) $('#res').hidden = true;
  });
  $('#btnExport').addEventListener('click', exportData);
  $('#btnImport').addEventListener('click', function () { $('#fileImport').click(); });
  $('#fileImport').addEventListener('change', function (e) { importData(e.target.files[0]); e.target.value = ''; });

  /* ---------- لاپەڕێن جیا (تاب) ---------- */
  /* خەرجی و تۆمارا پارەدانان د ڤی ئامێری دا دمینن و د کۆپیا GitHub دا دچن */
  var LSX = 'forge_gym_expenses_v1', LSP = 'forge_gym_pays_v1';
  var expenses = jget(LSX, []), pays = jget(LSP, null);
  var TABS = ['home', 'members', 'money', 'more'];

  /* تابێ هەلبژارتی نیشان بدە و یێن دی ڤەشێرە */
  function setTab(t) {
    if (TABS.indexOf(t) < 0) t = 'home';
    document.querySelectorAll('[data-view]').forEach(function (el) { el.classList.toggle('vhide', el.dataset.view !== t); });
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); });
    try { history.replaceState(null, '', '#' + t); } catch (e) {}
    window.scrollTo(0, 0);
  }

  /* ئەو ئەندامێن ئەڤرو هاتینە */
  function renderToday() {
    var t = members.filter(function (m) { return m.lastVisit === todayISO(); });
    $('#today').innerHTML = '<h3>ئەڤرو هاتینە <b>' + t.length + '</b></h3>' +
      (t.length ? '<div>' + t.map(function (m) { return '<span>' + esc(m.name) + '</span>'; }).join('') + '</div>' : '<p>هێشتا کەس ئەڤرو نەهاتیە. دوگمەیا «چووە ژوور» ل سەر کارتێ ئەندامی بکە.</p>');
  }

  /* کۆمێ پارەیێ هەیڤەکێ (key = 2026-11) */
  function sumBy(list, key) {
    return list.filter(function (p) { return String(p.d).slice(0, 7) === key; }).reduce(function (s, p) { return s + (Number(p.a) || 0); }, 0);
  }

  /* داهات (پارەدان) ــ خەرجی = پوخت، بۆ 3 هەیڤێن دوماهیێ */
  function renderMoney() {
    if (pays === null) {   /* جارا یەکێ: ژ ئەندامێن پارە داین تۆمارەکێ چێ بکە */
      pays = members.filter(function (m) { return m.paid && m.paidAt; }).map(function (m) { return { d: m.paidAt, a: Number(m.amount) || 0, n: m.name }; });
      jset(LSP, pays);
    }
    var now = new Date(), cards = '';
    for (var k = 0; k < 3; k++) {
      var key = toISO(new Date(now.getFullYear(), now.getMonth() - k, 1)).slice(0, 7);
      var inc = sumBy(pays, key), out = sumBy(expenses, key), net = inc - out;
      cards += '<div class="mc' + (k ? '' : ' cur') + '"><small>' + (k ? key : 'ئەڤ هەیڤە (' + key + ')') + '</small><dl>' +
        '<div><dt>داهات</dt><dd class="g">' + fmt(inc) + '</dd></div>' +
        '<div><dt>خەرجی</dt><dd class="r">' + fmt(out) + '</dd></div>' +
        '<div><dt>پوخت</dt><dd class="' + (net < 0 ? 'r' : 'g') + '">' + fmt(net) + '</dd></div></dl></div>';
    }
    $('#mrep').innerHTML = cards;
    var xs = expenses.slice().sort(function (a, b) { return b.t - a.t; }).slice(0, 30);
    $('#xlist').innerHTML = xs.length ? xs.map(function (x) {
      return '<div class="xi"><div><b>' + esc(x.n) + '</b><small>' + esc(x.d) + '</small></div><span>' + fmt(x.a) + ' د.ع</span><button type="button" data-x="' + x.t + '" aria-label="ژێبرن">✕</button></div>';
    }).join('') : '<p class="muted-p">هێشتا چ خەرجی نەهاتینە تۆمارکرن.</p>';
  }

  $('#tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setTab(b.dataset.t); });
  $('#xform').addEventListener('submit', function (e) {
    e.preventDefault();
    var n = $('#xT').value.trim(), a = Number($('#xA').value);
    if (!n || !(a > 0)) { toast('ناڤ و نرخێ خەرجیێ بنڤیسە.', true); return; }
    expenses.unshift({ t: Date.now(), d: todayISO(), n: n, a: a }); jset(LSX, expenses);
    logEv('warn', 'خەرجی هاتە تۆمارکرن: ' + n + ' (' + fmt(a) + ' دینار)');
    this.reset(); renderMoney(); schedulePublish(); toast('خەرجی هاتە تۆمارکرن');
  });
  $('#xlist').addEventListener('click', function (e) {
    var b = e.target.closest('[data-x]'); if (!b) return;
    expenses = expenses.filter(function (x) { return String(x.t) !== b.dataset.x; }); jset(LSX, expenses); renderMoney(); schedulePublish();
  });

  /* ---------- start ---------- */
  /* nothing from the panel is loaded or drawn here: only the gate is visible until the token is verified */
  (async function boot() {
    window.__fgReady = 1;
    prefillGate();
    var c0 = jget(LSG, {}) || {};
    if (c0.token) { delete c0.token; jset(LSG, c0); }   /* older versions kept the token in this object: remove it */
    var remembered = !!sget('localStorage', LST);
    var tk = sget('sessionStorage', SKT) || sget('localStorage', LST);
    if (tk && c0.owner && c0.repo) {
      gateBusy(true);
      try { await unlock({ owner: c0.owner, repo: c0.repo, branch: c0.branch || 'main', token: tk }, remembered); }
      catch (x) {
        if (x.status === 401 || x.status === 403 || x.status === 404) { sset('sessionStorage', SKT, null); sset('localStorage', LST, null); }
        $('#gErr').textContent = ghErr(x);
      }
      gateBusy(false);
    }
  })();
})();
