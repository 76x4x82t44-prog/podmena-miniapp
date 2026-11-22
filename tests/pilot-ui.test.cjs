const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');

const root = resolve(__dirname, '../telegram-test');
const assetTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
const assets = new Set(['index.html', 'help.html', 'pilot.css', 'shifts.js', 'social.js', 'analytics.js']);

async function serve() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!assets.has(path)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(resolve(root, path));
      const suffix = path.slice(path.lastIndexOf('.'));
      response.writeHead(200, { 'content-type': `${assetTypes[suffix]}; charset=utf-8` }).end(data);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((success, failure) => {
    server.once('error', failure);
    server.listen(0, '127.0.0.1', success);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('мобильные вкладки, формы, длинные строки и справка', async () => {
  const { server, url } = await serve();
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    await page.route('https://telegram.org/**', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.Telegram = { WebApp: { initData: "" } };',
    }));
    await page.goto(`${url}/index.html`);
    assert.equal(await page.locator('meta[name=viewport]').getAttribute('content').then(content => content.includes('viewport-fit=cover')), true);
    const tabs = page.locator('.tabs .tab');
    assert.equal(await tabs.count(), 5);
    for (const width of [360, 390, 430]) {
      await page.setViewportSize({ width, height: 780 });
      for (let i = 0; i < 5; i++) {
        const tab = tabs.nth(i);
        await tab.click();
        assert.ok((await tab.boundingBox()).height >= 44, 'Вкладки доступны для касания');
        assert.equal(await page.locator('.page.active').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    }
    assert.equal(await page.locator('#profilePage').isVisible(), true);
    assert.ok(parseFloat(await page.locator('#workerName').evaluate(node => getComputedStyle(node).fontSize)) >= 16);
    assert.ok((await page.locator('#workerName').boundingBox()).height >= 44);
    await tabs.first().click();
    await page.setViewportSize({ width: 360, height: 780 });
    await page.locator('#listings').evaluate(list => {
      const card = document.createElement('article');
      card.className = 'card shift-card';
      card.textContent = 'Санкт-Петербург/'.repeat(32);
      list.prepend(card);
    });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await tabs.last().click();
    assert.ok(await page.getByRole('link', { name: 'Справка и правила' }).isVisible());

    const response = await page.goto(`${url}/help.html`);
    assert.equal(response.status(), 200);
    for (const id of ['how-it-works', 'support', 'privacy', 'terms']) {
      const jump = page.locator(`nav a[href="#${id}"]`);
      assert.ok((await jump.boundingBox()).height >= 44);
      await jump.click();
      assert.equal(await page.locator(`section#${id}`).isVisible(), true);
      assert.equal(new URL(page.url()).hash, `#${id}`);
    }
    assert.match(await page.locator('#privacy').innerText(), /черновик/i);
    assert.match(await page.locator('#terms').innerText(), /черновик/i);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await browser?.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
