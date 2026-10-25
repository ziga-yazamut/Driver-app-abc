// GET /api/result?guid=&id=: one finished delivery with short-lived photo links (the delivery page)
import { json, handle } from '../lib/http.mjs';
import { select } from '../lib/supa.mjs';
import { validGuid, validId, withLinks } from '../lib/driver.mjs';

export default handle(async req => {
  const p = new URL(req.url).searchParams, guid = p.get('guid') || '', id = parseInt(p.get('id'), 10);
  if (!validGuid(guid) || !validId(id)) return json({ error: 'bad_request' }, 400);
  const [r] = await select('driver_results', `select=*&delivery_id=eq.${id}`);
  if (!r || r.guid !== guid) return json({ error: 'not_found' }, 404);
  return json(await withLinks(r), 200, { 'Cache-Control': 'no-store' });
});

export const config = { path: '/api/result' };
