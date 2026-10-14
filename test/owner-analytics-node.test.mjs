/* اختبار سلوكي للوحة تحليلات المالك — يشغّل كود الخادم الحقيقي (worker/worker.js)
   على قاعدة D1 في الذاكرة. لا يتصل بالإنترنت ولا ببيانات الإنتاج.

   الهدف: التحقق من الحماية على مستوى الخادم، ومن صحة الأرقام، ومن الخصوصية،
   ومن رفض الأسماء خارج القائمة البيضاء — لا قراءة أنماط نصية فقط. */

import assert from 'node:assert';
import worker from '../worker/worker.js';

let pass = 0, fail = 0;
const lines = [];
function t(name, fn) {
  try { fn(); pass++; lines.push('PASS  ' + name); }
  catch (e) { fail++; lines.push('FAIL  ' + name + '  -> ' + (e && e.message)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; lines.push('PASS  ' + name); }
  catch (e) { fail++; lines.push('FAIL  ' + name + '  -> ' + (e && e.message)); }
}

/* ---------------- D1 في الذاكرة ----------------
   يفسّر SQL البسيط المستخدم في الكود: SELECT/INSERT OR REPLACE/IGNORE/UPDATE/DELETE
   مع ? bind. كافٍ لجداول التحليلات والجلسات والزوار. */
class MemDB {
  constructor() { this.tables = new Map(); }
  tbl(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }
  colsOf(name) {
    const t = this.tbl(name);
    if (t.length) return Object.keys(t[0]);
    return this.schema && this.schema[name] ? this.schema[name] : null;
  }
  prepare(sql) {
    const self = this;
    const s = sql.replace(/\s+/g, ' ').trim();
    return {
      _sql: s,
      bind(...a) {
        return {
          async first() { return (match(s, a, self) || [null])[0] ?? null; },
          async all() { return { results: match(s, a, self) }; },
          async run() { return exec(s, a, self); },
        };
      },
      async first() { return (match(s, [], self) || [null])[0] ?? null; },
      async all() { return { results: match(s, [], self) }; },
      async run() { return exec(s, [], self); },
    };
  }
}

/* تحويل شرط WHERE بسيط إلى دالة */
function condOf(where, args) {
  if (!where) return () => true;
  // bentuk: col = ? AND col2 = ? OR ... (نستعمل AND و< و> و LIKE)
  const parts = where.split(/\s+(AND|OR)\s+/i);
  const clauses = []; let joiner = 'AND';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (/^(AND|OR)$/i.test(p)) { joiner = p.toUpperCase(); continue; }
    const pIs = p.match(/^(\w+(?:\.\w+)?)\s+IS\s+(NOT\s+)?NULL$/i);
    if (pIs) { clauses.push({ col: pIs[1].split('.').pop(), op: pIs[2] ? 'NOTNULL' : 'ISNULL', val: null }); continue; }
    const pDate = p.match(/^date\s*\(\s*(\w+(?:\.\w+)?)\s*\)\s*(=|!=|<=|>=|<>|<|>)\s*(.+)$/i);
    if (pDate) {
      // date(x) على نص ISO = أول 10 خانات، فالمقارنة النصية تكفي
      const rhsRaw = pDate[3].trim();
      clauses.push({ col: pDate[1].split('.').pop(), op: pDate[2], val: rhsRaw === '?' ? args.shift() : rhsRaw.replace(/^'|'$/g, ''), dateFn: true });
      continue;
    }
    const m = p.match(/^(\w+(?:\.\w+)?)\s*(=|!=|<=|>=|<|>|<>)\s*(.+)$/);
    if (m) {
      const [, colRaw, op, rhsRaw] = m;
      // عمود مؤهَّل (u.role / s.token) يُعامل كعموده بعد الدمج داخل match()
      const col = colRaw.split('.').pop();
      let rhs = rhsRaw.trim();
      let val;
      if (rhs === '?') { val = args.shift(); }
      else if (rhs === 'NULL') { val = null; }
      else if (/^'([^']*)'$/.test(rhs)) { val = rhs.slice(1, -1); }
      else val = rhs;
      clauses.push({ col, op, val });
    } else {
      const like = p.match(/^(\w+(?:\.\w+)?)\s+LIKE\s+(.+)$/i);
      if (like) { let val = like[2].trim(); if (val === '?') val = args.shift(); clauses.push({ col: like[1].split('.').pop(), op: 'LIKE', val }); }
      else clauses.push({ raw: p });
    }
  }
  return (row) => {
    for (const c of clauses) {
      if (c.raw) continue;
      const v = row[c.col];
      const cv = c.dateFn ? String(v ?? '').slice(0, 10) : v;
      const cs = c.dateFn ? String(c.val ?? '').slice(0, 10) : c.val;
      if (c.op === 'LIKE') { if (!String(v ?? '').includes(String(c.val).replace(/%/g, ''))) return false; continue; }
      if (c.op === 'ISNULL') { if (v !== null && v !== undefined) return false; continue; }
      if (c.op === 'NOTNULL') { if (v === null || v === undefined) return false; continue; }
      const isNull = c.val === null || c.val === 'NULL';
      if (c.op === '=') { if (isNull ? cv != null : String(cv) !== String(cs)) return false; }
      else if (c.op === '!=' || c.op === '<>') { if (isNull ? cv == null : String(cv) === String(cs)) return false; }
      else if (c.op === '<') { if (!(cv != null && cv < cs)) return false; }
      else if (c.op === '>') { if (!(cv != null && cv > cs)) return false; }
      else if (c.op === '<=') { if (!(cv != null && cv <= cs)) return false; }
      else if (c.op === '>=') { if (!(cv != null && cv >= cs)) return false; }
    }
    return true;
  };
}

function tableOf(sql) {
  // ترتيب مهم: FROM/INTO/UPDATE أولاً، لأن أول كلمة في SELECT ليست اسم جدول
  const f = sql.match(/\b(?:FROM|INTO|UPDATE)\s+(\w+)/i);
  if (f && !/^\s*CREATE/i.test(sql)) return f[1];
  const c = sql.match(/^\s*CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
  return c ? c[1] : (f ? f[1] : null);
}

/* ---------- مُحلِّل SQL بسيط이지만 صحيح للتجمعات التي يستخدمها الخادم ---------- */

/** يقسم قائمة بفاصلة على المستوى الأعلى (يتجاهل الأقواس) */
function splitTop(s, sep = ',') {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** يقيّم تعبير صفّ: عمود، أو CASE WHEN، أو عمود × معامل، أو عدد */
function evalExpr(expr, row, args) {
  const e = String(expr).trim();
  const cse = e.match(/^CASE\s+(.+?)\s+THEN\s+(.+?)\s+ELSE\s+(.+?)\s+END$/i);
  if (cse) {
    const [, condRaw, thenE, elseE] = cse;
    const cond = condRaw.replace(/^WHEN\s+/i, '');
    const cnds = cond.split(/\s+AND\s+/i);
    const ok = cnds.every((c) => {
      const m = c.trim().match(/^(\w+)\s*(>=|<=|<>|!=|=|<|>)\s*(.+)$/);
      if (!m) return false;
      const [, col, op, rhsRaw] = m;
      const rhs = rhsRaw.trim() === '?' ? args.shift() : rhsRaw.trim().replace(/^'|'$/g, '');
      const v = row[col];
      if (op === '=') return String(v) === String(rhs);
      if (op === '!=' || op === '<>') return String(v) !== String(rhs);
      if (op === '<') return v < rhs;
      if (op === '>') return v > rhs;
      if (op === '<=') return v <= rhs;
      return v >= rhs;
    });
    return evalExpr(ok ? thenE : elseE, row, args);
  }
  const mul = e.match(/^(\w+)\s*\*\s*(\d+(?:\.\d+)?)$/);
  if (mul) return (Number(row[mul[1]]) || 0) * Number(mul[2]);
  const jd = e.match(/^julianday\s*\(\s*(\w+)\s*\)$/i);
  if (jd) {
    const v = row[jd[1]];
    const ms = typeof v === 'number' ? v : Date.parse(String(v));
    return Number.isFinite(ms) ? ms / 86400000 + 2440587.5 : null;
  }
  const jdn = e.match(/^julianday\s*\(\s*'([^']*)'\s*\)$/i);
  if (jdn) return Date.parse(jdn[1]) / 86400000 + 2440587.5;
  if (/^\d+(?:\.\d+)?$/.test(e)) return Number(e);
  if (e === '?') return args.shift();
  const v = row[e.replace(/^\w+\./, '')];
  return v === undefined ? null : v;
}

const isAggExpr = (e) => /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(String(e)) && !/^\s*CASE\b/i.test(String(e));

function match(sql, args, db) {
  if (/^\s*CREATE/i.test(sql)) { if (!db.tables.has(tableOf(sql))) db.tables.set(tableOf(sql), []); return []; }
  const tbl = tableOf(sql);
  if (!tbl) return [];
  if (!/^\s*SELECT/i.test(sql)) return [];

  let list = db.tbl(tbl).slice();

  // JOIN: ندمج صفاً واحداً من الجدول المرتبط لكل صف أساسي
  const joinM = sql.match(/\bJOIN\s+(\w+)\s+(\w+)\s+ON\b([\s\S]*?)(?:\bWHERE\b|\bGROUP BY\b|\bORDER BY\b|$)/i);
  if (joinM) {
    const [, jt, ja, onRaw] = joinM;
    const jrows = db.tbl(jt);
    const pairs = (onRaw.match(/\b(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/g) || [])
      .map((x) => x.replace(/(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/, '$1,$2,$3,$4').split(','));
    list = list.flatMap((r) => jrows.filter((j) => pairs.every(([ta, ca, tb, cb]) => {
      const lv = (ta === ja ? j : r)[ca], rv = (tb === ja ? j : r)[cb];
      return String(lv) === String(rv);
    })).map((j) => {
      const o = { ...r };
      for (const k of Object.keys(j)) { o[`${ja}.${k}`] = j[k]; if (o[k] === undefined) o[k] = j[k]; }
      return o;
    }));
  }

  const whereM = sql.match(/\bWHERE\b([\s\S]*?)(?:\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b|$)/i);
  if (whereM) list = list.filter(condOf(whereM[1], args));

  const selM = sql.match(/\bSELECT\s+([\s\S]*?)\bFROM\b/i);
  const selList = splitTop(selM ? selM[1] : '*');
  const distinct = /\bSELECT\s+DISTINCT\b/i.test(sql);
  const groupM = sql.match(/\bGROUP BY\s+([\s\S]*?)(?:\bORDER BY\b|\bLIMIT\b|$)/i);
  const groupCols = groupM ? splitTop(groupM[1]).map((g) => g.replace(/^\w+\./, '')) : [];

  const items = selList.map((raw) => {
    const m = raw.match(/^(.*?)\s+AS\s+(\w+)$/i);
    return m ? { expr: m[1].trim(), alias: m[2] } : { expr: raw, alias: raw.replace(/^\w+\./, '') };
  });


  if (items.some((it) => isAggExpr(it.expr))) {
    const groups = groupCols.length
      ? [...new Map(list.map((r) => [groupCols.map((g) => String(r[g])).join('|'), r])).values()]
        .map((r) => [groupCols.map((g) => String(r[g])).join('|'), r])
      : [[null, null]];
    return groups.map(([, rep]) => {
      const rowsOf = groupCols.length ? list.filter((r) => groupCols.every((g) => String(r[g]) === String(rep[g]))) : list;
      const o = {};
      for (const g of groupCols) o[g] = rep[g];
      for (const it of items) {
        const a = [...args];
        o[it.alias] = isAggExpr(it.expr) ? aggValue(it.expr, rowsOf, a) : evalExpr(it.expr, rep || {}, a);
      }
      return o;
    });
  }

  // بلا تجميع: إسقاط أعمدة بسيط
  let src = list;
  if (distinct) src = [...new Map(src.map((r) => [JSON.stringify(r), r])).values()];
  if (items.length === 1 && items[0].expr === '*') return src;
  return src.map((r) => {
    const o = {};
    for (const it of items) { const a = [...args]; o[it.alias] = evalExpr(it.expr, r, a); }
    return o;
  });
}

function aggValue(expr, rows, args) {
  const e = String(expr).trim();
  const cm = e.match(/^COUNT\s*\(\s*(DISTINCT\s+)?(\*|\w+)\s*\)$/i);
  if (cm) {
    if (cm[2] === '*') return rows.length;
    const col = cm[2].replace(/^\w+\./, '');
    if (cm[1]) return new Set(rows.map((r) => r[col])).size;
    return rows.filter((r) => r[col] !== null && r[col] !== undefined).length;
  }
  const sm = e.match(/^(SUM|AVG|MIN|MAX)\s*\(([\s\S]+)\)$/i);
  if (sm) {
    const fn = sm[1].toUpperCase(), inner = sm[2];
    const vals = rows.map((r) => { const a = [...args]; return evalExpr(inner, r, a); })
      .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
      .map(Number);
    if (!vals.length) return null;
    if (fn === 'SUM') return vals.reduce((x, y) => x + y, 0);
    if (fn === 'AVG') return vals.reduce((x, y) => x + y, 0) / vals.length;
    if (fn === 'MIN') return Math.min(...vals);
    return Math.max(...vals);
  }
  // COALESCE(SUM(x),0) ونحوها: نقيّم الداخل ونطبّق COALESCE
  const co = e.match(/^COALESCE\s*\(([\s\S]+)\)$/i);
  if (co) {
    const parts = splitTop(co[1]);
    let v = null;
    for (const p of parts) { const a = [...args]; const got = isAggExpr(p) ? aggValue(p, rows, a) : evalExpr(p, rows[0] || {}, a); if (got !== null && got !== undefined) { v = got; break; } }
    return v === null ? (parts.length > 1 ? evalExpr(parts[parts.length - 1], rows[0] || {}, [...args]) : null) : v;
  }
  return null;
}
function exec(sql, args, db) {
  if (/^\s*CREATE/i.test(sql)) { if (!db.tables.has(tableOf(sql))) db.tables.set(tableOf(sql), []); return { success: true }; }
  const tbl = tableOf(sql);
  if (!tbl) return { success: true };
  const rows = db.tbl(tbl);
  const a = [...args];
  if (/^\s*(INSERT|REPLACE)/i.test(sql)) {
    const cols = (sql.match(/\(([^)]+)\)\s*VALUES/i)?.[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const valsM = sql.match(/VALUES\s*\(([^)]*)\)/i);
    const vals = valsM ? valsM[1].split(',').map((x) => x.trim()) : [];
    const valsA = a.slice(-vals.length);
    const obj = {}; cols.forEach((c, i) => { const v = vals[i] === '?' ? valsA[i] : (vals[i] || '').replace(/^'|'$/g, ''); obj[c] = typeof v === 'number' ? v : v; });
    const ignore = /INSERT OR IGNORE/i.test(sql);
    const pk = pkOf(sql);
    const idx = pk ? rows.findIndex((r) => pk.every((k) => String(r[k]) === String(obj[k]))) : -1;
    if (idx >= 0) { if (!ignore) rows[idx] = obj; } else rows.push(obj);
    return { success: true, changes: 1 };
  }
  if (/^\s*UPDATE/i.test(sql)) {
    const setM = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i);
    const whereM = sql.match(/\bWHERE\b([\s\S]*)$/i);
    const setA = [...a];
    const wA = [...a.slice((sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i)?.[1].match(/\?/g) || []).length)];
    const sets = (setM?.[1] || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
      const [col, rhs] = x.split('=').map((y) => y.trim());
      return [col, rhs === '?' ? setA.shift() : rhs.replace(/^'|'$/g, '')];
    });
    const keep = whereM ? rows.filter(condOf(whereM[1], wA)) : rows.slice();
    for (const r of keep) for (const [col, v] of sets) r[col] = normalize(v);
    return { success: true };
  }
  if (/^\s*DELETE/i.test(sql)) {
    const whereM = sql.match(/\bWHERE\b([\s\S]*)$/i);
    if (!whereM) { db.tables.set(tbl, []); return { success: true }; }
    const wA = [...a];
    const keep = rows.filter((r) => !condOf(whereM[1], wA)(r));
    db.tables.set(tbl, keep);
    return { success: true };
  }
  return { success: true };
}

function pkOf(sql) {
  const m = sql.match(/PRIMARY KEY\s*\(([^)]+)\)/i);
  return m ? m[1].split(',').map((x) => x.trim()) : null;
}
function normalize(v) {
  if (v == null) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/* ---------------- بيئة الاختبار ---------------- */
function envWith(seed = {}) {
  const db = new MemDB();
  for (const [name, rows] of Object.entries(seed)) db.tables.set(name, rows.map((r) => ({ ...r })));
  return {
    DB: db,
    ASSETS: null,
    TZ_OFFSET: 0,
    VISIT_TZ: 'Asia/Riyadh',
    ALLOWED_ORIGIN: '*',
    fetch: async () => new Response('{}'),
    cron: async () => {},
    caches: { default: { match: async () => null, put: async () => {} } },
  };
}
const req = (path, opts = {}) => new Request('https://x.test' + path, opts);
const jsonReq = (path, token, body) => req(path, {
  method: body ? 'POST' : 'GET',
  headers: { 'x-session-token': token || '', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});
const future = () => new Date(Date.now() + 86400000).toISOString();

const ADMIN = { sessions: [{ token: 'tok-admin', user_id: 1, expires_at: future() }], users: [{ id: 1, name: 'المالك', username: 'm', role: 'admin', active: 1 }] };
const STAFF = { sessions: [{ token: 'tok-staff', user_id: 2, expires_at: future() }], users: [{ id: 2, name: 'موظف', username: 's', role: 'staff', active: 1 }] };

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function seeded() {
  return {
    ...ADMIN,
    // موظف ومندوب حقيقيان في نفس القاعدة: الاختبار يجب أن يحاكي دوراً لا اسم رمز
    sessions: [...ADMIN.sessions, ...STAFF.sessions, { token: 'tok-mandoub', user_id: 3, expires_at: future() }],
    users: [...ADMIN.users, ...STAFF.users, { id: 3, name: 'مندوب', username: 'mb', role: 'mandoub', active: 1 }],
    link_visits: [
      { day: day(0), link: 'customer', n: 5 }, { day: day(1), link: 'customer', n: 3 },
      { day: day(0), link: 'expanded', n: 2 },
    ],
    link_visitors: [
      { day: day(0), link: 'customer', fp: 'f1' }, { day: day(0), link: 'customer', fp: 'f2' }, { day: day(0), link: 'customer', fp: 'f3' },
      { day: day(0), link: 'expanded', fp: 'f4' },
      { day: day(1), link: 'customer', fp: 'f1' }, { day: day(1), link: 'customer', fp: 'f9' },
    ],
    analytics_events: [
      { day: day(0), name: 'design_visit', dim: '', n: 5 },
      { day: day(0), name: 'design_start', dim: '', n: 4 },
      { day: day(0), name: 'design_finish', dim: '', n: 2 },
      { day: day(0), name: 'whatsapp_click', dim: '', n: 3 },
      { day: day(0), name: 'contact_request', dim: '', n: 1 },
      { day: day(1), name: 'design_visit', dim: '', n: 3 },
      { day: day(1), name: 'design_start', dim: '', n: 1 },
      { day: day(0), name: 'design_step', dim: '2', n: 4 },
      { day: day(0), name: 'design_step', dim: '3', n: 3 },
      { day: day(0), name: 'design_step_exit', dim: '2', n: 2 },
      { day: day(0), name: 'design_step', dim: '9', n: 1 },
    ],
    customer_designs: [
      { id: 1, status: 'new', contact_requested: 1, order_id: 'o1', design: JSON.stringify({ roomCount: 2, wallCount: 3, pieces: [{ type: 'sofa', pieces: 3, depth: 95, kind: 'sofa3' }, { type: 'table', pieces: 1 }] }), created_at: new Date(Date.now() - 3600000).toISOString(), updated_at: new Date(Date.now() - 1800000).toISOString() },
      { id: 2, status: 'draft', contact_requested: 0, order_id: null, design: JSON.stringify({ roomCount: 1, wallCount: 1, pieces: [{ type: 'sofa', pieces: 5, depth: 100, kind: 'sofa5' }] }), created_at: new Date(Date.now() - 7200000).toISOString(), updated_at: new Date(Date.now() - 7200000).toISOString() },
    ],
    orders: [{ id: 'o1', status: 'confirmed', data: JSON.stringify({ items: [{ name: 'كنبة', qty: 1, price: 100 }] }), created_at: new Date().toISOString() }],
  };
}

const call = async (env, path, token, body) => {
  const res = await worker.fetch(jsonReq(path, token, body), env);
  let data = null;
  try { data = await res.json(); } catch { /* غير JSON */ }
  return { status: res.status, data };
};

/* ================= الاختبارات ================= */
if (process.env.OA_DEBUG) {
  const e0 = envWith(seeded());
  const full = await call(e0, '/api/owner-analytics?range=d30', 'tok-admin');
  console.log('DEBUG payload =', JSON.stringify(full, null, 1).slice(0, 2200));
  console.log('DEBUG notoken =', JSON.stringify(await call(e0, '/api/owner-analytics', '')));
  const sum = await e0.DB.prepare('SELECT COALESCE(SUM(n),0) AS n FROM analytics_events WHERE name = ?').bind('design_visit').first();
  console.log('DEBUG raw SUM =', JSON.stringify(sum));
  const lv = await e0.DB.prepare("SELECT COALESCE(SUM(n),0) AS n FROM link_visits WHERE day >= ? AND day <= ?").bind(day(29), day(0)).first();
  console.log('DEBUG link_visits SUM =', JSON.stringify(lv), 'days=', day(0), day(29));
}
console.log('\n=== حماية الخادم (هي الأساس، لا إخفاء الزر) ===');

await ta('الموظف (staff) يُرفض عند /api/owner-analytics → 403', async () => {
  const env = envWith(seeded());
  const r = await call(env, '/api/owner-analytics', 'tok-staff');
  assert.strictEqual(r.status, 403, 'status=' + r.status);
});

await ta('لا جلسة → رفض (401 أو 403، كلاهما صحيح)', async () => {
  const env = envWith(seeded());
  const r = await call(env, '/api/owner-analytics', '');
  assert.ok(r.status === 401 || r.status === 403, 'status=' + r.status);
});

await ta('المندوب يُرفض أيضاً عند /api/owner-analytics', async () => {
  const env = envWith(seeded());
  const r = await call(env, '/api/owner-analytics', 'tok-mandoub');
  assert.strictEqual(r.status, 403, 'status=' + r.status);
});

await ta('جلسة منتهية تُرفض حتى لمدير', async () => {
  const env = envWith(seeded());
  env.DB.tables.set('sessions', [{ token: 'tok-admin', user_id: 1, expires_at: new Date(Date.now() - 1000).toISOString() }]);
  const r = await call(env, '/api/owner-analytics', 'tok-admin');
  assert.ok(r.status === 401 || r.status === 403, 'status=' + r.status);
});

await ta('المدير يحصل على 200', async () => {
  const env = envWith(seeded());
  const r = await call(env, '/api/owner-analytics', 'tok-admin');
  assert.strictEqual(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  assert.ok(r.data && r.data.funnel, 'لا يوجد funnel');
});


console.log('=== الخصوصية: لا بيانات شخصية ===');

await ta('جدول التحليلات لا يقبل اسماً ولا جوالاً (جدول الأعمدة)', async () => {
  const env = envWith({ ...seeded() });
  await worker.fetch(jsonReq('/api/analytics/event', '', { name: 'design_start', dim: '2' }), env);
  const row = env.DB.tables.get('analytics_events').find((r) => r.name === 'design_start' && r.dim === '2');
  assert.ok(row, 'الحدث لم يُسجَّل');
  assert.deepStrictEqual(Object.keys(row).sort(), ['day', 'dim', 'n', 'name'], 'أعمدة إضافية: ' + Object.keys(row));
});

await ta('اسم خارج القائمة البيضاء يُرفض بصمت', async () => {
  const env = envWith({ ...seeded() });
  await worker.fetch(jsonReq('/api/analytics/event', '', { name: 'steal_customer', dim: 'phone:0500000000' }), env);
  const bad = env.DB.tables.get('analytics_events').filter((r) => String(r.name).includes('steal'));
  assert.strictEqual(bad.length, 0, 'تم تخزين اسم غير مصرّح');
});

await ta('بُعد طويل/غير مطبَّع يُقصّ ولا يملأ الجدول', async () => {
  const env = envWith({ ...seeded() });
  await worker.fetch(jsonReq('/api/analytics/event', '', { name: 'design_step', dim: 'x'.repeat(500) + '@#$' }), env);
  const row = env.DB.tables.get('analytics_events').find((r) => r.name === 'design_step' && String(r.dim).length > 0 && r.dim !== '2');
  assert.ok(row, 'لم يُسجَّل البُعد');
  assert.ok(row.dim.length <= 40, 'طول البُعد=' + row.dim.length);
  assert.ok(!/[@#$]/.test(row.dim), 'بقايا رموز: ' + row.dim);
});

await ta('روبوت لا يُحتسب', async () => {
  const env = envWith({ ...seeded() });
  const r = await req('/api/analytics/event', { method: 'POST', headers: { 'user-agent': 'Googlebot/2.1', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'design_start' }) });
  await worker.fetch(r, env);
  const today = env.DB.tables.get('analytics_events').filter((x) => x.day === day(0) && x.name === 'design_start');
  assert.strictEqual(today.reduce((a, x) => a + x.n, 0), 4, 'عدّاد تصميم اليوم تغيّر');
});

await ta('الاستجابة العامة لا تكشف شيئاً عن المدخل', async () => {
  const env = envWith({ ...seeded() });
  const res = await worker.fetch(jsonReq('/api/analytics/event', '', { name: 'design_start' }), env);
  const txt = await res.text();
  assert.ok(txt.indexOf('day') < 0 && txt.indexOf('n"') < 0, 'تسريب بيانات: ' + txt.slice(0, 80));
});

console.log('=== صحة الأرقام ===');

await ta('visits ليست uniqueVisitors: الرقمان ليسا الشيء نفسه', async () => {
  const env = envWith(seeded());
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  assert.strictEqual(data.visits, 10, 'visits=' + data.visits);
  assert.ok(data.uniqueVisitors > 0, 'uniqueVisitors مفقود');
  assert.notStrictEqual(data.visits, data.uniqueVisitors, 'لا تمييز بين الزيارة والزائر');
});

await ta('نِسَب القمع محسوبة على مقامات صحيحة', async () => {
  const env = envWith(seeded());
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  const s = Object.fromEntries(data.funnel.steps.map((x) => [x.key, x]));
  const started = s.start.n, finished = s.finish.n, wa = s.whatsapp.n;
  const p = (a, b) => Math.round((a / b) * 1000) / 10;
  assert.strictEqual(s.start.rate, p(started, s.visit.n), 'rate البداية');
  assert.strictEqual(s.finish.rate, p(finished, started), 'rate الإكمال');
  // واتساب يُقاس على «من بدأ» لا «من أكمل»: من يضغط الزر قد لا يكمل، فالمقام
  // latter يعطي نسبة فوق 100% وهمية.
  assert.strictEqual(s.whatsapp.rate, p(wa, started), 'rate واتساب');
  assert.strictEqual(s.visit.rate, null, 'أول خطوة بلا نسبة');
});

await ta('لا نسبة فوق 100% في بيانات واقعية', async () => {
  const env = envWith(seeded());
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  for (const st of data.funnel.steps) {
    if (st.rate == null) continue;
    assert.ok(st.rate <= 100, 'نسبة ' + st.key + ' = ' + st.rate + '%');
  }
});

await ta('المقام صفر → rate = null لا Infinity ولا NaN', async () => {
  const env = envWith({ ...ADMIN, analytics_events: [{ day: day(0), name: 'design_visit', dim: '', n: 0 }] });
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  for (const st of data.funnel.steps) {
    assert.ok(st.rate === null || (Number.isFinite(st.rate) && st.rate >= 0), 'rate=' + st.rate + ' في ' + st.key);
  }
});

await ta('المراحل تُقرأ كما وصلت بلا اختراع أرقام', async () => {
  const env = envWith(seeded());
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  const rc = Object.fromEntries(data.stepReached.map((x) => [x.dim, x.n]));
  const ex = Object.fromEntries(data.stepExit.map((x) => [x.dim, x.n]));
  // الخام يحوي أبعاداً من كل الأرقام المسجَّلة؛ التصفية إلى المراحل الخمس обяور
  // الواجهة (وهي التي تملك خريطة المراحل)، والخادم لا يخترع ولا يحذف بيانات.
  assert.strictEqual(rc['2'], 4, 'وصول المرحلة 2 = ' + rc['2']);
  assert.strictEqual(rc['3'], 3, 'وصول المرحلة 3 = ' + rc['3']);
  assert.strictEqual(ex['2'], 2, 'مغادرة المرحلة 2 = ' + ex['2']);
  for (const x of data.stepReached.concat(data.stepExit)) {
    assert.ok(Number.isFinite(Number(x.n)) && x.n >= 0, 'عدد غير صالح: ' + JSON.stringify(x));
  }
});

await ta('متوسط المدة null عند غياب بيانات، لا صفر', async () => {
  const env = envWith({ ...ADMIN, customer_designs: [] });
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  assert.strictEqual(data.avgDesignMin, null, 'قيمة=' + data.avgDesignMin);
});

await ta('واتساب ليس طلباً: الطلب المؤكد من order_id فقط', async () => {
  const env = envWith(seeded());
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  const confirmed = data.funnel.steps.find((x) => x.key === 'order');
  assert.strictEqual(confirmed.n, 1, 'طلبات مؤكدة=' + confirmed.n + ' (ollc design واحد بـ order_id)');
  const wa = data.funnel.steps.find((x) => x.key === 'whatsapp').n;
  assert.notStrictEqual(confirmed.n, wa, 'تُحسب الطلبات من ضغطات واتساب');
});

await ta('تصفية الفترة تعمل: يوم واحد أصغر من 30 يوماً', async () => {
  const env = envWith(seeded());
  const d30 = (await call(env, '/api/owner-analytics?range=d30', 'tok-admin')).data;
  const d1 = (await call(env, '/api/owner-analytics?range=d', 'tok-admin')).data;
  assert.ok(d1.visits < d30.visits, 'today=' + d1.visits + ' d30=' + d30.visits);
});

await ta('تاريخ مخصص يُحترم', async () => {
  const env = envWith(seeded());
  const from = day(1), to = day(1);
  const { data } = await call(env, `/api/owner-analytics?range=custom&from=${from}&to=${to}`, 'tok-admin');
  assert.strictEqual(data.from, from); assert.strictEqual(data.to, to);
  assert.strictEqual(data.visits, 3, 'زيارات=' + data.visits);
});

await ta('تاريخ مخصص مقلوب لا يعطي أرقاماً كاذبة', async () => {
  const env = envWith(seeded());
  const { data } = await call(env, `/api/owner-analytics?range=custom&from=${day(1)}&to=${day(3)}`, 'tok-admin');
  assert.ok(data.visits === 0 || data.visits == null, 'visits=' + data.visits);
});

console.log('=== صراحة الغياب بدل الأرقام الوهمية ===');

await ta('المصدر غير متوفر مُعلن لا مخترَع', async () => {
  const env = envWith(seeded());
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  assert.ok(data.unavailable && data.unavailable.referrer, 'لا يوجد unavailable.referrer');
  assert.ok(data.unavailable.whatsappSent, 'لا يوجد whatsappSent');
  assert.ok(data.unavailable.deviceFingerprint, 'لا يوجد deviceFingerprint');
});

await ta('لا يسرّب بريد/جوال من التصاميم في الرد', async () => {
  const env = envWith(seeded());
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  const s = JSON.stringify(data);
  assert.ok(!/@/.test(s), 'يحتوي بريداً');
  assert.ok(!/05\d{8}/.test(s), 'يحتوي رقماً يبدأ بـ 05');
  assert.ok(!/design"?\s*:/.test(s), 'يسرّب محتوى التصميم الخام');
});

console.log('=== الاحتفاظ والتنظيف ===');

await ta('الأحداث الأقدم من مدة الاحتفاظ تُحذف', async () => {
  const env = envWith({ ...ADMIN, analytics_events: [{ day: '2000-01-01', name: 'design_start', dim: '', n: 3 }, { day: day(0), name: 'design_start', dim: '', n: 1 }] });
  await worker.fetch(jsonReq('/api/analytics/event', '', { name: 'design_finish' }), env);
  const rows = env.DB.tables.get('analytics_events');
  assert.ok(!rows.some((r) => r.day === '2000-01-01'), 'لم تُحذف الصفوف القديمة');
  assert.ok(rows.some((r) => r.day === day(0)), 'حُذفت بيانات اليوم أيضاً');
});

console.log('=== الإحصاء لا يعطّل الخدمة ===');

await ta('خطأ في جدول التحليلات وحده لا يُسقط الطلب ولا ينقل طلب العميل', async () => {
  const env = envWith(seeded());
  // نفشل فقط عمليات جدول التحليلات — كأن جدوله تالف، لا كأن القاعدة كلها معطلة
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (/analytics_events/i.test(sql)) throw new Error('analytics table broken');
    return realPrepare(sql);
  };
  // نقطة استقبال الحدث العام تعيد 200 رغم الخطأ
  const r = await call(env, '/api/analytics/event', '', { name: 'design_start' });
  assert.strictEqual(r.status, 200, 'status=' + r.status);
  // وطلب العميل نفسه ينجح: التصميم لا يتأثر بالإحصاء
  const p = await worker.fetch(req('/api/design/start', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({}) }), env);
  assert.ok(p.status < 500, 'طلب العميل سقط بسبب الإحصاء: ' + p.status);
});

await ta('جدول التحليلات يُنشأ تلقائياً إن لم يوجد', async () => {
  const env = envWith({ ...ADMIN });
  assert.ok(!env.DB.tables.has('analytics_events') || env.DB.tables.get('analytics_events').length === 0);
  const { data } = await call(env, '/api/owner-analytics', 'tok-admin');
  assert.strictEqual(data.visits, 0, 'visits=' + data.visits);
});

/* ---------- النتيجة ---------- */
const report = lines.join('\n') + '\n\n=== النتيجة: PASS=' + pass + '  FAIL=' + fail + ' ===';
if (process.env.OA_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.OA_OUT, report, 'utf8');
}
console.log(report);
process.exit(fail ? 1 : 0);