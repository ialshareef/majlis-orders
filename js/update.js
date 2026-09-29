/* ======================================================================
   AppUpdate: فحص تحديث تطبيق الأندرويد وتنزيله وتثبيته (يدوي فقط)
   - المصدر الرسمي الوحيد: GET {apiUrl}/api/app-update (بيانات وصفية فقط).
   - المقارنة برقم البناء: remote.versionCode > current = تحديث، وإلا لا شيء.
   - لا downgrade أبداً، ولا تنزيل تلقائي، ولا تثبيت صامت.
   - التنزيل على Android عبر المُنزِّل الأصلي (Filesystem.downloadFile: OkHttp
     بلا CORS ويتبع redirects) — لأن fetch داخل WebView يفشل (Failed to fetch)
     إذ يعيد GitHub التوجيه 302 إلى release-assets.githubusercontent.com
     الذي لا يرسل Access-Control-Allow-Origin إطلاقاً.
   - بعد التنزيل: تحقق SHA-256 إجباري — عدم التطابق = حذف الملف وعدم فتحه.
   - الفتح عبر مثبّت النظام الرسمي فقط (FileOpener)، وفي المتصفح تنزيل عادي.
   - فشل endpoint لا يمنع تشغيل التطبيق إطلاقاً.
   - سجل تشخيصي في console عبر AppUpdate._diag() (بلا أسرار: لا رموز ولا بيانات).
   ====================================================================== */
(function () {
  'use strict';

  var APK_ALLOW = 'https://github.com/ialshareef/majlis-orders/releases/download/';
  var APK_MIME = 'application/vnd.android.package-archive';
  var CHECK_TIMEOUT_MS = 12000;

  /* ---------------- السجل التشخيصي (console/logcat، بلا أسرار) ---------------- */
  var diagLog = [];
  function ulog(ev, info) {
    var e = { t: new Date().toISOString(), ev: String(ev), info: info == null ? '' : String(info).slice(0, 300) };
    diagLog.push(e);
    if (diagLog.length > 120) diagLog.shift();
    try { console.log('[AppUpdate]', e.ev, e.info); } catch (_) { /* noop */ }
  }

  /** نفس معادلة configure-version.js: رئيسي*10000 + فرعي*100 + تصحيح */
  function versionCodeOf(v) {
    var p = String(v == null ? '' : v).split('.').map(function (n) { return parseInt(n, 10); });
    if (p.length >= 2 && p.every(function (n) { return Number.isInteger(n) && n >= 0; })) {
      return p[0] * 10000 + (p[1] || 0) * 100 + (p[2] || 0);
    }
    return 1;
  }

  function apiBase() {
    var c = (window.APP_CONFIG || {}).apiUrl || '';
    return String(c).replace(/\/+$/, '');
  }

  /** تحقق صارم من البيانات الوصفية. أي خلل = مرفوضة (لا تنزيل). */
  function validUpdateMeta(m) {
    if (!m || typeof m !== 'object') return { ok: false, error: 'bad-shape' };
    var versionName = String(m.versionName || '').trim();
    var versionCode = Number(m.versionCode);
    var apkUrl = String(m.apkUrl || '').trim();
    var sha = m.sha256 == null ? null : String(m.sha256).trim().toLowerCase();
    if (!versionName) return { ok: false, error: 'bad-version' };
    if (!Number.isInteger(versionCode) || versionCode < 1) return { ok: false, error: 'bad-code' };
    // HTTPS + مصدر رسمي مثبّت فقط — لا يُقبل أي رابط من المستخدم أو خارج المسار
    if (apkUrl.slice(0, 8) !== 'https://' || apkUrl.indexOf(APK_ALLOW) !== 0) {
      return { ok: false, error: 'bad-url' };
    }
    if (sha !== null && !/^[0-9a-f]{64}$/.test(sha)) return { ok: false, error: 'bad-sha' };
    return {
      ok: true,
      meta: {
        versionName: versionName,
        versionCode: versionCode,
        apkUrl: apkUrl,
        sha256: sha,
        mandatory: m.mandatory === true,
      },
    };
  }

  function sameVersion(a, b) {
    return String(a || '').trim() === String(b || '').trim();
  }

  /** فحص الإصدار: يعيد {state} حيث state ∈ latest|available|error. لا يرمي أبداً. */
  async function checkForUpdate(current) {
    var base = apiBase();
    if (!base) return { state: 'error', error: 'no-server', message: 'التحقق من التحديث متاح في نسخة الخادم فقط.' };
    ulog('check/start', 'base=' + base + ' current=' + current.versionCode);
    var ctrl = null, timer = 0;
    try {
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        timer = setTimeout(function () { try { ctrl.abort(); } catch (_) { /* noop */ } }, CHECK_TIMEOUT_MS);
      }
      var res = await fetch(base + '/api/app-update', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        signal: ctrl ? ctrl.signal : undefined,
      });
      ulog('check/http', 'status=' + res.status);
      if (!res.ok) return { state: 'error', error: 'http-' + res.status, message: 'تعذّر الوصول إلى خادم التحديث. تحقق من الاتصال وحاول لاحقاً.' };
      var body = await res.json().catch(function () { return null; });
      var v = validUpdateMeta(body && (body.update || body));
      if (!v.ok) { ulog('check/invalid', v.error); return { state: 'error', error: 'invalid:' + v.error, message: 'بيانات التحديث من الخادم غير صالحة — لن يتم التنزيل.' }; }
      ulog('check/result', 'remote=' + v.meta.versionCode + ' sha=' + (v.meta.sha256 ? 'present' : 'missing'));
      // remote > current = تحديث؛ remote <= current = لا شيء (لا downgrade أبداً)
      if (v.meta.versionCode > current.versionCode) {
        return { state: 'available', meta: v.meta };
      }
      return { state: 'latest', meta: v.meta, same: sameVersion(v.meta.versionName, current.versionName) };
    } catch (e) {
      ulog('check/fail', (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : e));
      return { state: 'error', error: 'offline', message: 'تعذّر الوصول إلى خادم التحديث. تحقق من الاتصال وحاول لاحقاً.' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function bytesToHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }

  function b64ToBytes(b64) {
    var s = String(b64 || '').replace(/\s/g, '');
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function capPlugins() {
    return (window.Capacitor && window.Capacitor.Plugins) || {};
  }

  function isNative() {
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function') {
        return !!window.Capacitor.isNativePlatform();
      }
    } catch (_) { /* noop */ }
    var P = capPlugins();
    return !!(P.Filesystem && P.FileOpener);
  }

  function apkFileName(meta) {
    return 'asalh-najd-' + String(meta.versionName).replace(/[^0-9A-Za-z.\-]/g, '_') + '.apk';
  }

  /**
   * المسار الأصلي (Android): تنزيل عبر Filesystem.downloadFile (شبكة أصلية،
   * بلا CORS، يتبع redirects) ثم قراءة الملف والتحقق من SHA-256 قبل أي فتح.
   * يعيد {kind:'native', path, size}. أي فشل = رمي بسبب واضح، بلا ملف موثوق.
   */
  async function downloadNativeApk(meta, onProgress) {
    var P = capPlugins();
    var FS = P.Filesystem;
    if (!FS || !FS.downloadFile || !FS.readFile) throw { code: 'no-native', message: 'التنزيل الأصلي غير متاح على هذا الجهاز.' };
    var path = apkFileName(meta);
    ulog('download/start', 'method=native url=' + meta.apkUrl);
    try { await FS.deleteFile({ path: path, directory: 'CACHE' }); } catch (_) { /* stale cleanup best-effort */ }
    var progHandle = null;
    if (onProgress && FS.addListener) {
      try {
        progHandle = await FS.addListener('progress', function (p) {
          if (p && p.url === meta.apkUrl && onProgress) {
            try { onProgress(Number(p.bytes) || 0, Number(p.contentLength) || 0); } catch (_) { /* noop */ }
          }
        });
      } catch (_) { progHandle = null; }
    }
    try {
      await FS.downloadFile({ url: meta.apkUrl, path: path, directory: 'CACHE', progress: !!onProgress, recursive: true });
    } catch (e) {
      ulog('download/fail', 'method=native err=' + ((e && e.message) || e));
      throw { code: 'download', message: 'فشل تنزيل ملف التحديث. تحقق من الاتصال وحاول مجدداً.' };
    } finally {
      try { if (progHandle && progHandle.remove) await progHandle.remove(); } catch (_) { /* noop */ }
    }
    var size = 0;
    try {
      var st = await FS.stat({ path: path, directory: 'CACHE' });
      size = (st && st.size) || 0;
    } catch (_) { size = 0; }
    ulog('download/done', 'method=native bytes=' + size);
    var rd = await FS.readFile({ path: path, directory: 'CACHE' });
    var bin = b64ToBytes(rd && rd.data);
    var digest = await crypto.subtle.digest('SHA-256', bin);
    var ok = bytesToHex(digest) === meta.sha256;
    ulog('checksum/' + (ok ? 'match' : 'mismatch'), 'bytes=' + bin.length);
    if (!ok) {
      bin.fill(0);
      try { await FS.deleteFile({ path: path, directory: 'CACHE' }); ulog('checksum/deleted', path); } catch (_) { /* noop */ }
      throw { code: 'checksum', message: 'فشل التحقق من سلامة الملف — حُذف ولن يُثبَّت.' };
    }
    return { kind: 'native', path: path, size: bin.length };
  }

  /**
   * مسار المتصفح (احتياطي): fetch المباشر يعمل فقط إن سمح المضيف بـ CORS.
   * يعيد {kind:'web', blob}.
   */
  async function downloadWebApk(meta, onProgress) {
    ulog('download/start', 'method=web-fetch url=' + meta.apkUrl);
    var res;
    try {
      res = await fetch(meta.apkUrl, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'follow' });
    } catch (e) {
      ulog('download/fail', 'method=web-fetch err=' + (e && e.name ? e.name + ': ' : '') + ((e && e.message) || e));
      throw { code: 'download', message: 'تعذّر تنزيل الملف من المتصفح. افتح رابط الإصدار الرسمي مباشرة.' };
    }
    ulog('download/http', 'method=web-fetch status=' + res.status + ' final=' + (res.url || '').slice(0, 120));
    if (!res.ok) throw { code: 'http-' + res.status, message: 'فشل تنزيل ملف التحديث.' };
    var total = Number(res.headers.get('content-length')) || 0;
    var reader = res.body && res.body.getReader ? res.body.getReader() : null;
    var chunks = [], loaded = 0;
    if (!reader) {
      var buf0 = await res.arrayBuffer();
      if (onProgress) onProgress(buf0.byteLength, buf0.byteLength);
      chunks.push(new Uint8Array(buf0));
      loaded = buf0.byteLength;
    } else {
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        loaded += step.value.length;
        if (onProgress) { try { onProgress(loaded, total); } catch (_) { /* noop */ } }
      }
    }
    var bin = new Uint8Array(loaded), off = 0;
    for (var i = 0; i < chunks.length; i++) { bin.set(chunks[i], off); off += chunks[i].length; }
    ulog('download/done', 'method=web-fetch bytes=' + loaded);
    var digest = await crypto.subtle.digest('SHA-256', bin);
    var ok = bytesToHex(digest) === meta.sha256;
    ulog('checksum/' + (ok ? 'match' : 'mismatch'), 'bytes=' + loaded);
    if (!ok) {
      bin.fill(0);
      throw { code: 'checksum', message: 'فشل التحقق من سلامة الملف — حُذف ولن يُثبَّت.' };
    }
    return { kind: 'web', blob: new Blob([bin], { type: APK_MIME }) };
  }

  /**
   * تنزيل APK والتحقق منه. يعيد مصدراً موثوقاً فقط ({kind,...}).
   * - يتطلب sha256 في البيانات: غيابه = رفض (fail-closed).
   * - عدم التطابق = رفض + حذف الملف + لا يُفتح شيء.
   */
  async function downloadVerifiedApk(meta, onProgress) {
    if (!meta || !meta.sha256) throw { code: 'no-sha', message: 'بصمة التحقق غير متوفرة من الخادم — لن يتم التنزيل.' };
    if (isNative()) {
      try {
        return await downloadNativeApk(meta, onProgress);
      } catch (e) {
        // المسار الأصلي أولاً دائماً على الجهاز؛ fetch احتياط أخير فقط
        if (e && (e.code === 'checksum' || e.code === 'no-native')) throw e;
        ulog('download/fallback-web', String((e && e.code) || (e && e.message) || e));
        return downloadWebApk(meta, onProgress);
      }
    }
    return downloadWebApk(meta, onProgress);
  }

  /**
   * فتح مثبّت النظام الرسمي فقط:
   * - أندرويد: الملف الموثوق في CACHE يُفتح عبر FileOpener — النظام يعرض
   *   شاشة التثبيت، وإن لزم إذن «تثبيت التطبيقات غير المعروفة» يوجّه المستخدم
   *   للسماح من الإعدادات (آلية أندرويد الرسمية، بلا تجاوز).
   * - المتصفح: تنزيل الملف ليفتحه المستخدم بنفسه من إشعار الاكتمال.
   */
  async function installApk(src, fileName) {
    var P = capPlugins();
    if (src && src.kind === 'native') {
      if (!P.FileOpener || !P.FileOpener.open) throw { code: 'no-native', message: 'عارض الملفات الأصلي غير متاح.' };
      var FS = P.Filesystem;
      var uri = null;
      try {
        var w = await FS.getUri({ path: src.path, directory: 'CACHE' });
        uri = w && w.uri;
      } catch (e) {
        ulog('install/fail', 'getUri err=' + ((e && e.message) || e));
        throw { code: 'install', message: 'تعذّر تجهيز الملف للتثبيت.' };
      }
      ulog('install/start', 'method=native file=' + src.path + ' bytes=' + (src.size || 0));
      try {
        await P.FileOpener.open({ filePath: uri, contentType: APK_MIME, openWithDefault: true });
      } catch (e) {
        ulog('install/fail', 'open err=' + ((e && e.message) || e));
        throw { code: 'install', message: 'تعذّر فتح مثبّت النظام. اسمح بـ«تثبيت التطبيقات غير المعروفة» لهذا التطبيق ثم أعد المحاولة.' };
      }
      ulog('install/ok', 'method=native');
      return 'native';
    }
    var blob = src && src.blob;
    if (!blob) throw { code: 'install', message: 'لا يوجد ملف موثوق للتثبيت.' };
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (_) { /* noop */ } a.remove(); }, 5000);
    ulog('install/ok', 'method=browser-download');
    return 'browser';
  }

  /* ---------------- ربط واجهة صفحة «عن التطبيق» ---------------- */
  var wired = false;

  function setStatus(els, msg, kind) {
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.dataset.kind = kind || '';
  }

  function setProgress(els, loaded, total) {
    if (!els.progress || !els.bar) return;
    var lab = els.label && els.label !== els.status ? els.label : null;
    if (!loaded || loaded < 0) {
      els.progress.hidden = true;
      if (lab) lab.hidden = true;
      return;
    }
    els.progress.hidden = false;
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100))) : 0;
    els.bar.style.width = pct + '%';
    els.progress.setAttribute('aria-valuenow', String(pct));
    if (lab) {
      lab.hidden = false;
      lab.textContent = total > 0
        ? 'جارٍ التنزيل… ' + pct + '٪'
        : 'جارٍ التنزيل… ' + Math.round(loaded / 1024) + ' ك.ب';
    }
  }

  function initBox(opts) {
    if (wired) return false;
    var els = (opts && opts.els) || {};
    var current = (opts && opts.current) || { versionName: '', versionCode: 0 };
    var notify = (opts && opts.notify) || function () { /* noop */ };
    if (!els.check) return false;
    wired = true;

    var pending = null; // metadata of available update (set only after user-visible check)

    els.check.addEventListener('click', async function () {
      if (els.check.disabled) return;
      els.check.disabled = true;
      if (els.dl) els.dl.hidden = true;
      setProgress(els, -1, 0);
      pending = null;
      setStatus(els, 'جارٍ التحقق من وجود تحديث…', 'info');
      var r = await checkForUpdate(current);
      els.check.disabled = false;
      if (r.state === 'latest') {
        setStatus(els, 'You are using the latest version. (أنت تستخدم أحدث إصدار)', 'ok');
        notify('latest');
      } else if (r.state === 'available') {
        pending = r.meta;
        setStatus(
          els,
          (r.meta.mandatory ? 'يتوفر تحديث مهم ' : 'يتوفر إصدار جديد: ') + r.meta.versionName,
          'info'
        );
        if (els.dl) {
          els.dl.hidden = false;
          els.dl.textContent = 'Download & Install (تنزيل وتثبيت ' + r.meta.versionName + ')';
        }
        notify('available', r.meta);
      } else {
        setStatus(els, r.message || 'تعذّر التحقق من التحديث.', 'err');
        notify('error', r);
      }
    });

    if (els.dl) {
      els.dl.addEventListener('click', async function () {
        var meta = pending;
        // لا تنزيل دون فحص مسبق يعرض التحديث، ولا تثبيت لنسخة أقدم/مساوية
        if (!meta || meta.versionCode <= current.versionCode) {
          setStatus(els, 'لا يوجد تحديث صالح للتنزيل.', 'err');
          return;
        }
        els.dl.disabled = true;
        els.check.disabled = true;
        try {
          setStatus(els, 'جارٍ التنزيل…', 'info');
          var src = await downloadVerifiedApk(meta, function (loaded, total) { setProgress(els, loaded, total); });
          setProgress(els, -1, 0);
          setStatus(els, 'تم التحقق من الملف — سيُفتح مثبّت النظام.', 'info');
          var fname = apkFileName(meta);
          var how = await installApk(src, fname);
          setStatus(
            els,
            how === 'native'
              ? 'أُرسل الملف إلى مثبّت النظام — أكمل خطوات التثبيت.'
              : 'نُزّل الملف — افتحه من إشعار اكتمال التنزيل لإتمام التثبيت.',
            'ok'
          );
          notify('installed', { how: how });
        } catch (e) {
          setProgress(els, -1, 0);
          var msg = (e && e.message) || 'فشل التنزيل أو التثبيت.';
          setStatus(els, msg, 'err');
          notify('failed', e);
        } finally {
          els.dl.disabled = false;
          els.check.disabled = false;
        }
      });
    }
    return true;
  }

  window.AppUpdate = {
    APK_ALLOW: APK_ALLOW,
    versionCodeOf: versionCodeOf,
    validUpdateMeta: validUpdateMeta,
    checkForUpdate: checkForUpdate,
    downloadVerifiedApk: downloadVerifiedApk,
    installApk: installApk,
    initBox: initBox,
    _diag: function () { return diagLog.slice(); },
  };
})();
