// The main system client (netlify/lib/abc.mjs) against a fake fetch: reading the driver's list,
// and that nothing is ever written unless MAIN_WRITE is on (and MAIN_READ is not off).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMainList, finalize, setPositions, readsOn, writesOn, mapTask } from '../netlify/lib/abc.mjs';

const GUID = '11111111-2222-3333-4444-555555555555';
const MODEL = {
  GUID, DeliveryPerson: 'Moshe', ListDate: '25/10/2026', PreCheck1: false, PreCheck2: false,
  Tasks: [{ GUID, CreationDate: '/Date(1792900000000)/', DeliveryPerson: 'Moshe', Company: 'Kirur Plus', City: 'Kfar Saba', Address: 'Weizmann 45',
    PhoneNumber: '054-0000000', Total: 1890, PaymentTerms: 'שוטף+30', Completed: null, DeliveryGUIDId: 812, Position: 0, TotalPackages: 2,
    Confirmed: false, Paid: 390, DeliveryComment: 'back door', TASId: 9, VATNumber: '515195360', IsFirstOrder: true }],
};
function fakeFetch(handler) { const calls = []; globalThis.fetch = async (url, opt = {}) => { calls.push({ url: String(url), method: opt.method || 'GET', body: opt.body }); return handler(String(url), opt); }; return calls; }
const res = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('maps a delivery from the main system', () => {
  const t = mapTask(MODEL.Tasks[0]);
  assert.deepEqual({ id: t.id, due: t.due, boxes: t.boxes, terms: t.terms, firstOrder: t.firstOrder, completed: t.completed }, { id: 812, due: 1500, boxes: 2, terms: 'שוטף+30', firstOrder: true, completed: false });
  assert.equal(t.created, new Date(1792900000000).toISOString());
});

test('reads the list; an error from the main system means not found', async () => {
  const calls = fakeFetch(url => url.endsWith(GUID) ? res(MODEL) : res('error', 500));
  const list = await getMainList(GUID);
  assert.equal(list.person, 'Moshe');
  assert.equal(list.tasks.length, 1);
  assert.equal(calls[0].url, `https://abcmobile.shop/DeliveryList/GetModel/${GUID}`);
  assert.equal(await getMainList('99999999-2222-3333-4444-555555555555'), null);
});

test('a master link returns the drivers in it', async () => {
  fakeFetch(() => res({ IsMasterLink: true, PersonalModels: { Moshe: MODEL, Avi: { ...MODEL, Tasks: [{ ...MODEL.Tasks[0], GUID: 'other' }] } } }));
  const m = await getMainList(GUID);
  assert.equal(m.master, true);
  assert.deepEqual(m.people.map(p => p.person), ['Moshe', 'Avi']);
});

test('reads by default; writes nothing unless MAIN_WRITE is on and MAIN_READ is not off', async () => {
  const calls = fakeFetch(() => res({ Status: 200 }));
  delete process.env.MAIN_READ; delete process.env.MAIN_WRITE;
  assert.equal(readsOn(), true, 'reading is on by default');
  assert.equal(writesOn(), false);
  process.env.MAIN_READ = 'off';
  assert.equal(readsOn(), false);
  assert.deepEqual(await finalize({ id: 1, name: 'x', signatureB64: 'a', packageB64: 'b', amountPaid: 1 }), { skipped: true });
  process.env.MAIN_WRITE = 'on';
  assert.equal(writesOn(), false, 'MAIN_WRITE with MAIN_READ=off is not enough');
  assert.deepEqual(await setPositions(GUID, [1, 2]), { skipped: true });
  assert.equal(calls.length, 0);
  delete process.env.MAIN_READ;
  const r = await finalize({ id: 812, name: 'Danny', signatureB64: 'SIG', packageB64: 'PKG', amountPaid: 1500 });
  assert.equal(r.ok, true);
  const body = JSON.parse(calls[0].body);
  assert.equal(calls[0].url, 'https://abcmobile.shop/DeliveryList/FinalizeSignature/');
  // The receipt is never sent: the main system would save it over the package photo
  assert.deepEqual(body, { id: 812, name: 'Danny', imageData: 'SIG', deliveryPictureData: 'PKG', receiptPictureData: '', amountPaid: 1500 });
  delete process.env.MAIN_READ; delete process.env.MAIN_WRITE;
});

test('a "Task Not Found" answer counts as a failure', async () => {
  process.env.MAIN_READ = 'on'; process.env.MAIN_WRITE = 'on';
  fakeFetch(() => res({ Status: 404, Message: 'Task Not Found' }));
  assert.equal((await finalize({ id: 1, name: 'x', signatureB64: '', packageB64: '', amountPaid: 0 })).ok, false);
  delete process.env.MAIN_READ; delete process.env.MAIN_WRITE;
});
