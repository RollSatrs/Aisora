'use strict';

const fs = require('node:fs/promises');
const { chromium } = require('playwright');

const START_URL = 'https://ais.semuniver.kz/login.php';
const OUT_DIR = 'artifacts/ais-public-check';

(async () => {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'ru-RU',
      timezoneId: 'Asia/Almaty',
    });
    const page = await context.newPage();

    console.log('Step 1: Browser launched (new empty session; no credentials or cookies).');
    console.log('Step 2: Opening:', START_URL);
    let status = null;
    let navigationError = null;
    try {
      const response = await page.goto(START_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      status = response?.status() ?? null;
    } catch (error) {
      navigationError = error instanceof Error ? error.name : 'UnknownError';
    }

    // For safety, store screenshots ONLY if the browser is still on the
    // unauthenticated public page AND has no password field values.
    let locationCategory = 'unknown';
    try {
      const url = new URL(page.url());
      locationCategory = url.hostname === 'ais.semuniver.kz'
        ? `ais.semuniver.kz${url.pathname}`
        : `external-origin:${url.hostname}`;
    } catch { /* about:blank or malformed */ }

    const structure = await page.evaluate(() => ({
      loginFieldCount: document.querySelectorAll('input[name="login"]').length,
      passwordFieldCount: document.querySelectorAll('input[type="password"]').length,
      profileCardCount: document.querySelectorAll('.box-body.box-profile').length,
      iframeCount: document.querySelectorAll('iframe').length,
    })).catch(() => null);

    console.log('Step 3: Main response HTTP:', status ?? 'no-response');
    console.log('Step 4: Current URL:', locationCategory);
    console.log('Step 5: Page structure counts:', JSON.stringify(structure));
    if (navigationError) console.log('Navigation error class:', navigationError);

    const isPublicPreLogin = locationCategory.startsWith('ais.semuniver.kz')
      && structure?.profileCardCount === 0
      && (status === 403 || status === 401 || status === 200);
    if (isPublicPreLogin) {
      // Screenshot before any login attempt. Never collect a browser trace
      // or authenticated content into a workflow artifact.
      await page.screenshot({ path: `${OUT_DIR}/initial-public-page.png`, fullPage: false, timeout: 10000 });
      console.log('Step 6: Captured unauthenticated public page screenshot (initial-public-page.png).');
    } else {
      console.log('Step 6: Skipped screenshot to avoid capturing unexpected content.');
    }
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error('Public page visual diagnostic failed:', error instanceof Error ? error.name : 'unknown');
  process.exitCode = 1;
});
