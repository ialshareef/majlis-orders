/* تشغيل التطبيق الحقيقي (index.html + worker/worker.js) على SQLite مؤقتة ومتصفح بلا واجهة — لاختبارات الواجهة.
   لا اتصال بأي خدمة خارجية ولا بقاعدة الإنتاج. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from './_d1-sqlite.mjs';
import { routeDownloads, TEST_DL } from './_downloads.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, '..');
export const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PW = 'test1234';

/** users: [[id, username, name, role]] — المستخدم الأول مالك النظام */
export async function startApp(users, tag) {
  const mod = await import('data:text/javascript;base64,' + Buffer.from(read('worker/worker.js') + '\n// ' + (tag || 'harness') + Date.now(), 'utf8').toString('base64'));
  const worker = mod.default;
  const H = (() => { const s = crypto.randomBytes(16); return `pbkdf2$100000$${s.toString('base64')}$${crypto.pbkdf2Sync(PW, s, 100000, 32, 'sha256').toString('base64')}`; })();
  const DB = new SqliteD1();
  DB.exec(read('worker/schema.sql'));
  DB.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0');
  const T0 = new Date(Date.now() - 864e5).toISOString();
  for (const [id, un, name, role] of users) DB.db.prepare('INSERT INTO users (id, username, name, password_hash, role, active, created_at, must_change_password) VALUES (?,?,?,?,?,1,?,0)').run(id, un, name, H, role, T0);
  const env = { DB, OWNER_USER_ID: users[0][0], ALLOWED_ORIGIN: 'http://127.0.0.1' };
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  let origin = '';
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/api/')) {
        const r = await worker.fetch(new Request(origin + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')), body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
        res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v)); res.end(Buffer.from(await r.arrayBuffer())); return;
      }
      if (u.pathname === '/config.js') { res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(`window.APP_CONFIG = { apiUrl: ${JSON.stringify(origin)} };`); return; }
      if (u.pathname === '/sw.js') { res.writeHead(404); res.end(); return; }
      let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
      const file = path.join(root, p);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + server.address().port; env.ALLOWED_ORIGIN = origin;
  const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
  if (!CHROME) { console.log('لا يوجد Chrome/Edge — تخطّي'); server.close(); process.exit(2); }
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ downloadBehavior: TEST_DL, executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  routeDownloads(browser);
  const errs = [];
  /** opts.keepTour: لا يُخفى الشرح الأول (لاختبار الجولة نفسها) */
  async function login(un, vp = { width: 1366, height: 900 }, opts = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errs.push(un + ': ' + String(e.message).split('\n')[0]));
    await page.setViewport(vp);
    await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginUser', { visible: true });
    if (!opts.keepTour) await page.evaluate(() => { try { ['staff', 'mandoub'].forEach((k) => { localStorage.setItem('mj_help_seen_' + k + '@v2', '1'); localStorage.setItem('mj_help_seen_' + k, '1'); }); } catch (_) { /* */ } });
    await page.type('#loginUser', un); await page.type('#loginPass', PW);
    await page.click('#loginForm button[type=submit]');
    await page.waitForFunction(() => !document.getElementById('app').hidden, { timeout: 30000 });
    await sleep(opts.keepTour ? 600 : 2500);
    if (!opts.keepTour) await page.evaluate(() => { const m = document.getElementById('modal'); if (m && !m.hidden) document.getElementById('modalClose').click(); });
    return page;
  }
  const close = async () => { await browser.close(); server.close(); };
  return { env, DB, origin, browser, login, errs, close };
}
