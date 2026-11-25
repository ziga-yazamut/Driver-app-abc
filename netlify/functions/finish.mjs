// POST /api/finish {guid, id, result}: a finished delivery, saved in the main system only (no Supabase).
// Delivered: ConfirmPackage -> FinalizeDelivery -> SetCompleted(true), as the existing driver page does.
//   FinalizeDelivery gets the signature, receiver name, package photo, receipt photo, amountPaid (= the sum of the payments),
//   each payment (check details, check / cash photo), boxes delivered, the difference reason, the returns photo and note.
// Not delivered: FinalizeDelivery with failedDelivery and the reason -> SetCompleted(true), so the stop is done in the app.
// Finishing again (a retry, or after "reopen") updates what the main system has: a photo not sent keeps the saved one,
// a payment with its id updates that payment. A reopened delivery whose signature was not drawn again sends the saved one.
//
// result: {status: delivered|not_delivered, reason, boxes, receiver, signature (data URL), packages[], receipts[], rma[] (data URLs,
//          the first one is used), payments[{id, type, amount, photo (data URL), checkNum, bank, branch, account, holder,
//          holderId, dueDate}], diffReason, rmaNote}
import { json, handle } from '../lib/http.mjs';
import { finalizeDelivery, setCompleted, confirmPackage, savedPhotoB64 } from '../lib/abc.mjs';
import { validGuid, validId, taskOf, REASONS, PAY_TYPES } from '../lib/driver.mjs';

const txt = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const money = v => Math.round((Number(v) || 0) * 100) / 100;
// A data URL from the phone -> the bare base64 the main system expects
const b64 = (v, types = ['jpeg', 'png']) => { const m = /^data:image\/(\w+);base64,([A-Za-z0-9+/=]+)$/.exec(v || ''); return m && types.includes(m[1]) ? m[2] : null; };
const first = a => b64(Array.isArray(a) ? a[0] : null) || '';
const MAX_B64 = 5.5 * 1024 * 1024;   // a function's request can't be over 6 MB

export default handle(async req => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const { guid, id, result: r } = await req.json().catch(() => ({}));
  if (!validGuid(guid) || !validId(id) || !r || typeof r !== 'object') return json({ error: 'bad_request' }, 400);
  const delivered = r.status === 'delivered';
  if (!delivered && r.status !== 'not_delivered') return json({ error: 'bad_status' }, 400);
  if (!delivered && !REASONS.includes(r.reason)) return json({ error: 'bad_reason' }, 400);
  const { list, task } = await taskOf(guid, id);
  if (!task) return json({ error: 'not_found' }, 404);
  const saved = list.saved[id];
  const finished_at = new Date().toISOString();

  if (!delivered) {
    for (const [step, call] of [
      ['FinalizeDelivery', () => finalizeDelivery({ id, failed: true, failedReason: r.reason })],
      ['SetCompleted', () => setCompleted(id, true)],
    ]) { const res = await call(); if (!res.ok) return mainFailed(id, step, res); }
    return json({ ok: true, finished_at, main: 'sent' });
  }

  const name = txt(r.receiver, 80);
  // A reopened delivery keeps its signature unless the customer signed again
  const signature = b64(r.signature, ['png', 'jpeg']) || (saved?.status === 'delivered' ? await savedPhotoB64(saved.photos.signature) : null);
  const pkg = first(r.packages), receipt = first(r.receipts), rma = first(r.rma);
  if (!name || !signature || !(pkg || saved?.photos.package)) return json({ error: 'incomplete' }, 400);

  const savedIds = new Set((saved?.payments || []).map(p => p.id));
  const payments = (Array.isArray(r.payments) ? r.payments : []).slice(0, 20)
    .filter(p => PAY_TYPES.includes(p?.type) && money(p.amount) > 0)
    .map(p => ({
      id: savedIds.has(p.id) ? p.id : null, type: p.type, amount: money(p.amount),
      photoB64: p.type === 'credit' ? '' : b64(p.photo) || '',
      ...(p.type === 'check' ? { checkNum: txt(p.checkNum, 20), bank: txt(p.bank, 5), branch: txt(p.branch, 8), account: txt(p.account, 20),
        holder: txt(p.holder, 80), holderId: txt(p.holderId, 12), dueDate: /^\d{4}-\d{2}-\d{2}$/.test(p.dueDate || '') ? p.dueDate : null } : {}),
    }));
  const amountPaid = money(payments.reduce((a, p) => a + p.amount, 0));
  const size = signature.length + pkg.length + receipt.length + rma.length + payments.reduce((a, p) => a + p.photoB64.length, 0);
  if (size > MAX_B64) return json({ error: 'too_big', message: 'Too many photos to send at once' }, 413);
  const diffReason = amountPaid !== task.due ? txt(r.diffReason, 200) || null : null;
  const boxes = Math.max(0, Math.min(999, parseInt(r.boxes, 10) || 0));

  for (const [step, call] of [
    ['ConfirmPackage', () => confirmPackage(id)],
    ['FinalizeDelivery', () => finalizeDelivery({ id, name, signatureB64: signature, packageB64: pkg, receiptB64: receipt, amountPaid, boxes, diffReason,
      payments, rmaB64: rma, rmaNote: txt(r.rmaNote, 200) })],
    ['SetCompleted', () => setCompleted(id, true)],
  ]) { const res = await call(); if (!res.ok) return mainFailed(id, step, res); }
  return json({ ok: true, finished_at, main: 'sent', amount_paid: amountPaid });
});

function mainFailed(id, step, res) {
  console.error(`main ${step} failed for ${id}`, res.status, res.text);
  return json({ error: 'main_failed', message: `${step}: ${res.status} ${res.text}`.trim() }, 502);
}

export const config = { path: '/api/finish' };
