// GET /api/status: which keys are set (yes/no only, never the values), where deliveries come from,
// whether writing to the main system is on, and whether the tables exist.
import { select } from '../lib/supa.mjs';
import { json } from '../lib/http.mjs';
import { readsOn, writesOn } from '../lib/abc.mjs';

export default async () => {
  const keys = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'ADMIN_CODE']
    .map(k => [k, !!process.env[k] || (k === 'SUPABASE_SECRET_KEY' && !!process.env.SUPABASE_SERVICE_ROLE_KEY)]));
  let tables = null, error = null;
  try {
    const [lists, results] = await Promise.all([select('driver_lists', 'select=guid'), select('driver_results', 'select=delivery_id')]);
    tables = { lists: lists.length, results: results.length };
  } catch (e) { error = e.message; }
  return json({ keys, source: readsOn() ? 'main' : 'office', mainWrite: writesOn(), tables, error }, 200, { 'Cache-Control': 'no-store' });
};

export const config = { path: '/api/status' };
