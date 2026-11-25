// Used by the "Browser: driver app" debug target (.vscode/launch.json, "server" section).
// - If nothing answers on http://localhost:8888, starts `netlify dev --no-open --port 8888`
//   (stopped again when the debug session ends). If netlify dev is already running, leaves it alone.
// - Serves a small "starting..." page on http://localhost:8887 that redirects to the same path
//   on :8888 as soon as netlify dev answers, so the browser never shows a connection error.
// - With a browser profile name, exits when the debug browser using that profile is closed.
// Usage: node tools/netlify-dev-ensure.mjs [appPort=8888] [waitPort=8887] [browserProfileDirName]
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_PORT = +(process.argv[2] || 8888);
const WAIT_PORT = +(process.argv[3] || 8887);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function appIsUp() {
  try { await fetch(`http://localhost:${APP_PORT}/`, { signal: AbortSignal.timeout(1500) }); return true; }
  catch { return false; }
}

function netlifyCli() {
  const candidates = [];
  try { candidates.push(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'netlify-cli', 'bin', 'run.js')); } catch {}
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'netlify-cli', 'bin', 'run.js'));
  candidates.push(path.join(root, 'node_modules', 'netlify-cli', 'bin', 'run.js'));
  return candidates.find(existsSync);
}

/* ---------- wait page on WAIT_PORT ---------- */
const page = target => `<!doctype html><meta charset="utf-8"><title>Starting netlify dev…</title>
<body style="font:16px system-ui;padding:2em">Starting netlify dev on port ${APP_PORT}… <span id="s"></span>
<script>
const target = ${JSON.stringify(target)};
let n = 0;
(async function poll() {
  try { await fetch('http://localhost:${APP_PORT}/', { mode: 'no-cors', cache: 'no-store' }); location.replace(target); }
  catch { document.getElementById('s').textContent = '.'.repeat(++n % 4); setTimeout(poll, 500); }
})();
</script>`;
const waitServer = http.createServer((req, res) => {
  const target = `http://localhost:${APP_PORT}${req.url}`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(page(target));
});
waitServer.on('error', e => console.log(`wait page not started on :${WAIT_PORT} (${e.code}); another session probably serves it`));
waitServer.listen(WAIT_PORT, () => console.log(`wait page on http://localhost:${WAIT_PORT}`));

/* ---------- end when the debug browser is closed ---------- */
// The debug Chrome runs with its own profile folder (userDataDir in launch.json). Once it has been seen,
// exit (and stop netlify dev if this script started it) as soon as it is gone, which ends the debug session.
const PROFILE = process.argv[4];
let child = null;
function debugBrowserRunning() {
  try {
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "@(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${PROFILE}*' }).Count"`, { encoding: 'utf8', windowsHide: true });
    return +out.trim() > 0;
  } catch { return true; }   // can't tell: keep running
}
if (PROFILE && process.platform === 'win32') {
  let seen = false;
  setInterval(() => {
    const running = debugBrowserRunning();
    if (running) seen = true;
    else if (seen) {
      console.log('debug browser closed, stopping');
      if (child) child.kill();
      process.exit(0);
    }
  }, 3000);
}

/* ---------- netlify dev ---------- */
if (await appIsUp()) {
  console.log(`netlify dev already running on http://localhost:${APP_PORT}, not starting another one`);
} else {
  const cli = netlifyCli();
  if (!cli) {
    console.error('netlify-cli not found. Install it with: npm install -g netlify-cli');
    process.exit(1);
  }
  console.log(`starting netlify dev on http://localhost:${APP_PORT} ...`);
  // --offline: no calls to Netlify's servers (no online env vars, no geolocation lookup); env comes from .env only
  child = spawn(process.execPath, [cli, 'dev', '--offline', '--no-open', '--port', String(APP_PORT)], { cwd: root, stdio: 'inherit' });
  child.on('exit', code => { console.log(`netlify dev exited (${code})`); process.exit(code ?? 0); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}
