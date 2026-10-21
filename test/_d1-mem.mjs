/* D1 وهمية في الذاكرة لتشغيل الخادم الحقيقي (worker/worker.js) في Node —
   نفس أسلوب test/owner-analytics-node.test.mjs (لا اتصال ولا بيانات إنتاج)
   بدعم إضافي لما تستخدمه مزامنة الطلبات فعلياً:
     - IN (?, ?, …) في WHERE
     - INSERT … ON CONFLICT(id) DO UPDATE / DO NOTHING (بيانات مقيّدة كما في D1:
       ما يُربَط نصّاً يبقى نصّاً — لا يُحوَّل أرقاماً، وإلا انقلب ملكية الأعمدة
       النصية وأعطى نتائج كاذبة)
     - batch() ذرّي كما يستعمله sync
   يكفي للاختبارات الحالية؛ لا يهدف إلى محاكاة SQLite كاملة. */

export class MemDB {
  constructor() { this.tables = new Map(); }
  tbl(name) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name);
  }
  prepare(sql) {
    const self = this;
    const s = String(sql).replace(/\s+/g, ' ').trim();
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
  /** دفعة ذرّية بسيطة: تنفيذ تسلسلي — sync يعتمد على إتمامها كلها أو سقوطها */
  async batch(list) {
    const out = [];
    for (const st of list) out.push(await st.run());
    return out;
  }
}

/* شرط WHERE مبسّط: = != < > <= >= و IS [NOT] NULL و IN (…) و LIKE، بـ AND/OR */
function condOf(where, args) {
  if (!where) return () => true;
  const parts = String(where).split(/\s+(AND|OR)\s+/i);
  const clauses = []; let joiner = 'AND';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (/^(AND|OR)$/i.test(p)) { joiner = p.toUpperCase(); continue; }
    const pIn = p.match(/^(\w+(?:\.\w+)?)\s+IN\s*\(([^)]*)\)$/i);
    if (pIn) {
      const col = pIn[1].split('.').pop();
      const n = pIn[2].split(',').filter((x) => x.trim() === '?').length;
      const vals = args.splice(0, n);
      clauses.push({ col, op: 'IN', vals });
      continue;
    }
    const pIs = p.match(/^(\w+(?:\.\w+)?)\s+IS\s+(NOT\s+)?NULL$/i);
    if (pIs) { clauses.push({ col: pIs[1].split('.').pop(), op: pIs[2] ? 'NOTNULL' : 'ISNULL', val: null }); continue; }
    const like = p.match(/^(\w+(?:\.\w+)?)\s+LIKE\s+(.+)$/i);
    if (like) {
      let val = like[2].trim();
      if (val === '?') val = args.shift();
      clauses.push({ col: like[1].split('.').pop(), op: 'LIKE', val });
      continue;
    }
    const m = p.match(/^(\w+(?:\.\w+)?)\s*(=|!=|<=|>=|<|>|<>)\s*(.+)$/);
    if (m) {
      const [, colRaw, op, rhsRaw] = m;
      const col = colRaw.split('.').pop();
      const rhs = rhsRaw.trim();
      let val;
      if (rhs === '?') val = args.shift();
      else if (rhs === 'NULL') val = null;
      else if (/^'([^']*)'$/.test(rhs)) val = rhs.slice(1, -1);
      else if (/^-?\d+(\.\d+)?$/.test(rhs)) val = Number(rhs);
      else val = rhs;
      clauses.push({ col, op, val });
    }
  }
  return (row) => {
    for (const c of clauses) {
      const v = row[c.col];
      if (c.op === 'IN') { if (!c.vals.some((x) => String(x) === String(v))) return false; continue; }
      if (c.op === 'LIKE') { if (!String(v ?? '').includes(String(c.val).replace(/%/g, ''))) return false; continue; }
      if (c.op === 'ISNULL') { if (v !== null && v !== undefined) return false; continue; }
      if (c.op === 'NOTNULL') { if (v === null || v === undefined) return false; continue; }
      const isNull = c.val === null || c.val === 'NULL';
      if (c.op === '=') { if (isNull ? v != null : String(v) !== String(c.val)) return false; }
      else if (c.op === '!=' || c.op === '<>') { if (isNull ? v == null : String(v) === String(c.val)) return false; }
      else if (c.op === '<') { if (!(v != null && v < c.val)) return false; }
      else if (c.op === '>') { if (!(v != null && v > c.val)) return false; }
      else if (c.op === '<=') { if (!(v != null && v <= c.val)) return false; }
      else if (c.op === '>=') { if (!(v != null && v >= c.val)) return false; }
    }
    return true;
  };
}

function tableOf(sql) {
  const f = sql.match(/\b(?:FROM|INTO|UPDATE)\s+(\w+)/i);
  if (f && !/^\s*CREATE/i.test(sql)) return f[1];
  const c = sql.match(/^\s*CREATE\s+TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i);
  return c ? c[1] : null;
}

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

function evalExpr(expr, row, args) {
  const e = String(expr).trim();
  if (e === '?') return args.shift();
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
  const mul = e.match(/^(\w+)\s*\*\s*(\d+(?:\.\d+)?)$/);
  if (mul) return (Number(row[mul[1]]) || 0) * Number(mul[2]);
  const jd = e.match(/^julianday\s*\(\s*(\w+)\s*\)$/i);
  if (jd) {
    const v = row[jd[1]];
    const ms = typeof v === 'number' ? v : Date.parse(String(v));
    return Number.isFinite(ms) ? ms / 86400000 + 2440587.5 : null;
  }
  const v = row[e.replace(/^\w+\./, '')];
  return v === undefined ? null : v;
}

const isAggExpr = (e) => /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(String(e)) && !/^\s*CASE\b/i.test(String(e));

function aggValue(expr, rows, args) {
  const e = String(expr).trim();
  const cm = e.match(/^COUNT\s*\(\s*(DISTINCT\s+)?(\*|\w+)\s*\)$/i);
  if (cm) {
    if (cm[2] === '*') return rows.length;
    const col = cm[2].replace(/^\w+\./, '');
    if (cm[1]) return new Set(rows.map((r) => r[col])).size;
    return rows.filter((r) => r[col] !== null && r[col] !== undefined).length;
  }
  const co = e.match(/^COALESCE\s*\(([\s\S]+)\)$/i);
  if (co) {
    for (const p of splitTop(co[1])) {
      const a = [...args];
      const got = isAggExpr(p) ? aggValue(p, rows, a) : evalExpr(p, rows[0] || {}, a);
      if (got !== null && got !== undefined) return got;
    }
    return null;
  }
  return null;
}

function match(sql, args, db) {
  if (/^\s*CREATE/i.test(sql)) { if (!db.tables.has(tableOf(sql))) db.tables.set(tableOf(sql), []); return []; }
  const tbl = tableOf(sql);
  if (!tbl || !/^\s*SELECT/i.test(sql)) return [];
  const a = [...args];
  let list = db.tbl(tbl).slice();

  const joinM = sql.match(/\bJOIN\s+(\w+)\s+(\w+)\s+ON\b([\s\S]*?)(?:\bWHERE\b|\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b|$)/i);
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
  if (whereM) list = list.filter(condOf(whereM[1], a));

  const selM = sql.match(/\bSELECT\s+([\s\S]*?)\bFROM\b/i);
  const selList = splitTop(selM ? selM[1] : '*');
  if (selList.some((x) => isAggExpr(x))) {
    const o = {};
    for (const raw of selList) {
      const m = raw.match(/^(.*?)\s+AS\s+(\w+)$/i);
      const expr = m ? m[1].trim() : raw;
      const alias = m ? m[2] : raw.replace(/^\w+\./, '');
      o[alias] = aggValue(expr, list, [...a]);
    }
    return list.length || selList.some((x) => /COUNT\s*\(\s*\*/i.test(x)) ? [o] : [];
  }
  if (selList.length === 1 && selList[0].trim() === '*') return list;
  return list.map((r) => {
    const o = {};
    for (const raw of selList) {
      const m = raw.match(/^(.*?)\s+AS\s+(\w+)$/i);
      o[m ? m[2] : raw.replace(/^\w+\./, '')] = evalExpr(m ? m[1].trim() : raw, r, [...a]);
    }
    return o;
  });
}

/* قيّم تعبير SET في ON CONFLICT DO UPDATE: excluded.x أو COALESCE(excluded.x, tbl.y) */
function conflictRhs(rhsRaw, obj, old) {
  const rhs = String(rhsRaw).trim();
  const ex = rhs.match(/^excluded\.(\w+)$/i);
  if (ex) return obj[ex[1]];
  const co = rhs.match(/^COALESCE\s*\(\s*excluded\.(\w+)\s*,\s*(?:\w+\.)?(\w+)\s*\)$/i);
  if (co) {
    const v = obj[co[1]];
    if (v !== null && v !== undefined) return v;
    const ov = old ? old[co[2]] : undefined;
    return ov !== null && ov !== undefined ? ov : v;
  }
  if (rhs === '?') return { __bind: true };
  if (/^'([^']*)'$/.test(rhs)) return rhs.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(rhs)) return Number(rhs);
  return rhs;
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
    const obj = {};
    cols.forEach((c, i) => {
      if (vals[i] === '?') obj[c] = valsA[i];
      else if (vals[i] === undefined || vals[i] === '') obj[c] = undefined;
      else if (/^-?\d+(\.\d+)?$/.test(vals[i])) obj[c] = Number(vals[i]);
      else obj[c] = vals[i].replace(/^'|'$/g, '');
    });
    const conflictM = sql.match(/ON\s+CONFLICT\s*\((\w+)\)\s*DO\s+(UPDATE|NOTHING)/i);
    if (conflictM) {
      const pk = conflictM[1];
      const idx = rows.findIndex((r) => String(r[pk]) === String(obj[pk]));
      if (/nothing/i.test(conflictM[2])) {
        if (idx < 0) rows.push(obj);
        return { success: true, changes: 1 };
      }
      const old = idx >= 0 ? rows[idx] : null;
      if (idx < 0) { rows.push(obj); return { success: true, changes: 1 }; }
      const setM = sql.match(/\bDO\s+UPDATE\s+SET\b([\s\S]+)$/i);
      const assign = splitTop(setM ? setM[1] : '').filter(Boolean);
      for (const as of assign) {
        const m = as.match(/^(\w+)\s*=\s*([\s\S]+)$/);
        if (!m) continue;
        const v = conflictRhs(m[2], obj, old);
        rows[idx][m[1]] = (v && v.__bind) ? undefined : v;
      }
      return { success: true, changes: 1 };
    }
    const ignore = /INSERT\s+OR\s+IGNORE/i.test(sql);
    if (ignore && rows.some((r) => String(r.id) === String(obj.id))) return { success: true, changes: 0 };
    rows.push(obj);
    return { success: true, changes: 1 };
  }

  if (/^\s*UPDATE/i.test(sql)) {
    const setM = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/i);
    const whereM = sql.match(/\bWHERE\b([\s\S]*)$/i);
    const setCount = (setM?.[1]?.match(/\?/g) || []).length;
    const setA = a.slice(0, setCount);
    const wA = a.slice(setCount);
    const sets = splitTop(setM?.[1] || '').filter(Boolean).map((x) => {
      const eq = x.indexOf('=');
      const col = x.slice(0, eq).trim();
      const rhs = x.slice(eq + 1).trim();
      if (rhs === '?') return [col, setA.shift()];
      if (/^'([^']*)'$/.test(rhs)) return [col, rhs.slice(1, -1)];
      if (/^-?\d+(\.\d+)?$/.test(rhs)) return [col, Number(rhs)];
      return [col, rhs];
    });
    const keep = whereM ? rows.filter(condOf(whereM[1], wA)) : rows.slice();
    for (const r of keep) for (const [col, v] of sets) r[col] = v;
    return { success: true };
  }

  if (/^\s*DELETE/i.test(sql)) {
    const whereM = sql.match(/\bWHERE\b([\s\S]*)$/i);
    if (!whereM) { db.tables.set(tbl, []); return { success: true }; }
    const keep = rows.filter((r) => !condOf(whereM[1], [...a])(r));
    db.tables.set(tbl, keep);
    return { success: true };
  }
  return { success: true };
}

/** بيئة اختبار: جداول مبذورة كما هي */
export function envWith(seed = {}) {
  const db = new MemDB();
  for (const [name, rows] of Object.entries(seed)) db.tables.set(name, rows.map((r) => ({ ...r })));
  return {
    DB: db,
    ASSETS: null,
    ALLOWED_ORIGIN: '*',
    fetch: async () => new Response('{}'),
    caches: { default: { match: async () => null, put: async () => {} } },
  };
}
