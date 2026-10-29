// The main system (abcmobile.shop): only the driver-link endpoints that already exist there
// (MobileParts/Controllers/DeliveryListController.cs). Nothing new is asked of the main system.
//
// Reading is on by default (Yonatan, 29.10: the driver's link from the main system is the whole flow);
// MAIN_READ=off turns it off. Lists typed in /office keep working either way (netlify/lib/source.mjs).
// Reading:                 GET  /DeliveryList/GetModel/<GUID>   the driver's deliveries
// Writing (also MAIN_WRITE=on):
//   POST /DeliveryList/FinalizeSignature  signature, receiver name, package photo, receipt photo, amount paid.
//                                         Also marks the customer's orders as Delivered.
//   POST /DeliveryList/SetCompleted       the green tick on the existing driver page
//   POST /DeliveryList/SetPositions       the driver's order
//   POST /DeliveryList/SetPreCheck        the two start-of-day confirmations (checks, packages)
//   POST /DeliveryList/NotifyOffice       WhatsApp to the office that the driver finished
// Writing touches real orders, so it stays off until Yonatan says so.

export const MAIN_URL = 'https://abcmobile.shop';
// MAIN_URL_OVERRIDE exists for tests against a mock address.
export const base = () => (process.env.MAIN_URL_OVERRIDE || MAIN_URL).replace(/\/+$/, '');
// on, true, yes or 1 (any case, spaces ignored)
const val = k => (process.env[k] || '').trim().toLowerCase();
const on = k => ['on', 'true', 'yes', '1'].includes(val(k));
export const readsOn = () => !['off', 'false', 'no', '0'].includes(val('MAIN_READ'));
export const writesOn = () => readsOn() && on('MAIN_WRITE');

// The GUID in the driver's link. The link itself is the access, as it is on the existing driver page.
export const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class MainError extends Error {}

// ASP.NET MVC Json() writes dates as "/Date(1729847000000)/"
const asDate = v => { const m = /Date\((-?\d+)/.exec(v || ''); return m ? new Date(+m[1]).toISOString() : null; };
const num = v => Number(v) || 0;

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

function mapList(m, guid) {
  const tasks = (m.Tasks || []).map(mapTask);
  // ListDate is in the server's local format; the first delivery's creation date is unambiguous
  return { guid: m.GUID || guid, person: m.DeliveryPerson || '', date: tasks[0]?.created?.slice(0, 10) || m.ListDate || '', tasks };
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
  if (!writesOn()) return { skipped: true };
  const res = await fetch(`${base()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = (await res.text().catch(() => '')).slice(0, 300);
  // The main system answers 200 with {Status: 404} or "Task Not Found" when the id is unknown
  const ok = res.ok && !/"Status"\s*:\s*(4|5)\d\d|Not Found/.test(text);
  return { ok, status: res.status, text };
}

// What the main system can store today. Payment method, check details, boxes, returns and "not delivered"
// stay in Supabase only. Known bug there: the receipt photo is saved over the package photo
// (both go into DeliveryPackagePhoto), so we send the package photo only; the receipt stays in Supabase.
export const finalize = ({ id, name, signatureB64, packageB64, amountPaid }) =>
  post('/DeliveryList/FinalizeSignature/', { id, name, imageData: signatureB64, deliveryPictureData: packageB64 || '', receiptPictureData: '', amountPaid });
export const setCompleted = (id, completed) => post('/DeliveryList/SetCompleted/', { id, completed });
export const setPositions = (guid, ids) => post('/DeliveryList/SetPositions/', { GUID: guid, Positions: ids.map((id, i) => ({ DeliveryGUIDId: id, Position: i })) });
export const setPreCheck = (guid, number, state) => post('/DeliveryList/SetPreCheck/', { guid, number, state });
export const notifyOffice = guid => post('/DeliveryList/NotifyOffice/', { GUID: guid });
