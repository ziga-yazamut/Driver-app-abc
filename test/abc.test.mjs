// The main system client (netlify/lib/abc.mjs) against a fake fetch: reading the driver's list, and what is sent
// to it. The main system is the app's only backend: every write is always sent (there is no switch to turn it off).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMainList, finalizeDelivery as finalize, setPositions, mapTask, MAIN_URL } from '../netlify/lib/abc.mjs';

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
  assert.equal(calls[0].url, `${MAIN_URL}/DeliveryList/GetModel/${GUID}`);
  assert.equal(await getMainList('99999999-2222-3333-4444-555555555555'), null);
});

test('a master link returns the drivers in it', async () => {
  fakeFetch(() => res({ IsMasterLink: true, PersonalModels: { Moshe: MODEL, Avi: { ...MODEL, Tasks: [{ ...MODEL.Tasks[0], GUID: 'other' }] } } }));
  const m = await getMainList(GUID);
  assert.equal(m.master, true);
  assert.deepEqual(m.people.map(p => p.person), ['Moshe', 'Avi']);
});

test('always writes, even with the old MAIN_WRITE=off / MAIN_READ=off set; sends FinalizeDelivery', async () => {
  const calls = fakeFetch(() => res({ Status: 200 }));
  process.env.MAIN_WRITE = 'off'; process.env.MAIN_READ = 'off';   // the old switches no longer do anything
  assert.equal((await setPositions(GUID, [1, 2])).ok, true);
  assert.equal(calls.length, 1, 'the write was sent');
  assert.equal(calls[0].url, `${MAIN_URL}/DeliveryList/SetPositions/`);
  calls.length = 0;
  delete process.env.MAIN_READ; delete process.env.MAIN_WRITE;
  const r = await finalize({ id: 812, name: 'Danny', signatureB64: 'SIG', packageB64: 'PKG', receiptB64: 'RCP', amountPaid: 1500, boxes: 2, diffReason: 'partial',
    rmaB64: 'RMA', rmaNote: 'one broken',
    payments: [{ id: 77, type: 'check', amount: 1000, checkNum: '123', bank: '12', branch: '345', account: '678', holder: 'Kirur', holderId: '515', dueDate: '2026-12-01', photoB64: 'CHK' },
      { type: 'cash', amount: 300, photoB64: 'CSH' }, { type: 'credit', amount: 200 }] });
  assert.equal(r.ok, true);
  const body = JSON.parse(calls[0].body);
  assert.equal(calls[0].url, `${MAIN_URL}/DeliveryList/FinalizeDelivery/`, 'FinalizeDelivery, never FinalizeSignature');
  assert.deepEqual(body, { id: 812, name: 'Danny', imageData: 'SIG', deliveryPictureData: 'PKG', receiptPictureData: 'RCP', amountPaid: 1500, noResize: true,
    failedDelivery: false, failedDeliveryReason: null, boxDelivered: 2, differenceReason: 'partial', returnPictureData: 'RMA', returnComment: 'one broken',
    payments: [
      { paymentId: 77, methodType: 'CHECK', amount: 1000, paymentPictureData: 'CHK', checkNumber: '123', checkBank: '12', checkBranch: '345', checkAccount: '678', checkHolder: 'Kirur', checkHolderId: '515', checkDate: '2026-12-01' },
      { paymentId: null, methodType: 'CASH', amount: 300, paymentPictureData: 'CSH' }, { paymentId: null, methodType: 'CC', amount: 200, paymentPictureData: '' }] });
  calls.length = 0;
  await finalize({ id: 812, failed: true, failedReason: 'absent', payments: [{ type: 'cash', amount: 5 }] });
  const failed = JSON.parse(calls[0].body);
  assert.deepEqual({ f: failed.failedDelivery, r: failed.failedDeliveryReason, b: failed.boxDelivered, p: failed.payments, s: failed.imageData },
    { f: true, r: 'absent', b: 0, p: [], s: '' }, 'a failed delivery sends no payments and no signature');
});

test('reads back what the main system saved (GetModel Results)', async () => {
  fakeFetch(() => res({ ...MODEL, PreCheck1: true, PreCheck2: true, PreCheck3: false, DayClosed: true, Results: [
    { DeliveryGUIDId: 812, Completed: true, DeliveryTime: '/Date(1792900000000)/', RecipientName: 'Danny', AmountPaid: 1500, BoxDelivered: 2, DifferenceReason: 'partial',
      FailedDelivery: false, RecipientSignatureFile: '/DeliverySignatures/DeliverySignature_812.png', DeliveryPackagePhoto: '/DeliverySignatures/P_812.jpg',
      ReturnPhoto: '/DeliverySignatures/Returns/ReturnPicture_812.jpg', ReturnComment: 'one broken',
      Payments: [{ PaymentID: 77, MethodType: 'CHECK', Total: 1500, CHECK_Number: '123', CHECK_Bank: '12', CHECK_Branch: '345', CHECK_Date: `/Date(${Date.UTC(2026, 10, 30, 22)})/`, /* 2026-12-01 00:00 in Israel */
        PaymentPhoto: '/DeliverySignatures/DeliverySignature_ChequePicture1_812.jpg', Comment: 'Account 678, Holder Kirur Plus, Holder ID 515', Approved: false },
      { PaymentID: 78, MethodType: 'CHECK', Total: 1, Comment: '[Driver app, delivery 812] Account 9, Holder ID 7', Approved: false }] },
    { DeliveryGUIDId: 813, Completed: false, Payments: [] }] }));
  const list = await getMainList(GUID);
  assert.deepEqual(list.preChecks, [true, true, false]);
  assert.equal(list.dayClosed, true);
  assert.deepEqual(Object.keys(list.saved), ['812'], 'a delivery with nothing saved is left out');
  const s = list.saved[812];
  assert.equal(s.status, 'delivered');
  assert.equal(s.rma_note, 'one broken');
  assert.deepEqual(s.payments[0], { id: 77, type: 'check', amount: 1500, approved: false, checkNum: '123', bank: '12', branch: '345', dueDate: '2026-12-01',
    account: '678', holder: 'Kirur Plus', holderId: '515', photo: '/DeliverySignatures/DeliverySignature_ChequePicture1_812.jpg' });
  const old = s.payments[1];   // an earlier version's Comment, and no holder name
  assert.deepEqual({ a: old.account, h: old.holder, i: old.holderId }, { a: '9', h: '', i: '7' });
});

test('a "Task Not Found" answer counts as a failure', async () => {
  fakeFetch(() => res({ Status: 404, Message: 'Task Not Found' }));
  assert.equal((await finalize({ id: 1, name: 'x', signatureB64: '', packageB64: '', amountPaid: 0 })).ok, false);
});
