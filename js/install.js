/* تثبيت تطبيق الويب (PWA) لواجهة الموظفين — شريط «ثبّت التطبيق» عند فتح الرابط.
   - أندرويد/حاسوب (Chrome وEdge): زر «تثبيت» يفتح نافذة التثبيت الأصلية (beforeinstallprompt).
   - آيفون/آيباد (Safari): لا يسمح المتصفح بالتثبيت المباشر ← شرح بخطوتين (مشاركة ← إضافة إلى الشاشة الرئيسية).
   - لا يظهر داخل التطبيق المثبّت ولا داخل تطبيق أندرويد (APK)، ويختفي 14 يوماً بعد «ليس الآن».
   window.MajlisInstall.open() — من «عن التطبيق» في أي وقت. */
(function () {
  'use strict';
  var KEY = 'mj_install_dismissed_at';
  var SNOOZE_MS = 14 * 864e5;
  var deferred = null;

  function standalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) return true;
    } catch (e) { /* noop */ }
    return window.navigator.standalone === true;
  }
  function nativeApp() {
    try { return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()); }
    catch (e) { return false; }
  }
  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  }
  function snoozed() {
    try { var t = Number(localStorage.getItem(KEY)) || 0; return t && Date.now() - t < SNOOZE_MS; } catch (e) { return false; }
  }
  function snooze() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* noop */ } }

  var SHARE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function hide() {
    var b = document.getElementById('installBar');
    if (b) b.hidden = true;
    document.documentElement.classList.remove('has-install-bar');
  }

  function render(mode) {
    var b = document.getElementById('installBar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'installBar';
      b.className = 'install-bar';
      b.setAttribute('role', 'dialog');
      b.setAttribute('aria-label', 'تثبيت التطبيق');
      document.body.appendChild(b);
      b.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-inst]') : null;
        if (!t) return;
        var a = t.getAttribute('data-inst');
        if (a === 'go') install();
        else if (a === 'later') { snooze(); hide(); }
      });
    }
    var icon = '<img class="install-ic" src="icons/icon-192.png" alt="" width="40" height="40">';
    if (mode === 'ios') {
      b.innerHTML = icon + '<div class="install-txt"><b>ثبّت التطبيق على جوالك</b>'
        + '<span>اضغط زر المشاركة <i class="install-share">' + SHARE_SVG + '</i> في أسفل Safari، ثم اختر «إضافة إلى الشاشة الرئيسية».</span></div>'
        + '<div class="install-act"><button type="button" class="btn small" data-inst="later">حسناً</button></div>';
    } else {
      b.innerHTML = icon + '<div class="install-txt"><b>ثبّت تطبيق أصالة نجد</b>'
        + '<span>افتحه من الشاشة الرئيسية بضغطة، بملء الشاشة ودون شريط المتصفح.</span></div>'
        + '<div class="install-act"><button type="button" class="btn primary small" data-inst="go">تثبيت</button>'
        + '<button type="button" class="btn ghost small" data-inst="later">ليس الآن</button></div>';
    }
    b.hidden = false;
    document.documentElement.classList.add('has-install-bar');
  }

  async function install() {
    if (!deferred) { if (isIOS()) render('ios'); return false; }
    var p = deferred;
    deferred = null;
    try {
      p.prompt();
      var choice = await p.userChoice;
      hide();
      if (!choice || choice.outcome !== 'accepted') snooze();
      return !!choice && choice.outcome === 'accepted';
    } catch (e) { hide(); return false; }
  }

  function canShow() { return !standalone() && !nativeApp(); }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();          // نعرض شريطنا بدل الشريط الافتراضي المصغّر
    deferred = e;
    if (canShow() && !snoozed()) render('prompt');
    syncAbout();
  });
  window.addEventListener('appinstalled', function () { deferred = null; hide(); syncAbout(); });

  function boot() {
    if (canShow() && !snoozed() && isIOS()) render('ios');
    syncAbout();
  }

  /* زر «تثبيت تطبيق الويب» في «عن التطبيق»: متاح دائماً ما لم يكن التطبيق مثبّتاً */
  function syncAbout() {
    var btn = document.getElementById('btnInstallWeb');
    var st = document.getElementById('installWebStatus');
    if (!btn) return;
    if (nativeApp()) { btn.closest('.link-row').hidden = true; return; }
    if (standalone()) { btn.disabled = true; btn.textContent = 'مثبّت ✓'; if (st) st.textContent = 'أنت تستخدم التطبيق المثبّت الآن.'; return; }
    btn.disabled = false;
    if (st) st.textContent = deferred ? 'تثبيت بضغطة واحدة على هذا الجهاز.' : (isIOS() ? 'في Safari: مشاركة ← إضافة إلى الشاشة الرئيسية.' : 'من قائمة المتصفح: «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».');
  }

  window.MajlisInstall = {
    open: function () {
      if (deferred) return install();
      if (isIOS()) { render('ios'); return false; }
      return false;
    },
    available: function () { return !!deferred; },
    state: function () { return { standalone: standalone(), native: nativeApp(), ios: isIOS(), prompt: !!deferred, snoozed: !!snoozed(), shown: !!(document.getElementById('installBar') && !document.getElementById('installBar').hidden) }; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
