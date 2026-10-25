// POST /api/undo {guid, id}: "My mistake, reopen", up to 10 minutes after finishing.
// The photos stay in storage. With MAIN_WRITE=on and the delivery already sent, the green tick in the main
// system is removed (SetCompleted false), as the existing driver page does; the signature there stays.
import { json, handle } from '../lib/http.mjs';
import { select, remove } from '../lib/supa.mjs';
import { setCompleted } from '../lib/abc.mjs';
import { validGuid, validId, UNDO_MS } from '../lib/driver.mjs';

export default handle(async req => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const { guid, id } = await req.json().catch(() => ({}));
  if (!validGuid(guid) || !validId(id)) return json({ error: 'bad_request' }, 400);
  const [r] = await select('driver_results', `select=guid,finished_at,main_sent_at&delivery_id=eq.${id}`);
  if (!r || r.guid !== guid) return json({ error: 'not_found' }, 404);
  if (Date.now() - new Date(r.finished_at).getTime() > UNDO_MS) return json({ error: 'too_late' }, 409);
  await remove('driver_results', `delivery_id=eq.${id}`);
  if (r.main_sent_at) await setCompleted(id, false);
  return json({ ok: true });
});

export const config = { path: '/api/undo' };
