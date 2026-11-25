// DISABLED with the /office page (see README.md in this folder). The Supabase parts the driver functions used to share,
// moved here when the main system became the driver app's only backend.
import { select, upsert, signedUrls } from './supa.mjs';
import { getMainList } from '../lib/abc.mjs';

export const BUCKET = 'driver-photos';
export const UNDO_MS = 10 * 60 * 1000;

const fromRow = t => ({
  id: t.id, company: t.company, city: t.city, address: t.address, phone: t.phone,
  total: Number(t.total) || 0, paid: 0, due: Number(t.total) || 0, terms: t.terms, boxes: t.boxes,
  comment: t.comment, firstOrder: false, vat: '', position: t.position, completed: false, created: t.created_at,
});

// A list typed in /office (Supabase)
export async function getOfficeList(guid) {
  const [day] = await select('driver_lists', `select=guid,person,list_date&guid=eq.${guid}`);
  if (!day) return null;
  const tasks = await select('driver_tasks', `select=*&guid=eq.${guid}&order=position.asc,id.asc`);
  return { guid, person: day.person || '', date: day.list_date || '', tasks: tasks.map(fromRow), from: 'office' };
}

// A list typed in /office first, else the main system
export async function getAnyList(guid) {
  const office = await getOfficeList(guid);
  if (office?.tasks.length) return office;
  const main = await getMainList(guid);
  return main ? { ...main, from: 'main' } : office;
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
