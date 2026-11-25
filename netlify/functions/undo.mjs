// POST /api/undo {guid, id}: "My mistake, reopen" (the app offers it up to 10 minutes after finishing).
// ReopenDelivery in the main system: the delivery is no longer completed and the day is no longer closed.
// Nothing is deleted there: the saved data fills the steps again, and finishing again updates it (FinalizeDelivery).
import { json, handle } from '../lib/http.mjs';
import { reopenDelivery } from '../lib/abc.mjs';
import { validGuid, validId, taskOf } from '../lib/driver.mjs';

export default handle(async req => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const { guid, id } = await req.json().catch(() => ({}));
  if (!validGuid(guid) || !validId(id)) return json({ error: 'bad_request' }, 400);
  if (!(await taskOf(guid, id)).task) return json({ error: 'not_found' }, 404);
  const res = await reopenDelivery(id);
  if (!res.ok) return json({ error: 'main_failed', message: `${res.status} ${res.text}`.trim() }, 502);
  return json({ ok: true });
});

export const config = { path: '/api/undo' };
