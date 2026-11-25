// GET /api/result?guid=&id=: one finished delivery with links to its photos (the delivery page), from the main system.
import { json, handle } from '../lib/http.mjs';
import { photoUrl } from '../lib/abc.mjs';
import { validGuid, validId, taskOf } from '../lib/driver.mjs';

export default handle(async req => {
  const p = new URL(req.url).searchParams, guid = p.get('guid') || '', id = parseInt(p.get('id'), 10);
  if (!validGuid(guid) || !validId(id)) return json({ error: 'bad_request' }, 400);
  const { list, task } = await taskOf(guid, id);
  const s = task && list.saved[id];
  if (!s) return json({ error: 'not_found' }, 404);
  const one = path => path ? [photoUrl(path)] : [];
  return json({
    status: s.status, reason: s.reason, finished_at: s.finished_at, receiver_name: s.receiver_name,
    boxes_delivered: s.boxes_delivered, amount_paid: s.amount_paid, diff_reason: s.diff_reason, rma_note: s.rma_note,
    signature_url: photoUrl(s.photos.signature), package_urls: one(s.photos.package), receipt_urls: one(s.photos.receipt), rma_urls: one(s.photos.rma),
    payments: s.payments.map(x => ({ ...x, photo_url: photoUrl(x.photo) })),
  }, 200, { 'Cache-Control': 'no-store' });
});

export const config = { path: '/api/result' };
