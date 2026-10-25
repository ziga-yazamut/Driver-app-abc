// Local stand-in for Netlify + Supabase, for tests and trying the app without any account.
// Serves public/ with the netlify.toml redirects, runs netlify/functions/* on /api/*, and fakes the small part
// of Supabase the functions use (PostgREST select/insert/upsert/update/delete, Storage upload/download/sign).
// Usage: node test/devserver.mjs [port]   then open http://localhost:<port>/office (code: test)
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.argv[2] || process.env.PORT || 8888);
const BASE = `http://localhost:${PORT}`;
process.env.SUPABASE_URL ||= `${BASE}/sb`;
process.env.SUPABASE_SECRET_KEY ||= 'test-secret';
process.env.ADMIN_CODE ||= 'test';

/* ---------- fake Supabase ---------- */
export const db = { driver_lists: [], driver_tasks: [], driver_results: [], app_log: [] };
const KEYS = { driver_lists: 'guid', driver_tasks: 'id', driver_results: 'delivery_id', app_log: 'id' };
const files = new Map();
let seq = { driver_tasks: 1000000000, app_log: 1 };

function parseVal(v) { if (v === 'null') return null; if (v === 'true') return true; if (v === 'false') return false; return v; }
function filterRows(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
    const m = /^(eq|neq|in|gte|lte)\.(.*)$/.exec(v);
    if (!m) continue;
    const [, op, val] = m;
    const get = r => (k.includes('->>') ? r[k.split('->>')[0]]?.[k.split('->>')[1]] : r[k]);
    if (op === 'eq') out = out.filter(r => String(get(r)) === String(parseVal(val)));
    if (op === 'neq') out = out.filter(r => String(get(r)) !== String(parseVal(val)));
    if (op === 'gte') out = out.filter(r => String(get(r)) >= val);
    if (op === 'lte') out = out.filter(r => String(get(r)) <= val);
    if (op === 'in') { const set = val.replace(/^\(|\)$/g, '').split(','); out = out.filter(r => set.includes(String(get(r)))); }
  }
  const order = params.get('order');
  if (order) {
    const keys = order.split(',').map(o => o.split('.'));
    out = [...out].sort((a, b) => { for (const [k, dir] of keys) { if (a[k] < b[k]) return dir === 'desc' ? 1 : -1; if (a[k] > b[k]) return dir === 'desc' ? -1 : 1; } return 0; });
  }
  if (params.get('limit')) out = out.slice(0, +params.get('limit'));
  return out;
}
const pick = (r, sel) => !sel || sel === '*' ? { ...r } : Object.fromEntries(sel.split(',').map(k => [k, r[k] ?? null]));
function defaults(table, row) {
  const now = new Date().toISOString();
  if (table === 'driver_tasks') return { id: seq.driver_tasks++, position: 0, city: '', address: '', phone: '', total: 0, terms: '', boxes: 1, comment: '', created_at: now, ...row };
  if (table === 'driver_lists') return { order_ids: [], accepted_at: null, closed_at: null, updated_at: now, ...row };
  if (table === 'driver_results') return { package_paths: [], receipt_paths: [], rma_paths: [], payments: [], main_sent_at: null, main_error: null, ...row };
  if (table === 'app_log') return { id: seq.app_log++, at: now, ...row };
  return row;
}

async function supabase(req, res, url, body) {
  const p = url.pathname.replace(/^\/sb/, '');
  const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
  // A signed link works without the key, as on Supabase
  const signedGet = req.method === 'GET' && p.startsWith('/storage/v1/object/sign/') && url.searchParams.get('token');
  if (!signedGet && req.headers.apikey !== process.env.SUPABASE_SECRET_KEY) return send(401, { message: 'bad key' });
  let m;
  if ((m = /^\/rest\/v1\/(\w+)$/.exec(p))) {
    const table = m[1], rows = db[table];
    if (!rows) return send(404, { message: 'no table' });
    const q = url.searchParams;
    if (req.method === 'GET') {
      const range = (req.headers.range || '').split('-').map(Number);
      let out = filterRows(rows, q).map(r => pick(r, q.get('select')));
      if (req.headers.range) out = out.slice(range[0], range[1] + 1);
      return send(200, out);
    }
    if (req.method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const upsert = (req.headers.prefer || '').includes('merge-duplicates'), key = q.get('on_conflict') || KEYS[table];
      for (const row of list) {
        const i = rows.findIndex(r => row[key] !== undefined && String(r[key]) === String(row[key]));
        if (i >= 0) { if (!upsert) return send(409, { message: 'duplicate' }); rows[i] = { ...rows[i], ...row }; }
        else {
          if (table === 'driver_results' && !db.driver_lists.some(l => l.guid === row.guid)) return send(409, { message: 'fk driver_lists' });
          if (table === 'driver_tasks' && !db.driver_lists.some(l => l.guid === row.guid)) return send(409, { message: 'fk driver_lists' });
          rows.push(defaults(table, row));
        }
      }
      return send(201, (req.headers.prefer || '').includes('representation') ? list : undefined);
    }
    if (req.method === 'PATCH') { for (const r of filterRows(rows, q)) Object.assign(r, body); return send(204); }
    if (req.method === 'DELETE') {
      const gone = new Set(filterRows(rows, q));
      db[table] = rows.filter(r => !gone.has(r));
      if (table === 'driver_lists') db.driver_tasks = db.driver_tasks.filter(t => !db.driver_lists.some(l => l.guid === t.guid) ? false : true);
      return send(204);
    }
  }
  if ((m = /^\/storage\/v1\/object\/sign\/([\w-]+)$/.exec(p)) && req.method === 'POST')
    return send(200, body.paths.map(x => ({ path: x, signedURL: files.has(`${m[1]}/${x}`) ? `/object/sign/${m[1]}/${x}?token=t` : null })));
  if ((m = /^\/storage\/v1\/object\/(?:sign\/)?([\w-]+)\/(.+)$/.exec(p))) {
    const k = `${m[1]}/${m[2]}`;
    if (req.method === 'POST') { files.set(k, { type: req.headers['content-type'], data: body }); return send(200, { Key: k }); }
    if (req.method === 'GET') { const f = files.get(k); if (!f) return send(404, { message: 'not found' }); res.writeHead(200, { 'Content-Type': f.type }); return res.end(f.data); }
  }
  send(404, { message: 'unknown ' + p });
}

/* ---------- functions ---------- */
const routes = {};
for (const f of await readdir(path.join(root, 'netlify/functions'))) {
  const mod = await import(pathToFileURL(path.join(root, 'netlify/functions', f)).href);
  routes[mod.config.path] = mod.default;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  try {
    if (url.pathname.startsWith('/sb/')) {
      const ct = req.headers['content-type'] || '';
      return await supabase(req, res, url, ct.includes('json') && raw.length ? JSON.parse(raw) : raw);
    }
    if (routes[url.pathname]) {
      const r = await routes[url.pathname](new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw }), {});
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (/^\/d\//.test(file)) file = '/index.html';
    if (file === '/office') file = '/office.html';
    const data = await readFile(path.join(root, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, '')));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('not found'); }
    console.error(e); res.writeHead(500); res.end(e.message);
  }
});
server.listen(PORT, () => console.log(`driver app on ${BASE} (office code: ${process.env.ADMIN_CODE})`));
