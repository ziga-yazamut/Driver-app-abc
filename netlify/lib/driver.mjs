// Shared by the driver functions: checking the link, the photo bucket, and reading our own rows.
import { select, upsert, signedUrls } from './supa.mjs';
import { GUID } from './abc.mjs';
import { getList } from './source.mjs';

export const BUCKET = 'driver-photos';
export const REASONS = ['absent', 'refused', 'address', 'damaged'];
export const PAY_TYPES = ['check', 'cash', 'credit'];
export const UNDO_MS = 10 * 60 * 1000;

export const validGuid = g => typeof g === 'string' && GUID.test(g);
export const validId = id => Number.isInteger(id) && id > 0;

// The driver's list from the main system, and the delivery inside it (null when the id is not on this link)
export async function taskOf(guid, id) {
  const list = await getList(guid);
  if (!list || list.master) return { list, task: null };
  return { list, task: list.tasks.find(t => t.id === id) || null };
}

// Our row for the link. Created on first use, so results can reference it.
export async function ensureList(list) {
  await upsert('driver_lists', [{ guid: list.guid, person: list.person, list_date: list.date, updated_at: new Date().toISOString() }], { onConflict: 'guid' });
}

export const getDay = async guid => (await select('driver_lists', `select=*&guid=eq.${guid}`))[0] || null;
export const getResults = (ids) => ids.length ? select('driver_results', `select=*&delivery_id=in.(${ids.join(',')})`) : Promise.resolve([]);

// Every photo path a result points to
export function pathsOf(r) {
  return [r.signature_path, ...(r.package_paths || []), ...(r.receipt_paths || []), ...(r.rma_paths || []), ...(r.payments || []).map(p => p.photo)].filter(Boolean);
}

// The result with short-lived links instead of storage paths
export async function withLinks(r) {
  const urls = await signedUrls(BUCKET, pathsOf(r));
  const u = p => urls[p] || null;
  return {
    ...r,
    signature_url: u(r.signature_path),
    package_urls: (r.package_paths || []).map(u),
    receipt_urls: (r.receipt_paths || []).map(u),
    rma_urls: (r.rma_paths || []).map(u),
    payments: (r.payments || []).map(p => ({ ...p, photo_url: u(p.photo) })),
  };
}

// What the list needs of a result (no photos)
export const summary = r => ({
  status: r.status, reason: r.reason, finished_at: r.finished_at, receiver_name: r.receiver_name,
  boxes_delivered: r.boxes_delivered, amount_paid: Number(r.amount_paid) || 0,
  payments: (r.payments || []).map(p => ({ type: p.type, amount: Number(p.amount) || 0, checkNum: p.checkNum || '' })),
  main_sent: !!r.main_sent_at, main_error: r.main_error || null,
});
