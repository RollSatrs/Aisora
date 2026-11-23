'use strict';

// This smoke test intentionally uses only local, generated HTML.
// It must never contact ABU AIS or read real student credentials.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html lang="ru"><body>
      <section id="journal">
        <a data-week="13">СРС 4. Интернет вещей</a>
        <a data-week="13">СРО №4. Блокчейн</a>
      </section>
    </body></html>`);
    const titles = await page.locator('#journal a').allTextContents();
    if (titles.length !== 2 || !titles[0].includes('СРС 4') || !titles[1].includes('СРО №4')) {
      throw new Error('Cloud browser could not extract expected mock journal data');
    }
    console.log('Cloud Playwright ready: headless Chromium launched and read 2 synthetic journal titles');
    console.log('No connection to university AIS; no user credentials; no submissions');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error('Cloud Playwright smoke failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
