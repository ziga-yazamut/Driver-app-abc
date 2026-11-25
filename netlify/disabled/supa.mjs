// Minimal Supabase REST client (PostgREST + Storage) using the secret key from Netlify env.
// Copied from the ABC catalog (netlify/lib/supa.mjs), plus delete, download and signed links.
// The key never reaches the browser: only server functions import this file.

export function supaConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new ConfigError('SUPABASE_URL / SUPABASE_SECRET_KEY are missing in Netlify environment variables');
  return { url, key };
}

export class ConfigError extends Error {}

function headers(key, extra = {}) {
  // New "sb_secret_..." keys go only in the apikey header; legacy JWT service keys also go in Authorization
  const h = { apikey: key, ...extra };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

async function check(res, what) {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  throw new Error(`${what} failed: ${res.status} ${body.slice(0, 300)}`);
}

// GET rows. query is a PostgREST query string, e.g. "select=id,name&active=eq.true"
export async function select(table, query, { pageSize = 1000 } = {}) {
  const { url, key } = supaConfig();
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
      headers: headers(key, { Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items' }),
    });
    await check(res, `select ${table}`);
    const rows = await res.json();
    out.push(...rows);
    // A query with its own limit is one page: asking PostgREST for the next range would fail (416)
    if (rows.length < pageSize || /(^|&)limit=/.test(query)) return out;
  }
}

export async function upsert(table, rows, { onConflict = 'id', returning = false } = {}) {
  if (!rows.length) return [];
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: headers(key, {
      'Content-Type': 'application/json',
      Prefer: `resolution=merge-duplicates,return=${returning ? 'representation' : 'minimal'}`,
    }),
    body: JSON.stringify(rows),
  });
  await check(res, `upsert ${table}`);
  return returning ? res.json() : [];
}

export async function insert(table, row) {
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  await check(res, `insert ${table}`);
}

export async function update(table, query, patch) {
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: headers(key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  await check(res, `update ${table}`);
}

export async function uploadObject(bucket, path, body, contentType) {
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' }),
    body,
  });
  await check(res, `upload ${path}`);
}

export function publicUrl(bucket, path) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  return `${url}/storage/v1/object/public/${bucket}/${path}`;
}

export async function remove(table, query) {
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: headers(key) });
  await check(res, `delete ${table}`);
}

export async function downloadObject(bucket, path) {
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, { headers: headers(key) });
  await check(res, `download ${path}`);
  return Buffer.from(await res.arrayBuffer());
}

// Short-lived links for private photos (check photos carry bank details, so the bucket is never public)
export async function signedUrls(bucket, paths, expiresIn = 3600) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return {};
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/storage/v1/object/sign/${bucket}`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn, paths: list }),
  });
  await check(res, 'sign urls');
  const out = {};
  for (const r of await res.json()) if (r.signedURL) out[r.path] = `${url}/storage/v1${r.signedURL}`;
  return out;
}

export async function log(kind, ok, info) {
  try {
    await insert('app_log', { kind, ok, info });
  } catch (e) {
    console.error('app_log insert failed', e.message);
  }
}
