export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

// Wraps a handler: an unexpected error becomes a 500 with its message, which the app can show
export const handle = fn => async (req, ctx) => {
  try {
    return await fn(req, ctx);
  } catch (e) {
    console.error(e);
    return json({ error: 'server_error', message: e.message }, 500);
  }
};
