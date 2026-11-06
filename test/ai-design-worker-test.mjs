/* اختبار مسار بوت التصميم الذكي في الخادم (worker/worker.js):
   - المصادقة بتوكن البوابة، والعلم aiDesign في الإعدادات، وحدود المدخلات
   - تنقية مخرجات النموذج (مخطط أبيض) + كتم المفتاح من أي رد
   - المزوّد المتوافق مع OpenAI: نداء واحد، إعادة محاولة مناسبة، قصّ التاريخ
   - حدّ 15 طلباً/ساعة، وإصلاح قبول التلفاز في checkDesign
   - الخصوصية: لا يُسجَّل نص المحادثة ولا المفتاح في السجلات
   node test/ai-design-worker-test.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0, fail = 0;
const lines = [];
const t = (n, ok, i = '') => { if (ok) { pass++; lines.push('PASS  ' + n); } else { fail++; lines.push('FAIL  ' + n + (i ? '  -> ' + i : '')); } };

const TOKEN = 'ab'.repeat(32);
const AI = { AI_API_KEY: 'sk-live-secret-XYZ', AI_BASE_URL: 'https://provider.test/v1', AI_MODEL: 'test-model' };

function freshState() {
  return {
    fail: {},
    users: [],
    settings: { shopName: 'أصالة نجد', aiDesignEnabled: true },
    items: [
      { data: JSON.stringify({ id: 'f1', name: 'كتان بيج', category: 'fabric', active: true }) },
      { data: JSON.stringify({ id: 'fo1', name: 'إسفنج متوسط', category: 'foam', active: true }) },
      { data: JSON.stringify({ id: 'a1', name: 'مروحة', category: 'acc', active: true }) },
    ],
    designRow: {
      id: 'd1', public_no: null, status: 'draft', design: '{}',
      customer_name: '', customer_phone: '', contact_requested: 0,
      order_id: null, order_number: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      expires_at: 4102444800000,
    },
  };
}

function makeDb(state) {
  return {
    prepare(sql) {
      const q = String(sql).replace(/\s+/g, ' ').trim();
      return {
        _q: q, _b: [],
        bind(...a) { this._b = a; return this; },
        async first() {
          if (/FROM customer_designs WHERE token/.test(q)) return state.designRow ? Object.assign({}, state.designRow) : null;
          if (/FROM login_fail WHERE k/.test(q)) { const r = state.fail[this._b[0]]; return r ? { n: r.n, first_at: r.first_at } : null; }
          if (/FROM settings/.test(q)) return { data: JSON.stringify(state.settings) };
          if (/AS n FROM users/.test(q)) return { n: (state.users || []).length };
          if (/FROM users WHERE lower\(username\)/.test(q)) {
            const uname = (this._b[0] || '').toLowerCase();
            const u = (state.users || []).find((u) => u.username.toLowerCase() === uname);
            return u ? Object.assign({}, u) : null;
          }
          if (/FROM users WHERE id/.test(q)) {
            const u = (state.users || []).find((u) => u.id === this._b[0]);
            return u ? Object.assign({}, u) : null;
          }
          return null;
        },
        async all() {
          if (/FROM items/.test(q)) {
            // Handle parameterized queries: WHERE category = ? and LIMIT ?
            const catMatch = q.match(/WHERE\s+json_extract\(data,\s*'\$\.category'\)\s*=\s*'([^']+)'/i)
              || q.match(/WHERE\s+category\s*=\s*'([^']+)'/i);
            const limitMatch = q.match(/LIMIT\s+(\d+)/i);
            const desc = /ORDER BY updated_at DESC/i.test(q);
            // Use bound params if available (parameterized query)
            const boundCat = this._b && this._b.length > 0 && typeof this._b[0] === 'string' ? this._b[0] : null;
            const boundLimit = this._b && this._b.length > 1 && typeof this._b[1] === 'number' ? this._b[1] : null;
            const cat = catMatch ? catMatch[1] : boundCat;
            const limit = boundLimit !== null ? boundLimit : (limitMatch ? parseInt(limitMatch[1], 10) : state.items.length);
            let items = state.items;
            if (cat) {
              items = items.filter((item) => {
                try {
                  const i = JSON.parse(item.data);
                  if (!i || typeof i !== 'object') return false;
                  if (i.category !== cat) return false;
                  if (i.active === false) return false;
                  if (!i.id || i.id === '') return false;
                  if (!i.name || i.name === '') return false;
                  return true;
                } catch (e) { return false; }
              });
            } else {
              // No category filter: apply validity filters only
              items = items.filter((item) => {
                try {
                  const i = JSON.parse(item.data);
                  if (!i || typeof i !== 'object') return false;
                  if (i.active === false) return false;
                  if (!i.id || i.id === '') return false;
                  if (!i.name || i.name === '') return false;
                  return true;
                } catch (e) { return false; }
              });
            }
            if (desc) {
              items = items.slice().sort((a, b) => {
                try {
                  const ia = JSON.parse(a.data);
                  const ib = JSON.parse(b.data);
                  const ua = (ia && ia.updated_at) || '';
                  const ub = (ib && ib.updated_at) || '';
                  return String(ub).localeCompare(String(ua));
                } catch (e) { return 0; }
              });
            }
            return { results: items.slice(0, limit) };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO login_fail/.test(q)) {
            const [k, n, first] = this._b;
            state.fail[k] = { n: n, first_at: first };
            return { success: true };
          }
          if (/INSERT INTO users/.test(q)) {
            // SQL: INSERT INTO users (id, username, name, password_hash, role, active, created_at, must_change_password)
            //      SELECT ?, ?, ?, ?, ?, 1, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM users)
            // Bind params: [id, username, name, password_hash, role, created_at] (6 params; active=1, must_change=1 hardcoded)
            const params = this._b;
            const u = { id: params[0], username: params[1], name: params[2], password_hash: params[3], role: params[4], active: 1, created_at: params[5], must_change_password: 1 };
            if (!(state.users || []).find((x) => x.id === u.id)) {
              (state.users = state.users || []).push(u);
            }
            return { success: true };
          }
          if (/UPDATE users SET password_hash/.test(q)) {
            const params = this._b;
            const u = (state.users || []).find((x) => x.id === params[1]);
            if (u) u.password_hash = params[0];
            return { success: true };
          }
          if (/UPDATE users SET name/.test(q)) {
            const params = this._b;
            const u = (state.users || []).find((x) => x.id === params[params.length - 1]);
            if (u) {
              u.name = params[0];
              u.username = params[1];
              u.role = params[2];
              u.active = params[3];
              if (params.length > 8) u.password_hash = params[4];
              u.parent_id = params[params.length > 8 ? 5 : 4];
              u.rate = params[params.length > 8 ? 6 : 5];
              u.parent_rate = params[params.length > 8 ? 7 : 6];
            }
            return { success: true };
          }
          if (/UPDATE users SET password_hash = \?, must_change_password/.test(q)) {
            const params = this._b;
            const u = (state.users || []).find((x) => x.id === params[1]);
            if (u) { u.password_hash = params[0]; u.must_change_password = 0; }
            return { success: true };
          }
          return { success: true };
        },
      };
    },
    async batch(stmts) { for (const s of stmts) if (s && s.run) await s.run(); return []; },
  };
}

const worker = await import('data:text/javascript;base64,' + Buffer.from(read('worker/worker.js'), 'utf8').toString('base64'));

const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };

let calls = [];
let handler = null;
const realFetch = globalThis.fetch;
function setProvider(h) {
  handler = h;
  calls = [];
  globalThis.fetch = async (url, opts) => {
    const b = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body: b, headers: (opts && opts.headers) || {} });
    return handler(String(url), opts, b, calls.length);
  };
}
const ok = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

async function call(env, method, p, body, token) {
  const headers = {};
  if (token !== null) headers['x-design-token'] = token === undefined ? TOKEN : token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request('https://x.test' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const r = await worker.default.fetch(req, env);
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, body: j, text: JSON.stringify(j) };
}
const ai = (env, body, token) => call(env, 'POST', '/api/portal/ai-design', body, token);
const READY = {
  status: 'ready', note: 'فهمت طلبك وجهزته.', assumptions: ['الباب في وسط الجدار'], issues: [], questions: [],
  spec: {
    roomW: '٦', roomH: 4, seating: 'arabic', depth: '٠٫٨',
    door: { wall: 1, w: 0.9, distFromCorner: 1, side: 'start' },
    window: { wall: 9, w: 2 },
    tv: { wall: 2, w: 1.4 },
    sofaWalls: [0, 1, 2],
    fabric: 'كتان بيج',
    accessories: [{ name: 'مروحة', qty: 2 }],
    price: 999, walls: [1, 2, 3],
  },
};
const READY_TXT = JSON.stringify(READY);

try {
  console.log('== 1) إعدادات البوابة: علم الميزة ==');
  {
    const st = freshState();
    const noKey = await call({ DB: makeDb(st) }, 'GET', '/api/portal/settings');
    t('بلا مفتاح مزوّد: aiDesign.enabled == false', noKey.status === 200 && noKey.body.settings.aiDesign.enabled === false, noKey.text);
    const withKey = await call({ DB: makeDb(st), AI_API_KEY: 'sk-x' }, 'GET', '/api/portal/settings');
    t('مع مفتاح: aiDesign.enabled == true', withKey.status === 200 && withKey.body.settings.aiDesign.enabled === true, withKey.text);
  }

  console.log('== 2) المصادقة ==');
  {
    const st = freshState();
    const env = { DB: makeDb(st) };
    setProvider(() => ok(READY_TXT));
    t('بلا توكن ← 401', (await ai(env, { text: 'مرحبا' }, null)).status === 401);
    t('توكن قصير ← 401', (await ai(env, { text: 'مرحبا' }, 'abc')).status === 401);
    st.designRow = null;
    t('توكن غير موجود في القاعدة ← 401', (await ai(env, { text: 'مرحبا' })).status === 401);
    t('لا نداء مزوّد عند فشل المصادقة', calls.length === 0, String(calls.length));
  }

  console.log('== 3) التهيئة والحدود ==');
  {
    const st = freshState();
    setProvider(() => ok(READY_TXT));
    const noKey = await ai({ DB: makeDb(st) }, { text: 'مجلس 6×4' });
    t('بلا AI_API_KEY ← 503 برسالة عربية لطيفة', noKey.status === 503 && /غير مفعّلة حالياً/.test(noKey.body.error), noKey.text);
    t('لا نداء مزوّد بلا مفتاح', calls.length === 0, String(calls.length));

    st.settings.aiDesignEnabled = false;
    const off = await ai({ DB: makeDb(st), AI_API_KEY: 'sk-x' }, { text: 'مجلس 6×4' });
    t('العلم aiDesignEnabled=false ← 503 «غير مفعّلة»', off.status === 503 && /غير مفعّلة/.test(off.body.error), off.text);
    t('لا نداء مزوّد والعلم مطفأ', calls.length === 0, String(calls.length));

    const st2 = freshState();
    const env2 = { DB: makeDb(st2), AI_API_KEY: 'sk-x' };
    const long = await ai(env2, { text: 'ي'.repeat(3001) });
    t('نص 3001 حرف ← 400', long.status === 400, long.text);
    const empty = await ai(env2, { text: '   ' });
    t('نص فارغ ← 400', empty.status === 400, empty.text);
  }

  console.log('== 4) النجاح: تنقية المخطط والنداء للمزوّد ==');
  {
    const st = freshState();
    const env = { DB: makeDb(st), ...AI };
    setProvider(() => ok(READY_TXT));
    const r = await ai(env, { text: 'مجلس ٦×٤ باب وتلفاز' });
    t('200 مع status=ready', r.status === 200 && r.body.status === 'ready', r.text);
    t('الأرقام العربية تُطاب إلى لاتينية', r.body.spec.roomW === 6 && r.body.spec.depth === 0.8, JSON.stringify(r.body.spec));
    t('مفتاح خارج العقد يُمحى (price/walls)', !('price' in r.body.spec) && !('walls' in r.body.spec), Object.keys(r.body.spec).join(','));
    t('فتحة بجدار 9 تُسقط بلا تحطيم', !('window' in r.body.spec) && r.body.spec.door, JSON.stringify(r.body.spec));
    t('لا مفتاح في أي رد', !r.text.includes('sk-live-secret') && !r.text.includes('sk-'), r.text.slice(0, 120));
    const pc = calls[0];
    t('نداء المزوّد على المسار الصحيح', pc && pc.url === 'https://provider.test/v1/chat/completions', pc && pc.url);
    t('المفتاح في ترويسة المزوّد فقط', pc && pc.headers.authorization === 'Bearer sk-live-secret-XYZ', pc && pc.headers.authorization);
    t('النموذج والحرارة وjson_object', pc && pc.body.model === 'test-model' && pc.body.temperature === 0.2 && pc.body.response_format.type === 'json_object', JSON.stringify(pc && pc.body.response_format));
    t('التعليمات تحتوي اسم قماش الكتالوج', pc && pc.body.messages[0].content.includes('كتان بيج'));
    t('التعليمات تحتوي إكسسوار الكتالوج', pc && pc.body.messages[0].content.includes('مروحة'));
    t('لا يمر نص العميل داخل سجلّات الخادم', !warns.some((w) => w.includes('مجلس')), JSON.stringify(warns));
    t('لا مفتاح في السجلات', !warns.some((w) => w.includes('sk-live')), JSON.stringify(warns));
  }

  console.log('== 5) الأسئلة والحدّود والتنقيح ==');
  {
    const st = freshState();
    const env = { DB: makeDb(st), ...AI };
    setProvider(() => ok(JSON.stringify({
      status: 'need_answers', note: 'ما مقاس الغرفة؟',
      questions: [
        { id: 'q1', q: 'ما الطول؟', options: ['4', '5', '6', '7', '8', '9'] },
        { id: 'q2', q: 'كم باباً؟', options: ['واحد', 'اثنان'] },
        { id: 'q3', q: 'نوع الجلسة؟', options: ['عربي', 'كنب'] },
        { id: 'q4', q: 'هل تلفاز؟', options: ['نعم', 'لا'] },
        { id: 'q5', q: 'سؤال زائد؟', options: ['أ'] },
      ],
      assumptions: [], issues: [], spec: null,
    })));
    const r = await ai(env, { text: 'ابدأ' });
    t('need_answers يمر كما هو', r.status === 200 && r.body.status === 'need_answers', r.text);
    t('الأسئلة مقصوصة إلى 3', r.body.questions.length === 3, String(r.body.questions.length));
    t('الخيارات مقصوصة إلى 5', r.body.questions[0].options.length === 5, String(r.body.questions[0].options.length));
    t('بلا مواصفات ← spec null', r.body.spec === null);

    setProvider(() => ok(JSON.stringify({
      status: 'invalid', note: 'هذا ليس طلب تصميم.', questions: [], assumptions: [], issues: ['أعد صياغة الطلب'], spec: null,
    })));
    const inv = await ai(env, { text: 'كم الساعة؟' });
    t('invalid يمر برسالة مهذبة', inv.status === 200 && inv.body.status === 'invalid' && /ليس طلب تصميم/.test(inv.body.note), inv.text);

    setProvider(() => ok(JSON.stringify({ status: 'ready', note: 'جاهز', questions: [], assumptions: [], issues: [] })));
    const noSpec = await ai(env, { text: 'جاهز بلا مواصفات' });
    t('ready بلا spec ← يُخفَض إلى need_answers', noSpec.status === 200 && noSpec.body.status === 'need_answers', noSpec.text);

    setProvider(() => ok('```json\n' + READY_TXT + '\n```'));
    const fenced = await ai(env, { text: 'مع كتل رموز' });
    t('كتل ```json تُزال قبل القراءة', fenced.status === 200 && fenced.body.status === 'ready', fenced.text);
  }

  console.log('== 6) فشل المزوّد: رسائل عربية بلا تسريب تقني ==');
  {
    const st = freshState();
    const env = { DB: makeDb(st), ...AI };

    setProvider(() => ok('ليس JSON أبداً'));
    const bad = await ai(env, { text: 'اختبار' });
    t('رد غير JSON ← 503 برسالة عربية', bad.status === 503 && /تعذّرت الاستجابة من خدمة التصميم/.test(bad.body.error), bad.text);
    t('لا تسريب تفاصيل تقنية', !/SyntaxError|JSON\.parse|Unexpected/.test(bad.text), bad.text);

    let n = 0;
    setProvider(() => { n++; return n === 1 ? new Response('err', { status: 500 }) : ok(READY_TXT); });
    const retried = await ai(env, { text: 'بعد 500' });
    t('500 ← إعادة محاولة واحدة تنجح', retried.status === 200 && calls.length === 2, JSON.stringify({ s: retried.status, c: calls.length }));

    setProvider(() => new Response('no', { status: 401 }));
    const denied = await ai(env, { text: 'مفتاح مرفوض' });
    t('401 من المزوّد ← بلا إعادة، 503', denied.status === 503 && calls.length === 1 && /تعذّرت الاستجابة من خدمة التصميم/.test(denied.body.error) && !/401|status|key/i.test(denied.body.error), JSON.stringify({ s: denied.status, c: calls.length }));

    let m = 0;
    setProvider(() => { m++; return m === 1 ? new Response('bad request', { status: 400 }) : ok(READY_TXT); });
    const fmt = await ai(env, { text: 'بلا response_format' });
    t('400 ← إعادة بلا response_format تنجح', fmt.status === 200 && calls.length === 2 && calls[1].body.response_format === undefined, JSON.stringify({ s: fmt.status, c: calls.length }));

    setProvider(() => { throw new TypeError('network down'); });
    const net = await ai(env, { text: 'انقطاع' });
    t('فشل شبكة ← محاولتان ثم 503 عربية', net.status === 503 && calls.length === 2 && /تعذّرت الاستجابة من خدمة التصميم/.test(net.body.error) && !/network/i.test(net.body.error), JSON.stringify({ s: net.status, c: calls.length }));
  }

  console.log('== 7) التاريخ والنص والمواصفات ==');
  {
    const st = freshState();
    const env = { DB: makeDb(st), ...AI };
    setProvider(() => ok(READY_TXT));

    const hist = [];
    for (let i = 0; i < 20; i++) hist.push({ r: 'u', t: 'بداية' + 'x'.repeat(440) + 'نهاية' + i });
    await ai(env, { text: 'أكمل', history: hist });
    const convo = calls[0].body.messages[1].content;
    const count = (convo.match(/العميل: /g) || []).length;
    t('التاريخ مقصوص إلى 8 رسائل', count <= 8, String(count));
    t('كل رسالة تاريخ مقصوصة إلى 400 حرف', !convo.includes('نهاية'), 'tail leaked');

    await ai(env, { text: 'أكمل', spec: { roomW: 6, roomH: 4, notes: 'ن'.repeat(20050) } });
    t('مواصفات تتجاوز 20KB ← تُسقط من السياق', calls[1].body.messages[1].content.includes('لا توجد'));

    await ai(env, { text: 'أكمل', spec: { roomW: 6, roomH: 4 } });
    t('مواصفات صغيرة تدخل السياق كـ JSON', calls[2].body.messages[1].content.includes('"roomW":6'));
  }

  console.log('== 8) حدّ الطلبات ==');
  {
    const st = freshState();
    const env = { DB: makeDb(st), ...AI };
    setProvider(() => ok(READY_TXT));
    let okCount = 0;
    for (let i = 0; i < 15; i++) {
      const r = await ai(env, { text: 'طلب ' + i });
      if (r.status === 200) okCount++;
    }
    t('15 طلباً تمر خلال الساعة', okCount === 15, String(okCount));
    const over = await ai(env, { text: 'الطلب السادس عشر' });
    t('الطلب 16 ← 429', over.status === 429, over.text);
    const st2 = freshState();
    const fresh = await ai({ DB: makeDb(st2), ...AI }, { text: 'طلب جديد' });
    t('حدّ مختلف لكل (توكن+عنوان) — جلسة جديدة تمر', fresh.status === 200, fresh.text);
  }

  console.log('== 9) إصلاح checkDesign: التلفاز يُحفظ ==');
  {
    const st = freshState();
    const env = { DB: makeDb(st) };
    const good = {
      walls: [{ len: 5, angle: 0 }, { len: 4, angle: 90 }, { len: 5, angle: 180 }, { len: 4, angle: 270 }],
      openings: [{ wall: 0, t: 2, w: 1.4, type: 'tv' }],
      pieces: [], cornerMode: 'deduct',
    };
    const r = await call(env, 'POST', '/api/portal/save', { design: good });
    t('حفظ تصميم فيه تلفاز ← 200 (قبل الإصلاح كان 400)', r.status === 200 && r.body.ok === true, r.text);

    const badType = Object.assign({}, good, { openings: [{ wall: 0, t: 2, w: 1, type: 'curtain' }] });
    const r2 = await call(env, 'POST', '/api/portal/save', { design: badType });
    t('نوع فتحة غير مدعوم ما زال مرفوضاً', r2.status === 400, r2.text);
  }

  console.log('== 10) حدّ کتالوج aiCatalogBrief: استعلامات منفصلة لكل فئة ==');
  {
    // 1) أكثر من 100 صنف موزعة بالتساوي — يجب أن تصل حصص الفئات (30+10+40)
    const st = freshState();
    st.items = [];
    for (let i = 0; i < 150; i++) {
      const cat = i % 3 === 0 ? 'fabric' : i % 3 === 1 ? 'foam' : 'acc';
      st.items.push({ data: JSON.stringify({ id: 'eq-' + i, name: 'متساوٍ-' + i, category: cat, active: true, updated_at: '2026-01-' + String((i % 28) + 1).padStart(2, '0') }) });
    }
    const env = { DB: makeDb(st), ...AI };
    setProvider(() => ok(READY_TXT));
    const r = await ai(env, { text: 'مجلس 6×4' });
    t('150 صنف متساوٍ: الرد 200', r.status === 200, r.text);
    const pc = calls[calls.length - 1];
    const sys = pc && pc.body.messages[0].content;
    t('150 متساوٍ: كتالوج يُرسل (≥1 اسم)', sys && /متساوٍ-\d+/.test(sys), sys && sys.slice(0, 60));

    // 2) أكثر من 100 صنف مع عدد كبير من الأصناف غير المطلوبة
    const st2 = freshState();
    st2.items = [];
    for (let i = 0; i < 200; i++) {
      if (i < 5) st2.items.push({ data: JSON.stringify({ id: 'unk-' + i, name: 'غيرمطابق-' + i, category: 'wood', active: true }) });
      else if (i < 35) st2.items.push({ data: JSON.stringify({ id: 'fab-' + i, name: 'قماش-' + i, category: 'fabric', active: true }) });
      else if (i < 45) st2.items.push({ data: JSON.stringify({ id: 'foam-' + i, name: 'إسفنج-' + i, category: 'foam', active: true }) });
      else st2.items.push({ data: JSON.stringify({ id: 'acc-' + i, name: 'إكسسوار-' + i, category: 'acc', active: true }) });
    }
    const env2 = { DB: makeDb(st2), ...AI };
    setProvider(() => ok(READY_TXT));
    const r2 = await ai(env2, { text: 'مجلس 6×4' });
    t('200 صنف (195 غير مطابق): الرد 200', r2.status === 200, r2.text);
    const pc2 = calls[calls.length - 1];
    const sys2 = pc2 && pc2.body.messages[0].content;
    t('200 صنف: قماش موجود (صنف مطابق)', sys2 && sys2.includes('قماش-'), sys2 && sys2.slice(0, 60));
    t('200 صنف: إكسسوار موجود', sys2 && sys2.includes('إكسسوار-'), sys2 && sys2.slice(0, 60));
    t('200 صنف: غيرمطابق غائب', sys2 && !sys2.includes('غيرمطابق-'), sys2 && sys2.includes('غيرمطابق-') ? 'leaked' : 'ok');

    // 3) أكثر من 100 صنف مع فئة واحدة مهيمنة
    const st3 = freshState();
    st3.items = [];
    for (let i = 0; i < 90; i++) st3.items.push({ data: JSON.stringify({ id: 'dom-f-' + i, name: 'هيمنة-قماش-' + i, category: 'fabric', active: true }) });
    for (let i = 0; i < 5; i++) st3.items.push({ data: JSON.stringify({ id: 'dom-fo-' + i, name: 'هيمنة-إسفنج-' + i, category: 'foam', active: true }) });
    for (let i = 0; i < 5; i++) st3.items.push({ data: JSON.stringify({ id: 'dom-a-' + i, name: 'هيمنة-إكسسوار-' + i, category: 'acc', active: true }) });
    const env3 = { DB: makeDb(st3), ...AI };
    setProvider(() => ok(READY_TXT));
    const r3 = await ai(env3, { text: 'مجلس 6×4' });
    t('100 صنف (90 قماش مهيمن): الرد 200', r3.status === 200, r3.text);
    const pc3 = calls[calls.length - 1];
    const sys3 = pc3 && pc3.body.messages[0].content;
    t('هيمنة: قماش موجود', sys3 && sys3.includes('هيمنة-قماش-'), sys3 && sys3.slice(0, 60));
    t('هيمنة: إسفنج موجود (5 < 10)', sys3 && sys3.includes('هيمنة-إسفنج-'), sys3 && sys3.slice(0, 60));
    t('هيمنة: إكسسوار موجود (5 < 40)', sys3 && sys3.includes('هيمنة-إكسسوار-'), sys3 && sys3.slice(0, 60));

    // 4) أصناف حديثة وأخرى قديمة — newest first (DESC)
    const st4 = freshState();
    st4.items = [
      { data: JSON.stringify({ id: 'old-f', name: 'قديم-قماش', category: 'fabric', active: true, updated_at: '2025-01-01' }) },
      { data: JSON.stringify({ id: 'new-f', name: 'حديث-قماش', category: 'fabric', active: true, updated_at: '2026-06-01' }) },
      { data: JSON.stringify({ id: 'old-a', name: 'قديم-إكسسوار', category: 'acc', active: true, updated_at: '2025-01-01' }) },
      { data: JSON.stringify({ id: 'new-a', name: 'حديث-إكسسوار', category: 'acc', active: true, updated_at: '2026-06-01' }) },
    ];
    const env4 = { DB: makeDb(st4), ...AI };
    setProvider(() => ok(READY_TXT));
    const r4 = await ai(env4, { text: 'مجلس 6×4' });
    t('recent/old: الرد 200', r4.status === 200, r4.text);
    const pc4 = calls[calls.length - 1];
    const sys4 = pc4 && pc4.body.messages[0].content;
    t('recent/old: حديث-قماش موجود', sys4 && sys4.includes('حديث-قماش'), sys4 && sys4.slice(0, 60));
    t('recent/old: حديث-إكسسوار موجود', sys4 && sys4.includes('حديث-إكسسوار'), sys4 && sys4.slice(0, 60));

    // 5) أقل من 100 صنف — جميعها تُعالَج
    const st5 = freshState();
    st5.items = [];
    for (let i = 0; i < 3; i++) {
      st5.items.push({ data: JSON.stringify({ id: 'few-' + i, name: 'قليل-' + i, category: 'fabric', active: true }) });
    }
    const env5 = { DB: makeDb(st5), ...AI };
    setProvider(() => ok(READY_TXT));
    const r5 = await ai(env5, { text: 'مجلس 6×4' });
    t('3 صنوف: الرد 200', r5.status === 200, r5.text);
    const pc5 = calls[calls.length - 1];
    const sys5 = pc5 && pc5.body.messages[0].content;
    t('3 صنوف: قليل-0 موجود', sys5 && sys5.includes('قليل-0'), sys5 && sys5.slice(0, 60));
    t('3 صنوف: قليل-2 موجود', sys5 && sys5.includes('قليل-2'), sys5 && sys5.slice(0, 60));

    // 6) 30 صنف حديث (معظمها غير نشط) + أصناف نشطة أقدم — يجب أن تظهر النشطة
    const st6 = freshState();
    st6.items = [];
    for (let i = 0; i < 30; i++) {
      st6.items.push({ data: JSON.stringify({ id: 'inactive-' + i, name: 'غيرنشط-' + i, category: 'fabric', active: false, updated_at: '2026-06-' + String(i % 28 + 1).padStart(2, '0') }) });
    }
    for (let i = 0; i < 5; i++) {
      st6.items.push({ data: JSON.stringify({ id: 'active-old-' + i, name: 'نشط-قديم-' + i, category: 'fabric', active: true, updated_at: '2025-01-' + String(i + 1).padStart(2, '0') }) });
    }
    const env6 = { DB: makeDb(st6), ...AI };
    setProvider(() => ok(READY_TXT));
    const r6 = await ai(env6, { text: 'مجلس 6×4' });
    t('30 غير نشط + 5 نشط: الرد 200', r6.status === 200, r6.text);
    const pc6 = calls[calls.length - 1];
    const sys6 = pc6 && pc6.body.messages[0].content;
    t('30 غير نشط + 5 نشط: نشط-قديم-0 موجود', sys6 && sys6.includes('نشط-قديم-0'), sys6 && sys6.slice(0, 60));
    t('30 غير نشط + 5 نشط: غيرنشط-0 غائب', sys6 && !sys6.includes('غيرنشط-0'), sys6 && sys6.includes('غيرنشط-0') ? 'leaked' : 'ok');

    // 7) أصناف بلا id — يجب استبعادها
    const st7 = freshState();
    st7.items = [
      { data: JSON.stringify({ name: 'بلا-id', category: 'fabric', active: true }) },
      { data: JSON.stringify({ id: 'valid-1', name: 'صالح-1', category: 'fabric', active: true }) },
    ];
    const env7 = { DB: makeDb(st7), ...AI };
    setProvider(() => ok(READY_TXT));
    const r7 = await ai(env7, { text: 'مجلس 6×4' });
    t('بلا id: الرد 200', r7.status === 200, r7.text);
    const pc7 = calls[calls.length - 1];
    const sys7 = pc7 && pc7.body.messages[0].content;
    t('بلا id: صالح-1 موجود', sys7 && sys7.includes('صالح-1'), sys7 && sys7.slice(0, 60));
    t('بلا id: بلا-id غائب', sys7 && !sys7.includes('بلا-id'), sys7 && sys7.includes('بلا-id') ? 'leaked' : 'ok');

    // 8) أصناف بلا name أو اسم فارغ — يجب استبعادها
    const st8 = freshState();
    st8.items = [
      { data: JSON.stringify({ id: 'no-name-1', category: 'fabric', active: true }) },
      { data: JSON.stringify({ id: 'empty-name-1', name: '', category: 'fabric', active: true }) },
      { data: JSON.stringify({ id: 'valid-2', name: 'صالح-2', category: 'fabric', active: true }) },
    ];
    const env8 = { DB: makeDb(st8), ...AI };
    setProvider(() => ok(READY_TXT));
    const r8 = await ai(env8, { text: 'مجلس 6×4' });
    t('بلا/فارغ name: الرد 200', r8.status === 200, r8.text);
    const pc8 = calls[calls.length - 1];
    const sys8 = pc8 && pc8.body.messages[0].content;
    t('بلا/فارغ name: صالح-2 موجود', sys8 && sys8.includes('صالح-2'), sys8 && sys8.slice(0, 60));
    t('بلا/فارغ name: no-name-1 غائب', sys8 && !sys8.includes('no-name-1'), sys8 && sys8.includes('no-name-1') ? 'leaked' : 'ok');

    // 9) فئة تحتوي على أكثر من حصتها — عدم تجاوز الحصص (30/10/40)
    const st9 = freshState();
    st9.items = [];
    for (let i = 0; i < 50; i++) st9.items.push({ data: JSON.stringify({ id: 'over-f-' + i, name: 'تجاوز-قماش-' + i, category: 'fabric', active: true }) });
    for (let i = 0; i < 20; i++) st9.items.push({ data: JSON.stringify({ id: 'over-fo-' + i, name: 'تجاوز-إسفنج-' + i, category: 'foam', active: true }) });
    for (let i = 0; i < 60; i++) st9.items.push({ data: JSON.stringify({ id: 'over-a-' + i, name: 'تجاوز-إكسسوار-' + i, category: 'acc', active: true }) });
    const env9 = { DB: makeDb(st9), ...AI };
    setProvider(() => ok(READY_TXT));
    const r9 = await ai(env9, { text: 'مجلس 6×4' });
    t('تجاوز الحصص: الرد 200', r9.status === 200, r9.text);
    const pc9 = calls[calls.length - 1];
    const sys9 = pc9 && pc9.body.messages[0].content;
    // Count fabric names in system prompt
    const fabCount = (sys9.match(/تجاوز-قماش-\d+/g) || []).length;
    const foamCount = (sys9.match(/تجاوز-إسفنج-\d+/g) || []).length;
    const accCount = (sys9.match(/تجاوز-إكسسوار-\d+/g) || []).length;
    t('تجاوز الحصص: قماش ≤ 30', fabCount <= 30, 'got ' + fabCount);
    t('تجاوز الحصص: إسفنج ≤ 10', foamCount <= 10, 'got ' + foamCount);
    t('تجاوز الحصص: إكسسوار ≤ 40', accCount <= 40, 'got ' + accCount);
  }

  console.log('== 11) تطابق SQL/JS: active, id, name, malformed JSON ==');
  {
    // 1) JSON غير صالح — يجب استبعاده
    const st = freshState();
    st.items = [
      { data: 'not json at all', updated_at: '2026-01-01' },
      { data: JSON.stringify({ id: 'valid-1', name: 'صالح-1', category: 'fabric', active: true }), updated_at: '2026-01-02' },
    ];
    const env = { DB: makeDb(st), ...AI };
    setProvider(() => ok(READY_TXT));
    const r = await ai(env, { text: 'مجلس 6×4' });
    t('malformed JSON: الرد 200', r.status === 200, r.text);
    const pc = calls[calls.length - 1];
    const sys = pc && pc.body.messages[0].content;
    t('malformed JSON: صالح-1 موجود', sys && sys.includes('صالح-1'), sys && sys.slice(0, 60));
    t('malformed JSON: غير صالح غائب', sys && !sys.includes('not json'), sys && sys.includes('not json') ? 'leaked' : 'ok');

    // 2) active=false — مستبعد
    const st2 = freshState();
    st2.items = [
      { data: JSON.stringify({ id: 'af-1', name: 'غير نشط', category: 'fabric', active: false }), updated_at: '2026-01-01' },
      { data: JSON.stringify({ id: 'af-2', name: 'نشط', category: 'fabric', active: true }), updated_at: '2026-01-02' },
    ];
    const env2 = { DB: makeDb(st2), ...AI };
    setProvider(() => ok(READY_TXT));
    const r2 = await ai(env2, { text: 'مجلس 6×4' });
    t('active=false: الرد 200', r2.status === 200, r2.text);
    const pc2 = calls[calls.length - 1];
    const sys2 = pc2 && pc2.body.messages[0].content;
    t('active=false: نشط موجود', sys2 && sys2.includes('نشط'), sys2 && sys2.slice(0, 60));
    t('active=false: غير نشط غائب', sys2 && !sys2.includes('غير نشط'), sys2 && sys2.includes('غير نشط') ? 'leaked' : 'ok');

    // 3) active=0 (integer) — مطابق JS: 0 === false → false → NOT excluded → included
    const st3 = freshState();
    st3.items = [
      { data: JSON.stringify({ id: 'az-1', name: 'صفر-نشط', category: 'fabric', active: 0 }), updated_at: '2026-01-01' },
    ];
    const env3 = { DB: makeDb(st3), ...AI };
    setProvider(() => ok(READY_TXT));
    const r3 = await ai(env3, { text: 'مجلس 6×4' });
    t('active=0: الرد 200', r3.status === 200, r3.text);
    const pc3 = calls[calls.length - 1];
    const sys3 = pc3 && pc3.body.messages[0].content;
    t('active=0: صفر-نشط موجود (مطابق JS)', sys3 && sys3.includes('صفر-نشط'), sys3 && sys3.slice(0, 60));

    // 4) active=true — included
    const st4 = freshState();
    st4.items = [
      { data: JSON.stringify({ id: 'at-1', name: 'true-نشط', category: 'fabric', active: true }), updated_at: '2026-01-01' },
    ];
    const env4 = { DB: makeDb(st4), ...AI };
    setProvider(() => ok(READY_TXT));
    const r4 = await ai(env4, { text: 'مجلس 6×4' });
    t('active=true: الرد 200', r4.status === 200, r4.text);
    const pc4 = calls[calls.length - 1];
    const sys4 = pc4 && pc4.body.messages[0].content;
    t('active=true: true-نشط موجود', sys4 && sys4.includes('true-نشط'), sys4 && sys4.slice(0, 60));

    // 5) active غير موجود — included (undefined === false → false → not excluded)
    const st5 = freshState();
    st5.items = [
      { data: JSON.stringify({ id: 'am-1', name: 'بلا-active', category: 'fabric' }), updated_at: '2026-01-01' },
    ];
    const env5 = { DB: makeDb(st5), ...AI };
    setProvider(() => ok(READY_TXT));
    const r5 = await ai(env5, { text: 'مجلس 6×4' });
    t('active missing: الرد 200', r5.status === 200, r5.text);
    const pc5 = calls[calls.length - 1];
    const sys5 = pc5 && pc5.body.messages[0].content;
    t('active missing: بلا-active موجود', sys5 && sys5.includes('بلا-active'), sys5 && sys5.slice(0, 60));

    // 6) id=0 (integer) — مستبعد (مطابق JS: !0 → true → excluded)
    const st6 = freshState();
    st6.items = [
      { data: JSON.stringify({ id: 0, name: 'صفر-id', category: 'fabric', active: true }), updated_at: '2026-01-01' },
      { data: JSON.stringify({ id: 'valid-id', name: 'صالح-id', category: 'fabric', active: true }), updated_at: '2026-01-02' },
    ];
    const env6 = { DB: makeDb(st6), ...AI };
    setProvider(() => ok(READY_TXT));
    const r6 = await ai(env6, { text: 'مجلس 6×4' });
    t('id=0: الرد 200', r6.status === 200, r6.text);
    const pc6 = calls[calls.length - 1];
    const sys6 = pc6 && pc6.body.messages[0].content;
    t('id=0: صالح-id موجود', sys6 && sys6.includes('صالح-id'), sys6 && sys6.slice(0, 60));
    t('id=0: صفر-id غائب', sys6 && !sys6.includes('صفر-id'), sys6 && sys6.includes('صفر-id') ? 'leaked' : 'ok');

    // 7) id='' (empty string) — مستبعد
    const st7 = freshState();
    st7.items = [
      { data: JSON.stringify({ id: '', name: 'فارغ-id', category: 'fabric', active: true }), updated_at: '2026-01-01' },
      { data: JSON.stringify({ id: 'valid-id2', name: 'صالح-id2', category: 'fabric', active: true }), updated_at: '2026-01-02' },
    ];
    const env7 = { DB: makeDb(st7), ...AI };
    setProvider(() => ok(READY_TXT));
    const r7 = await ai(env7, { text: 'مجلس 6×4' });
    t('id="": الرد 200', r7.status === 200, r7.text);
    const pc7 = calls[calls.length - 1];
    const sys7 = pc7 && pc7.body.messages[0].content;
    t('id="": صالح-id2 موجود', sys7 && sys7.includes('صالح-id2'), sys7 && sys7.slice(0, 60));
    t('id="": فارغ-id غائب', sys7 && !sys7.includes('فارغ-id'), sys7 && sys7.includes('فارغ-id') ? 'leaked' : 'ok');

    // 8) id missing — مستبعد
    const st8 = freshState();
    st8.items = [
      { data: JSON.stringify({ name: 'بلا-id', category: 'fabric', active: true }), updated_at: '2026-01-01' },
      { data: JSON.stringify({ id: 'valid-id3', name: 'صالح-id3', category: 'fabric', active: true }), updated_at: '2026-01-02' },
    ];
    const env8 = { DB: makeDb(st8), ...AI };
    setProvider(() => ok(READY_TXT));
    const r8 = await ai(env8, { text: 'مجلس 6×4' });
    t('id missing: الرد 200', r8.status === 200, r8.text);
    const pc8 = calls[calls.length - 1];
    const sys8 = pc8 && pc8.body.messages[0].content;
    t('id missing: صالح-id3 موجود', sys8 && sys8.includes('صالح-id3'), sys8 && sys8.slice(0, 60));
    t('id missing: بلا-id غائب', sys8 && !sys8.includes('بلا-id'), sys8 && sys8.includes('بلا-id') ? 'leaked' : 'ok');

    // 9) name=0 (integer) — مستبعد (مطابق JS: !0 → true → excluded)
    const st9 = freshState();
    st9.items = [
      { data: JSON.stringify({ id: 'n0-1', name: 0, category: 'fabric', active: true }), updated_at: '2026-01-01' },
      { data: JSON.stringify({ id: 'valid-n', name: 'صالح-name', category: 'fabric', active: true }), updated_at: '2026-01-02' },
    ];
    const env9 = { DB: makeDb(st9), ...AI };
    setProvider(() => ok(READY_TXT));
    const r9 = await ai(env9, { text: 'مجلس 6×4' });
    t('name=0: الرد 200', r9.status === 200, r9.text);
    const pc9 = calls[calls.length - 1];
    const sys9 = pc9 && pc9.body.messages[0].content;
    t('name=0: صالح-name موجود', sys9 && sys9.includes('صالح-name'), sys9 && sys9.slice(0, 60));
    t('name=0: 0 غائب', sys9 && !sys9.includes('"0"'), sys9 && sys9.includes('"0"') ? 'leaked' : 'ok');

    // 10) name='' (empty string) — مستبعد
    const st10 = freshState();
    st10.items = [
      { data: JSON.stringify({ id: 'ne-1', name: '', category: 'fabric', active: true }), updated_at: '2026-01-01' },
      { data: JSON.stringify({ id: 'valid-ne', name: 'صالح-ne', category: 'fabric', active: true }), updated_at: '2026-01-02' },
    ];
    const env10 = { DB: makeDb(st10), ...AI };
    setProvider(() => ok(READY_TXT));
    const r10 = await ai(env10, { text: 'مجلس 6×4' });
    t('name="": الرد 200', r10.status === 200, r10.text);
    const pc10 = calls[calls.length - 1];
    const sys10 = pc10 && pc10.body.messages[0].content;
    t('name="": صالح-ne موجود', sys10 && sys10.includes('صالح-ne'), sys10 && sys10.slice(0, 60));
    t('name="": فارغ غائب', sys10 && !sys10.includes('ne-1'), sys10 && sys10.includes('ne-1') ? 'leaked' : 'ok');

    // 11) name missing — مستبعد
    const st11 = freshState();
    st11.items = [
      { data: JSON.stringify({ id: 'nm-1', category: 'fabric', active: true }), updated_at: '2026-01-01' },
      { data: JSON.stringify({ id: 'valid-nm', name: 'صالح-nm', category: 'fabric', active: true }), updated_at: '2026-01-02' },
    ];
    const env11 = { DB: makeDb(st11), ...AI };
    setProvider(() => ok(READY_TXT));
    const r11 = await ai(env11, { text: 'مجلس 6×4' });
    t('name missing: الرد 200', r11.status === 200, r11.text);
    const pc11 = calls[calls.length - 1];
    const sys11 = pc11 && pc11.body.messages[0].content;
    t('name missing: صالح-nm موجود', sys11 && sys11.includes('صالح-nm'), sys11 && sys11.slice(0, 60));
    t('name missing: nm-1 غائب', sys11 && !sys11.includes('nm-1'), sys11 && sys11.includes('nm-1') ? 'leaked' : 'ok');

    // 12) فئة تحتوي على أكثر من حصتها — عدم تجاوز الحصص (30/10/40)
    const st12 = freshState();
    st12.items = [];
    for (let i = 0; i < 50; i++) st12.items.push({ data: JSON.stringify({ id: 'over-f-' + i, name: 'تجاوز-قماش-' + i, category: 'fabric', active: true }), updated_at: '2026-01-01' });
    for (let i = 0; i < 20; i++) st12.items.push({ data: JSON.stringify({ id: 'over-fo-' + i, name: 'تجاوز-إسفنج-' + i, category: 'foam', active: true }), updated_at: '2026-01-01' });
    for (let i = 0; i < 60; i++) st12.items.push({ data: JSON.stringify({ id: 'over-a-' + i, name: 'تجاوز-إكسسوار-' + i, category: 'acc', active: true }), updated_at: '2026-01-01' });
    const env12 = { DB: makeDb(st12), ...AI };
    setProvider(() => ok(READY_TXT));
    const r12 = await ai(env12, { text: 'مجلس 6×4' });
    t('تجاوز الحصص: الرد 200', r12.status === 200, r12.text);
    const pc12 = calls[calls.length - 1];
    const sys12 = pc12 && pc12.body.messages[0].content;
    const fabCount = (sys12.match(/تجاوز-قماش-\d+/g) || []).length;
    const foamCount = (sys12.match(/تجاوز-إسفنج-\d+/g) || []).length;
    const accCount = (sys12.match(/تجاوز-إكسسوار-\d+/g) || []).length;
    t('تجاوز الحصص: قماش ≤ 30', fabCount <= 30, 'got ' + fabCount);
    t('تجاوز الحصص: إسفنج ≤ 10', foamCount <= 10, 'got ' + foamCount);
    t('تجاوز الحصص: إكسسوار ≤ 40', accCount <= 40, 'got ' + accCount);

    // 13) التأكد من أن الأحدث من الأصناف الصالحة يظهر أولًا
    const st13 = freshState();
    st13.items = [
      { data: JSON.stringify({ id: 'old-valid', name: 'قديم-صالح', category: 'fabric', active: true }), updated_at: '2025-01-01' },
      { data: JSON.stringify({ id: 'new-valid', name: 'حديث-صالح', category: 'fabric', active: true }), updated_at: '2026-06-01' },
    ];
    const env13 = { DB: makeDb(st13), ...AI };
    setProvider(() => ok(READY_TXT));
    const r13 = await ai(env13, { text: 'مجلس 6×4' });
    t('الأحدث: الرد 200', r13.status === 200, r13.text);
    const pc13 = calls[calls.length - 1];
    const sys13 = pc13 && pc13.body.messages[0].content;
    t('الأحدث: حديث-صالح موجود', sys13 && sys13.includes('حديث-صالح'), sys13 && sys13.slice(0, 60));
  }

  console.log('== 12) PBKDF2: إنشاء وكلمة مرور وتسجيل دخول ==');
  {
    // 1) Admin creation with ADMIN_INIT_PASSWORD
    const st = freshState();
    const env = { DB: makeDb(st), ADMIN_INIT_PASSWORD: 'TestPass123!' };
    const r = await call(env, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    t('Admin creation: login succeeds', r.status === 200 && r.body.ok === true, r.text);
    t('Admin creation: mustChangePassword=true', r.body.mustChangePassword === true, r.text);
    t('Admin creation: user.username=admin', r.body.user && r.body.user.username === 'admin', r.text);
    t('Admin creation: users table has 1 user', (st.users || []).length === 1, String((st.users || []).length));

    // 2) Login with correct password
    const st2 = freshState();
    const env2 = { DB: makeDb(st2), ADMIN_INIT_PASSWORD: 'TestPass123!' };
    await call(env2, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' }); // create admin
    const r2 = await call(env2, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    t('Login correct: 200 ok', r2.status === 200 && r2.body.ok === true, r2.text);

    // 3) Login with wrong password
    const r3 = await call(env2, 'POST', '/api/login', { username: 'admin', password: 'WrongPass1!' });
    t('Login wrong: bad_credentials', r3.status === 200 && r3.body.ok === false && r3.body.error === 'bad_credentials', r3.text);

    // 4) DEFAULT_ITER is fixed at 100000 (no env var configurability)
    const st4 = freshState();
    const env4 = { DB: makeDb(st4), ADMIN_INIT_PASSWORD: 'TestPass123!' };
    const r4 = await call(env4, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    t('DEFAULT_ITER=100000: login succeeds', r4.status === 200 && r4.body.ok === true, r4.text);
    const hash4 = st4.users[0].password_hash;
    t('DEFAULT_ITER=100000: hash uses 100000 iter', hash4.split('$')[1] === '100000', hash4.split('$')[1]);
    // Even if PBKDF2_ITER is set, it is ignored (fixed at 100000)
    const st4b = freshState();
    const env4b = { DB: makeDb(st4b), ADMIN_INIT_PASSWORD: 'TestPass123!', PBKDF2_ITER: '50000' };
    const r4b = await call(env4b, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    t('PBKDF2_ITER ignored: login succeeds', r4b.status === 200 && r4b.body.ok === true, r4b.text);
    const hash4b = st4b.users[0].password_hash;
    t('PBKDF2_ITER ignored: hash still uses 100000', hash4b.split('$')[1] === '100000', hash4b.split('$')[1]);

    // 5) Old hashes (20000, 100000, 210000) — verify behavior
    // Helper: compute a real PBKDF2 hash with given iterations using Web Crypto API
    async function computeHash(password, iterations) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
      const hash = new Uint8Array(bits);
      const b64 = (buf) => Buffer.from(buf).toString('base64');
      return 'pbkdf2$' + iterations + '$' + b64(salt) + '$' + b64(hash);
    }

    // 20000-iter hash: verifyPassword uses stored iter (20000 <= 100000) → should work
    const st5 = freshState();
    const env5 = { DB: makeDb(st5), ADMIN_INIT_PASSWORD: 'TestPass123!' };
    await call(env5, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    const u5 = st5.users[0];
    u5.password_hash = await computeHash('TestPass123!', 20000);
    const r5 = await call(env5, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    t('Old hash 20000: login succeeds (iter <= 100000)', r5.status === 200 && r5.body.ok === true, r5.text);

    // 100000-iter hash: verifyPassword uses stored iter (100000) → should work
    const st5c = freshState();
    const env5c = { DB: makeDb(st5c), ADMIN_INIT_PASSWORD: 'TestPass123!' };
    await call(env5c, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    const u5c = st5c.users[0];
    u5c.password_hash = await computeHash('TestPass123!', 100000);
    const r5c = await call(env5c, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    t('Old hash 100000: login succeeds', r5c.status === 200 && r5c.body.ok === true, r5c.text);

    // 210000-iter hash: verifyPassword returns false (iter > 100000) → password_needs_reset
    const st5b = freshState();
    const env5b = { DB: makeDb(st5b), ADMIN_INIT_PASSWORD: 'TestPass123!' };
    await call(env5b, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    const u5b = st5b.users[0];
    u5b.password_hash = await computeHash('TestPass123!', 210000);
    const r5b = await call(env5b, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    t('Old hash 210000: login fails (iter > 100000)', r5b.status === 200 && r5b.body.ok === false, r5b.text);
    t('Old hash 210000: error is password_needs_reset', r5b.body.error === 'password_needs_reset', r5b.text);

    // Upgrade: 20000-iter hash upgraded to 100000 after login
    const st7 = freshState();
    const env7 = { DB: makeDb(st7), ADMIN_INIT_PASSWORD: 'TestPass123!' };
    await call(env7, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    const u7 = st7.users[0];
    u7.password_hash = await computeHash('TestPass123!', 20000);
    const r7 = await call(env7, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    t('Upgrade: login succeeds', r7.status === 200 && r7.body.ok === true, r7.text);
    const hashAfter7 = st7.users[0].password_hash;
    const iterAfter7 = parseInt(hashAfter7.split('$')[1]);
    t('Upgrade: upgraded to 100000', iterAfter7 === 100000, String(iterAfter7));

    // 6) No data change on failed verification
    const st6 = freshState();
    const env6 = { DB: makeDb(st6), ADMIN_INIT_PASSWORD: 'TestPass123!' };
    await call(env6, 'POST', '/api/login', { username: 'admin', password: 'TestPass123!' });
    const hashBefore = st6.users[0].password_hash;
    // Failed login
    await call(env6, 'POST', '/api/login', { username: 'admin', password: 'WrongPass!' });
    const hashAfter = st6.users[0].password_hash;
    t('Failed login: password_hash unchanged', hashBefore === hashAfter, 'hash changed');
  }

  console.log('== 13) Cloudflare Workers AI (مجاني بلا مفتاح ولا اشتراك) ==');
  {
    /* ربط env.AI وهمي يسجّل كل نداء: النموذج والمدخلات */
    const mkAI = (fn) => { const runs = []; return { runs, run: async (model, input) => { runs.push({ model, input }); return fn(model, input, runs.length); } }; };
    setProvider(() => { throw new Error('لا يجوز نداء مزوّد خارجي'); });
    let st = freshState();
    let AIb = mkAI(() => ({ response: READY_TXT }));
    const s1 = await call({ DB: makeDb(st), AI: AIb }, 'GET', '/api/portal/settings');
    t('WAI: البوت مفعّل بربط AI وحده (بلا AI_API_KEY)', s1.status === 200 && s1.body.settings.aiDesign.enabled === true, s1.text);

    const r1 = await ai({ DB: makeDb(st), AI: AIb }, { text: 'مجلس 6×4 بباب واحد' });
    t('WAI: طلب ناجح عبر Workers AI', r1.status === 200 && r1.body.status === 'ready', r1.text);
    t('WAI: النموذج الأول متعدد اللغات وبوضع JSON', AIb.runs[0] && AIb.runs[0].model === '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
      && AIb.runs[0].input.response_format && AIb.runs[0].input.response_format.type === 'json_object', JSON.stringify(AIb.runs[0] && AIb.runs[0].model));
    t('WAI: رسالة النظام + رسالة العميل فقط', AIb.runs[0].input.messages.length === 2 && AIb.runs[0].input.messages[0].role === 'system' && /مجلس 6×4/.test(AIb.runs[0].input.messages[1].content));
    t('WAI: لا نداء لأي مزوّد خارجي', calls.length === 0, String(calls.length));

    AIb = mkAI(() => ({ response: READY }));   // بعض النماذج تعيد كائناً جاهزاً في وضع JSON
    const r2 = await ai({ DB: makeDb(freshState()), AI: AIb }, { text: 'مجلس' });
    t('WAI: رد كائن JSON مقبول', r2.status === 200 && r2.body.status === 'ready', r2.text);

    AIb = mkAI((m, input) => { if (input.response_format) throw new Error('json mode unsupported'); return { response: READY_TXT }; });
    const r3 = await ai({ DB: makeDb(freshState()), AI: AIb }, { text: 'مجلس' });
    t('WAI: فشل وضع JSON ← إعادة بلا response_format تنجح', r3.status === 200 && AIb.runs.length === 2 && AIb.runs[1].input.response_format === undefined, JSON.stringify({ s: r3.status, n: AIb.runs.length }));

    AIb = mkAI((m) => { if (/70b/.test(m)) throw new Error('capacity'); return { response: READY_TXT }; });
    const r4 = await ai({ DB: makeDb(freshState()), AI: AIb }, { text: 'مجلس' });
    t('WAI: تعذّر النموذج الأول ← البديل الأخف ينجح', r4.status === 200 && AIb.runs.some((x) => /8b/.test(x.model)), JSON.stringify(AIb.runs.map((x) => x.model)));

    AIb = mkAI(() => { throw new Error('daily neuron quota exceeded 429'); });
    warns.length = 0;
    const r5 = await ai({ DB: makeDb(freshState()), AI: AIb }, { text: 'مجلس' });
    t('WAI: نفاد الحصة اليومية ← 503 برسالة عربية بلا تفاصيل تقنية', r5.status === 503 && /تعذّرت الاستجابة من خدمة التصميم/.test(r5.body.error) && !/quota|neuron|429/i.test(r5.body.error), r5.text);
    t('WAI: سبب الفشل في السجل فقط (quota)', warns.some((w) => /workers-ai quota/.test(w)), warns.join(' | '));

    AIb = mkAI(() => ({ response: 'ليس JSON' }));
    const r6 = await ai({ DB: makeDb(freshState()), AI: AIb }, { text: 'مجلس' });
    t('WAI: رد غير JSON ← 503 عربية', r6.status === 503, r6.text);

    AIb = mkAI(() => ({ response: READY_TXT }));
    setProvider(() => ok(READY_TXT));
    const r7 = await ai({ DB: makeDb(freshState()), AI: AIb, ...AI }, { text: 'مجلس' });
    t('WAI: مع AI_API_KEY يُستعمل المزوّد الخارجي لا Workers AI', r7.status === 200 && calls.length === 1 && AIb.runs.length === 0, JSON.stringify({ ext: calls.length, wai: AIb.runs.length }));

    st = freshState();
    st.settings = { aiDesignEnabled: false };
    AIb = mkAI(() => ({ response: READY_TXT }));
    const envOff = { DB: makeDb(st), AI: AIb };
    const s8 = await call(envOff, 'GET', '/api/portal/settings');
    const r8 = await ai(envOff, { text: 'مجلس' });
    t('WAI: إيقاف المحل للبوت يبقى نافذاً', (s8.body.settings.aiDesign.enabled === false) && r8.status === 503 && AIb.runs.length === 0, JSON.stringify({ en: s8.body.settings.aiDesign, s: r8.status }));

    const r9 = await call({ DB: makeDb(freshState()) }, 'GET', '/api/portal/settings');
    t('WAI: بلا مفتاح ولا ربط ← معطّل', r9.body.settings.aiDesign.enabled === false, r9.text);
  }

  console.log('== 14) الحوار: إجابات متعددة، دمج المواصفات، نهاية الأسئلة ==');
  {
    const env = { get DB() { return makeDb(freshState()); }, ...AI };   // قاعدة جديدة لكل طلب (لا يتدخل حد المعدل)
    const reply = (o) => ok(JSON.stringify(Object.assign({ status: 'need_answers', note: '', questions: [], assumptions: [], issues: [], spec: null }, o)));
    const lastUser = () => calls[calls.length - 1].body.messages[1].content;

    setProvider(() => reply({}));
    await ai(env, { text: 'ثالث', history: [{ r: 'u', t: 'أبي مجلس' }, { r: 'b', t: 'كم المقاس؟' }] });
    t('سجل المحادثة: كلام العميل باسم العميل والبوت باسم المساعد', /العميل: أبي مجلس/.test(lastUser()) && /المساعد: كم المقاس؟/.test(lastUser()), lastUser().slice(0, 300));
    t('رسالة النظام تطلب اعتماد كل الإجابات', /كل الإجابات/.test(calls[calls.length - 1].body.messages[0].content));

    // نموذج نسي ما سبق ← لا تضيع الإجابات السابقة
    setProvider(() => reply({ spec: { seating: 'floor' } }));
    let r = await ai(env, { text: 'نوع الجلسة: أرضي', spec: { roomW: 6, roomH: 4, door: { wall: 1, w: 1 } }, history: [{ r: 'b', t: 'سؤال' }] });
    t('الدمج: المقاس والباب السابقان باقيان مع الإجابة الجديدة', r.body.spec && r.body.spec.roomW === 6 && r.body.spec.door && r.body.spec.door.wall === 1 && r.body.spec.seating === 'floor', JSON.stringify(r.body.spec));
    // null = حذف
    setProvider(() => reply({ status: 'ready', spec: { tv: null } }));
    r = await ai(env, { text: 'شيل التلفزيون', spec: { roomW: 6, roomH: 4, tv: { wall: 2, w: 1.5 } } });
    t('الدمج: null يحذف العنصر', r.body.spec && !r.body.spec.tv && r.body.spec.roomW === 6, JSON.stringify(r.body.spec));

    // مقاس مكتوب صراحةً يغلب تخمين النموذج
    const cases = [['مجلس 6×4', 6, 4], ['أبغى ٥ × ٤ جلسة أرضية', 5, 4], ['غرفة 7 في 5', 7, 5], ['طولها 7.5 متر وعرضها 4', 7.5, 4], ['المقاس: 5 × 4', 5, 4], ['6x3.5', 6, 3.5]];
    for (const [txt, w, h] of cases) {
      setProvider(() => reply({ status: 'ready', spec: { roomW: 3, roomH: 3 } }));
      r = await ai(env, { text: txt });
      t('قراءة المقاس من «' + txt + '»', r.body.spec && r.body.spec.roomW === w && r.body.spec.roomH === h, JSON.stringify(r.body.spec));
    }
    setProvider(() => reply({ status: 'ready', spec: { roomW: 4, roomH: 6 } }));
    r = await ai(env, { text: 'مجلس 6×4' });
    t('المقاس المعكوس من النموذج لا يُستبدل', r.body.spec.roomW === 4 && r.body.spec.roomH === 6, JSON.stringify(r.body.spec));
    setProvider(() => reply({ spec: {} , questions: [{ q: 'عدد الأبواب؟', options: ['1', '2'] }] }));
    r = await ai(env, { text: 'عندي 2 في الجدار' });
    t('لا يخترع مقاساً من أرقام عابرة', !(r.body.spec && r.body.spec.roomW), JSON.stringify(r.body.spec));
    // نوع الجلسة المذكور صراحةً
    setProvider(() => reply({ status: 'ready', spec: { roomW: 5, roomH: 4 } }));
    r = await ai(env, { text: 'جلسة عربية 5×4' });
    t('نوع الجلسة المكتوب يُعتمد إن نسيه النموذج', r.body.spec.seating === 'arabic', JSON.stringify(r.body.spec));

    setProvider(() => reply({ status: 'ready', spec: { roomW: 5, roomH: 4, seating: 'arabic' } }));
    r = await ai(env, { text: 'أبغى مجلس ٥×٤ جلسة أرضية' });
    t('«جلسة أرضية» المكتوبة تغلب تخمين النموذج (عربي)', r.body.spec.seating === 'floor', JSON.stringify(r.body.spec));
    setProvider(() => reply({ questions: [{ q: 'ما هو مقاس الغرفة؟', options: ['6 في 4', '8 في 5'] }] }));
    r = await ai(env, { text: 'أبي أصمم مجلس' });
    t('طلب مبهم ← أسئلة المقاس والجلسة والباب معاً في جولة واحدة', r.body.questions.length === 3 && /جلس/.test(r.body.questions[1].q) && /باب/.test(r.body.questions[2].q), JSON.stringify(r.body.questions.map((q) => q.q)));
    setProvider(() => reply({ status: 'ready', spec: { roomW: 6, roomH: 4, tv: { wall: 0, w: 1.5 }, sofaWalls: [0, 2, 3] } }));
    r = await ai(env, { text: 'تلفاز مقابل الكنب' });
    t('جدار التلفاز يُستبعد من جدران الجلسة', JSON.stringify(r.body.spec.sofaWalls) === '[2,3]', JSON.stringify(r.body.spec));
    setProvider(() => reply({ spec: { roomW: 5, roomH: 4, seating: 'floor', door: { wall: 3 } }, questions: [{ q: 'أين الباب بالضبط؟', options: ['المنتصف', 'الزاوية'] }] }));
    r = await ai(env, { text: 'مجلس ٥×٤ جلسة أرضية وباب على اليسار' });
    t('الأساسيات الثلاث معروفة ← جاهز بلا أسئلة ثانوية', r.body.status === 'ready' && !r.body.questions.length, JSON.stringify({ s: r.body.status, q: r.body.questions }));
    // نهاية واضحة: بعد جولتي أسئلة ومع معرفة المقاس ← جاهز
    const Q3 = [{ q: 'لون القماش؟', options: ['بني', 'بيج'] }];
    setProvider(() => reply({ spec: { roomW: 6, roomH: 4 }, questions: Q3 }));
    r = await ai(env, { text: 'أكمل', history: [{ r: 'b', t: 'س1' }, { r: 'u', t: 'ج1' }, { r: 'b', t: 'س2' }] });
    t('بعد جولتين من الأسئلة والمقاس معروف ← ready بلا أسئلة', r.body.status === 'ready' && !r.body.questions.length, JSON.stringify({ s: r.body.status, q: r.body.questions.length }));
    t('…مع افتراض واضح للعميل', r.body.assumptions.some((a) => /خيارات شائعة/.test(a)), JSON.stringify(r.body.assumptions));
    r = await ai(env, { text: 'أكمل', history: [{ r: 'b', t: 'س1' }] });
    t('جولة أولى: الأسئلة تبقى', r.body.status === 'need_answers' && r.body.questions.length === 1 && r.body.progress.canCreate === true, JSON.stringify(r.body.progress));
    setProvider(() => reply({ spec: { roomW: 6, roomH: 4 } }));
    r = await ai(env, { text: 'أكمل' });
    t('need_answers بلا أسئلة والمقاس معروف ← ready', r.body.status === 'ready', r.body.status);
    // بلا مقاس: لا ready أبداً، وسؤال المقاس أولاً
    setProvider(() => reply({ status: 'ready', spec: { seating: 'sofa' } }));
    r = await ai(env, { text: 'كنب', history: [{ r: 'b', t: 'a' }, { r: 'b', t: 'b' }, { r: 'b', t: 'c' }] });
    t('بلا مقاس ← need_answers مع سؤال المقاس بخيارات', r.body.status === 'need_answers' && /مقاس/.test(r.body.questions[0].q) && r.body.questions[0].options.length >= 3, JSON.stringify(r.body.questions));
    t('progress: الناقص هو المقاس والباب', JSON.stringify(r.body.progress.missing) === JSON.stringify(['size', 'door']) && r.body.progress.canCreate === false, JSON.stringify(r.body.progress));
    // multi
    setProvider(() => reply({ questions: [{ q: 'الإكسسوارات؟', options: ['طاولة', 'مركى'], multi: true }, { q: 'المقاس؟', options: ['5×4'] }] }));
    r = await ai(env, { text: 'أبي مجلس' });
    t('السؤال متعدد الإجابات يحمل multi:true والآخر false', r.body.questions[0].multi === true && r.body.questions[1].multi === false, JSON.stringify(r.body.questions));
    // invalid يبقى كما هو بلا أسئلة
    setProvider(() => reply({ status: 'invalid', questions: [{ q: 'x', options: [] }] }));
    r = await ai(env, { text: 'كم سعر الذهب' });
    t('طلب خارج الموضوع ← invalid بلا أسئلة', r.body.status === 'invalid' && !r.body.questions.length, JSON.stringify(r.body));
    // إجابات متعددة في رسالة واحدة تصل كاملة للنموذج
    setProvider(() => reply({}));
    await ai(env, { text: 'كم مقاس الغرفة: 6 × 4\nما نوع الجلسة: جلسة عربية\nأين مكان الباب: الجدار الأيمن' });
    t('كل الإجابات تصل للنموذج في رسالة واحدة', /6 × 4/.test(lastUser()) && /جلسة عربية/.test(lastUser()) && /الجدار الأيمن/.test(lastUser()), lastUser().slice(-200));
  }
} finally {
  console.warn = origWarn;
  globalThis.fetch = realFetch;
}

console.log('');
console.log('PASS=' + pass + ' FAIL=' + fail);
if (fail) console.log(lines.filter((l) => l.startsWith('FAIL')).join('\n'));
process.exit(fail ? 1 : 0);
