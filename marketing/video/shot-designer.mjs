// لقطة حقيقية من مصمم المجالس لمشهد «صمّم مجلسك بنفسك»: أصناف الكتالوج العام، غرفة 6×5، «فرش الكل»، طاولة وسط
import { startApp, sleep } from '../../test/_app-harness.mjs';
const out = process.argv[2];
const app = await startApp([['1', 'owner', 'فواز', 'admin']], 'video-shot');
const T = new Date().toISOString();
const items = [
  { id: 'w1', name: 'كنب - خشب سويدي', category: 'wood', unit: 'm', price: 0, color: '#a28467', active: true },
  { id: 'f1', name: 'قماش - ابو طير', category: 'fabric', unit: 'm', price: 0, color: '#c93140', active: true },
  { id: 'm1', name: 'اسفنج - الراجحي', category: 'foam', unit: 'm', price: 0, color: '#8b5a2b', active: true },
  { id: 'acc-balot', name: 'طاولة بلوت', category: 'acc', unit: 'pc', price: 350, color: '#6d4c41', w: 0.9, h: 0.6, shape: 'rect', active: true },
];
for (const it of items) app.DB.db.prepare('INSERT OR REPLACE INTO items (id, data, updated_at) VALUES (?,?,?)').run(it.id, JSON.stringify(it), T);
try {
  const p = await app.login('owner', { width: 430, height: 932, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await p.evaluate(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } };
    set('#roomW', '6'); set('#roomL', '5');
  });
  await sleep(500);
  await p.evaluate(() => {
    for (const [sel, v] of [['#sofaWoodSel', 'w1'], ['#sofaFabricSel', 'f1'], ['#sofaFoamSel', 'm1']]) {
      const el = document.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  });
  await sleep(300);
  await p.evaluate(() => document.getElementById('tbFillAll').click());
  await sleep(1000);
  const n = await p.evaluate(() => (window.MajlisApp.designer.getState().pieces || []).length);
  console.log('pieces', n);
  // صورة المخطط من لوحة الرسم نفسها (بلا أشرطة الواجهة)
  const url = await p.evaluate(() => window.MajlisApp.designer.toImage ? window.MajlisApp.designer.toImage(1400, 1400) : document.getElementById('designCanvas').toDataURL('image/png'));
  const fs = await import('node:fs');
  fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
  console.log('ok');
} finally { await app.close(); }
