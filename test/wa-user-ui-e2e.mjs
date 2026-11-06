/* رقم واتساب في نافذة تعديل المستخدم — في التطبيق الحقيقي:
   المالك يضيف رقماً لموظف ← يظهر في «إشعارات واتساب ← المستلمون» بشارة «مستخدم» ← يُختار في نافذة الإرسال.
   الموظف بلا صلاحية لا يرى القسم. node test/wa-user-ui-e2e.mjs [--save <مجلد>] */
import fs from 'node:fs';
import path from 'node:path';
import { startApp, sleep } from './_app-harness.mjs';

const saveDir = process.argv.includes('--save') ? process.argv[process.argv.indexOf('--save') + 1] : '';
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x).slice(0, 400) : '')); } };
const shot = async (page, name) => { if (saveDir) { fs.mkdirSync(saveDir, { recursive: true }); await page.screenshot({ path: path.join(saveDir, name + '.png') }); } };

const app = await startApp([['1', 'owner', 'فواز', 'admin'], ['2', 'staff1', 'سارة', 'staff']], 'wauser');
const go = (page, p) => page.evaluate((n) => (document.querySelector(`#mainNav button[data-page="${n}"]`) || document.querySelector(`.page-tabs [data-goto="${n}"]`)).click(), p);
const openEdit = async (page, id) => { await go(page, 'users'); await sleep(900); await page.evaluate((i) => document.querySelector(`#usersTable [data-edit="${i}"]`).click(), id); await sleep(500); };

const P = await app.login('owner');
await openEdit(P, '2');
ok(await P.evaluate(() => !!document.getElementById('uWaSec') && document.querySelectorAll('[data-uwaev]').length === 4), 'form: قسم «تنبيهات واتساب» برقم وأربعة تنبيهات للمالك');
// رقم غير صحيح ← رسالة واضحة ولا حفظ
await P.evaluate(() => { document.getElementById('uWaPhone').value = '12345'; document.getElementById('uSave').click(); }); await sleep(400);
const e1 = await P.evaluate(() => document.getElementById('uErr').textContent);
ok(/رقم واتساب/.test(e1), 'form: رقم خاطئ يُرفض برسالة واضحة', e1);
ok(Number(app.DB.db.prepare('SELECT COUNT(*) n FROM wa_recipients').get().n) === 0, 'form: لم يُحفظ شيء');
// تنبيهات بلا رقم
await P.evaluate(() => { document.getElementById('uWaPhone').value = ''; document.querySelector('[data-uwaev="order_created"]').checked = true; document.getElementById('uSave').click(); }); await sleep(400);
ok(/اكتب رقم واتساب/.test(await P.evaluate(() => document.getElementById('uErr').textContent)), 'form: اختيار تنبيه بلا رقم يُنبَّه عليه');
// الحفظ الصحيح
await P.evaluate(() => { document.getElementById('uWaPhone').value = '0551234567'; document.querySelector('[data-uwaev="payment_received"]').checked = true; });
await shot(P, 'user-form-wa');
await P.evaluate(() => document.getElementById('uSave').click()); await sleep(1200);
ok(await P.evaluate(() => document.getElementById('modal').hidden), 'save: النافذة تُغلق بعد الحفظ');
const row = app.DB.db.prepare('SELECT r.phone, r.name FROM wa_recipient_users l JOIN wa_recipients r ON r.id = l.recipient_id WHERE l.user_id = ?').get('2');
ok(row && row.phone === '966551234567' && row.name === 'سارة', 'save: المستلم المرتبط محفوظ في القاعدة', row);
// إعادة الفتح تعرض الرقم والتنبيهات
await openEdit(P, '2');
const pre = await P.evaluate(() => ({ v: document.getElementById('uWaPhone').value, ev: [...document.querySelectorAll('[data-uwaev]:checked')].map((c) => c.dataset.uwaev).sort().join(',') }));
ok(/55 123 4567/.test(pre.v) && pre.ev === 'order_created,payment_received', 'edit: الرقم والتنبيهات تظهر عند إعادة الفتح', pre);
await P.evaluate(() => document.getElementById('modalClose').click()); await sleep(300);
// «إشعارات واتساب ← المستلمون»
await go(P, 'whatsapp'); await sleep(1200);
await P.evaluate(() => document.querySelector('#waTabs [data-watab="recipients"]').click()); await sleep(600);
const rc = await P.evaluate(() => [...document.querySelectorAll('#waRcTable tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()));
ok(rc.length === 1 && /سارة/.test(rc[0]) && /مستخدم/.test(rc[0]) && /طلب جديد|تسجيل طلب جديد/.test(rc[0]), 'wa: الموظف في «المستلمين» بشارة «مستخدم» وتنبيهاته', rc);
await shot(P, 'wa-recipients-user');
// نافذة الإرسال: الرقم متاح ومختار تلقائياً لتنبيه طلب جديد
await P.evaluate(() => document.querySelector('#waTabs [data-watab="send"]').click()); await sleep(400);
const opened = await P.evaluate(() => { const b = document.getElementById('waNewSend'); if (!b || b.hidden) return false; b.click(); return true; });
await sleep(700);
if (opened) {
  await P.evaluate(() => { const s = document.querySelector('#modal select'); if (s && [...s.options].some((o) => o.value === 'order_created')) { s.value = 'order_created'; s.dispatchEvent(new Event('change', { bubbles: true })); } }); await sleep(400);
  const cl = await P.evaluate(() => [...document.querySelectorAll('[data-wacr]')].map((c) => ({ on: c.checked, t: c.closest('label').textContent.replace(/\s+/g, ' ').trim() })));
  ok(cl.some((c) => /سارة/.test(c.t) && c.on), 'send: رقم الموظف متاح ومختار تلقائياً في نافذة الإرسال', cl);
  await P.evaluate(() => document.getElementById('modalClose').click()); await sleep(300);
} else ok(false, 'send: زر «تنبيه جديد» متاح للمالك');
// مسح الرقم يزيله
await openEdit(P, '2');
await P.evaluate(() => { document.getElementById('uWaPhone').value = ''; document.querySelectorAll('[data-uwaev]').forEach((c) => { c.checked = false; }); document.getElementById('uSave').click(); }); await sleep(1200);
ok(Number(app.DB.db.prepare('SELECT COUNT(*) n FROM wa_recipients').get().n) === 0, 'clear: مسح الرقم يزيل الموظف من المستلمين');

// الجوال: القسم لا يسبب تمريراً أفقياً
const PM = await app.login('owner', { width: 375, height: 812, isMobile: true, hasTouch: true });
await openEdit(PM, '2');
const m = await PM.evaluate(() => { const c = document.querySelector('#modal .modal-card'); return { sw: c.scrollWidth, cw: c.clientWidth, sec: !!document.getElementById('uWaSec') }; });
ok(m.sec && m.sw <= m.cw + 1, 'mobile: القسم ظاهر بلا تمرير أفقي في النافذة', m);
await shot(PM, 'user-form-wa-mobile');

ok(!app.errs.length, 'js: لا أخطاء JavaScript', app.errs);
await app.close();
console.log(`\n=== wa-user-ui: PASS=${pass}  FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
