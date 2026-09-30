// בדיקת חוזה: כל הודעה שההדמיה שולחת למערכת הראשית חייבת לעבור את api/openapi.yaml.
const { test, expect, devices } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
test.use({ ...devices['Pixel 5'] });

const spec = yaml.load(fs.readFileSync(path.resolve(__dirname, '..', '..', 'api', 'openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'openapi', components: spec.components });
const validateDelivery = ajv.compile({ $ref: 'openapi#/components/schemas/DeliveryResult' });
const validateRoute = ajv.compile({ $ref: 'openapi#/components/schemas/RouteFinished' });

function check(validate, payload) {
  const ok = validate(payload);
  expect(ok, JSON.stringify(validate.errors, null, 1) + '\n' + JSON.stringify(payload, null, 1)).toBe(true);
}

async function sign(page) {
  const c = page.locator('#sig');
  await c.scrollIntoViewIfNeeded();
  const bb = await c.boundingBox();
  await page.mouse.move(bb.x + 20, bb.y + 20);
  await page.mouse.down();
  await page.mouse.move(bb.x + 140, bb.y + 60, { steps: 6 });
  await page.mouse.up();
}
const payload = async (page) => JSON.parse(await page.textContent('#payload'));

test('every webhook payload matches the OpenAPI schema', async ({ page }) => {
  await page.goto(URL);
  await page.uncheck('#preview');
  for (const i of [0, 1, 2]) await page.check('#rule-' + i);
  await page.click('#accept');
  const back = async () => { if (!(await page.$('.stop'))) await page.click('#back').catch(() => {}); };

  // 1. מזומן
  await page.click('.stop[data-id="DLV-558813"] .c');
  await page.click('[data-demo="photos"]'); await sign(page); await page.click('#next');
  await page.click('[data-add="cash"]'); await page.click('[data-ldemo="0"]');
  await page.click('#next'); await page.click('#next');
  let p = await payload(page);
  check(validateDelivery, p);
  expect(p.revision).toBe(1);
  expect(p.payments[0]).toMatchObject({ method: 'cash', amount: 1890, status: 'to_review' });

  // 2. שני שיקים + מזומן + אשראי, חוסר ארגז
  await back();
  await page.click('.stop[data-id="DLV-558820"] .c');
  await page.click('#bx-minus');
  await page.click('[data-demo="photos"]'); await sign(page); await page.click('#next');
  await page.click('[data-add="check"]'); await page.fill('[data-l="0"][data-f="amount"]', '5000');
  await page.click('[data-ldemo="0"]'); await page.fill('[data-l="0"][data-f="dueDate"]', '2026-11-06');
  await page.click('[data-add="check"]'); await page.fill('[data-l="1"][data-f="amount"]', '5000');
  await page.click('[data-ldemo="1"]'); await page.fill('[data-l="1"][data-f="dueDate"]', '2026-12-06');
  await page.click('[data-add="cash"]'); await page.fill('[data-l="2"][data-f="amount"]', '1600'); await page.click('[data-ldemo="2"]');
  await page.click('[data-add="credit"]');
  await page.click('#next'); await page.click('#next');
  p = await payload(page);
  check(validateDelivery, p);
  expect(p.status).toBe('partial');
  expect(p.payments.map((x) => x.method)).toEqual(['check', 'check', 'cash', 'credit']);
  expect(p.amount_collected).toBe(p.amount_due);

  // 3. תשלום חלקי עם סיבה
  await back();
  await page.click('.stop[data-id="DLV-558824"] .c');
  await page.click('[data-demo="photos"]'); await sign(page); await page.click('#next');
  await page.click('[data-add="cash"]'); await page.fill('[data-l="0"][data-f="amount"]', '500'); await page.click('[data-ldemo="0"]');
  await page.click('[data-diff="ישלים בהמשך"]');
  await page.click('#next'); await page.click('#next');
  p = await payload(page);
  check(validateDelivery, p);
  expect(p.amount_diff_reason).toBeTruthy();

  // 4. פתיחה מחדש וסגירה שוב: revision עולה
  await back();
  await page.click('.stop[data-id="DLV-558824"] .c');
  await page.click('#undo');
  await page.click('[data-demo="photos"]'); await sign(page); await page.click('#next');
  await page.click('[data-add="credit"]');
  await page.click('#next'); await page.click('#next');
  p = await payload(page);
  check(validateDelivery, p);
  expect(p.revision).toBe(2);

  // 5. לא נמסר
  await back();
  await page.click('.stop[data-id="DLV-558817"] .c');
  await page.click('#fail');
  await page.click('[data-reason="הלקוח לא נמצא"]');
  p = await payload(page);
  check(validateDelivery, p);
  expect(p.status).toBe('failed');

  // 6. סגירת יום
  await back();
  await page.click('#eod');
  await page.click('#close-day');
  p = await payload(page);
  check(validateRoute, p);
});

test('schema rejects broken payloads', async () => {
  const good = {
    event: 'delivery.completed', delivery_id: 'DLV-1', revision: 1, route_id: 'R', driver_id: 'D', status: 'completed',
    completed_at: '2026-09-30T10:00:00+03:00', boxes_delivered: 1, point_url: 'https://x.example/v/1',
    proof_of_delivery: { photos: [{ url: 'https://x.example/1.jpg' }], signature: { url: 'https://x.example/s.png' } },
    payments: [{ line: 1, method: 'check', amount: 100, status: 'to_review', photo_url: 'https://x.example/c.jpg',
      check: { check_number: '1000001', bank: '10', branch: '647', account: '01234567', due_date: '2026-11-06' } }],
  };
  expect(validateDelivery(good)).toBe(true);
  const bad = (f) => { const x = JSON.parse(JSON.stringify(good)); f(x); return validateDelivery(x); };
  expect(bad((x) => delete x.revision)).toBe(false);
  expect(bad((x) => delete x.payments[0].check)).toBe(false);          // שיק בלי פרטים
  expect(bad((x) => delete x.payments[0].photo_url)).toBe(false);      // שיק בלי צילום
  expect(bad((x) => (x.payments[0].amount = 0))).toBe(false);
  expect(bad((x) => (x.payments[0].check.bank = '1'))).toBe(false);
  expect(bad((x) => { x.status = 'failed'; })).toBe(false);            // לא נמסר בלי סיבה
  expect(bad((x) => (x.proof_of_delivery.photos = []))).toBe(false);   // נמסר בלי צילום
  expect(bad((x) => (x.payments[0] = { line: 1, method: 'credit', amount: 50, status: 'to_review' }))).toBe(true);
});
