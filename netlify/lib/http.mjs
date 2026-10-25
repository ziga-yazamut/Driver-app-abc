import { ConfigError } from './supa.mjs';

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

// Wraps a handler: missing keys become a clear 503 the app can show, other errors a 500
export const handle = fn => async (req, ctx) => {
  try {
    return await fn(req, ctx);
  } catch (e) {
    if (e instanceof ConfigError) return json({ error: 'not_configured', message: e.message }, 503);
    console.error(e);
    return json({ error: 'server_error', message: e.message }, 500);
  }
};
