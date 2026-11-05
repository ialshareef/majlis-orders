/* تنزيلات متصفح الاختبار (PDF/Excel/CSV التي تنزّلها الاختبارات) تذهب لمجلد مستقل
   بدل مجلد التنزيلات الشخصي: ‎Documents\majlis-test-downloads (أو MAJLIS_TEST_DOWNLOADS).
   - TEST_DL يُمرَّر لـ puppeteer.launch({ downloadBehavior }) فيغطي السياق الافتراضي
   - routeDownloads(browser) يجعل كل createBrowserContext لاحق يستعمل المجلد نفسه */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_DOWNLOADS = process.env.MAJLIS_TEST_DOWNLOADS
  || path.join(os.homedir(), 'Documents', 'majlis-test-downloads');
fs.mkdirSync(TEST_DOWNLOADS, { recursive: true });

export const TEST_DL = { policy: 'allow', downloadPath: TEST_DOWNLOADS };

export function routeDownloads(browser) {
  const orig = browser.createBrowserContext.bind(browser);
  browser.createBrowserContext = (opts = {}) => orig({ downloadBehavior: TEST_DL, ...opts });
  return TEST_DOWNLOADS;
}
