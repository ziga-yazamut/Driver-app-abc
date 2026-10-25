// POST /api/finish {guid, id, result}: a finished delivery (photos already uploaded through /api/photo).
// Saved in Supabase. With MAIN_WRITE=on, a delivered one also goes to the main system's FinalizeSignature
// (signature, receiver name, package photo, amount paid) and gets its green tick (SetCompleted).
// Sending the same delivery again (the phone retrying after no signal) just saves it again.
//
// result: {status: delivered|not_delivered, reason, boxes, receiver, signature, packages[], receipts[],
//          payments[{type, amount, photo, checkNum, bank, branch, account, holder, holderId, dueDate}],
//          diffReason, rma[], rmaNote}
import { json, handle } from '../lib/http.mjs';
import { upsert, update, downloadObject, log } from '../lib/supa.mjs';
import { finalize, setCompleted, writesOn } from '../lib/abc.mjs';
import { validGuid, validId, taskOf, ensureList, BUCKET, REASONS, PAY_TYPES } from '../lib/driver.mjs';

const txt = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const money = v => Math.round((Number(v) || 0) * 100) / 100;

export default handle(async req => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const { guid, id, result: r } = await req.json().catch(() => ({}));
  if (!validGuid(guid) || !validId(id) || !r || typeof r !== 'object') return json({ error: 'bad_request' }, 400);
  const { list, task } = await taskOf(guid, id);
  if (!task) return json({ error: 'not_found' }, 404);

  // A photo must belong to this link and this delivery
  const prefix = `${guid}/${id}/`;
  const own = p => typeof p === 'string' && p.startsWith(prefix) && !p.includes('..');
  const paths = a => (Array.isArray(a) ? a : []).filter(own).slice(0, 20);
  const delivered = r.status === 'delivered';
  if (!delivered && r.status !== 'not_delivered') return json({ error: 'bad_status' }, 400);
  if (!delivered && !REASONS.includes(r.reason)) return json({ error: 'bad_reason' }, 400);

  const payments = delivered ? (Array.isArray(r.payments) ? r.payments : []).slice(0, 20)
    .filter(p => PAY_TYPES.includes(p?.type))
    .map(p => ({
      type: p.type, amount: money(p.amount), photo: own(p.photo) ? p.photo : null,
      ...(p.type === 'check' ? { checkNum: txt(p.checkNum, 20), bank: txt(p.bank, 5), branch: txt(p.branch, 8), account: txt(p.account, 20),
        holder: txt(p.holder, 80), holderId: txt(p.holderId, 12), dueDate: /^\d{4}-\d{2}-\d{2}$/.test(p.dueDate || '') ? p.dueDate : null } : {}),
    })) : [];
  const amountPaid = money(payments.reduce((a, p) => a + p.amount, 0));
  const row = {
    delivery_id: id, guid, company: task.company,
    status: delivered ? 'delivered' : 'not_delivered',
    reason: delivered ? null : r.reason,
    boxes_ordered: task.boxes,
    boxes_delivered: delivered ? Math.max(0, Math.min(999, parseInt(r.boxes, 10) || 0)) : 0,
    receiver_name: delivered ? txt(r.receiver, 80) : null,
    signature_path: delivered && own(r.signature) ? r.signature : null,
    package_paths: delivered ? paths(r.packages) : [],
    receipt_paths: delivered ? paths(r.receipts) : [],
    amount_due: task.due,
    amount_paid: amountPaid,
    payments,
    diff_reason: delivered && amountPaid !== task.due ? txt(r.diffReason, 20) || null : null,
    rma_paths: paths(r.rma),
    rma_note: txt(r.rmaNote, 500) || null,
    finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (delivered && (!row.signature_path || !row.package_paths.length || !row.receiver_name)) return json({ error: 'incomplete' }, 400);

  await ensureList(list);
  await upsert('driver_results', [row], { onConflict: 'delivery_id' });

  let main = 'off';
  if (writesOn() && delivered) {
    try {
      const b64 = async p => p ? (await downloadObject(BUCKET, p)).toString('base64') : '';
      const f = await finalize({ id, name: row.receiver_name, signatureB64: await b64(row.signature_path), packageB64: await b64(row.package_paths[0]), amountPaid });
      const c = f.ok ? await setCompleted(id, true) : { ok: false };
      main = f.ok && c.ok ? 'sent' : 'failed';
      await update('driver_results', `delivery_id=eq.${id}`, main === 'sent' ? { main_sent_at: new Date().toISOString(), main_error: null } : { main_error: `${f.status} ${f.text || ''}`.slice(0, 300) });
      await log('main_finalize', main === 'sent', { id, status: f.status });
    } catch (e) {
      main = 'failed';
      await update('driver_results', `delivery_id=eq.${id}`, { main_error: e.message.slice(0, 300) });
    }
  }
  return json({ ok: true, finished_at: row.finished_at, main });
});

export const config = { path: '/api/finish' };
