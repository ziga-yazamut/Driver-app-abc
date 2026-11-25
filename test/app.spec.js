// The real driver app against test/devserver.mjs: Netlify functions + a fake main system (abcmobile), its only backend.
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

// A fresh list with 4 deliveries in the fake main system: A 1250 to collect, B 890, C nothing (prepaid), D 3400
async function newList(request) {
  const r = await request.post('/test/new-list', { data: { person: 'Moshe' } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).guid;
}
// What the fake main system holds for the list
const main = async (request, guid) => (await request.get('/test/main?guid=' + guid)).json();
const delivery = async (request, guid, n) => (await main(request, guid)).deliveries[n];

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
// Opens the n-th open stop and does the delivery + signature step
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
const sent = page => expect(page.locator('.q-wait')).toHaveCount(0, { timeout: 15000 });

test('driver: rules gate, delivery with a check, saved in the main system with photos', async ({ page, request }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const guid = await newList(request);
  await page.goto('/d/' + guid);
  await expect(page.locator('#accept')).toBeDisabled();
  await start(page, guid);
  await expect.poll(async () => (await main(request, guid)).preChecks).toEqual([true, true, true]);   // sent in the background
  await step1(page, 0, 'Danny');
  // payment: a check needs its photo, number, bank, branch, account and due date
  await page.click('[data-add="check"]');
  await expect(page.locator('#next')).toBeDisabled();
  await page.setInputFiles('#lp-0', PHOTO);
  await expect(page.locator('.pl-ph img')).toHaveCount(1);   // the photo is processed before typing on
  for (const [f, v] of [['checkNum', '1000001'], ['bank', '10'], ['branch', '647'], ['account', '01234567'], ['holder', 'Kirur']]) await page.fill(`[data-l="0"][data-f="${f}"]`, v);
  await expect(page.locator('#next')).toBeDisabled();
  await page.fill('[data-l="0"][data-f="dueDate"]', '2026-12-01');
  await expect(page.locator('#next')).toBeEnabled();
  await page.click('#next');
  await page.fill('#rma-note', 'one unit back');
  await page.setInputFiles('#f-rma', PHOTO);
  await expect(page.locator('.thumbs img')).toHaveCount(1);
  await page.click('#next');
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await sent(page);
  const m = await main(request, guid), d = m.deliveries[0];
  expect(d).toMatchObject({ Completed: true, Confirmed: true, RecipientName: 'Danny', AmountPaid: 1250, BoxDelivered: 2, ReturnComment: 'one unit back', FailedDelivery: false });
  expect(d.RecipientSignatureFile).toBeTruthy();
  expect(d.DeliveryPackagePhoto).toBeTruthy();
  expect(d.ReturnPhoto).toBeTruthy();
  expect(m.payments).toHaveLength(1);
  expect(m.payments[0]).toMatchObject({ MethodType: 'CHECK', Total: 1250, CHECK_Number: '1000001', CHECK_Bank: '10', CHECK_Branch: '647', Approved: false, Comment: 'Account 01234567, Holder Kirur' });
  expect(m.payments[0].PaymentPhoto).toBeTruthy();
  // the finished stop shows what was saved, read back from the main system
  await page.reload();
  await page.click('.stop.done');
  await expect(page.locator('.tiles img')).toHaveCount(4);   // package, signature, check, returns
  await expect(page.locator('.info')).toContainText('Danny');
  expect(errors).toEqual([]);
});

test('driver: paying less needs a reason', async ({ page, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await step1(page, 1, 'Ronit'); // 890 to collect
  await page.click('[data-add="cash"]');
  await page.setInputFiles('#lp-0', PHOTO);
  await expect(page.locator('.pl-ph img')).toHaveCount(1);
  await page.fill('[data-l="0"][data-f="amount"]', '500');
  await expect(page.locator('#next')).toBeDisabled();
  await page.click('[data-diff="later"]');
  await expect(page.locator('#next')).toBeEnabled();
  await page.click('#next'); await page.click('#next');
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await sent(page);
  const m = await main(request, guid);
  expect(m.deliveries[1]).toMatchObject({ AmountPaid: 500, DifferenceReason: 'later' });
  expect(m.payments[0]).toMatchObject({ MethodType: 'CASH', Total: 500 });
  expect(m.payments[0].PaymentPhoto).toBeTruthy();
});

test('driver: nothing to collect still shows the payment step, which can be skipped', async ({ page, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await step1(page, 2, 'Avi'); // prepaid
  await expect(page.locator('.paygrid')).toBeVisible();
  await expect(page.locator('#next')).toBeEnabled();
  await page.click('#next'); await page.click('#next');
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await sent(page);
  expect(await delivery(request, guid, 2)).toMatchObject({ Completed: true, RecipientName: 'Avi', AmountPaid: 0 });
});

test('driver: not delivered, with a reason', async ({ page, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await page.click('.stop >> nth=1');
  await page.click('#fail');
  await page.click('[data-reason="absent"]');
  await expect(page.locator('.stop.fail')).toHaveCount(1);
  await sent(page);
  expect(await delivery(request, guid, 1)).toMatchObject({ FailedDelivery: true, FailedDeliveryReason: 'absent', Completed: true });
  expect((await delivery(request, guid, 1)).DeliveryTime).toBeTruthy();
});

test('driver: no signal keeps the delivery on the phone and sends it later, even after a reload', async ({ page, context, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await step1(page, 2, 'Avi'); // nothing to collect
  await page.click('#next'); await page.click('#next');
  await expect(page.locator('.offline')).toBeVisible();
  await expect(page.locator('.q-wait')).toHaveCount(1);
  expect((await delivery(request, guid, 2)).RecipientName).toBeUndefined();
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await sent(page);
  expect(await delivery(request, guid, 2)).toMatchObject({ Completed: true, RecipientName: 'Avi' });
});

test('driver: reopen within 10 minutes brings back the draft, keeps the saved data, and stays reopened after a reload', async ({ page, request }) => {
  const guid = await newList(request);
  await start(page, guid);
  await step1(page, 2, 'Avi');
  await page.click('#next'); await page.click('#next');
  await expect(page.locator('.stop.done')).toHaveCount(1);
  await sent(page);
  await page.click('.stop.done');
  await page.click('#undo');
  await expect(page.locator('#signer')).toHaveValue('Avi');
  await expect(page.locator('.thumbs img')).toHaveCount(1);
  expect(await delivery(request, guid, 2)).toMatchObject({ Completed: false, RecipientName: 'Avi' });   // reopened, nothing deleted
  await page.reload();
  await expect(page.locator('.stop')).toHaveCount(4);
  await expect(page.locator('.stop.done')).toHaveCount(0);
  await page.waitForTimeout(1500);   // a stale outbox entry would be sent again right after loading
  expect((await delivery(request, guid, 2)).Completed).toBe(false);
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
  await sent(page);
  await page.click('#eod');
  await expect(page.locator('#close-day')).toBeEnabled();
  await page.click('#close-day');
  await expect(page.locator('#close-day')).toHaveText('Day closed');
  expect((await main(request, guid)).dayClosed).toBe(true);
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

test('server: refuses incomplete results, bad reasons and deliveries from another link', async ({ request }) => {
  const guid = await newList(request);
  const list = await (await request.get('/api/list?guid=' + guid)).json();
  const [a] = list.tasks;
  expect(list.source).toBe('main');
  expect((await request.post('/api/finish', { data: { guid, id: a.id, result: { status: 'delivered', receiver: 'X' } } })).status()).toBe(400);
  expect((await request.post('/api/finish', { data: { guid, id: a.id, result: { status: 'not_delivered', reason: 'nope' } } })).status()).toBe(400);
  expect((await request.post('/api/finish', { data: { guid, id: 999, result: { status: 'not_delivered', reason: 'absent' } } })).status()).toBe(404);
  expect((await delivery(request, guid, 0)).Completed).toBe(false);
});

test('main system links: a master link lists its drivers; the main system\'s own link address opens the app', async ({ page, request }) => {
  const MAIN = 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb', MASTER = 'cccccccc-1111-4222-8333-dddddddddddd';
  const master = await (await request.get('/api/list?guid=' + MASTER)).json();
  expect(master.people).toEqual([{ person: 'Main driver', guid: MAIN, count: 4 }]);
  expect((await request.get('/api/list?guid=00000000-0000-4000-8000-000000000000')).status()).toBe(404);
  await page.goto('/DeliveryList/Single/' + MAIN);
  await page.click('[data-lang="en"]');
  await expect(page.locator('.t').first()).toContainText('Main driver');
});

test('/office is gone', async ({ request }) => {
  expect((await request.get('/office')).status()).toBe(404);
  expect((await request.get('/api/office?code=test')).status()).toBe(404);
});
