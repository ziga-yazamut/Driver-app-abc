// בדיקות קצה-לקצה להדמיה (mockup/index.html) בטלפון מדומה.
// הרצה: npm install && npx playwright install chromium && npm run test:mockup
const { test, expect, devices } = require('@playwright/test');
const path = require('path');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
test.use({ ...devices['Pixel 5'] });

const D = (page, id) => page.evaluate((id) => window.__D.find((d) => d.id === id), id);
const nextDisabled = (page) => page.$eval('#next', (e) => e.disabled);

async function sign(page) {
  const c = page.locator('#sig');
  await c.scrollIntoViewIfNeeded();
  const bb = await c.boundingBox();
  await page.mouse.move(bb.x + 20, bb.y + 20);
  await page.mouse.down();
  await page.mouse.move(bb.x + 140, bb.y + 60, { steps: 6 });
  await page.mouse.up();
}

async function start(page, { acceptTerms = true } = {}) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.click('#lang-he');
  await page.uncheck('#preview'); // כל כללי החובה פעילים
  if (acceptTerms) {
    for (const i of [0, 1, 2]) await page.check('#rule-' + i);
    await page.click('#accept');
  }
  return errors;
}

async function deliverStep(page, id) {
  await page.click(`.stop[data-id="${id}"] .c`);
  await page.click('[data-demo="photos"]');
  await sign(page);
  await page.click('#next');
}

// ---------- מסך פתיחה ----------

test('terms: accept is locked until all 3 rules are checked', async ({ page }) => {
  const errors = await start(page, { acceptTerms: false });
  await expect(page.locator('#accept')).toBeDisabled();
  await page.check('#rule-0');
  await page.check('#rule-1');
  await expect(page.locator('#accept')).toBeDisabled();
  await page.check('#rule-2');
  await expect(page.locator('#accept')).toBeEnabled();
  await page.click('#accept');
  await expect(page.locator('.stop').first()).toBeVisible();
  expect(errors).toEqual([]);
});

// ---------- מסירות ----------

test('cash delivery: photo + signature + cash photo closes the point', async ({ page }) => {
  const errors = await start(page);
  await deliverStep(page, 'DLV-558813');
  await page.click('[data-add="cash"]');
  expect(await nextDisabled(page)).toBe(true); // בלי צילום מזומן
  await page.click('[data-ldemo="0"]');
  expect(await nextDisabled(page)).toBe(false);
  await page.click('#next'); // חזרות (אופציונלי)
  await page.click('#next'); // סיום
  const d = await D(page, 'DLV-558813');
  expect(d.status).toBe('completed');
  expect(d.lines.map((l) => [l.type, +l.amount])).toEqual([['cash', 1890]]);
  expect(errors).toEqual([]);
});

test('signature is mandatory', async ({ page }) => {
  await start(page);
  await page.click('.stop[data-id="DLV-558813"] .c');
  await page.click('[data-demo="photos"]');
  expect(await nextDisabled(page)).toBe(true);
  await sign(page);
  expect(await nextDisabled(page)).toBe(false);
});

test('check needs photo (OCR) and due date', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558824');
  await page.click('[data-add="check"]');
  expect(await nextDisabled(page)).toBe(true);
  await page.click('[data-ldemo="0"]');
  expect(await nextDisabled(page)).toBe(true); // עדיין חסר תאריך
  await page.fill('[data-l="0"][data-f="dueDate"]', '2026-11-06');
  expect(await nextDisabled(page)).toBe(false);
  await page.click('#next');
  await page.click('#next');
  const d = await D(page, 'DLV-558824');
  expect(d.lines[0].type).toBe('check');
  expect(d.lines[0].checkNum).toBeTruthy();
  expect(d.lines[0].dueDate).toBe('2026-11-06');
});

test('credit is a tap with an amount, no photo', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558820');
  await page.click('[data-add="credit"]');
  expect(await nextDisabled(page)).toBe(false);
  await page.click('#next');
  await page.click('#next');
  const d = await D(page, 'DLV-558820');
  expect(d.lines).toHaveLength(1);
  expect(d.lines[0].type).toBe('credit');
  expect(d.lines[0].photo || null).toBeNull();
  expect(+d.lines[0].amount).toBe(12600);
});

test('mixed payment: 2 checks + cash + credit add up to the due amount', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558820');
  await page.click('[data-add="check"]');
  await page.fill('[data-l="0"][data-f="amount"]', '5000');
  await page.click('[data-ldemo="0"]');
  await page.fill('[data-l="0"][data-f="dueDate"]', '2026-11-06');
  await page.click('[data-add="check"]');
  await page.fill('[data-l="1"][data-f="amount"]', '5000');
  await page.click('[data-ldemo="1"]');
  await page.fill('[data-l="1"][data-f="dueDate"]', '2026-12-06');
  await page.click('[data-add="cash"]');
  await page.fill('[data-l="2"][data-f="amount"]', '1600');
  await page.click('[data-ldemo="2"]');
  await page.click('[data-add="credit"]');
  // שורה חדשה מקבלת את היתרה
  await expect(page.locator('[data-l="3"][data-f="amount"]')).toHaveValue('1000');
  expect(await nextDisabled(page)).toBe(false);
  await page.click('#next');
  await page.click('#next');
  const d = await D(page, 'DLV-558820');
  expect(d.lines.map((l) => l.type)).toEqual(['check', 'check', 'cash', 'credit']);
  expect(d.lines.reduce((a, l) => a + +l.amount, 0)).toBe(12600);
  const nums = d.lines.filter((l) => l.type === 'check').map((l) => l.checkNum);
  expect(new Set(nums).size).toBe(2); // שני שיקים שונים
});

test('underpay requires a reason; zero and empty lines are blocked', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558824');
  await page.click('[data-add="cash"]');
  await page.fill('[data-l="0"][data-f="amount"]', '500');
  await page.click('[data-ldemo="0"]');
  expect(await nextDisabled(page)).toBe(true);
  await page.click('[data-diff="later"]');
  expect(await nextDisabled(page)).toBe(false);
  await page.fill('[data-l="0"][data-f="amount"]', '0');
  expect(await nextDisabled(page)).toBe(true);
  await page.click('[data-del="0"]');
  expect(await nextDisabled(page)).toBe(true);
});

test('overpay also requires a reason', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558824');
  await page.click('[data-add="cash"]');
  await page.fill('[data-l="0"][data-f="amount"]', '900');
  await page.click('[data-ldemo="0"]');
  expect(await nextDisabled(page)).toBe(true);
});

test('prepaid point skips the payment step', async ({ page }) => {
  await start(page);
  await page.click('.stop[data-id="DLV-558817"] .c');
  const steps = await page.$$eval('.dots > *', (x) => x.length);
  expect(steps).toBe(2); // ארגזים/מסירה + חזרות
});

test('boxes: short delivery is recorded', async ({ page }) => {
  await start(page);
  await page.click('.stop[data-id="DLV-558820"] .c');
  await page.click('#bx-minus');
  await expect(page.locator('#bx-val')).toHaveText('3');
  await page.click('[data-demo="photos"]');
  await sign(page);
  await page.click('#next');
  await page.click('[data-add="credit"]');
  await page.click('#next');
  await page.click('#next');
  expect((await D(page, 'DLV-558820')).boxesDelivered).toBe(3);
});

// ---------- מקרי קצה ----------

test('leaving mid-wizard keeps the draft', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558813');
  await page.click('[data-add="cash"]');
  await page.click('#back');
  await page.click('.stop[data-id="DLV-558813"] .c');
  await expect(page.locator('[data-l="0"][data-f="amount"]')).toBeVisible();
});

test('double tap on finish records once', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558824');
  await page.click('[data-add="credit"]');
  await page.click('#next');
  const btn = await page.$('#next');
  await Promise.all([btn.click(), btn.click().catch(() => {})]);
  const n = await page.evaluate(() => window.__D.filter((d) => d.id === 'DLV-558824' && d.status === 'completed').length);
  expect(n).toBe(1);
});

test('undo within 10 minutes reopens the point', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558824');
  await page.click('[data-add="credit"]');
  await page.click('#next');
  await page.click('#next');
  if (!(await page.$('.stop'))) await page.click('#back').catch(() => {});
  await page.click('.stop[data-id="DLV-558824"] .c');
  await page.click('#undo');
  expect((await D(page, 'DLV-558824')).status).toBe('pending');
  await expect(page.locator('#next')).toBeVisible();
});

test('not delivered: reason is required and recorded', async ({ page }) => {
  await start(page);
  await page.click('.stop[data-id="DLV-558817"] .c');
  await page.click('#fail');
  await page.click('[data-reason="absent"]');
  const d = await D(page, 'DLV-558817');
  expect(d.status).toBe('failed');
});

test('duplicate check scan shows a warning', async ({ page }) => {
  await start(page);
  const prev = (await D(page, 'DLV-558812')).lines.find((l) => l.type === 'check');
  await deliverStep(page, 'DLV-558824');
  await page.click('[data-add="check"]');
  await page.click('[data-ldemo="0"]');
  await page.click('[data-ocr="0"]'); // תיקון ידני של ערכי ה-OCR
  await page.fill('[data-l="0"][data-f="checkNum"]', prev.checkNum);
  await page.fill('[data-l="0"][data-f="account"]', prev.account);
  await expect(page.locator('#lw-0')).toContainText('כבר נסרק');
});

test('third-party check shows a warning', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558824');
  await page.click('[data-add="check"]');
  await page.click('[data-ldemo="0"]');
  await page.click('[data-ocr="0"]');
  await page.fill('[data-l="0"][data-f="drawerId"]', '000000018');
  await expect(page.locator('#lw-0')).toContainText("צד ג'");
});

// ---------- סיכומים וצוות ----------

test('interim summary counts checks (not amount) and cash total', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558813');
  await page.click('[data-add="cash"]');
  await page.click('[data-ldemo="0"]');
  await page.click('#next');
  await page.click('#next');
  if (!(await page.$('#eod'))) await page.click('#back').catch(() => {});
  const tally = (await page.textContent('.tally')).replace(/\s+/g, ' ');
  expect(tally).toMatch(/1,?890/); // מזומן
  await page.click('#eod');
  const txt = (await page.textContent('.phone')).replace(/\s+/g, ' ');
  expect(txt).toMatch(/שיק/);
});

test('staff view: new columns only, approve marks payment reviewed', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.click('#lang-he');
  await page.click('#tab-office');
  await expect(page.locator('.mtable th.new')).toHaveCount(2);
  await expect(page.locator('.mtable th.new').nth(0)).toContainText('סטטוס מסירה');
  await expect(page.locator('.mtable th.new').nth(1)).toContainText('תשלום מהנהג');
  const card = page.locator('.rcard[data-id="DLV-558812"]');
  await expect(card).toContainText('אשר והזן');
  await page.click('[data-approve="DLV-558812"]');
  expect((await D(page, 'DLV-558812')).reviewed).toBe(true);
  await expect(page.locator('.rcard[data-id="DLV-558812"]')).toContainText('הוזן לשורות התשלום');
  await expect(page.locator('.rcard[data-id="DLV-558812"] [data-approve]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('completed point appears in staff view as delivered', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558820');
  await page.click('[data-add="credit"]');
  await page.click('#next');
  await page.click('#next');
  if (!(await page.$('#tab-office:visible'))) await page.click('#back').catch(() => {});
  await page.click('#tab-office');
  await expect(page.locator('.rcard[data-id="DLV-558820"]')).toContainText('נמסר');
});

// ---------- פריסה וביצועים ----------

test('no horizontal scroll, light theme even in dark mode', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.click('#lang-he');
  for (const tab of ['#tab-driver', '#tab-office']) {
    await page.click(tab);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  expect((r + g + b) / 3).toBeGreaterThan(200);
  await ctx.close();
});

test('taps respond fast on a slow phone (CPU x6)', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const t0 = Date.now();
  await start(page);
  const load = Date.now() - t0;
  const times = [];
  for (const sel of ['.stop[data-id="DLV-558813"] .c', '[data-demo="photos"]', '#back', '#eod', '#back']) {
    const t = Date.now();
    await page.click(sel).catch(() => {});
    times.push(Date.now() - t);
  }
  test.info().annotations.push({ type: 'perf', description: `load ${load}ms, taps ${times.join('/')}ms` });
  expect(load).toBeLessThan(5000);
  expect(Math.max(...times)).toBeLessThan(1500);
});

// ---------- שפה ----------

test('language switch: English is LTR, Hebrew is RTL, no Hebrew left in English', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.click('#lang-en');
  expect(await page.getAttribute('html', 'dir')).toBe('ltr');
  const heb = /[\u0590-\u05FF]/;
  const visibleHebrew = async () => (await page.evaluate(() => document.body.innerText)).split('\n').filter((l) => /[\u0590-\u05FF]/.test(l) && l.trim() !== 'עב');
  // every screen in English
  expect(await visibleHebrew()).toEqual([]);
  for (const i of [0, 1, 2]) await page.check('#rule-' + i);
  await page.click('#accept');
  expect(await visibleHebrew()).toEqual([]);
  await page.click('.stop[data-id="DLV-558820"] .c');
  await page.click('#fail');
  expect(await visibleHebrew()).toEqual([]);
  await page.click('#fail');
  await page.click('#next');
  await page.click('[data-add="check"]');
  await page.click('[data-ldemo="0"]');
  await page.click('[data-ocr="0"]');
  await page.click('[data-add="cash"]');
  expect(await visibleHebrew()).toEqual([]);
  await page.click('#next');
  expect(await visibleHebrew()).toEqual([]);
  await page.click('#next');
  await page.click('#eod');
  expect(await visibleHebrew()).toEqual([]);
  await page.click('#tab-office');
  expect(await visibleHebrew()).toEqual([]);
  await page.click('#lang-he');
  expect(await page.getAttribute('html', 'dir')).toBe('rtl');
  expect(heb.test(await page.textContent('#kpis'))).toBe(true);
  expect(errors).toEqual([]);
});

test('language switch keeps the driver on the same screen and draft', async ({ page }) => {
  await start(page);
  await deliverStep(page, 'DLV-558813');
  await page.click('[data-add="cash"]');
  await page.click('#lang-en');
  await expect(page.locator('[data-l="0"][data-f="amount"]')).toHaveValue('1890');
  await expect(page.locator('#next')).toHaveText('Next');
});

// ---------- מובייל ----------

test('mobile: the driver app starts right under the top bar and fills the width', async ({ page }) => {
  await page.goto(URL);
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  const box = await page.locator('#phone').boundingBox();
  expect(box.width).toBeGreaterThan(vw - 2);
  expect(box.y).toBeLessThan(100);
  for (const sel of ['#accept', '#rule-0']) {
    const b = await page.locator(sel).boundingBox();
    expect(b.height).toBeGreaterThanOrEqual(24);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('mobile: tap targets in the wizard are at least 40px', async ({ page }) => {
  await start(page);
  await page.click('.stop[data-id="DLV-558820"] .c');
  for (const sel of ['#bx-minus', '#bx-plus', '#next', '.bigbtn']) {
    const b = await page.locator(sel).first().boundingBox();
    expect(b.height, sel).toBeGreaterThanOrEqual(40);
  }
  await page.click('#back');
  await deliverStep(page, 'DLV-558820');
  const b = await page.locator('[data-add="cash"]').boundingBox();
  expect(b.height).toBeGreaterThanOrEqual(40);
});

test('developer notes: every screen in the map opens and is described', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await page.click('#lang-en');
  for (const k of ['terms', 'list', 'box', 'pay', 'rma', 'summary', 'done']) {
    await page.click(`[data-go="${k}"]`);
    await expect(page.locator(`[data-go="${k}"]`)).toHaveAttribute('aria-current', 'true');
    expect((await page.textContent('#scr-h')).length).toBeGreaterThan(3);
  }
  await page.click('[data-go="pay"]');
  await expect(page.locator('[data-add="check"]')).toBeVisible();
  expect(errors).toEqual([]);
});
