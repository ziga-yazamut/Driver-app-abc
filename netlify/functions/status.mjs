// GET /api/status: which keys are set (yes/no only, never the values), where deliveries come from,
// whether writing to the main system is on, and whether the tables exist.
// GET /api/status?guid=<GUID>: also what the main system answers for that driver link (status and counts only, no data).
import { select } from '../lib/supa.mjs';
import { json } from '../lib/http.mjs';
import { readsOn, writesOn, base, GUID } from '../lib/abc.mjs';

export default async req => {
  const keys = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ADMIN_CODE']
    .map(k => [k, !!process.env[k] || (k === 'SUPABASE_SECRET_KEY' && !!process.env.SUPABASE_SERVICE_ROLE_KEY)]));
  keys.MAIN_READ = readsOn() ? (process.env.MAIN_READ ? 'on' : 'on (default)') : 'off';
  let tables = null, error = null;
  try {
    const [lists, tasks, results] = await Promise.all([select('driver_lists', 'select=guid'), select('driver_tasks', 'select=id'), select('driver_results', 'select=delivery_id')]);
    tables = { lists: lists.length, tasks: tasks.length, results: results.length };
  } catch (e) { error = e.message; }
  const guid = new URL(req.url).searchParams.get('guid') || '';
  let main;
  if (GUID.test(guid)) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${base()}/DeliveryList/GetModel/${guid}`, { headers: { Accept: 'application/json' } });
      const text = await res.text();
      let m = null; try { m = JSON.parse(text); } catch (e) {}
      main = { http: res.status, type: res.headers.get('content-type'), json: !!m, master: !!m?.IsMasterLink,
        tasks: m ? (m.IsMasterLink ? Object.values(m.PersonalModels || {}).reduce((a, p) => a + (p.Tasks || []).length, 0) : (m.Tasks || []).length) : null,
        ms: Date.now() - t0, start: m ? undefined : text.slice(0, 80).replace(/\s+/g, ' ') };
    } catch (e) { main = { error: e.message, cause: e.cause?.code || e.cause?.message, ms: Date.now() - t0 }; }
  }
  return json({ keys, source: readsOn() ? 'main' : 'office', mainWrite: writesOn(), tables, error, main }, 200, { 'Cache-Control': 'no-store' });
};

export const config = { path: '/api/status' };
