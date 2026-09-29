/* ======================================================================
   AppUpdate: فحص تحديث تطبيق الأندرويد وتنزيله وتثبيته (يدوي فقط)
   - المصدر الرسمي الوحيد: GET {apiUrl}/api/app-update (بيانات وصفية فقط).
   - المقارنة برقم البناء: remote.versionCode > current = تحديث، وإلا لا شيء.
   - لا downgrade أبداً، ولا تنزيل تلقائي، ولا تثبيت صامت.
   - بعد التنزيل: تحقق SHA-256 إجباري — عدم التطابق = حذف الملف وعدم فتحه.
   - الفتح عبر مثبّت النظام الرسمي فقط (FileOpener في الأندرويد، وإلا تنزيل
     المتصفح حيث يفتح المستخدم الملف بنفسه من إشعار اكتمال التنزيل).
   - فشل endpoint لا يمنع تشغيل التطبيق إطلاقاً.
   - يعمل في المتصفح (fallback) وفي WebView الأندرويد (مسار أصلي).
   ====================================================================== */
(function () {
  'use strict';

  var APK_ALLOW = 'https://github.com/ialshareef/majlis-orders/releases/download/';
  var APK_MIME = 'application/vnd.android.package-archive';
  var CHECK_TIMEOUT_MS = 12000;

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
      if (!res.ok) return { state: 'error', error: 'http-' + res.status, message: 'تعذّر الوصول إلى خادم التحديث. تحقق من الاتصال وحاول لاحقاً.' };
      var body = await res.json().catch(function () { return null; });
      var v = validUpdateMeta(body && (body.update || body));
      if (!v.ok) return { state: 'error', error: 'invalid:' + v.error, message: 'بيانات التحديث من الخادم غير صالحة — لن يتم التنزيل.' };
      // remote > current = تحديث؛ remote <= current = لا شيء (لا downgrade أبداً)
      if (v.meta.versionCode > current.versionCode) {
        return { state: 'available', meta: v.meta };
      }
      return { state: 'latest', meta: v.meta, same: sameVersion(v.meta.versionName, current.versionName) };
    } catch (e) {
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

  /**
   * تنزيل APK والتحقق منه. يعيد Blob موثوقاً فقط.
   * - يتطلب sha256 في البيانات: غيابه = رفض (fail-closed).
   * - عدم التطابق = رفض + لا يُحفظ أي ملف ولا يُفتح شيء.
   */
  async function downloadVerifiedApk(meta, onProgress) {
    if (!meta || !meta.sha256) throw { code: 'no-sha', message: 'بصمة التحقق غير متوفرة من الخادم — لن يتم التنزيل.' };
    var res = await fetch(meta.apkUrl, { method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'follow' });
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
    var digest = await crypto.subtle.digest('SHA-256', bin);
    if (bytesToHex(digest) !== meta.sha256) {
      bin.fill(0);
      throw { code: 'checksum', message: 'فشل التحقق من سلامة الملف — حُذف ولن يُثبَّت.' };
    }
    return new Blob([bin], { type: APK_MIME });
  }

  function blobToBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result).split(',')[1]); };
      r.onerror = function () { rej(new Error('تعذّر قراءة الملف')); };
      r.readAsDataURL(blob);
    });
  }

  function capPlugins() {
    return (window.Capacitor && window.Capacitor.Plugins) || {};
  }

  /**
   * فتح مثبّت النظام الرسمي فقط:
   * - أندرويد (FileOpener): حفظ الملف الموثوق في CACHE ثم فتحه — النظام يعرض
   *   شاشة التثبيت، وإن لزم إذن «تثبيت التطبيقات غير المعروفة» يوجّه المستخدم
   *   للسماح من الإعدادات (آلية أندرويد الرسمية، بلا تجاوز).
   * - المتصفح: تنزيل الملف ليفتحه المستخدم بنفسه من إشعار الاكتمال.
   */
  async function installApk(blob, fileName) {
    var P = capPlugins();
    if (P.Filesystem && P.FileOpener) {
      var data = await blobToBase64(blob);
      var w = await P.Filesystem.writeFile({ path: fileName, data: data, directory: 'CACHE', recursive: true });
      await P.FileOpener.open({ filePath: w.uri, contentType: APK_MIME, openWithDefault: true });
      return 'native';
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (_) { /* noop */ } a.remove(); }, 5000);
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
          var blob = await downloadVerifiedApk(meta, function (loaded, total) { setProgress(els, loaded, total); });
          setProgress(els, -1, 0);
          setStatus(els, 'تم التحقق من الملف — سيُفتح مثبّت النظام.', 'info');
          var fname = 'asalh-najd-' + meta.versionName + '.apk';
          var how = await installApk(blob, fname);
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
  };
})();
