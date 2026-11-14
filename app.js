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
  var formCode = '', formPhoto = '', detailId = null;
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
    $('#veil').hidden = true; $('#veil3').hidden = true; $('#veil4').hidden = true; $('#veil5').hidden = true; prog = null; $('#res').hidden = true; document.body.style.overflow = '';
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
      w: normPlan(m.plan).filter(dayHas).map(function (d) {
        return { k: d.k, t: d.t, f: d.f || '', x: d.x || '', e: d.e.filter(function (z) { return z.n || z.g; }).map(function (z) { return { n: z.n, s: z.s, g: okImg(z.g) ? z.g : '' }; }) };
      })
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

  function remindLink(m, inf) {
    var p = String(m.phone || '').replace(/\D/g, '').replace(/^00/, '');
    if (p && p.indexOf('964') !== 0) p = '964' + p.replace(/^0/, '');
    var t = 'سلاڤ ' + m.name + '،\nئەندامەتیا تە ل Forge Gym ' + (inf.expired ? 'ب دوماهی هاتیە.' : (inf.days === 0 ? 'ئەڤرو ب دوماهی دهێت.' : 'تنێ ' + inf.days + ' ڕۆژ ماینە.')) + '\nبۆ نویکرنێ ڕا بگەهینە مە. سوپاس 🙏';
    return 'https://wa.me/' + p + '?text=' + encodeURIComponent(t);
  }
  function backupBar() {
    var bar = $('#bkbar');
    if (!members.length) { bar.hidden = true; return; }
    var last = lastBackupDate();
    var age = last ? dayDiff(parseISO(last), parseISO(todayISO())) : null;
    if (last && age < 3) { bar.hidden = true; return; }
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
        String(m.phone || '').replace(/\s/g, '').indexOf(term.replace(/\s/g, '')) >= 0 ||
        [m.snap, m.insta, m.tiktok].some(function (x) { return String(x || '').toLowerCase().indexOf(term) >= 0; });
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
      list.innerHTML = rows.map(row).join('');
    }
    $('#qClear').hidden = !q;
    backupBar(); renderDetail(); renderStatus(); renderAttn(); renderLogBadge(); renderToday(); renderMoney();
  }

  /* دۆخ: سەوز = پارە دایە، سور = پارە نەدایە، زەرد = کات ب دوماهی هاتی و پارە نەدایە */
  function state(m) {
    var inf = info(m);
    if (!m.paid && inf.expired) return { c: 'warn', t: 'کات ب دوماهی هاتیە و پارە نەدایە', inf: inf };
    if (!m.paid) return { c: 'bad', t: 'پارە نەدایە', inf: inf };
    return { c: 'ok', t: 'پارە دایە', inf: inf };
  }
  function avatar(m, big) {
    var ini = esc(String(m.name || '?').trim().charAt(0) || '?');
    return '<span class="av' + (big ? ' big' : '') + '">' + (okPhoto(m.photo) ? '<img alt="" src="' + esc(m.photo) + '">' : '<b>' + ini + '</b>') + '</span>';
  }
  function okPhoto(p) { return /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(p || ''); }
  function handle(v) {
    var s = String(v || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (s.indexOf('/') >= 0) s = s.split('/').pop();
    return s.replace(/^@+/, '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  }
  function socials(m) {
    var out = [];
    if (m.snap) out.push('<a class="sc snap" target="_blank" rel="noopener" href="https://www.snapchat.com/add/' + encodeURIComponent(m.snap) + '"><i>S</i><span dir="ltr">' + esc(m.snap) + '</span></a>');
    if (m.insta) out.push('<a class="sc insta" target="_blank" rel="noopener" href="https://www.instagram.com/' + encodeURIComponent(m.insta) + '"><i>I</i><span dir="ltr">' + esc(m.insta) + '</span></a>');
    if (m.tiktok) out.push('<a class="sc tiktok" target="_blank" rel="noopener" href="https://www.tiktok.com/@' + encodeURIComponent(m.tiktok) + '"><i>T</i><span dir="ltr">' + esc(m.tiktok) + '</span></a>');
    return out.join('');
  }

  /* لیستا سادە: تنێ وێنە و ناڤ. ناڤ ب ڕەنگێ دۆخی */
  function row(m) {
    var s = state(m);
    return '<button type="button" class="mr s-' + s.c + '" data-act="open" data-id="' + esc(m.id) + '" aria-label="' + esc(m.name) + ': ' + s.t + '">' +
      avatar(m) + '<span class="mn">' + esc(m.name) + '</span><i class="dotc" aria-hidden="true"></i></button>';
  }

  /* زانیاریێن تەمام: دهێنە ڤەکرن دەمێ کلیک ل سەر ناڤی دهێتە کرن */
  function detailHtml(m) {
    var s = state(m), inf = s.inf, id = esc(m.id);
    var left = inf.expired ? 'ب دوماهی هاتیە ' + Math.abs(inf.days) + ' ڕۆژ بەری ئێستا' : (inf.days === 0 ? 'ئەڤرو ب دوماهی دهێت' : 'ماینە ' + inf.days + ' ڕۆژ');
    var days = normPlan(m.plan).filter(dayHas).length;
    var visit = m.lastVisit ? (m.lastVisit === todayISO() ? 'ئەڤرو' : esc(m.lastVisit)) : 'هێشتا نەهاتیە';
    var soc = socials(m);
    moneyInit();
    var vm = (m.visits || []).filter(function (d) { return d.slice(0, 7) === todayISO().slice(0, 7); }).length;
    var hist = pays.filter(function (p) { return p.i === m.id; }).sort(function (a, b) { return b.d.localeCompare(a.d) || b.t - a.t; }).slice(0, 6);
    var del = confirmId === m.id
      ? '<span class="confirm">پشت ڕاستی؟ <button type="button" class="yes" data-act="del-yes" data-id="' + id + '">بەلێ، ژێببە</button><button type="button" class="no" data-act="del-no">نەخێر</button></span>'
      : '<button type="button" class="del" data-act="del" data-id="' + id + '">ژێببە</button>';
    return '<div class="sheet det s-' + s.c + '" role="dialog" aria-modal="true" aria-label="' + esc(m.name) + '">' +
      '<button type="button" class="det-x" data-act="close" aria-label="داخستن">✕</button>' +
      '<div class="det-top">' + avatar(m, true) + '<h2>' + esc(m.name) + '</h2><span class="stp">' + s.t + '</span></div>' +
      '<dl class="kv">' +
        '<div><dt>نرخ</dt><dd dir="ltr">' + fmt(m.amount) + ' <small>دینار</small></dd></div>' +
        '<div><dt>ماوە</dt><dd>' + esc(PLAN[m.months] || '1 هەیڤ') + '</dd></div>' +
        '<div><dt>دەستپێک</dt><dd dir="ltr">' + esc(m.start || '') + '</dd></div>' +
        '<div><dt>ب دوماهی دهێت</dt><dd dir="ltr">' + esc(inf.iso) + '</dd></div>' +
        '<div class="wide ' + (inf.expired ? 'bad' : inf.days <= 5 ? 'warn' : '') + '"><dt>ماوەی مای</dt><dd>' + left + '</dd></div>' +
        '<div><dt>دوماهیک هاتن</dt><dd>' + visit + '</dd></div>' +
        '<div><dt>هاتن ئەڤ هەیڤێ</dt><dd dir="ltr">' + vm + '</dd></div>' +
        '<div><dt>بەرنامە</dt><dd>' + (days ? days + ' ڕۆژ' : 'بێ بەرنامە') + '</dd></div>' +
      '</dl>' +
      '<div class="det-sec"><h3>پەیوەندی</h3>' +
        (m.phone ? '<a class="tel" dir="ltr" href="tel:' + esc(String(m.phone).replace(/[^\d+]/g, '')) + '">' + esc(m.phone) + '</a>' : '') +
        (soc ? '<div class="scs">' + soc + '</div>' : '') +
        (!m.phone && !soc ? '<p class="muted-p">هێشتا ژمارە یان ئەکاونت نەهاتینە نڤیسین. ب «دەستکاری» زێدە بکە.</p>' : '') +
      '</div>' +
      '<div class="det-sec"><h3>دیرۆکا پارەدانان</h3>' + (hist.length ? hist.map(function (p) { return '<div class="hl"><span dir="ltr">' + esc(p.d) + '</span><b dir="ltr">' + fmt(p.a) + '</b></div>'; }).join('') : '<p class="muted-p">هێشتا چ پارەدان نەهاتیە تۆمارکرن.</p>') + '</div>' +
      (m.note ? '<div class="note">' + esc(m.note) + '</div>' : '') +
      '<div class="seg" role="group" aria-label="دۆخێ پارەدانێ">' +
        '<button type="button" class="no' + (m.paid ? '' : ' on') + '" data-act="unpaid" data-id="' + id + '">پارە نەدایە</button>' +
        '<button type="button" class="yes' + (m.paid ? ' on' : '') + '" data-act="paid" data-id="' + id + '">پارە دایە</button>' +
      '</div>' +
      '<div class="codeline"><span>کۆد</span><code dir="ltr">' + esc(m.code) + '</code>' +
        '<button type="button" data-act="copy" data-id="' + id + '">کۆپی</button>' +
        '<a href="' + esc(waLink(m)) + '" target="_blank" rel="noopener">ناردن ب WhatsApp</a></div>' +
      '<div class="acts">' +
        '<button type="button" class="in" data-act="in" data-id="' + id + '">چووە ژوور</button>' +
        ((inf.expired || inf.days <= 5) && m.phone ? '<a class="rem" target="_blank" rel="noopener" href="' + esc(remindLink(m, inf)) + '">بیرئینان ب WhatsApp</a>' : '') +
        (inf.expired ? '<button type="button" data-act="renew" data-id="' + id + '">نویکرن</button>' : '') +
        '<button type="button" class="pg" data-act="prog" data-id="' + id + '">بەرنامەیا ڕاهێنانێ</button>' +
        '<button type="button" data-act="edit" data-id="' + id + '">دەستکاری</button>' +
        del +
      '</div></div>';
  }
  function renderDetail() {
    var v = $('#veil6'); if (!v) return;
    var m = detailId && find(detailId);
    if (!m) { v.hidden = true; detailId = null; return; }
    var keep = v.querySelector('.sheet'), top = keep ? keep.scrollTop : 0;
    $('#detail').innerHTML = detailHtml(m);
    v.hidden = false;
    var sh = v.querySelector('.sheet'); if (sh) sh.scrollTop = top;
  }
  function openDetail(id) { detailId = id; confirmId = null; document.body.style.overflow = 'hidden'; renderDetail(); }
  function closeDetail() { detailId = null; confirmId = null; $('#veil6').hidden = true; document.body.style.overflow = ''; }

  /* ---------- actions ---------- */
  function setPaid(id, val) {
    var m = find(id); if (!m || !!m.paid === val) return;
    if (!val && m.paidAt && m.paidAt < todayISO()) { toast('ئەڤ پارەدانە ل ڕۆژەکا بوری هاتیە و داخراوە. نابێت هەلبوەشێ.', true); return; }
    if (val) addPay(m, Number(m.amount) || 0); else dropPay(m);
    save(Object.assign({}, m, { paid: val, paidAt: val ? todayISO() : null }));
    logEv(val ? 'ok' : 'warn', m.name + (val ? ': پارەدان هاتە تۆمارکرن (' + fmt(m.amount) + ' دینار)' : ': وەک پارە نەدایی هاتە دانان'));
    toast(val ? 'پارەدان هاتە تۆمارکرن' : 'وەک پارە نەدایی هاتە دانان');
  }
  /* تۆمارا پارەیێ: هەر پارەدانەک/خەرجیەک ب ڕۆژی خۆ یێ دهێتە تۆمارکرن. تنێ ڕۆژا ئەڤرو دهێتە گوهۆڕین، ڕۆژێن بوری داخراوینە */
  function nowHM() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function newT() { var t = Date.now(); while (pays.some(function (x) { return x.t === t; }) || expenses.some(function (x) { return x.t === t; })) t++; return t; }
  function memberPayIdx(m) {
    for (var z = pays.length - 1; z >= 0; z--) { var p = pays[z]; if (p.d === todayISO() && !p.m && (p.i ? p.i === m.id : p.n === m.name)) return z; }
    return -1;
  }
  function addPay(m, a) { moneyInit(); pays.push({ t: newT(), d: todayISO(), h: nowHM(), a: a, n: m.name, i: m.id }); jset(LSP, pays); }
  function dropPay(m) { moneyInit(); var z = memberPayIdx(m); if (z >= 0) { pays.splice(z, 1); jset(LSP, pays); } }
  function syncPay(m, a) {
    moneyInit(); var z = memberPayIdx(m);
    if (z >= 0) { pays[z].a = a; pays[z].n = m.name; jset(LSP, pays); } else addPay(m, a);
  }
  function checkIn(id) {
    var m = find(id); if (!m) return;
    var inf = info(m);
    var next = Object.assign({}, m, { lastVisit: todayISO(), updatedAt: Date.now(), visits: (m.visits || []).filter(function (d) { return d !== todayISO(); }).concat(todayISO()).slice(-120) });
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
  /* وێنەیێ ئەندامی: چوارگۆشە، بچووک (نێزیک 8 KB)، تنێ د ڤی ئامێری و د کۆپیا کۆدکری دا دمینیت. ناچیتە سەر portal.json */
  async function squarePhoto(file, size) {
    var bmp;
    try { bmp = await createImageBitmap(file); }
    catch (e) {
      bmp = await new Promise(function (ok, no) {
        var im = new Image(), u = URL.createObjectURL(file);
        im.onload = function () { URL.revokeObjectURL(u); ok(im); };
        im.onerror = function () { no(new Error('img')); };
        im.src = u;
      });
    }
    var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    if (!w || !h) throw new Error('img');
    var s = Math.min(w, h), c = document.createElement('canvas'); c.width = c.height = size;
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, size, size);
    x.drawImage(bmp, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', 0.74);
  }
  function setFormPhoto() {
    var b = $('#fPhotoBtn');
    b.classList.toggle('has', !!formPhoto);
    b.innerHTML = formPhoto ? '<img alt="" src="' + esc(formPhoto) + '">' : '<span>+</span>';
    $('#fPhotoDel').hidden = !formPhoto;
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
    $('#fSnap').value = m ? (m.snap || '') : '';
    $('#fInsta').value = m ? (m.insta || '') : '';
    $('#fTok').value = m ? (m.tiktok || '') : '';
    formPhoto = m && okPhoto(m.photo) ? m.photo : ''; setFormPhoto();
    formCode = m ? m.code : freshCode();
    $('#fCode').value = formCode;
    showCodeHint();
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
    if (old && old.paid && !paid && old.paidAt && old.paidAt < todayISO()) { $('#fErr').textContent = 'ئەڤ ئەندامە ل ڕۆژەکا بوری پارە داییە و ئەو ڕۆژە داخراوە. نابێت ببیتە «پارە نەدایە».'; return; }
    save(Object.assign({}, old || {}, {
      id: old ? old.id : newId(),
      name: name, amount: amount,
      months: Number($('#fMonths').value) || 1,
      phone: $('#fPhone').value.trim(),
      start: $('#fStart').value || todayISO(),
      note: $('#fNote').value.trim(),
      photo: formPhoto,
      snap: handle($('#fSnap').value), insta: handle($('#fInsta').value), tiktok: handle($('#fTok').value),
      code: codeRaw,
      plan: old ? (old.plan || []) : blankWeek(),   /* a new member starts with the six weekdays ready */
      paid: paid,
      paidAt: paid ? ((old && old.paid && old.paidAt) || todayISO()) : null,
      createdAt: old ? (old.createdAt || Date.now()) : Date.now()
    }));
    var sid = old ? old.id : members[0].id;   /* a new member is put first by save() */
    if (paid && !(old && old.paid)) addPay({ id: sid, name: name }, amount);
    else if (!paid && old && old.paid) dropPay({ id: old.id, name: old.name });   /* was missing: un-paying from the form left the income in the report */
    else if (paid && old && old.paid && old.paidAt === todayISO()) syncPay({ id: old.id, name: name }, amount);   /* the amount was changed today: the till follows */
    var pastNote = !!(paid && old && old.paid && old.paidAt && old.paidAt < todayISO() && Number(old.amount) !== amount);
    renderMoney();
    logEv(old ? 'hot' : 'ok', old ? 'زانیاریێن ' + name + ' هاتنە گوهۆڕین' : 'ئەندامێ نوی هاتە زێدەکرن: ' + name);
    closeForm();
    toast(pastNote ? 'نرخ هاتە گوهۆڕین. بەلێ پارەدانا ڕۆژا بوری ناهێتە گوهۆڕین، چونکی داخراوە.' : (old ? 'گوهورین هاتنە پاشەکەفتکرن' : 'ئەندام هاتە تۆمارکرن'));
    if (!old) openProg(sid);   /* straight on to writing his exercises */
  }

  /* ---------- training program: the six weekdays are ready, the owner writes the exercises ---------- */
  var WEEK = ['شەممە', 'ئێک شەمب', 'دوو شەمب', 'سێ شەمب', 'چار شەمب', 'پێنج شەمب'];
  var LSE = 'forge_gym_exlib_v1';
  var prog = null, exLib = {}, imgPrev = {}, pickIdx = -1;

  function okImg(g) { return /^img\/[A-Za-z0-9._-]+\.jpg$/.test(g || ''); }
  function blankDay(k) { return { k: k, t: WEEK[k], f: '', e: [], x: '' }; }
  function blankWeek() { return WEEK.map(function (_, k) { return blankDay(k); }); }
  function dayHas(d) { return !!(d && (d.f || d.x || (d.e || []).some(function (z) { return z && (z.n || z.g); }))); }
  function cleanDay(d) {
    return { k: d.k, t: d.t || WEEK[d.k] || '', f: d.f || '', x: d.x || '',
      e: (d.e || []).filter(Boolean).map(function (z) { return { n: z.n || '', s: z.s || '', g: z.g || '' }; }) };
  }
  /* always returns the six weekdays (plus any extra days an older plan had) */
  function normPlan(plan) {
    var src = Array.isArray(plan) ? plan.filter(Boolean) : [], out = [], k;
    if (src.some(function (d) { return typeof d.k === 'number'; })) {
      for (k = 0; k < 6; k++) { var f = src.find(function (d) { return d.k === k; }); out.push(f ? cleanDay(f) : blankDay(k)); }
      src.filter(function (d) { return typeof d.k === 'number' && d.k >= 6; }).forEach(function (d) { out.push(cleanDay(d)); });
      return out;
    }
    /* older free-text plan: day i becomes weekday i, its old title becomes the focus line, its text stays as notes */
    src.forEach(function (d, i) {
      var b = i < 6 ? blankDay(i) : { k: i, t: d.t || ('ڕۆژا ' + (i + 1)), f: '', e: [], x: '' };
      if (i < 6) b.f = d.t || '';
      b.x = d.x || '';
      out.push(b);
    });
    for (k = out.length; k < 6; k++) out.push(blankDay(k));
    return out;
  }

  /* exercise library: a name typed once remembers its picture for every other member */
  function libKey(n) { return String(n).trim().toLowerCase().replace(/\s+/g, ' '); }
  function libAdd(n, g, keep) { var k = libKey(n); if (!k || !okImg(g)) return; if (!keep || !exLib[k]) exLib[k] = { n: String(n).trim(), g: g }; }
  function libLoad() {
    exLib = jget(LSE, {});
    members.forEach(function (m) { normPlan(m.plan).forEach(function (d) { d.e.forEach(function (z) { if (z.n) libAdd(z.n, z.g, true); }); }); });
    jset(LSE, exLib);
  }

  function openProg(id) {
    var m = find(id); if (!m) return;
    libLoad();
    var plan = normPlan(m.plan), first = plan.findIndex(dayHas), t = (new Date().getDay() + 1) % 7;   /* Saturday = 0 … Thursday = 5, Friday = 6 */
    prog = { id: id, draft: JSON.parse(JSON.stringify(plan)), day: first < 0 ? 0 : (t < 6 ? t : first), dirty: false };
    $('#pTitle').textContent = 'بەرنامەیا ڕاهێنانێ: ' + m.name;
    $('#pErr').textContent = '';
    var opts = members.filter(function (x) { return x.id !== id && normPlan(x.plan).some(dayHas); });
    $('#pCopy').innerHTML = '<option value="">کۆپیکرنا بەرنامەیێ ژ ئەندامەکێ دی…</option>' +
      opts.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>'; }).join('');
    $('#pCopyBox').hidden = !opts.length;
    renderProg();
    $('#veil5').hidden = false; document.body.style.overflow = 'hidden';
  }
  function closeProg(force) {
    if (!force && prog && prog.dirty && !confirm('گوهۆڕینێن تە نەهاتینە پاشەکەفتکرن. دێ داخی؟')) return;
    $('#veil5').hidden = true; document.body.style.overflow = ''; prog = null;
  }
  function exRow(z, i) {
    var src = z.g ? (imgPrev[z.g] || z.g) : '';
    return '<div class="ex"><button type="button" class="exph' + (src ? ' has' : '') + '" data-pick="' + i + '" aria-label="وێنەی ڕاهێنانێ">' +
      (src ? '<img src="' + esc(src) + '" alt="">' : '') +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 7.5 6H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2.5L15 4zm3 4.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"/></svg></button>' +
      '<div class="exf"><input data-i="' + i + '" data-k="n" list="exNames" dir="auto" autocomplete="off" value="' + esc(z.n) + '" placeholder="ناڤێ ڕاهێنانێ (Bench Press)" aria-label="ناڤێ ڕاهێنانێ">' +
      '<input data-i="' + i + '" data-k="s" class="ltr" dir="ltr" autocomplete="off" value="' + esc(z.s) + '" placeholder="4×10" aria-label="سێت و دووبارەکرن"></div>' +
      '<button type="button" class="exrm" data-rm="' + i + '" aria-label="ژێبرنا ڕاهێنانێ">✕</button></div>';
  }
  function renderProg() {
    if (!prog) return;
    var d = prog.draft[prog.day];
    $('#pTabs').innerHTML = prog.draft.map(function (x, i) {
      return '<button type="button" role="tab" class="wtab' + (i === prog.day ? ' on' : '') + (dayHas(x) ? ' has' : '') + '" data-d="' + i + '" aria-selected="' + (i === prog.day) + '">' + esc(x.t) + '</button>';
    }).join('');
    $('#pFocus').value = d.f; $('#pNote').value = d.x;
    $('#pEx').innerHTML = d.e.map(exRow).join('') || '<p class="exempty">هێشتا چ ڕاهێنان نەهاتینە زێدەکرن. دوگمەیا ل خوارێ بکە.</p>';
    $('#exNames').innerHTML = Object.keys(exLib).map(function (k) { return '<option value="' + esc(exLib[k].n) + '">'; }).join('');
  }
  function markTabs() {
    if (!prog) return;
    $('#pTabs').querySelectorAll('[data-d]').forEach(function (b) { b.classList.toggle('has', dayHas(prog.draft[Number(b.dataset.d)])); });
  }
  function setThumb(i) {
    var b = $('#pEx').querySelector('[data-pick="' + i + '"]'), z = prog && prog.draft[prog.day].e[i];
    if (!b || !z) return;
    var src = z.g ? (imgPrev[z.g] || z.g) : '', old = b.querySelector('img');
    if (old) old.remove();
    if (src) { var im = document.createElement('img'); im.alt = ''; im.src = src; b.insertBefore(im, b.firstChild); }
    b.classList.toggle('has', !!src);
  }

  /* a phone photo is 3-6 MB: shrink it to about 60 KB before it goes to GitHub */
  async function shrink(file) {
    var bmp;
    try { bmp = await createImageBitmap(file); }
    catch (e) {
      bmp = await new Promise(function (ok, no) {
        var im = new Image(), u = URL.createObjectURL(file);
        im.onload = function () { URL.revokeObjectURL(u); ok(im); };
        im.onerror = function () { no(new Error('img')); };
        im.src = u;
      });
    }
    var w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    if (!w || !h) throw new Error('img');
    var sc = Math.min(1, 720 / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', 0.72);
  }
  async function pickImage(file) {
    var i = pickIdx; pickIdx = -1;
    if (!file || !prog || i < 0) return;
    var z = prog.draft[prog.day].e[i]; if (!z) return;
    var btn = $('#pEx').querySelector('[data-pick="' + i + '"]');
    if (btn) btn.classList.add('busy');
    try {
      var url = await shrink(file);
      var path = 'img/ex-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.jpg';
      await gh('contents/' + path, { method: 'PUT', body: JSON.stringify({ message: 'Add exercise image', content: url.split(',')[1], branch: cfg.branch }) });
      imgPrev[path] = url; z.g = path;
      if (prog) prog.dirty = true;
      if (z.n) { libAdd(z.n, path); jset(LSE, exLib); }
    } catch (e) { toast(e && e.message === 'img' ? 'نەشێین وێنەی بخوینین.' : ghErr(e), true); }
    if (prog) renderProg();
  }

  function saveProg() {
    if (!prog) return;
    var m = find(prog.id); if (!m) { closeProg(true); return; }
    m.plan = prog.draft.map(function (d) {
      return { k: d.k, t: d.t, f: d.f.trim(), x: d.x.trim(),
        e: d.e.map(function (z) {
          var n = z.n.trim(), hit = n && !z.g ? exLib[libKey(n)] : null;
          return { n: n, s: z.s.trim(), g: z.g || (hit ? hit.g : '') };
        }).filter(function (z) { return z.n || z.g; }) };
    });
    m.plan.forEach(function (d) { d.e.forEach(function (z) { if (z.n) libAdd(z.n, z.g, true); }); });
    jset(LSE, exLib);
    save(m);
    logEv('hot', 'بەرنامەیا ڕاهێنانێ یا ' + m.name + ' هاتە گوهۆڕین');
    closeProg(true);
    toast('بەرنامە هاتە پاشەکەفتکرن');
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
      if (!okPhoto(m.photo)) m.photo = '';
      m.snap = handle(m.snap); m.insta = handle(m.insta); m.tiktok = handle(m.tiktok);
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
  var onAct = function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var a = b.dataset.act, id = b.dataset.id;
    if (a === 'open') openDetail(id);
    else if (a === 'close') closeDetail();
    else if (a === 'add') openForm();
    else if (a === 'add-q') openForm(null, q.trim());
    else if (a === 'paid') setPaid(id, true);
    else if (a === 'unpaid') setPaid(id, false);
    else if (a === 'in') checkIn(id);
    else if (a === 'renew') renew(id);
    else if (a === 'copy') copyCode(id);
    else if (a === 'edit') openForm(id);
    else if (a === 'prog') openProg(id);
    else if (a === 'del') { confirmId = id; render(); }
    else if (a === 'del-no') { confirmId = null; render(); }
    else if (a === 'del-yes') { confirmId = null; logEv('bad', 'ئەندام هاتە ژێبرن: ' + ((find(id) || {}).name || '')); closeDetail(); removeMember(id); toast('هاتە ژێبرن'); }
  };
  $('#list').addEventListener('click', onAct);
  $('#detail').addEventListener('click', onAct);
  $('#veil6').addEventListener('click', function (e) { if (e.target === this) closeDetail(); });
  $('#fPhotoBtn').addEventListener('click', function () { $('#fPhotoFile').click(); });
  $('#fPhotoDel').addEventListener('click', function () { formPhoto = ''; setFormPhoto(); });
  $('#fPhotoFile').addEventListener('change', async function (e) {
    var f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { formPhoto = await squarePhoto(f, 220); setFormPhoto(); $('#fErr').textContent = ''; }
    catch (er) { $('#fErr').textContent = 'نەشێین وێنەی بخوینین.'; }
  });
  $('#fPay').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setPay(Number(b.dataset.v)); });
  $('#fNewCode').addEventListener('click', function () { formCode = freshCode(); $('#fCode').value = formCode; showCodeHint(); });
  $('#fCode').addEventListener('input', function (e) {
    var v = e.target.value.toUpperCase();
    if (v !== e.target.value) e.target.value = v;
    showCodeHint();
  });
  $('#fPhone').addEventListener('input', showCodeHint);
  /* program editor */
  $('#pTabs').addEventListener('click', function (e) { var b = e.target.closest('[data-d]'); if (!b || !prog) return; prog.day = Number(b.dataset.d); renderProg(); });
  $('#pFocus').addEventListener('input', function (e) { if (!prog) return; prog.draft[prog.day].f = e.target.value; prog.dirty = true; markTabs(); });
  $('#pNote').addEventListener('input', function (e) { if (!prog) return; prog.draft[prog.day].x = e.target.value; prog.dirty = true; markTabs(); });
  $('#pEx').addEventListener('input', function (e) {
    var el = e.target, i = el.dataset.i; if (!prog || i == null) return;
    var z = prog.draft[prog.day].e[i]; if (!z) return;
    z[el.dataset.k] = el.value; prog.dirty = true; markTabs();
  });
  $('#pEx').addEventListener('change', function (e) {
    var el = e.target; if (!prog || el.dataset.k !== 'n') return;
    var i = Number(el.dataset.i), z = prog.draft[prog.day].e[i]; if (!z) return;
    var hit = exLib[libKey(z.n)];
    if (hit && !z.g) { z.g = hit.g; setThumb(i); }
    else if (z.g && z.n) { libAdd(z.n, z.g, true); jset(LSE, exLib); }
  });
  $('#pEx').addEventListener('click', function (e) {
    if (!prog) return;
    var p = e.target.closest('[data-pick]'), r = e.target.closest('[data-rm]');
    if (p) { pickIdx = Number(p.dataset.pick); $('#pFile').click(); }
    else if (r) { prog.draft[prog.day].e.splice(Number(r.dataset.rm), 1); prog.dirty = true; renderProg(); }
  });
  $('#pEx').addEventListener('error', function (e) {
    if (e.target.tagName !== 'IMG') return;
    var b = e.target.closest('.exph'); e.target.remove(); if (b) b.classList.remove('has');
  }, true);
  $('#pAdd').addEventListener('click', function () {
    if (!prog) return;
    prog.draft[prog.day].e.push({ n: '', s: '', g: '' }); prog.dirty = true; renderProg();
    var f = $('#pEx').querySelectorAll('input[data-k="n"]'); if (f.length) f[f.length - 1].focus();
  });
  $('#pFile').addEventListener('change', function (e) { pickImage(e.target.files[0]); e.target.value = ''; });
  $('#pCopy').addEventListener('change', function (e) {
    var m = find(e.target.value); e.target.value = '';
    if (!m || !prog) return;
    if (prog.draft.some(dayHas) && !confirm('بەرنامەیا نوکە دێ ب بەرنامەیا ' + m.name + ' هێتە گوهۆڕین. بەردەوام؟')) return;
    prog.draft = JSON.parse(JSON.stringify(normPlan(m.plan))); prog.dirty = true; renderProg();
  });
  $('#pSave').addEventListener('click', saveProg);
  $('#pCancel').addEventListener('click', function () { closeProg(); });
  $('#veil5').addEventListener('click', function (e) { if (e.target === this) closeProg(); });
  $('#form').addEventListener('submit', submitForm);
  $('#fCancel').addEventListener('click', closeForm);
  $('#veil').addEventListener('click', function (e) { if (e.target === this) closeForm(); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!$('#veil7').hidden) { closeEntry(); return; }
    if (!$('#veil').hidden) { closeForm(); return; }
    if (!$('#veil5').hidden) { closeProg(); return; }
    if (!$('#veil6').hidden) closeDetail();
    if (!$('#veil3').hidden) closeCloud();
    if (!$('#veil4').hidden) closeLog();
    if (!$('#veil5').hidden) closeProg();
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
    if (t === 'money') { mScroll = true; renderMoney(); }
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

  /* ====== کاشێر: داهات و خەرجی ب ڕۆژ ====== */
  var MONTHS = ['کانوونا دووێ', 'شوبات', 'ئادار', 'نیسان', 'ئایار', 'حوزەیران', 'تەمووز', 'ئاب', 'ئەیلوول', 'تشرینا ئێکێ', 'تشرینا دووێ', 'کانوونا ئێکێ'];
  var DAYN = ['ئێک شەمب', 'دوو شەمب', 'سێ شەمب', 'چار شەمب', 'پێنج شەمب', 'ئینی', 'شەممە'];
  var DAYS = ['ئێک', 'دوو', 'سێ', 'چار', 'پێنج', 'ئینی', 'شەم'];
  var mDay = null, mKind = 'in', mScroll = true, editEnt = null, eConfirm = false;
  var ICON_IN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  var ICON_OUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
  var ICON_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>';

  function sel() { var t = todayISO(); return (mDay && mDay < t) ? mDay : t; }

  /* جارا یەکێ: تۆمارەکێ ژ ئەندامێن پارە داین چێ بکە. هەر تۆمارەکێ ژمارەیەکا تایبەت بدە */
  function moneyInit() {
    var changed = false;
    if (pays === null) {
      pays = members.filter(function (m) { return m.paid && m.paidAt; }).map(function (m) { return { d: m.paidAt, a: Number(m.amount) || 0, n: m.name, i: m.id }; });
      changed = true;
    }
    var seen = {}, n = Date.now();
    [pays, expenses].forEach(function (arr, k) {
      arr.forEach(function (e) {
        var a = Number(e.a) || 0; if (a !== e.a) { e.a = a; changed = true; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.d || '')) { e.d = todayISO(); changed = true; }
        if (typeof e.t !== 'number' || seen[e.t]) { e.t = n++; changed = true; }
        seen[e.t] = 1;
      });
    });
    if (changed) { jset(LSP, pays); jset(LSX, expenses); }
  }

  function moneyOf(day) {
    var L = [], inc = 0, out = 0;
    pays.forEach(function (p) { if (p.d === day) { L.push({ k: 'in', e: p }); inc += p.a; } });
    expenses.forEach(function (x) { if (x.d === day) { L.push({ k: 'out', e: x }); out += x.a; } });
    L.sort(function (a, b) { return (b.e.h || '').localeCompare(a.e.h || '') || b.e.t - a.e.t; });
    return { L: L, inc: inc, out: out };
  }
  var sgn = function (n) { return (n < 0 ? '-' : '') + fmt(Math.abs(n)); };

  function renderMoney() {
    if (!$('#mHero')) return;
    moneyInit();
    var today = todayISO(), day = sel(), isToday = day === today, key = day.slice(0, 7), curKey = today.slice(0, 7);
    var y = Number(key.slice(0, 4)), mo = Number(key.slice(5, 7)) - 1, dim = new Date(y, mo + 1, 0).getDate();
    var last = key === curKey ? Number(today.slice(8)) : dim;
    var d0 = parseISO(day), dm = moneyOf(day), net = dm.inc - dm.out;

    $('#mLabel').innerHTML = MONTHS[mo] + ' <span dir="ltr">' + y + '</span>';
    $('#mNext').disabled = key >= curKey;

    /* the big card for the chosen day */
    $('#mHero').className = 'mh ' + (isToday ? 'open' : 'shut');
    $('#mHero').innerHTML =
      '<div class="mh-top"><div class="mh-date"><b>' + DAYN[d0.getDay()] + '</b><span> ' + d0.getDate() + ' ' + MONTHS[d0.getMonth()] + '</span></div>' +
      '<span class="mh-st">' + (isToday ? 'ئەڤرو' : ICON_LOCK + 'داخراوە') + '</span></div>' +
      '<div class="mh-lbl">داهاتێ ڤی ڕۆژی</div>' +
      '<div class="mh-big"><span dir="ltr">' + fmt(dm.inc) + '</span><em>د.ع</em></div>' +
      '<div class="mh-row"><div><small>خەرجی</small><b class="r" dir="ltr">' + fmt(dm.out) + '</b></div>' +
      '<div><small>پوخت</small><b class="' + (net < 0 ? 'r' : 'g') + '" dir="ltr">' + sgn(net) + '</b></div></div>';

    /* month bars: one pill per day, tap to open the day */
    var inc = [], outs = [], mx = 1, mInc = 0, mOut = 0, cnt = 0, bestD = 0, bestA = 0, daysWith = 0;
    for (var i = 1; i <= dim; i++) { inc[i] = 0; outs[i] = 0; }
    pays.forEach(function (p) { if (String(p.d).slice(0, 7) === key) { var dd = Number(p.d.slice(8)); inc[dd] += p.a; mInc += p.a; cnt++; } });
    expenses.forEach(function (x) { if (String(x.d).slice(0, 7) === key) { var dd = Number(x.d.slice(8)); outs[dd] += x.a; mOut += x.a; } });
    for (i = 1; i <= last; i++) { if (inc[i] > mx) mx = inc[i]; if (inc[i] > bestA) { bestA = inc[i]; bestD = i; } if (inc[i] > 0) daysWith++; }
    var strip = '';
    for (i = 1; i <= last; i++) {
      var iso = key + '-' + pad(i), wd = new Date(y, mo, i).getDay();
      strip += '<button type="button" class="dp' + (iso === day ? ' on' : '') + (iso === today ? ' td' : '') + '" data-d="' + iso + '" aria-label="' + i + ' ' + MONTHS[mo] + '"' + (iso === day ? ' aria-current="date"' : '') + '>' +
        '<small>' + DAYS[wd] + '</small><span class="bar"><i style="height:' + (inc[i] ? Math.max(8, Math.round(inc[i] / mx * 100)) : 0) + '%"></i></span><b>' + i + '</b>' +
        '<u class="' + (outs[i] ? 'x' : '') + '"></u></button>';
    }
    $('#dstrip').innerHTML = strip;
    if (mScroll && !$('[data-view="money"]').classList.contains('vhide')) {
      mScroll = false;
      var on = $('#dstrip .on'); if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
    }

    /* adding is only possible today */
    $('#mAdd').hidden = !isToday;
    $('#mLock').hidden = isToday;
    $('#qKind').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.k === mKind); });
    $('#qT').placeholder = mKind === 'in' ? 'داهات چ بوو؟ (ئێک ڕۆژ، ئاو، پرۆتین…)' : 'خەرجی چ بوو؟ (کارەبا، کرێ، ئامێر…)';
    $('#qBtn').textContent = mKind === 'in' ? '+ داهات' : '+ خەرجی';
    $('#qBtn').className = 'btn-add' + (mKind === 'in' ? '' : ' out');

    /* the receipt: every line of the day */
    var lines = dm.L.map(function (r) {
      var e = r.e, member = r.k === 'in' && e.i, sub = r.k === 'out' ? 'خەرجی' : (member ? 'پارەدانا ئەندامی' : 'داهاتێ دەستی');
      var inner = '<i class="ri ' + r.k + '">' + (r.k === 'in' ? ICON_IN : ICON_OUT) + '</i>' +
        '<span class="tt"><b>' + esc(e.n || (r.k === 'in' ? 'داهات' : 'خەرجی')) + '</b><small>' + sub + (e.h ? ' · <span dir="ltr">' + esc(e.h) + '</span>' : '') + '</small></span>' +
        '<span class="am ' + r.k + '" dir="ltr">' + (r.k === 'in' ? '+' : '-') + fmt(e.a) + '</span>';
      return isToday
        ? '<button type="button" class="re" data-e="' + r.k + '" data-t="' + e.t + '">' + inner + '</button>'
        : '<div class="re">' + inner + '</div>';
    }).join('');
    $('#mList').innerHTML = '<div class="rc"><div class="rc-h"><b>تۆمارێن ڕۆژێ</b><span>' + dm.L.length + '</span></div>' +
      (lines || '<p class="rc-e">' + (isToday ? 'هێشتا چ تۆمار نینە. پارەدانا ئەندامەکی یان داهات/خەرجیەکێ زێدە بکە.' : 'د ڤی ڕۆژی دا چ تۆمار نەبوون.') + '</p>') + '</div>';

    /* the month */
    var days = key === curKey ? Number(today.slice(8)) : dim;
    $('#mSum').innerHTML = '<h3>کورتکرنا ' + MONTHS[mo] + '</h3><dl>' +
      '<div><dt>داهات</dt><dd class="g" dir="ltr">' + fmt(mInc) + '</dd></div>' +
      '<div><dt>خەرجی</dt><dd class="r" dir="ltr">' + fmt(mOut) + '</dd></div>' +
      '<div><dt>پوخت</dt><dd class="' + (mInc - mOut < 0 ? 'r' : 'g') + '" dir="ltr">' + sgn(mInc - mOut) + '</dd></div>' +
      '<div><dt>ناڤنجی ڕۆژانە</dt><dd dir="ltr">' + fmt(Math.round(mInc / Math.max(1, days))) + '</dd></div>' +
      '<div><dt>باشترین ڕۆژ</dt><dd>' + (bestD ? bestD + ' ' + MONTHS[mo] + ' <small dir="ltr">' + fmt(bestA) + '</small>' : '-') + '</dd></div>' +
      '<div><dt>ژمارا پارەدانان</dt><dd dir="ltr">' + cnt + '</dd></div></dl><button type="button" class="dl" data-dl="' + key + '">دابەزاندنا ڕاپۆرتا ' + MONTHS[mo] + ' (Excel)</button>';

    var curInc = 0; pays.forEach(function (p) { if (String(p.d).slice(0, 7) === curKey) curInc += p.a; });
    $('#sSum').innerHTML = fmt(curInc) + '<em>د.ع</em>';
  }

  function exportMonth(key) {
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }, rows = [];
    pays.forEach(function (p) { if (String(p.d).slice(0, 7) === key) rows.push([p.d, p.h || '', 'داهات', p.n, p.a]); });
    expenses.forEach(function (x) { if (String(x.d).slice(0, 7) === key) rows.push([x.d, x.h || '', 'خەرجی', x.n, -x.a]); });
    rows.sort(function (a, b) { return (a[0] + a[1]).localeCompare(b[0] + b[1]); });
    var csv = '\ufeff' + [['ڕێکەفت', 'دەم', 'جۆر', 'ناڤ', 'نرخ']].concat(rows).map(function (r) { return r.map(q).join(','); }).join('\r\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), a = document.createElement('a');
    a.href = url; a.download = 'forge-gym-' + key + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000); toast('ڕاپۆرت هاتە دابەزاندن');
  }
  function gotoMonth(delta) {
    var day = sel(), y = Number(day.slice(0, 4)), mo = Number(day.slice(5, 7)) - 1 + delta;
    var first = new Date(y, mo, 1), t = todayISO();
    if (toISO(first).slice(0, 7) > t.slice(0, 7)) return;
    var lastD = new Date(first.getFullYear(), first.getMonth() + 1, 0), iso = toISO(lastD);
    mDay = iso >= t ? null : iso; mScroll = true; renderMoney();
  }

  /* edit a line of TODAY only */
  function findEnt(k, t) { var arr = k === 'in' ? pays : expenses; var i = arr.findIndex(function (x) { return String(x.t) === String(t); }); return i < 0 ? null : { arr: arr, i: i, e: arr[i] }; }
  function openEntry(k, t) {
    var f = findEnt(k, t); if (!f) return;
    if (f.e.d !== todayISO()) { toast('ئەڤ ڕۆژە داخراوە.', true); renderMoney(); return; }
    editEnt = { k: k, t: f.e.t }; eConfirm = false;
    var member = k === 'in' && f.e.i;
    $('#eT').value = f.e.n || ''; $('#eT').disabled = !!member;
    $('#eA').value = f.e.a;
    $('#eInfo').textContent = (k === 'out' ? 'خەرجی' : (member ? 'پارەدانا ئەندامی' : 'داهاتێ دەستی')) + (f.e.h ? ' · ' + f.e.h : '');
    $('#eDel').textContent = 'ژێبرنا ئەڤ تۆمارێ'; $('#eDel').classList.remove('sure');
    $('#eErr').textContent = '';
    $('#veil7').hidden = false; document.body.style.overflow = 'hidden';
    setTimeout(function () { $('#eA').focus(); }, 50);
  }
  function closeEntry() { $('#veil7').hidden = true; editEnt = null; eConfirm = false; if ($('#veil6').hidden && $('#veil').hidden && $('#veil5').hidden) document.body.style.overflow = ''; }
  function saveEntry(ev) {
    ev.preventDefault();
    var f = editEnt && findEnt(editEnt.k, editEnt.t); if (!f) { closeEntry(); return; }
    if (f.e.d !== todayISO()) { closeEntry(); renderMoney(); return; }
    var a = Number($('#eA').value), n = $('#eT').value.trim();
    if (!(a > 0)) { $('#eErr').textContent = 'نرخەکێ دروست بنڤیسە (ژ سفرێ مەزنتر).'; $('#eA').focus(); return; }
    if (!f.e.i && !n) { $('#eErr').textContent = 'ناڤێ تۆمارێ بنڤیسە.'; $('#eT').focus(); return; }
    var was = f.e.a;
    f.e.a = a; if (!f.e.i) f.e.n = n;
    jset(editEnt.k === 'in' ? LSP : LSX, editEnt.k === 'in' ? pays : expenses);
    logEv('hot', 'تۆمار هاتە گوهۆڕین: ' + (f.e.n || '') + ' (' + fmt(was) + ' بوو ' + fmt(a) + ')');
    closeEntry(); renderMoney(); schedulePublish(); toast('گوهۆڕین هاتە پاشەکەفتکرن');
  }
  function delEntry() {
    var f = editEnt && findEnt(editEnt.k, editEnt.t); if (!f) { closeEntry(); return; }
    if (f.e.d !== todayISO()) { closeEntry(); renderMoney(); return; }
    var memberPay = editEnt.k === 'in' && f.e.i;
    if (!eConfirm) {
      eConfirm = true; $('#eDel').classList.add('sure');
      $('#eDel').textContent = memberPay ? 'پشت ڕاستی؟ ئەندام ژی دێ ببیتە «پارە نەدایە»' : 'پشت ڕاستی؟ بەلێ ژێببە';
      return;
    }
    f.arr.splice(f.i, 1);
    jset(editEnt.k === 'in' ? LSP : LSX, f.arr);
    if (memberPay) {
      var m = find(f.e.i);
      if (m && m.paid && m.paidAt === todayISO()) { save(Object.assign({}, m, { paid: false, paidAt: null })); }
    }
    logEv('warn', 'تۆمار هاتە ژێبرن: ' + (f.e.n || '') + ' (' + fmt(f.e.a) + ' دینار)');
    closeEntry(); renderMoney(); schedulePublish(); toast('هاتە ژێبرن');
  }

  $('#tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setTab(b.dataset.t); });
  $('#mSum').addEventListener('click', function (e) { var b = e.target.closest('[data-dl]'); if (b) exportMonth(b.dataset.dl); });
  $('#mPrev').addEventListener('click', function () { gotoMonth(-1); });
  $('#mNext').addEventListener('click', function () { gotoMonth(1); });
  $('#dstrip').addEventListener('click', function (e) {
    var b = e.target.closest('[data-d]'); if (!b) return;
    mDay = b.dataset.d === todayISO() ? null : b.dataset.d; mScroll = true; renderMoney();
  });
  $('#qKind').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; mKind = b.dataset.k; renderMoney(); });
  $('#qChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-add]'); if (!b) return;
    $('#qA').value = (Number($('#qA').value) || 0) + Number(b.dataset.add);
  });
  $('#mAdd').addEventListener('submit', function (e) {
    e.preventDefault();
    if (sel() !== todayISO()) { toast('ئەڤ ڕۆژە داخراوە.', true); return; }
    var n = $('#qT').value.trim(), a = Number($('#qA').value);
    if (!n || !(a > 0)) { toast('ناڤ و نرخەکێ دروست بنڤیسە.', true); return; }
    moneyInit();
    if (mKind === 'in') { pays.push({ t: newT(), d: todayISO(), h: nowHM(), a: a, n: n, m: 1 }); jset(LSP, pays); logEv('ok', 'داهاتێ دەستی هاتە تۆمارکرن: ' + n + ' (' + fmt(a) + ' دینار)'); }
    else { expenses.unshift({ t: newT(), d: todayISO(), h: nowHM(), n: n, a: a }); jset(LSX, expenses); logEv('warn', 'خەرجی هاتە تۆمارکرن: ' + n + ' (' + fmt(a) + ' دینار)'); }
    this.reset(); renderMoney(); schedulePublish(); toast(mKind === 'in' ? 'داهات هاتە تۆمارکرن' : 'خەرجی هاتە تۆمارکرن');
  });
  $('#mList').addEventListener('click', function (e) { var b = e.target.closest('[data-e]'); if (b) openEntry(b.dataset.e, b.dataset.t); });
  $('#eform').addEventListener('submit', saveEntry);
  $('#eDel').addEventListener('click', delEntry);
  $('#eCancel').addEventListener('click', closeEntry);
  $('#veil7').addEventListener('click', function (e) { if (e.target === this) closeEntry(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && cfg) renderMoney(); });   /* a new day started while the phone was asleep */

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
