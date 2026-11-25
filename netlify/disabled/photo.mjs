// DISABLED: not deployed (only netlify/functions is). The app now sends its photos inside /api/finish to the main system.
// POST /api/photo {guid, id, kind, data}: one photo (a JPEG or PNG data URL, already shrunk on the phone)
// into the private Supabase bucket. Returns its path, which the old /api/finish then referred to.
import { json, handle } from '../lib/http.mjs';
import { uploadObject } from './supa.mjs';
import { validGuid, validId, taskOf } from '../lib/driver.mjs';
import { BUCKET } from './office-lib.mjs';

const KINDS = ['package', 'receipt', 'signature', 'check', 'cash', 'rma'];
const MAX = 4 * 1024 * 1024;

export default handle(async req => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const { guid, id, kind, data } = await req.json().catch(() => ({}));
  if (!validGuid(guid) || !validId(id) || !KINDS.includes(kind)) return json({ error: 'bad_request' }, 400);
  const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(data || '');
  if (!m) return json({ error: 'bad_image' }, 400);
  // Only for a delivery that is really on this link, so the bucket can't be filled from outside
  if (!(await taskOf(guid, id)).task) return json({ error: 'not_found' }, 404);
  const body = Buffer.from(m[2], 'base64');
  if (body.length > MAX) return json({ error: 'too_big' }, 413);
  const ext = m[1] === 'png' ? 'png' : 'jpg';
  const path = `${guid}/${id}/${kind}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  await uploadObject(BUCKET, path, body, `image/${m[1]}`);
  return json({ path });
});

export const config = { path: '/api/photo' };
