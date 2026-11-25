// The main system (abcmobile.shop), the driver app's only backend: the driver-link endpoints in
// MobileParts/Controllers/DeliveryListController.cs. Everything is read from it and saved to it.
// Reading:                 GET  /DeliveryList/GetModel/<GUID>   the driver's deliveries and what was saved for them
// Writing (changes real orders):
//   POST /DeliveryList/FinalizeDelivery   a finished delivery: everything FinalizeSignature takes (signature, receiver name,
//                                         package and receipt photos, amount paid; it calls FinalizeSignature, which marks
//                                         the customer's orders as Delivered), plus each payment (PaymentsCustomersWeek,
//                                         Approved = false, DeliveryGUIDId) with check details and a check / cash photo,
//                                         boxes delivered, the reason for a difference, the returns photo and comment, and a
//                                         failed delivery with its reason (DeliveryGuids). Sending it again updates, never adds twice.
//                                         The app never calls FinalizeSignature itself; it stays for the old driver page.
//   POST /DeliveryList/SetCompleted       the green tick on the existing driver page
//   POST /DeliveryList/ReopenDelivery     "My mistake, reopen": not completed, the day not closed; nothing is deleted
//   POST /DeliveryList/SetPositions       the driver's order
//   POST /DeliveryList/SetPreCheck        the three start-of-day confirmations (PreCheck1-3)
//   POST /DeliveryList/NotifyOffice       "Close the day": DayClosed, and a WhatsApp to the office
//   POST /DeliveryList/ConfirmPackage     the delivery's packages confirmed

// THE SWITCH: the main system's address. The live system; for the local copy use 'http://localhost:48289'
// (or MAIN_URL_OVERRIDE=http://localhost:48289 in .env, which wins over this).
export const MAIN_URL = 'https://abcmobile.shop';
// MAIN_URL_OVERRIDE also exists for tests against a mock address.
export const base = () => (process.env.MAIN_URL_OVERRIDE || MAIN_URL).replace(/\/+$/, '');

// The GUID in the driver's link. The link itself is the access, as it is on the existing driver page.
export const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class MainError extends Error {}

// ASP.NET MVC Json() writes dates as "/Date(1729847000000)/"
const asDate = v => { const m = /Date\((-?\d+)/.exec(v || ''); return m ? new Date(+m[1]).toISOString() : null; };
const num = v => Number(v) || 0;
// A date-only value (a check's due date, saved as local midnight in Israel) -> "yyyy-mm-dd" as it was typed
const asDay = v => { const m = /Date\((-?\d+)/.exec(v || ''); return m ? new Date(+m[1]).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) : ''; };

// One delivery as the app uses it. Field names on the left are the app's; on the right, the main system's.
export function mapTask(t) {
  return {
    id: t.DeliveryGUIDId,
    company: t.Company || '',
    city: t.City || '',
    address: t.Address || '',
    phone: t.PhoneNumber || '',
    total: num(t.Total),
    paid: num(t.Paid),
    due: Math.max(0, Math.round((num(t.Total) - num(t.Paid)) * 100) / 100),
    terms: t.PaymentTerms || '',
    boxes: t.TotalPackages || 0,
    comment: t.DeliveryComment || '',
    firstOrder: !!t.IsFirstOrder,
    vat: t.VATNumber || '',
    position: t.Position ?? null,
    completed: !!t.Completed,   // done on the existing driver page
    created: asDate(t.CreationDate),
  };
}

// A photo path saved by the main system (relative to /Data/Signatures) -> a link the phone can open
export const photoUrl = p => p ? `${base()}/Data/Signatures${p}` : null;
export const SAVED_PATH = /^\/DeliverySignatures\/(?!.*\.\.)[\w./-]+\.(png|jpg)$/;
const TYPES_BACK = { CHECK: 'check', CASH: 'cash', CC: 'credit' };
// Check details that have no column yet are in the payment's Comment: "Account 1, Holder X, Holder ID 2"
// (rows from an earlier version start with "[Driver app, delivery N] "). "Holder" must not read "Holder ID 2".
const fromComment = (c, label) => { const m = new RegExp(`(?:^|[\\],] )${label} (?!ID )([^,]*)`).exec(c || ''); return m ? m[1].trim() : ''; };

// What the main system saved for one delivery (GetModel Results), in the app's words
export function mapResult(r) {
  const failed = !!r.FailedDelivery;
  return {
    status: failed ? 'not_delivered' : 'delivered',
    reason: failed ? r.FailedDeliveryReason || null : null,
    completed: !!r.Completed,
    finished_at: asDate(r.DeliveryTime),
    receiver_name: r.RecipientName || '',
    boxes_delivered: r.BoxDelivered ?? null,
    amount_paid: num(r.AmountPaid),
    diff_reason: r.DifferenceReason || null,
    rma_note: r.ReturnComment || '',
    photos: { signature: r.RecipientSignatureFile || null, package: r.DeliveryPackagePhoto || null, receipt: r.ReceiptPhoto || null, rma: r.ReturnPhoto || null },
    payments: (r.Payments || []).filter(p => TYPES_BACK[p.MethodType]).map(p => ({
      id: p.PaymentID, type: TYPES_BACK[p.MethodType], amount: num(p.Total), approved: p.Approved === true,
      checkNum: p.CHECK_Number || '', bank: p.CHECK_Bank || '', branch: p.CHECK_Branch || '', dueDate: asDay(p.CHECK_Date),
      account: fromComment(p.Comment, 'Account'), holder: fromComment(p.Comment, 'Holder'), holderId: fromComment(p.Comment, 'Holder ID'),
      photo: p.PaymentPhoto || null,
    })),
  };
}
// Something was saved for it (a delivery that was never finished has an empty row)
const hasResult = r => !!(r.DeliveryTime || r.FailedDelivery || r.RecipientSignatureFile || (r.Payments || []).length);

function mapList(m, guid) {
  const tasks = (m.Tasks || []).map(mapTask);
  // ListDate is in the server's local format; the first delivery's creation date is unambiguous
  return { guid: m.GUID || guid, person: m.DeliveryPerson || '', date: tasks[0]?.created?.slice(0, 10) || m.ListDate || '', tasks,
    // The three start-of-day confirmations, set by SetPreCheck (1 = checks, 2 = packages, 3 = the third rule)
    preChecks: [!!m.PreCheck1, !!m.PreCheck2, !!m.PreCheck3],
    dayClosed: !!m.DayClosed,
    saved: Object.fromEntries((m.Results || []).filter(hasResult).map(r => [r.DeliveryGUIDId, mapResult(r)])) };
}

// A master link holds several drivers; each has his own GUID inside (Tasks[0].GUID).
export async function getMainList(guid) {
  let res;
  try {
    res = await fetch(`${base()}/DeliveryList/GetModel/${guid}`, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new MainError(`main system unreachable: ${e.message}`);
  }
  // An unknown GUID makes the main system fail (it reads Tasks[0] of an empty list), so any error = not found
  if (!res.ok) return null;
  const m = await res.json().catch(() => null);
  if (!m) return null;
  if (m.IsMasterLink) {
    const people = Object.entries(m.PersonalModels || {}).map(([person, pm]) => ({ ...mapList(pm, pm.Tasks?.[0]?.GUID), person }));
    return { master: true, guid, people };
  }
  const list = mapList(m, guid);
  return list.tasks.length ? list : null;
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, status: 0, text: `main system unreachable: ${e.message}` };
  }
  let text = await res.text().catch(() => '');
  // An ASP.NET error page: its <title> holds the exception message
  const title = /<title>([\s\S]*?)<\/title>/i.exec(text);
  text = (title ? title[1].replace(/\s+/g, ' ').trim() : text).slice(0, 300);
  // The main system answers 200 with {Status: 404} or "Task Not Found" when the id is unknown
  const ok = res.ok && !/"Status"\s*:\s*(4|5)\d\d|Not Found/.test(text);
  return { ok, status: res.status, text };
}

// App payment types -> PaymentsCustomersWeek.MethodType
export const METHOD_TYPES = { check: 'CHECK', cash: 'CASH', credit: 'CC' };

// One finished delivery. Photos are bare base64 (no "data:" prefix); a photo not sent keeps the one already saved.
// Delivered: signatureB64 is required. Failed: failedReason is required, nothing else is needed.
// payments: [{id (PaymentID when already saved), type: check|cash|credit, amount, checkNum, bank, branch, account, holder,
//             holderId, dueDate, photoB64}]
export const finalizeDelivery = ({ id, name, signatureB64, packageB64, receiptB64, amountPaid, failed, failedReason, boxes, diffReason, payments, rmaB64, rmaNote }) =>
  post('/DeliveryList/FinalizeDelivery/', {
    id, name: name || '', imageData: signatureB64 || '', deliveryPictureData: packageB64 || '', receiptPictureData: receiptB64 || '', amountPaid: amountPaid || 0,
    noResize: true,   // the photos are already resized on the phone: the main system saves them as they are
    failedDelivery: !!failed, failedDeliveryReason: failed ? failedReason : null,
    boxDelivered: failed ? 0 : boxes ?? null, differenceReason: failed ? null : diffReason || null,
    returnPictureData: failed ? '' : rmaB64 || '', returnComment: failed ? null : rmaNote || null,
    payments: failed ? [] : (payments || []).map(p => ({
      paymentId: p.id || null, methodType: METHOD_TYPES[p.type], amount: p.amount, paymentPictureData: p.photoB64 || '',
      ...(p.type === 'check' ? { checkNumber: p.checkNum || '', checkBank: p.bank || '', checkBranch: p.branch || '', checkAccount: p.account || '',
        checkHolder: p.holder || '', checkHolderId: p.holderId || '', checkDate: p.dueDate || null } : {}),
    })),
  });
export const setCompleted = (id, completed) => post('/DeliveryList/SetCompleted/', { id, completed });
export const reopenDelivery = id => post('/DeliveryList/ReopenDelivery/', { id });
// A photo the main system already has, as bare base64 (to send the saved signature again when only the payments change)
export async function savedPhotoB64(path) {
  if (!SAVED_PATH.test(path || '')) return null;
  const res = await fetch(photoUrl(path)).catch(() => null);
  return res?.ok ? Buffer.from(await res.arrayBuffer()).toString('base64') : null;
}
// "Confirm Packages: N" on the existing driver page (sets Confirmed on the delivery)
export const confirmPackage = id => post('/DeliveryList/ConfirmPackage/', { DeliveryGUIDId: id });
export const setPositions = (guid, ids) => post('/DeliveryList/SetPositions/', { GUID: guid, Positions: ids.map((id, i) => ({ DeliveryGUIDId: id, Position: i })) });
export const setPreCheck = (guid, number, state) => post('/DeliveryList/SetPreCheck/', { guid, number, state });
export const notifyOffice = guid => post('/DeliveryList/NotifyOffice/', { GUID: guid });
