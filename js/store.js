/* ======================================================================
   Store: طبقة البيانات
   - الوضع المحلي (localStorage) عند ترك apiUrl فارغاً في config.js
   - الوضع السحابي (Cloudflare Worker + D1) عند ضبط apiUrl
   الواجهة موحّدة: init, login, restoreSession, logout, save, refresh, nextOrderNo,
   saveUser, deleteUser, log, exportJSON, importJSON, reset, getItem, getUser
   ====================================================================== */
(function (global) {
  'use strict';

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = () => new Date().toISOString();
  const OLD_SHOP_NAME = 'مفروشات المجالس';

  /** اشتقاق نوع القماش من اسم الصنف: "كنب عربي - قطيفة" → "قطيفة" */
  function deriveFabric(name) {
    const parts = String(name || '').split(/\s[-–—]\s/);
    return parts.length > 1 ? parts[parts.length - 1].trim() : '';
  }
  /** ضمان وجود حقل القماش لكل صنف كنب (يُشتق من الاسم للأصناف القديمة) */
  function normalizeItems(items) {
    (items || []).forEach((i) => {
      if (!i) return;
      if (i.category === 'sofa') i.fabric = (i.fabric || deriveFabric(i.name) || '').trim();
      else if (i.fabric === undefined) i.fabric = '';
    });
    return items || [];
  }

  function defaultItems() {
    return [
      { id: uid(), name: 'كنب عربي - قطيفة', category: 'sofa', unit: 'm', price: 450, depth: 0.8, fabric: 'قطيفة', color: '#8b5a2b', active: true },
      { id: uid(), name: 'كنب عربي - مخمل', category: 'sofa', unit: 'm', price: 550, depth: 0.8, fabric: 'مخمل', color: '#5b2c6f', active: true },
      { id: uid(), name: 'كنب عربي - جلد', category: 'sofa', unit: 'm', price: 700, depth: 0.85, fabric: 'جلد طبيعي', color: '#2c3e50', active: true },
      { id: uid(), name: 'كنب عربي - كتان', category: 'sofa', unit: 'm', price: 400, depth: 0.75, fabric: 'كتان', color: '#a67c52', active: true },
      { id: uid(), name: 'طاولة بلوت', category: 'acc', unit: 'pc', price: 350, w: 0.9, h: 0.6, shape: 'rect', color: '#6d4c41', active: true },
      { id: uid(), name: 'مركى', category: 'acc', unit: 'pc', price: 80, w: 0.6, h: 0.35, shape: 'rect', color: '#c0392b', active: true },
      { id: uid(), name: 'مخدة', category: 'acc', unit: 'pc', price: 45, w: 0.45, h: 0.45, shape: 'rect', color: '#d35400', active: true },
      { id: uid(), name: 'طاولة جانبية', category: 'acc', unit: 'pc', price: 120, w: 0.5, h: 0.5, shape: 'circle', color: '#7f8c8d', active: true },
    ];
  }

  function defaultSettings() {
    return { shopName: 'أصالة نجد', phone: '', address: '', currency: 'ر.س', vatEnabled: true, vatRate: 15, vatNumber: '', invoiceNote: '', cornerMode: 'deduct' };
  }

  function normalizeSettings(s) {
    const st = Object.assign(defaultSettings(), s || {});
    if (st.cornerMode === 'full' && !st.cornerModeChosen) st.cornerMode = 'deduct';
    if (!st.shopName || st.shopName === OLD_SHOP_NAME) st.shopName = 'أصالة نجد';
    return st;
  }

  async function hash(str) {
    try {
      if (global.crypto && global.crypto.subtle) {
        const buf = await global.crypto.subtle.digest('SHA-256', new TextEncoder().encode('majlis::' + str));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) { /* fallback below */ }
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const s = 'majlis::' + str;
    for (let i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ s.charCodeAt(i), 2246822519) + i) >>> 0;
    }
    return 'fb:' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active !== false });
  const mapOf = (arr) => { const m = new Map(); (arr || []).forEach((x) => m.set(x.id, JSON.stringify(x))); return m; };

  /* ======================= الوضع المحلي ======================= */
  const Local = {
    mode: 'local',
    KEY: 'majlis_orders_db_v1',
    db: null,
    lastError: '',

    defaults() {
      return {
        version: 1,
        seq: { order: 1000 },
        settings: defaultSettings(),
        users: [{ id: uid(), name: 'مدير النظام', username: 'admin', password: '', role: 'admin', active: true, createdAt: now() }],
        items: defaultItems(),
        orders: [],
        activity: [],
      };
    },

    async init() {
      let data = null;
      try { data = JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch (_) { data = null; }
      if (!data || typeof data !== 'object') data = this.defaults();
      const d = this.defaults();
      data.seq = Object.assign(d.seq, data.seq || {});
      data.settings = normalizeSettings(data.settings);
      data.users = Array.isArray(data.users) && data.users.length ? data.users : d.users;
      data.items = normalizeItems(Array.isArray(data.items) ? data.items : d.items);
      data.orders = Array.isArray(data.orders) ? data.orders : [];
      data.activity = Array.isArray(data.activity) ? data.activity : [];
      this.db = data;
      for (const u of this.db.users) {
        if (!u.password) u.password = await hash(u.username === 'admin' ? 'admin' : '123456');
      }
      await this.save();
      return this.db;
    },

    async save() {
      try { localStorage.setItem(this.KEY, JSON.stringify(this.db)); return true; }
      catch (e) { console.error(e); this.lastError = 'مساحة التخزين ممتلئة'; return false; }
    },

    async refresh() { return false; },

    async login(username, password) {
      const u = this.db.users.find((x) => x.username.toLowerCase() === String(username).trim().toLowerCase());
      const h = await hash(password);
      if (!u || u.password !== h) return { ok: false, error: 'bad_credentials' };
      if (u.active === false) return { ok: false, error: 'inactive' };
      sessionStorage.setItem('majlis_session', u.id);
      return { ok: true, user: publicUser(u) };
    },

    async restoreSession() {
      const id = sessionStorage.getItem('majlis_session');
      const u = id && this.getUser(id);
      return u && u.active !== false ? publicUser(u) : null;
    },

    async logout() { sessionStorage.removeItem('majlis_session'); },

    async nextOrderNo() {
      this.db.seq.order = (this.db.seq.order || 1000) + 1;
      return this.db.seq.order;
    },

    async saveUser(data, password) {
      if (data.id) {
        const u = this.getUser(data.id);
        if (!u) throw new Error('المستخدم غير موجود');
        Object.assign(u, { name: data.name, username: data.username, role: data.role, active: data.active });
        if (password) u.password = await hash(password);
      } else {
        this.db.users.push({ id: uid(), createdAt: now(), name: data.name, username: data.username, role: data.role, active: data.active, password: await hash(password) });
      }
      if (!(await this.save())) throw new Error(this.lastError);
    },

    async deleteUser(id) {
      this.db.users = this.db.users.filter((x) => x.id !== id);
      if (!(await this.save())) throw new Error(this.lastError);
    },

    exportJSON() { return JSON.stringify(this.db, null, 2); },

    async importJSON(text) {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.items) || !Array.isArray(data.orders)) throw new Error('ملف غير صالح');
      if (!Array.isArray(data.users) || !data.users.length) data.users = this.db.users;
      this.db = data;
      await this.init();
    },

    async reset() { localStorage.removeItem(this.KEY); },

    getUser(id) { return (this.db.users || []).find((u) => u.id === id) || null; },
  };

  /* ======================= الوضع السحابي (Cloudflare Worker + D1) ======================= */
  const Remote = {
    mode: 'remote',
    db: null,
    token: null,
    user: null,
    snap: {},
    lastError: '',
    lastStatus: 0,   // 409 تعارض، -1 انقطاع اتصال، 0 لا خطأ
    cfg: null,
    TOKEN_KEY: 'majlis_token',

    async api(method, path, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (this.token) headers['x-session-token'] = this.token;
      let res;
      try {
        res = await fetch(`${this.cfg.apiUrl.replace(/\/+$/, '')}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        const err = new Error('تعذر الاتصال بالخادم. تحقق من الإنترنت.');
        err.offline = true;
        throw err;
      }
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!res.ok) {
        if (res.status === 401 && this.user) {
          // انتهت الجلسة على الخادم
          this.token = null; this.user = null; localStorage.removeItem(this.TOKEN_KEY);
          if (this.onSessionLost) this.onSessionLost();
        }
        const err = new Error((data && data.error) || `خطأ من الخادم (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return data;
    },

    emptyDb() { return { version: 1, seq: {}, settings: defaultSettings(), users: [], items: [], orders: [], activity: [] }; },

    async init() {
      this.db = this.emptyDb();
      this.token = localStorage.getItem(this.TOKEN_KEY) || null;
      if (this.token) {
        try {
          const r = await this.api('GET', '/api/me');
          if (r && r.user) { this.user = r.user; await this.loadAll(); }
          else { this.token = null; localStorage.removeItem(this.TOKEN_KEY); }
        } catch (e) {
          console.warn('session restore failed', e);
          this.lastError = e.message;
        }
      }
      return this.db;
    },

    _apply(b) {
      this.db.settings = normalizeSettings(b.settings);
      // التطبيع قبل اللقطة حتى لا يُحسب القماش المشتق تغييراً يُرسَل للخادم
      this.db.items = normalizeItems(Array.isArray(b.items) ? b.items.filter(Boolean) : []);
      this.db.orders = Array.isArray(b.orders) ? b.orders.filter(Boolean) : [];
      this.db.activity = Array.isArray(b.activity) ? b.activity.filter(Boolean) : [];
      this.db.users = Array.isArray(b.users) ? b.users : [];
      if (b.user) this.user = b.user;
      this.snapshot();
    },

    async loadAll() { this._apply(await this.api('GET', '/api/bootstrap')); },

    snapshot() {
      this.snap = { items: mapOf(this.db.items), orders: mapOf(this.db.orders), activity: mapOf(this.db.activity), settings: JSON.stringify(this.db.settings) };
    },

    _diff(coll) {
      const cur = mapOf(this.db[coll]);
      const prev = this.snap[coll] || new Map();
      const upsert = [], del = [];
      cur.forEach((json, id) => {
        if (prev.get(id) === json) return;
        const rec = JSON.parse(json);
        // حماية التعارض: اللقطة تحمل النسخة التي وصلتنا من الخادم آخر مرة،
        // فنرسلها كأساس ليرفض الخادم الكتابة فوق تعديل جاء بعدها من جهاز آخر.
        if (coll === 'orders') {
          const before = prev.get(id);
          let base = null;
          if (before) { try { base = JSON.parse(before).updatedAt || null; } catch (_) { base = null; } }
          rec._base = base;
        }
        upsert.push(rec);
      });
      prev.forEach((_, id) => { if (!cur.has(id)) del.push(id); });
      return { upsert, delete: del };
    },

    /** مزامنة التغييرات المحلية فقط (إضافة/تعديل/حذف) إلى الخادم */
    async save() {
      if (!this.user) { this.lastError = 'غير مسجّل الدخول'; return false; }
      const payload = {};
      const it = this._diff('items'); if (it.upsert.length || it.delete.length) payload.items = it;
      const od = this._diff('orders'); if (od.upsert.length || od.delete.length) payload.orders = od;
      const ac = this._diff('activity');
      if (ac.upsert.length || ac.delete.length) payload.activity = (!this.db.activity.length && ac.delete.length) ? { upsert: [], clear: true } : ac;
      if (JSON.stringify(this.db.settings) !== this.snap.settings) payload.settings = this.db.settings;
      if (!Object.keys(payload).length) return true;
      try {
        await this.api('POST', '/api/sync', payload);
        this.snapshot();
        this.lastError = '';
        this.lastStatus = 0;
        return true;
      } catch (e) {
        console.error(e);
        this.lastError = e.message;
        this.lastStatus = e.status || (e.offline ? -1 : 0);
        return false;
      }
    },

    async refresh() {
      if (!this.user) return false;
      await this.loadAll();
      return true;
    },

    async login(username, password) {
      const r = await this.api('POST', '/api/login', { username: String(username).trim(), password });
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'bad_credentials' };
      this.token = r.token;
      localStorage.setItem(this.TOKEN_KEY, r.token);
      this.user = r.user;
      await this.loadAll();
      return { ok: true, user: r.user };
    },

    async restoreSession() { return this.user; },

    async logout() {
      try { if (this.token) await this.api('POST', '/api/logout'); } catch (_) { /* ignore */ }
      this.token = null; this.user = null;
      localStorage.removeItem(this.TOKEN_KEY);
      this.db = this.emptyDb();
      this.snap = {};
    },

    async nextOrderNo() {
      const r = await this.api('POST', '/api/next-order-no');
      if (!r || r.number == null) throw new Error('تعذر الحصول على رقم الطلب');
      return +r.number;
    },

    async saveUser(data, password) {
      const r = await this.api('POST', '/api/users', { id: data.id || null, name: data.name, username: data.username, password: password || '', role: data.role, active: data.active !== false });
      this.db.users = r.users || this.db.users;
      if (this.user && data.id === this.user.id) this.user = Object.assign({}, this.user, { name: data.name, username: data.username, role: data.role });
    },

    async deleteUser(id) {
      const r = await this.api('DELETE', `/api/users/${encodeURIComponent(id)}`);
      this.db.users = r.users || this.db.users.filter((u) => u.id !== id);
    },

    exportJSON() {
      return JSON.stringify({ version: 1, mode: 'remote', exportedAt: now(), settings: this.db.settings, items: this.db.items, orders: this.db.orders, activity: this.db.activity, users: this.db.users }, null, 2);
    },

    async importJSON(text) {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.items) || !Array.isArray(data.orders)) throw new Error('ملف غير صالح');
      this.db.items = data.items;
      this.db.orders = data.orders;
      this.db.activity = Array.isArray(data.activity) ? data.activity : this.db.activity;
      this.db.settings = normalizeSettings(data.settings);
      if (!(await this.save())) throw new Error(this.lastError);
      await this.api('POST', '/api/sync-order-seq');
      await this.loadAll();
    },

    async reset() { throw new Error('في الوضع السحابي تُمسح البيانات من لوحة Cloudflare (D1 > Console)'); },
  };

  /* ======================= الواجهة الموحدة ======================= */
  const cfg = global.APP_CONFIG || {};
  const remote = !!(cfg.apiUrl && /^https?:\/\//i.test(cfg.apiUrl));
  const backend = remote ? Remote : Local;
  if (remote) Remote.cfg = cfg;

  const Store = {
    get mode() { return backend.mode; },
    get isRemote() { return remote; },
    get db() { return backend.db; },
    get lastError() { return backend.lastError || ''; },
    get lastStatus() { return backend.lastStatus || 0; },
    set onSessionLost(fn) { Remote.onSessionLost = fn; },
    uid, now, hash,
    init: () => backend.init(),
    save: () => backend.save(),
    refresh: () => backend.refresh(),
    login: (u, p) => backend.login(u, p),
    restoreSession: () => backend.restoreSession(),
    logout: () => backend.logout(),
    nextOrderNo: () => backend.nextOrderNo(),
    saveUser: (d, p) => backend.saveUser(d, p),
    deleteUser: (id) => backend.deleteUser(id),
    exportJSON: () => backend.exportJSON(),
    importJSON: (t) => backend.importJSON(t),
    reset: () => backend.reset(),
    getItem(id) { return (backend.db.items || []).find((i) => i.id === id) || null; },
    getUser(id) { return (backend.db.users || []).find((u) => u.id === id) || null; },
    /** تسجيل حدث في سجل التحديثات (يحتفظ بآخر 3000 حدث). يجب استدعاء save() بعده */
    log(entry) {
      const e = Object.assign({ id: uid(), at: now() }, entry);
      backend.db.activity.push(e);
      if (backend.db.activity.length > 3000) backend.db.activity.splice(0, backend.db.activity.length - 3000);
      return e;
    },
  };

  global.Store = Store;
})(window);
