// يصوّر مشاهد scenes.html إطاراً إطاراً (render(t)) ثم يرمّزها MP4 بـ ffmpeg (H.264، 30 إطاراً/ث)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const [repo, vdir, outMp4, fpsArg, stillsArg] = process.argv.slice(2);
const FPS = Number(fpsArg || 30);
const MIME = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = p.startsWith('/v/') ? path.join(vdir, p.slice(3)) : p === '/' ? path.join(vdir, 'scenes.html') : path.join(repo, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  const fontOk = await page.evaluate(() => document.fonts.check('700 40px "IBM Plex Sans Arabic"'));
  const dur = await page.evaluate(() => window.DURATION);
  console.log('font', fontOk, 'duration', dur);
  if (stillsArg) {   // لقطات ثابتة للمراجعة فقط
    for (const t of stillsArg.split(',').map(Number)) {
      await page.evaluate((x) => window.render(x), t);
      await page.screenshot({ path: path.join(vdir, `still-${t}.jpg`), type: 'jpeg', quality: 80 });
    }
    await b.close(); server.close(); return;
  }
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart',
    '-metadata', 'title=أصالة نجد — فيديو تعريفي', outMp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const N = Math.round(dur * FPS);
  for (let i = 0; i < N; i++) {
    await page.evaluate((x) => window.render(x), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log('frame', i, '/', N);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await b.close(); server.close();
  console.log('done', outMp4);
})().catch((e) => { console.error(e); process.exit(1); });
