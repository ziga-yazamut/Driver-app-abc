// GET /api/list?guid=<GUID>: the driver's deliveries, read from the main system only (no Supabase).
// The day comes from the main system too: the start-of-day confirmations (PreCheck1-3), the day closed (DayClosed);
// the driver's order is the order GetModel returns (Completed, then Position).
// results: the finished deliveries (Completed), as the list shows them.
// saved:   everything the main system has for a delivery, also one that was reopened, so its steps can be filled in again.
// A master link (several drivers) returns the drivers to pick from.
import { json, handle } from '../lib/http.mjs';
import { getList } from '../lib/source.mjs';
import { photoUrl } from '../lib/abc.mjs';
import { validGuid } from '../lib/driver.mjs';

// What the list needs of a finished delivery (no photos)
const summary = s => ({
  status: s.status, reason: s.reason, finished_at: s.finished_at, receiver_name: s.receiver_name,
  boxes_delivered: s.boxes_delivered, amount_paid: s.amount_paid,
  payments: s.payments.map(p => ({ type: p.type, amount: p.amount, checkNum: p.checkNum })),
});
// For filling the steps again: the photos as links, each payment with its PaymentID
const forDraft = s => ({
  status: s.status, receiver_name: s.receiver_name, boxes_delivered: s.boxes_delivered, diff_reason: s.diff_reason, rma_note: s.rma_note,
  photos: { signature: s.photos.signature, package: s.photos.package, receipt: s.photos.receipt, rma: s.photos.rma },
  urls: { signature: photoUrl(s.photos.signature), package: photoUrl(s.photos.package), receipt: photoUrl(s.photos.receipt), rma: photoUrl(s.photos.rma) },
  payments: s.payments.map(p => ({ ...p, photo_url: photoUrl(p.photo) })),
});

export default handle(async req => {
  const guid = new URL(req.url).searchParams.get('guid') || '';
  if (!validGuid(guid)) return json({ error: 'bad_link' }, 400);
  const list = await getList(guid);
  if (!list) return json({ error: 'not_found' }, 404);
  if (list.master) return json({ master: true, people: list.people.map(p => ({ person: p.person, guid: p.guid, count: p.tasks.length })) });
  const { preChecks, dayClosed, saved, ...rest } = list;
  const done = new Set(list.tasks.filter(t => t.completed).map(t => t.id));
  return json({
    ...rest,
    // The app only checks that accepted_at / closed_at are set; the main system keeps no time for them
    day: { accepted_at: preChecks.every(Boolean) ? 'main' : null, order: [], closed_at: dayClosed ? 'main' : null },
    results: Object.fromEntries(Object.entries(saved).filter(([id]) => done.has(+id)).map(([id, s]) => [id, summary(s)])),
    saved: Object.fromEntries(Object.entries(saved).map(([id, s]) => [id, forDraft(s)])),
    source: list.from,
  }, 200, { 'Cache-Control': 'no-store' });
});

export const config = { path: '/api/list' };
