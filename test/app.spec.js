// The real driver app and office page, against test/devserver.mjs (fake Supabase and a fake, read-only main system).
const { test, expect, devices } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

test.use({ ...devices['Pixel 5'] });
// Sortable and the fonts come from CDNs; tests must not depend on them
test.beforeEach(async ({ context }) => { await context.route(/cdnjs|fonts\.g/, r => r.abort()); });

// A small JPEG to "photograph"
const PHOTO = path.join(os.tmpdir(), 'abc-driver-test.jpg');
fs.writeFileSync(PHOTO, Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64'));

const office = (request, body) => request.post('/api/office', { data: { code: 'test', ...body } });
async function newList(request) {
  const r = await office(request, { op: 'sample', person: 'Moshe' });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).guid;
}
const results = async (request, guid) => (await (await request.get(`/api/office?code=test&guid=${guid}`)).json()).results;

async function sign(page) {
  const c = page.locator('#sig');
  await c.scrollIntoViewIfNeeded();
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 20, b.y + 20); await page.mouse.down();
  await page.mouse.move(b.x + 150, b.y + 70, { steps: 5 }); await page.mouse.up();
}
async function start(page, guid) {
  await page.goto('/d/' + guid);
  await page.click('[data-lang="en"]');
  for (const i of [0, 1, 2]) await page.check('#rule-' + i);
  await page.click('#accept');
  await expect(page.locator('.stop')).toHaveCount(4);
}
async function step1(page, n, name) {
  await page.click(`.stop >> nth=${n}`);
  await expect(page.locator('#next')).toBeDisabled();
  await page.setInputFiles('#f-photo', PHOTO);
  await expect(page.locator('.thumbs img')).toHaveCount(1);
  await sign(page);
  await page.fill('#signer', name);
  await expect(page.locator('#next')).toBeEnabled();
  await page.click('#next');
}

test('driver: rules gate, delivery with a check, saved with photos', async ({ page, request }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const guid = await newList(request);
  await page.goto('/d/' + guid);
  await expect(page.locator('#accept')).toBeDisabled();
  await start(page, guid);
  await step1(page, 0, 'Danny');
  // payment: a check needs its photo, number, bank, branch, account and due date
  await page.click('[data-add="check"]');
  await expect(page.locator('#next')).toBeDisabled();
  await page.setInputFiles('#lp-0', PHOTO);
  for (const [f, v] of [['checkNum', '1000001'], ['bank', '10'], ['branch', '647'], ['account', '01234567']]) await page.fill(`[data-l="0"][data-f="${f}"]`, v);
  await expect(page.locator('#next')).toBeDisabled();
  await page.fill('[data-l="0"][data-f="dueDate"]', '2026-12-01');
  await expect(page.locator('#next')).toBeEnabled();
  await page.click('#next');
  await page.fill('#rma-note', 'one unit back');
  await page.click('#next');
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await expect(page.locator('.q-wait')).toHaveCount(0, { timeout: 10000 });
  const r = Object.values(await results(request, guid))[0];
  expect(r.status).toBe('delivered');
  expect(r.receiver_name).toBe('Danny');
  expect(Number(r.amount_paid)).toBe(1250);
  expect(r.payments[0]).toMatchObject({ type: 'check', checkNum: '1000001', bank: '10', branch: '647', account: '01234567', dueDate: '2026-12-01' });
  expect(r.package_urls).toHaveLength(1);
  expect(r.signature_url).toBeTruthy();
  expect(r.payments[0].photo_url).toBeTruthy();
  expect(r.rma_note).toBe('one unit back');
  expect(errors).toEqual([]);
});

test('driver: paying less needs a reason', async ({ page, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await step1(page, 1, 'Ronit'); // 890 to collect
  await page.click('[data-add="cash"]');
  await page.setInputFiles('#lp-0', PHOTO);
  await page.fill('[data-l="0"][data-f="amount"]', '500');
  await expect(page.locator('#next')).toBeDisabled();
  await page.click('[data-diff="later"]');
  await expect(page.locator('#next')).toBeEnabled();
  await page.click('#next'); await page.click('#next');
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await expect(page.locator('.q-wait')).toHaveCount(0, { timeout: 10000 });
  const r = Object.values(await results(request, guid))[0];
  expect(Number(r.amount_paid)).toBe(500);
  expect(r.diff_reason).toBe('later');
});

test('driver: not delivered, with a reason', async ({ page, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await page.click('.stop >> nth=1');
  await page.click('#fail');
  await page.click('[data-reason="absent"]');
  await expect(page.locator('.stop.fail')).toHaveCount(1);
  await expect(page.locator('.q-wait')).toHaveCount(0, { timeout: 10000 });
  expect(Object.values(await results(request, guid))[0]).toMatchObject({ status: 'not_delivered', reason: 'absent' });
});

test('driver: no signal keeps the delivery on the phone and sends it later, even after a reload', async ({ page, context, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await step1(page, 2, 'Avi'); // nothing to collect: straight to returns
  await page.click('#next');
  await expect(page.locator('.offline')).toBeVisible();
  await expect(page.locator('.q-wait')).toHaveCount(1);
  expect(Object.keys(await results(request, guid))).toHaveLength(0);
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await expect(page.locator('.q-wait')).toHaveCount(0, { timeout: 15000 });
  expect(Object.values(await results(request, guid))[0]).toMatchObject({ status: 'delivered', receiver_name: 'Avi' });
});

test('driver: reopen within 10 minutes brings back the draft', async ({ page, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await step1(page, 2, 'Avi');
  await page.click('#next');
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await expect(page.locator('.q-wait')).toHaveCount(0, { timeout: 10000 });
  await page.click('.stop.done');
  await page.click('#undo');
  await expect(page.locator('#signer')).toHaveValue('Avi');
  await expect(page.locator('.thumbs img')).toHaveCount(1);
  expect(Object.keys(await results(request, guid))).toHaveLength(0);
});

test('driver: day summary, close the day only when all are done', async ({ page, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await page.click('#eod');
  await expect(page.locator('#close-day')).toBeDisabled();
  await page.click('#back');
  for (let i = 0; i < 4; i++) {
    await page.click('.stop:not(.done):not(.fail) >> nth=0');
    await page.click('#fail'); await page.click('[data-reason="refused"]');
    await expect(page.locator('.stop.fail')).toHaveCount(i + 1);
  }
  await expect(page.locator('.q-wait')).toHaveCount(0, { timeout: 10000 });
  await page.click('#eod');
  await expect(page.locator('#close-day')).toBeEnabled();
  await page.click('#close-day');
  await expect(page.locator('#close-day')).toHaveText('Day closed');
});

test('driver: Hebrew is right-to-left, English left-to-right; a bad link says so', async ({ page, request }) => {
  const guid = await newList(request);
  await page.goto('/d/' + guid);
  await page.click('[data-lang="he"]');
  expect(await page.getAttribute('html', 'dir')).toBe('rtl');
  await page.click('[data-lang="en"]');
  expect(await page.getAttribute('html', 'dir')).toBe('ltr');
  await page.goto('/d/00000000-0000-0000-0000-000000000000');
  await expect(page.locator('.msg b')).toHaveText('This link has no deliveries.');
});

test('server: refuses photos from another delivery, incomplete results and wrong office codes', async ({ request }) => {
  const guid = await newList(request);
  const list = await (await request.get('/api/list?guid=' + guid)).json();
  const [a, b] = list.tasks;
  const bad = await request.post('/api/finish', { data: { guid, id: a.id, result: { status: 'delivered', receiver: 'X', signature: `${guid}/${b.id}/signature-1.png`, packages: [`${guid}/${b.id}/package-1.jpg`] } } });
  expect(bad.status()).toBe(400);
  expect((await request.post('/api/finish', { data: { guid, id: a.id, result: { status: 'not_delivered', reason: 'nope' } } })).status()).toBe(400);
  expect((await request.post('/api/finish', { data: { guid, id: 999, result: { status: 'not_delivered', reason: 'absent' } } })).status()).toBe(404);
  expect((await request.post('/api/office', { data: { code: 'wrong', op: 'sample', person: 'x' } })).status()).toBe(403);
  expect(list.writes).toBe(false);
  expect(list.source).toBe('office');
});

test('office: create a list, add and edit deliveries, results lock the row', async ({ browser, request }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto('/office');
  await page.click('#lang-en');
  await page.fill('#code', 'test'); await page.click('#go');
  await page.fill('#person', 'Yossi'); await page.click('#create');
  await expect(page.locator('#link')).toContainText('/d/');
  const af = page.locator('#af');
  await af.locator('[data-k="company"]').fill('Kirur Plus');
  await af.locator('[data-k="total"]').fill('760');
  await af.locator('[data-save]').click();
  await expect(page.locator('.mtable tbody tr')).toHaveCount(1);
  await page.click('[data-edit]');
  await page.locator('#ef [data-k="company"]').fill('Kirur Plus Ltd.');
  await page.locator('#ef [data-save]').click();
  await expect(page.locator('.mtable')).toContainText('Kirur Plus Ltd.');
  const guid = (await page.textContent('#link')).split('/d/')[1].trim();
  const [task] = (await (await request.get('/api/list?guid=' + guid)).json()).tasks;
  await request.post('/api/finish', { data: { guid, id: task.id, result: { status: 'not_delivered', reason: 'address' } } });
  expect((await office(request, { op: 'edit', id: task.id, task: { company: 'x' } })).status()).toBe(409);
  await page.reload();
  await expect(page.locator('[data-edit]')).toHaveCount(0);
});

test('office: the sample button works without a driver name', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto('/office');
  await page.click('#lang-en');
  await page.fill('#code', 'test'); await page.click('#go');
  await page.click('#sample');
  await expect(page.locator('#link')).toContainText('/d/');
  await expect(page.locator('.mtable tbody tr')).toHaveCount(4);
  await expect(page.locator('h2').first()).toContainText('Sample driver');
});

test('main system, read only: the office opens a pasted driver link, the driver uses it, nothing is sent back', async ({ browser, request }) => {
  test.skip(process.env.MAIN_READ === 'off', 'needs the fake main system');
  const MAIN = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb', MASTER = 'cccccccc-1111-4222-8333-dddddddddddd';
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto('/office');
  await page.click('#lang-en');
  await page.fill('#code', 'test'); await page.click('#go');
  await expect(page.locator('.note')).toContainText('reading only');
  await page.fill('#mainlink', 'nothing here');
  await page.click('#openmain');
  await expect(page.locator('#mainerr')).toContainText('No link code');
  await page.fill('#mainlink', 'https://abcmobile.shop/DeliveryList/Single/00000000-0000-4000-8000-000000000000');
  await page.click('#openmain');
  await expect(page.locator('#mainerr')).toContainText('no deliveries');
  // The "Manager" link of a sending lists its drivers
  await page.fill('#mainlink', `Manager: https://abcmobile.shop/DeliveryList/Single/${MASTER}`);
  await page.click('#openmain');
  await page.click(`[data-g="${MAIN}"]`);
  await expect(page.locator('.mtable tbody tr')).toHaveCount(2);
  await expect(page.locator('.mtable')).toContainText('Main customer A');
  await expect(page.locator('#af')).toHaveCount(0);
  await expect(page.locator('.box h2').first()).toContainText('Main driver · 2025-10-27');

  // The driver opens the main system's link with this site's address
  const d = await (await browser.newContext()).newPage();
  await d.route(/cdnjs|fonts\.g/, r => r.abort());
  await d.goto('/DeliveryList/Single/' + MAIN);
  await d.click('[data-lang="en"]');
  for (const i of [0, 1, 2]) await d.check('#rule-' + i);
  await d.click('#accept');
  await expect(d.locator('.stop')).toHaveCount(2);
  await expect(d.locator('.stop').first()).toContainText('Main customer A');
  const list = await (await request.get('/api/list?guid=' + MAIN)).json();
  expect(list.source).toBe('main');
  expect(list.writes).toBe(false);
  expect((await request.post('/api/finish', { data: { guid: MAIN, id: 501, result: { status: 'not_delivered', reason: 'address' } } })).status()).toBe(200);
  expect(await (await request.get('/test/main-posts')).json()).toEqual([]);
  // The office can't type deliveries into a main-system list
  expect((await office(request, { op: 'add', guid: MAIN, task: { company: 'X' } })).status()).toBe(409);
  // and it is now in the office's lists
  const lists = await (await request.get('/api/office?code=test')).json();
  expect(lists.lists.some(l => l.guid === MAIN && l.tasks === null)).toBe(true);
});
