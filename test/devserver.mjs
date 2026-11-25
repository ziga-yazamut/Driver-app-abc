// Local stand-in for Netlify and the main system (abcmobile), for the tests and for trying the app with no account.
// Serves public/ with the netlify.toml redirects, runs netlify/functions/* on /api/*, and fakes the main system's
// driver-link endpoints on /main (GetModel, FinalizeDelivery, SetCompleted, ReopenDelivery, SetPreCheck, SetPositions,
// ConfirmPackage, NotifyOffice) and its photos (/main/Data/Signatures/...), kept in memory.
// Usage: node test/devserver.mjs [port]   then POST /test/new-list for a driver link, and open /d/<GUID>
// Test helpers: POST /test/new-list {person}  -> {guid}: a fresh list with 4 sample deliveries
//               GET  /test/main?guid=<GUID>   -> what the fake main system holds for that list (to check what was saved)
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.argv[2] || process.env.PORT || 8888);
const BASE = `http://localhost:${PORT}`;
process.env.MAIN_URL_OVERRIDE = `${BASE}/main`;   // never the live abcmobile.shop

/* ---------- fake main system ---------- */
export const MASTER_GUID = 'cccccccc-1111-4222-8333-dddddddddddd';
const lists = new Map();      // GUID -> { person, preChecks: [b, b, b], dayClosed, ids: [] }
const deliveries = new Map(); // DeliveryGUIDId -> the task (DeliveryTasks) and its DeliveryGuids fields
const payments = [];          // PaymentsCustomersWeek rows of the driver app
const photos = new Map();     // path under /Data/Signatures -> bytes
let nextId = 5000, nextPayment = 1;
const SAMPLE = [
  ['Sample customer A', 'Ra\'anana', '12 Herzl St.', 1250, 'Check 45 days', 2],
  ['Sample customer B', 'Kfar Saba', '45 Weizmann St.', 890, 'Cash', 1],
  ['Sample customer C', 'Hod HaSharon', '8 HaTa\'asiya St.', 0, 'Prepaid', 3],
  ['Sample customer D', 'Herzliya', '3 HaYam St.', 3400, 'Credit', 4],
];
const msDate = d => `/Date(${new Date(d).getTime()})/`;

function newList(person = 'Moshe', guid = crypto.randomUUID()) {
  const ids = SAMPLE.map(([company, city, address, total, terms, boxes], i) => {
    const id = nextId++;
    deliveries.set(id, { DeliveryGUIDId: id, GUID: guid, Company: company, City: city, Address: address, PhoneNumber: '050-000000' + i,
      Total: total, Paid: 0, PaymentTerms: terms, TotalPackages: boxes, Completed: false, Position: i, Confirmed: false,
      DeliveryPerson: person, DeliveryComment: '', CreationDate: msDate('2026-10-27T08:00:00Z'), TASId: id, IsFirstOrder: false, VATNumber: '' });
    return id;
  });
  lists.set(guid, { person, preChecks: [false, false, false], dayClosed: false, ids });
  return guid;
}
const MAIN_GUID = newList('Main driver', 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb');

function model(guid) {
  const l = lists.get(guid);
  const tasks = l.ids.map(id => deliveries.get(id));
  return {
    GUID: guid, DeliveryPerson: l.person, ListDate: '27/10/2026', PreCheck1: l.preChecks[0], PreCheck2: l.preChecks[1], PreCheck3: l.preChecks[2], DayClosed: l.dayClosed,
    Tasks: tasks.map(t => ({ ...t, Completed: t.Completed })).sort((a, b) => (a.Completed - b.Completed) || (a.Position - b.Position)),
    Results: tasks.map(t => ({
      DeliveryGUIDId: t.DeliveryGUIDId, Completed: t.Completed, DeliveryTime: t.DeliveryTime || null, RecipientName: t.RecipientName || null,
      AmountPaid: t.AmountPaid ?? null, BoxDelivered: t.BoxDelivered ?? null, DifferenceReason: t.DifferenceReason || null,
      FailedDelivery: !!t.FailedDelivery, FailedDeliveryReason: t.FailedDeliveryReason || null, RecipientSignatureFile: t.RecipientSignatureFile || null,
      DeliveryPackagePhoto: t.DeliveryPackagePhoto || null, ReceiptPhoto: t.ReceiptPhoto || null, ReturnPhoto: t.ReturnPhoto || null, ReturnComment: t.ReturnComment || null,
      Payments: payments.filter(p => p.DeliveryGUIDId === t.DeliveryGUIDId),
    })),
  };
}

const savePhoto = (file, b64) => { if (!b64) return null; photos.set(file, Buffer.from(b64, 'base64')); return file; };

// FinalizeDelivery as in DeliveryListController: delivered = the signature part (FinalizeSignature) + payments + extra fields;
// finishing again updates: payments matched by paymentId, else in order; the ones not sent are deleted
function finalizeDelivery(m) {
  const t = deliveries.get(m.id);
  if (!t) return { Status: 404, Message: 'Task Not Found' };
  const sent = m.failedDelivery ? [] : (m.payments || []);
  if (sent.some(p => !['CHECK', 'CASH', 'CC'].includes(p.methodType) || !(p.amount > 0))) return { Status: 400, Message: 'Bad payment' };
  if (m.failedDelivery && !m.failedDeliveryReason) return { Status: 400, Message: 'Failed delivery needs a reason' };
  if (!m.failedDelivery) {
    if (!m.imageData) return { Status: 400, Message: 'Signature is missing' };
    t.RecipientSignatureFile = savePhoto(`/DeliverySignatures/DeliverySignature_${m.id}.png`, m.imageData);
    t.DeliveryPackagePhoto = savePhoto(`/DeliverySignatures/DeliverySignature_PackagePicture_${m.id}.jpg`, m.deliveryPictureData) || t.DeliveryPackagePhoto;
    t.ReceiptPhoto = savePhoto(`/DeliverySignatures/DeliverySignature_ReceiptPicture_${m.id}.jpg`, m.receiptPictureData) || t.ReceiptPhoto;
    t.AmountPaid = m.amountPaid; t.RecipientName = m.name; t.DeliveryTime = msDate(Date.now());
  } else t.DeliveryTime = msDate(Date.now());
  const existing = payments.filter(p => p.DeliveryGUIDId === m.id);
  const unmatched = [...existing];
  const targets = sent.map(p => { const i = unmatched.findIndex(e => e.PaymentID === p.paymentId); return i >= 0 ? unmatched.splice(i, 1)[0] : null; });
  sent.forEach((p, i) => { if (!targets[i] && unmatched.length) targets[i] = unmatched.shift(); });
  for (const old of unmatched) payments.splice(payments.indexOf(old), 1);
  const n = { CHECK: 0, CASH: 0 };
  sent.forEach((p, i) => {
    let row = targets[i];
    if (!row) { row = { PaymentID: nextPayment++, DeliveryGUIDId: m.id }; payments.push(row); }
    Object.assign(row, { MethodType: p.methodType, Total: p.amount, Approved: false, CHECK_Number: p.checkNumber || null, CHECK_Bank: p.checkBank || null,
      CHECK_Branch: p.checkBranch || null, CHECK_Date: p.checkDate ? msDate(p.checkDate + 'T00:00:00+02:00') : null,
      Comment: [p.checkAccount && `Account ${p.checkAccount}`, p.checkHolder && `Holder ${p.checkHolder}`, p.checkHolderId && `Holder ID ${p.checkHolderId}`].filter(Boolean).join(', ') || null });
    if (p.methodType in n) {
      n[p.methodType]++;
      const kind = p.methodType === 'CHECK' ? 'Cheque' : 'Cash';
      row.PaymentPhoto = savePhoto(`/DeliverySignatures/DeliverySignature_${kind}Picture${n[p.methodType]}_${m.id}.jpg`, p.paymentPictureData) || row.PaymentPhoto || null;
    }
  });
  Object.assign(t, { FailedDelivery: !!m.failedDelivery, FailedDeliveryReason: m.failedDelivery ? m.failedDeliveryReason : null,
    BoxDelivered: m.failedDelivery ? 0 : m.boxDelivered, DifferenceReason: m.failedDelivery ? null : m.differenceReason || null });
  if (!m.failedDelivery) {
    t.ReturnPhoto = savePhoto(`/DeliverySignatures/Returns/ReturnPicture_${m.id}.jpg`, m.returnPictureData) || t.ReturnPhoto;
    t.ReturnComment = m.returnComment || null;
  }
  return { Status: 200, Payments: sent.length };
}

function mainSystem(req, res, url, body) {
  const send = (data, code = 200) => { res.writeHead(code, { 'Content-Type': typeof data === 'string' ? 'text/plain' : 'application/json' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
  const p = url.pathname.replace(/^\/main/, '').replace(/\/+$/, '');
  let m;
  if (req.method === 'GET' && (m = /^\/Data\/Signatures(\/.+)$/.exec(p))) {
    const f = photos.get(m[1]);
    if (!f) return send('not found', 404);
    res.writeHead(200, { 'Content-Type': m[1].endsWith('.png') ? 'image/png' : 'image/jpeg' }); return res.end(f);
  }
  if (req.method === 'GET' && (m = /^\/DeliveryList\/GetModel\/(.+)$/.exec(p))) {
    if (m[1] === MASTER_GUID) return send({ IsMasterLink: true, PersonalModels: { 'Main driver': model(MAIN_GUID) } });
    if (!lists.has(m[1])) return send('Index was out of range', 500);   // what the main system does for an unknown GUID
    return send(model(m[1]));
  }
  if (req.method !== 'POST') return send('not found', 404);
  const task = id => deliveries.get(id);
  switch (p) {
    case '/DeliveryList/FinalizeDelivery': return send(finalizeDelivery(body));
    case '/DeliveryList/SetCompleted': { const t = task(body.id); if (!t) return send('Task Not Found'); t.Completed = !!body.completed; return send('OK'); }
    case '/DeliveryList/ConfirmPackage': { const t = task(body.DeliveryGUIDId); if (!t) return send('Not Found'); t.Confirmed = true; return send('OK'); }
    case '/DeliveryList/ReopenDelivery': { const t = task(body.id); if (!t) return send('Task Not Found'); t.Completed = false; lists.get(t.GUID).dayClosed = false; return send('OK'); }
    case '/DeliveryList/SetPreCheck': { const l = lists.get(body.guid); if (!l) return send('Task Not Found'); l.preChecks[body.number - 1] = !!body.state; return send('OK'); }
    case '/DeliveryList/SetPositions': { for (const x of body.Positions || []) { const t = task(x.DeliveryGUIDId); if (t && t.GUID === body.GUID) t.Position = x.Position; } return send('OK'); }
    case '/DeliveryList/NotifyOffice': { const l = lists.get(body.GUID); if (!l) return send({ Status: 404, Message: 'Task Not Found' }); l.dayClosed = true; return send({ Status: 200 }); }
  }
  send('not found', 404);
}

/* ---------- functions ---------- */
const routes = {};
for (const f of await readdir(path.join(root, 'netlify/functions'))) {
  const mod = await import(pathToFileURL(path.join(root, 'netlify/functions', f)).href);
  routes[mod.config.path] = mod.default;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const body = () => { try { return JSON.parse(raw.toString() || '{}'); } catch { return {}; } };
  try {
    if (url.pathname.startsWith('/main/')) return mainSystem(req, res, url, body());
    if (url.pathname === '/test/new-list' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ guid: newList(body().person) }));
    }
    if (url.pathname === '/test/main') {
      const guid = url.searchParams.get('guid'), l = lists.get(guid);
      res.writeHead(l ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(l ? { ...l, deliveries: l.ids.map(id => deliveries.get(id)), payments: payments.filter(p => l.ids.includes(p.DeliveryGUIDId)) } : {}));
    }
    if (routes[url.pathname]) {
      const r = await routes[url.pathname](new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw }), {});
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (/^\/(d|DeliveryList\/Single)\//.test(file)) file = '/index.html';
    const data = await readFile(path.join(root, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, '')));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('not found'); }
    console.error(e); res.writeHead(500); res.end(e.message);
  }
});
server.listen(PORT, () => console.log(`driver app on ${BASE}  (fake main system on ${BASE}/main; a list: POST ${BASE}/test/new-list)`));
