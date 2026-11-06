/* بوت التصميم الذكي لبوابة العميل — محادثة عربية تتصل بـ POST /api/portal/ai-design
   وتبني معاينة عبر js/ai-design-adapter.js على مصمم شبح (غير متصل بالتصميم الحالي)
   ولا تطبّق شيء على المصمم الحي إلا بضغطة المستخدم الصريحة. */
(function () {
  'use strict';

  var TOKEN_KEY = 'majlis_design_token';
  var A = {
    open: false, busy: false, locked: false, lockShown: false,
    msgs: [], history: [],
    spec: null, status: null, questions: [], assumptions: [], issues: [],
    preview: null, applied: false,
    answers: {}, rounds: 0, progress: null
  };
  var ESSENTIALS = [['size', 'المقاس'], ['seating', 'نوع الجلسة'], ['door', 'مكان الباب']];

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureModal() {
    if ($('aiModal')) return;
    var el = document.createElement('div');
    el.id = 'aiModal';
    el.className = 'modal ai-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.hidden = true;
    el.innerHTML = ''
      + '<div class="modal-card ai-card">'
      + '<div class="modal-head"><h3>صمّم مجلسك بالذكاء الاصطناعي</h3>'
      + '<button type="button" class="icon-btn" id="aiClose" aria-label="إغلاق"><svg><use href="#p-x"/></svg></button></div>'
      + '<div class="ai-prog" id="aiProg" aria-live="polite"></div>'
      + '<div class="ai-body" id="aiBody"></div>'
      + '<div class="ai-extra" id="aiExtra" hidden></div>'
      + '<div class="ai-input">'
      + '<input id="aiText" type="text" maxlength="3000" autocomplete="off" placeholder="مثال: مجلس ٦×٤ باب على اليمين وتلفاز مقابل الكنب">'
      + '<button type="button" class="btn primary" id="aiSend">إرسال</button>'
      + '</div></div>';
    document.body.appendChild(el);
  }

  /* أسئلة البوت: كل سؤال له إجابته (أو أكثر إن كان multi) — تُجمع كلها وتُرسل معاً بزر واحد.
     الأسئلة القديمة تبقى للعرض فقط مع إبراز ما اختاره العميل. */
  function botHTML(m, live) {
    var h = '<p>' + esc(m.text) + '</p>';
    var qs = m.qs || [];
    qs.forEach(function (q, qi) {
      var picked = (live ? A.answers[qi] : (m.picked && m.picked[qi])) || [];
      h += '<div class="ai-q" data-qi="' + qi + '"><b>' + esc(q.q) + (q.multi ? ' <span class="ai-qhint">(يمكن اختيار أكثر من إجابة)</span>' : '') + '</b>';
      if (q.options && q.options.length) {
        h += '<div class="ai-chips">';
        q.options.forEach(function (o, oi) {
          var on = picked.indexOf(o) >= 0;
          h += '<button type="button" class="ai-chip' + (on ? ' on' : '') + '" data-ai-q="' + qi + '" data-ai-o="' + oi + '" aria-pressed="' + on + '"' + (live ? '' : ' disabled') + '>' + esc(o) + '</button>';
        });
        h += '</div>';
      }
      h += '</div>';
    });
    if (live && qs.length) {
      h += '<div class="ai-qfoot"><button type="button" class="btn primary ai-answer" id="aiAnswer">إرسال الإجابات</button>'
        + '<span class="ai-qcount" id="aiQCount"></span></div>';
    }
    return h;
  }

  function liveIdx() {
    if (A.status !== 'need_answers' || A.busy) return -1;
    for (var i = A.msgs.length - 1; i >= 0; i--) {
      if (A.msgs[i].who === 'bot') return (A.msgs[i].qs && A.msgs[i].qs.length) ? i : -1;
      if (A.msgs[i].who === 'me') return -1;
    }
    return -1;
  }

  function answeredCount() {
    var n = 0;
    Object.keys(A.answers).forEach(function (k) { if (A.answers[k] && A.answers[k].length) n++; });
    return n;
  }

  function syncAnswerBar() {
    var b = $('aiAnswer'), c = $('aiQCount');
    if (!b) return;
    var total = A.questions.length, n = answeredCount();
    b.disabled = A.busy || A.locked || !n;
    if (c) c.textContent = n ? ('أجبت عن ' + n + ' من ' + total + (n < total ? ' — الباقي سأختاره لك' : '')) : 'اختر إجابة لكل سؤال، ثم أرسلها معاً';
  }

  function renderBody() {
    var el = $('aiBody');
    if (!el) return;
    var li = liveIdx();
    el.innerHTML = A.msgs.map(function (m, i) {
      return '<div class="ai-msg ' + m.who + '">' + (m.who === 'bot' ? botHTML(m, i === li) : esc(m.text)) + '</div>';
    }).join('');
    syncAnswerBar();
    renderProgress();
    el.scrollTop = el.scrollHeight;
  }

  /* ما الذي عرفه البوت وما الباقي — حتى يعرف العميل متى ينتهي */
  function renderProgress() {
    var el = $('aiProg');
    if (!el) return;
    var sp = A.spec || {};
    var have = { size: sp.roomW != null && sp.roomH != null, seating: !!sp.seating, door: !!sp.door };
    var h = '<ol class="ai-steps">';
    ESSENTIALS.forEach(function (e) {
      h += '<li class="' + (have[e[0]] ? 'done' : '') + '"><span class="ai-dot" aria-hidden="true">' + (have[e[0]] ? '✓' : '') + '</span>' + e[1] + '</li>';
    });
    h += '</ol><p class="ai-prog-t">';
    if (A.preview && A.applied) h += 'تم تطبيق التصميم ✓ — يمكنك طلب تعديل بالكتابة هنا.';
    else if (A.preview) h += 'المعاينة جاهزة — راجعها ثم طبّقها على المصمم.';
    else if (A.status === 'ready') h += 'المعلومات كافية ✓ — اضغط «إنشاء التصميم» بالأسفل.';
    else if (have.size) h += 'يمكنك إنشاء التصميم الآن، أو أجب عن الأسئلة لنتيجة أدق.';
    else if (A.status === 'need_answers') {
      var mx = (A.progress && A.progress.maxRounds) || 2;
      h += 'أسئلة قليلة ثم أجهّز التصميم (جولة ' + Math.min(A.rounds || 1, mx + 1) + ' — المقاس هو الأهم).';
    } else h += 'أحتاج ٣ معلومات: مقاس الغرفة، ونوع الجلسة، ومكان الباب — والباقي أقترحه لك.';
    h += '</p>';
    el.innerHTML = h;
  }

  function addMe(t) { A.msgs.push({ who: 'me', text: t }); renderBody(); }
  function addBot(t, qs) { A.msgs.push({ who: 'bot', text: t, qs: qs || [] }); renderBody(); }

  function pickChip(qi, oi) {
    var q = A.questions[qi];
    if (!q || !q.options || q.options[oi] == null) return;
    var o = q.options[oi];
    var cur = (A.answers[qi] || []).slice();
    var at = cur.indexOf(o);
    if (q.multi) { if (at >= 0) cur.splice(at, 1); else cur.push(o); }
    else cur = at >= 0 ? [] : [o];
    A.answers[qi] = cur;
    var box = document.querySelector('#aiBody .ai-q[data-qi="' + qi + '"]');
    if (box && !box.querySelector('[disabled]')) {
      Array.prototype.forEach.call(box.querySelectorAll('.ai-chip'), function (b) {
        var on = cur.indexOf(q.options[+b.getAttribute('data-ai-o')]) >= 0;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    syncAnswerBar();
  }

  /** نص الإجابات المختارة: سطر لكل سؤال «السؤال: الإجابة» */
  function answersText() {
    var lines = [];
    A.questions.forEach(function (q, qi) {
      var a = A.answers[qi];
      if (a && a.length) lines.push(q.q.replace(/[؟?]\s*$/, '') + ': ' + a.join('، '));
    });
    return lines.join('\n');
  }

  function showTyping() {
    var el = $('aiBody');
    if (!el) return;
    hideTyping();
    var d = document.createElement('div');
    d.className = 'ai-msg bot ai-typing';
    d.id = 'aiTyping';
    d.innerHTML = 'جارٍ التحضير<span class="ai-dots">…</span>';
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  function hideTyping() {
    var d = document.getElementById('aiTyping');
    if (d && d.parentNode) d.parentNode.removeChild(d);
  }

  function syncBusy() {
    var t = $('aiText'), s = $('aiSend');
    if (t) t.disabled = A.busy || A.locked;
    if (s) s.disabled = A.busy || A.locked;
    syncAnswerBar();
  }

  function getItem(id) {
    var cat = (window.PortalAI && PortalAI.catalog()) || [];
    for (var i = 0; i < cat.length; i++) {
      var it = cat[i];
      if (it.id === id) {
        return { id: it.id, name: it.name || 'صنف', price: 0, color: it.color, fabric: it.fabric, depth: it.depth, w: it.w, h: it.h, shape: it.shape, category: it.category };
      }
    }
    return { id: id, name: 'صنف', price: 0 };
  }

  function designerHasContent() {
    var P = window.PortalAI;
    var dz = P && P.designer();
    if (!dz) return false;
    try {
      var st = dz.getState();
      return !!((st.pieces && st.pieces.length) || (st.openings && st.openings.length));
    } catch (e) { return false; }
  }

  function renderExtra() {
    var el = $('aiExtra');
    if (!el) return;
    var ad = window.AiDesignAdapter;
    var h = '';
    if (A.preview) {
      h += '<div class="ai-preview">';
      if (A.preview.img) h += '<img src="' + A.preview.img + '" alt="معاينة التصميم">';
      h += '<dl class="ai-facts">';
      (A.preview.summary || []).forEach(function (r) { h += '<div><dt>' + esc(r.k) + '</dt><dd>' + esc(r.v) + '</dd></div>'; });
      h += '</dl></div>';
      if (A.preview.replaceWarn) h += '<p class="ai-warn">سيُستبدل التصميم الحالي — بما فيه التعديلات اليدوية — بهذه المواصفات.</p>';
      (A.preview.warnings || []).forEach(function (w) { h += '<p class="ai-warn">' + esc(w) + '</p>'; });
      if (A.applied) {
        h += '<p class="ai-ok">تم تطبيق التصميم على المصمم ✓</p>';
      } else {
        h += '<div class="ai-actrow"><button type="button" class="btn primary" id="aiApply">تطبيق التصميم على المصمم</button>'
          + '<button type="button" class="btn ghost" id="aiDiscard">إلغاء</button></div>';
      }
      h += '<div class="ai-actrow"><button type="button" class="link-btn" id="aiClear">مسح المحادثة</button></div>';
    } else if (A.status === 'ready' && A.spec && ad) {
      // زر الإنشاء أولاً حتى يظهر بلا تمرير، ثم الملخص
      h += '<div class="ai-actrow ai-actrow-top"><button type="button" class="btn primary" id="aiCreate">إنشاء التصميم</button>'
        + '<button type="button" class="link-btn" id="aiClear">مسح المحادثة</button></div>';
      h += '<div class="ai-sum"><h4>المواصفات المفهومة</h4><dl>';
      ad.specSummary(A.spec).forEach(function (r) { h += '<div><dt>' + esc(r.k) + '</dt><dd>' + esc(r.v) + '</dd></div>'; });
      h += '</dl></div>';
      A.assumptions.forEach(function (a) { h += '<p class="ai-assume">افتراض: ' + esc(a) + '</p>'; });
      A.issues.forEach(function (x) { h += '<p class="ai-warn">' + esc(x) + '</p>'; });
    } else if (A.status === 'need_answers' && A.spec && A.spec.roomW != null && A.spec.roomH != null && ad) {
      h += '<div class="ai-actrow ai-actrow-top"><button type="button" class="btn ghost" id="aiCreate">إنشاء التصميم الآن</button>'
        + '<button type="button" class="link-btn" id="aiClear">مسح المحادثة</button></div>'
        + '<p class="ai-assume">سأكمل ما لم تحدده بخيارات شائعة، ويمكنك تعديله بعد ذلك.</p>';
      h += '<div class="ai-sum"><h4>ما فهمته حتى الآن</h4><dl>';
      ad.specSummary(A.spec).forEach(function (r) { h += '<div><dt>' + esc(r.k) + '</dt><dd>' + esc(r.v) + '</dd></div>'; });
      h += '</dl></div>';
      A.issues.forEach(function (x) { h += '<p class="ai-warn">' + esc(x) + '</p>'; });
    } else {
      A.issues.forEach(function (x) { h += '<p class="ai-warn">' + esc(x) + '</p>'; });
      if (A.msgs.length) h += '<div class="ai-actrow"><button type="button" class="link-btn" id="aiClear">مسح المحادثة</button></div>';
    }
    el.innerHTML = h;
    el.hidden = !h;
  }

  function fallbackText(status) {
    if (status === 'ready') return 'فهمت طلبك — راجع الملخص بالأسفل ثم اضغط «إنشاء التصميم».';
    if (status === 'invalid') return 'يبدو أن الطلب ليس لتصميم مجلس. إن أردت، صف لي مقاس غرفتك وعدد الأبواب ونوع الجلسة وسأبدأ معك.';
    return 'أحتاج توضيحًا بسيطًا قبل المتابعة:';
  }

  function handleReply(d) {
    A.status = d.status || 'need_answers';
    if (d.spec) A.spec = d.spec;
    A.questions = d.questions || [];
    A.assumptions = d.assumptions || [];
    A.issues = d.issues || [];
    A.progress = d.progress || null;
    A.answers = {};
    A.preview = null;
    A.applied = false;
    if (A.status === 'need_answers' && A.questions.length) A.rounds++;
    var text = d.note || fallbackText(A.status);
    if (A.status === 'ready' && d.note) text += ' راجع الملخص بالأسفل ثم اضغط «إنشاء التصميم».';
    addBot(text, A.questions);
    var hist = text;
    if (A.questions.length) hist += ' — الأسئلة: ' + A.questions.map(function (q) { return q.q; }).join(' / ');
    A.history.push({ r: 'b', t: hist.slice(0, 400) });
    renderExtra();
  }

  async function send() {
    if (A.busy || A.locked) return;
    var inp = $('aiText');
    var typed = inp ? inp.value.trim() : '';
    var picked = liveIdx() >= 0 ? answersText() : '';
    var text = picked && typed ? picked + '\n' + typed : (picked || typed);
    if (!text) return;
    if (inp) inp.value = '';
    var li = liveIdx();
    if (li >= 0) A.msgs[li].picked = JSON.parse(JSON.stringify(A.answers));
    A.answers = {};
    addMe(text);
    A.history.push({ r: 'u', t: text.slice(0, 400) });
    A.busy = true;
    syncBusy();
    renderBody();
    showTyping();
    try {
      var token = '';
      try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e0) { token = ''; }
      var P = window.PortalAI;
      if (!token && P && !P.hasToken()) {
        try { await P.start(); } catch (e1) { /* noop */ }
        try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e2) { token = ''; }
      }
      var res = await fetch('/api/portal/ai-design', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-design-token': token },
        body: JSON.stringify({ text: text, spec: A.spec, history: A.history.slice(-9, -1), rounds: A.rounds })
      });
      var data = null;
      try { data = await res.json(); } catch (e3) { data = null; }
      hideTyping();
      if (res.status === 401) {
        addBot('جلسة التصميم غير صالحة أو انتهت — اضغط «ابدأ تصميم مجلسك» ثم أعد إرسال طلبك.');
        return;
      }
      if (!res.ok) {
        addBot((data && data.error) || 'تعذّر الوصول إلى خدمة التصميم الذكي الآن. حاول مرة أخرى بعد قليل.');
        return;
      }
      handleReply(data || {});
    } catch (e) {
      hideTyping();
      addBot('تعذّر الاتصال بالخدمة — تحقق من الشبكة ثم أعد المحاولة.');
    } finally {
      A.busy = false;
      syncBusy();
      renderBody();
    }
  }

  async function createPreview() {
    if (A.busy || A.preview || !window.AiDesignAdapter || !A.spec) return;
    A.busy = true;
    syncBusy();
    try {
      var ad = window.AiDesignAdapter;
      var P = window.PortalAI;
      if (P && P.ensureCatalog) { try { await P.ensureCatalog(); } catch (e0) { /* noop */ } }
      var v = ad.validateSpec(A.spec);
      if (!v.spec || !ad.specReady(v.spec)) {
        addBot('أحتاج مقاس الغرفة على الأقل (الطول × العرض بالمتر) حتى أجهّز التصميم.');
        return;
      }
      var built = ad.buildOps(v.spec, { catalog: (P && P.catalog()) || [] });
      var ghost;
      try {
        ghost = new Designer(document.createElement('canvas'), {
          getItem: getItem, pieceSpecLabel: function () { return ''; }, pieceStyle: function () { return null; },
          noOverlap: true, boundAware: true
        });
        ghost.setState(null);
      } catch (e2) {
        addBot('تعذّر تجهيز المعاينة — أعد تحميل الصفحة ثم حاول مجدداً.');
        return;
      }
      var res = ad.applyOps(ghost, built);
      if (!res.valid || !res.valid.ok) {
        var reasons = res.issues.slice(0, 3).join('، ');
        addBot('تعذّر إنشاء تصميم سليم بهذه المواصفات' + (reasons ? ' — ' + reasons : '') + '. عدّل الوصف وسأعيد المحاولة.');
        return;
      }
      var img = '';
      try { img = ghost.toImage(700, Math.max(360, Math.round(700 / ghost.aspect()))); } catch (e3) { img = ''; }
      var warnings = res.warnings.slice();
      built.issues.forEach(function (x) { warnings.push('تجاهلته: ' + x); });
      (res.failed || []).forEach(function (f) { warnings.push('لم يُوضع: ' + f); });
      A.preview = {
        state: res.state,
        img: img,
        replaceWarn: designerHasContent(),
        warnings: warnings,
        summary: ad.specSummary(v.spec)
      };
      A.applied = false;
      A.status = 'ready';
      A.questions = [];
      addBot('جهّزت لك معاينة التصميم — راجعها بالأسفل ثم اضغط «تطبيق التصميم على المصمم».');
      renderExtra();
    } finally {
      A.busy = false;
      syncBusy();
    }
  }

  async function applyPreview() {
    if (A.busy || A.applied || !A.preview) return;
    A.busy = true;
    syncBusy();
    try {
      var P = window.PortalAI;
      if (!P) return;
      var ok = false;
      if (P.inDesign()) ok = true;
      else if (P.designer() && P.hasToken()) ok = !!P.backToDesign();
      else { try { await P.start(); } catch (e) { /* noop */ } ok = P.inDesign(); }
      if (!ok) {
        addBot('تعذّر فتح المصمم — ابدأ تصميمك من الصفحة الرئيسية ثم أعد المحاولة.');
        return;
      }
      if (!P.applyState(A.preview.state)) {
        addBot('تعذّر تطبيق التصميم على المصمم. يمكنك تجهيزه يدويًا داخل المصمم.');
        return;
      }
      A.applied = true;
      addBot('تم تطبيق التصميم على المصمم. يمكنك تعديل أي عنصر يدويًا، أو اكتب لي تعديلًا جديدًا وسأحدّث لك التصميم.');
      renderExtra();
    } finally {
      A.busy = false;
      syncBusy();
    }
  }

  function resetChat() {
    A.spec = null;
    A.status = null;
    A.questions = [];
    A.assumptions = [];
    A.issues = [];
    A.preview = null;
    A.applied = false;
    A.msgs = [];
    A.history = [];
    A.answers = {};
    A.rounds = 0;
    A.progress = null;
    renderBody();
    addBot('تم مسح المحادثة — اطلب جديدًا مثل: «مجلس ٦×٤ بابان وتلفاز وكراسي عربية».');
    renderExtra();
  }

  function openChat() {
    ensureModal();
    var P = window.PortalAI;
    var st = (P && P.settings()) || {};
    A.locked = !!(st.aiDesign && st.aiDesign.enabled === false);
    A.open = true;
    var m = $('aiModal');
    if (m) m.hidden = false;
    if (!A.msgs.length) {
      addBot('أهلاً بك! صف لي مجلسك في رسالة واحدة — مثل: «مجلس 6×4، الباب في الجدار الأيمن، جلسة عربية، وتلفاز مقابل الجلسة». إن نقص شيء أسألك عنه بخيارات جاهزة، ثم أجهّز التصميم.');
    }
    if (A.locked && !A.lockShown) {
      A.lockShown = true;
      addBot('ميزة التصميم الذكي غير مفعّلة حالياً — يمكنك المتابعة بالتصميم اليدوي من «ابدأ تصميم مجلسك».');
    }
    syncBusy();
    var t = $('aiText');
    if (t && !A.locked && !A.busy) t.focus();
  }

  function closeChat() {
    A.open = false;
    var m = $('aiModal');
    if (m) m.hidden = true;
  }

  function wire() {
    ensureModal();
    var b1 = $('pAiBtn');
    if (b1) b1.addEventListener('click', openChat);
    var b2 = $('pAiOpen');
    if (b2) b2.addEventListener('click', openChat);
    $('aiClose').addEventListener('click', closeChat);
    $('aiSend').addEventListener('click', send);
    $('aiText').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    });
    $('aiBody').addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-ai-q], #aiAnswer') : null;
      if (!el || el.disabled || A.busy || A.locked) return;
      if (el.id === 'aiAnswer') { send(); return; }
      pickChip(+el.getAttribute('data-ai-q'), +el.getAttribute('data-ai-o'));
    });
    $('aiExtra').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'aiCreate') createPreview();
      else if (t.id === 'aiApply') applyPreview();
      else if (t.id === 'aiDiscard') { A.preview = null; renderExtra(); }
      else if (t.id === 'aiClear') resetChat();
    });
    $('aiModal').addEventListener('click', function (e) {
      if (e.target === $('aiModal')) closeChat();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && A.open) closeChat();
    });
  }

  window.AiDesign = {
    open: openChat,
    close: closeChat,
    clear: resetChat,
    send: send,
    spec: function () { return A.spec; },
    previewState: function () { return A.preview ? A.preview.state : null; },
    state: function () {
      return {
        open: A.open, busy: A.busy, locked: A.locked, status: A.status,
        hasSpec: !!A.spec, hasPreview: !!A.preview, applied: A.applied, msgs: A.msgs.length,
        rounds: A.rounds, answers: JSON.parse(JSON.stringify(A.answers)), questions: A.questions.length
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
