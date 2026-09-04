// Servidor web local para US Visa Bot
// - No usa .env: credenciales y refresh delay se piden en el formulario.
// - Valores FIJOS para todas las sesiones: LOCALE, COUNTRY_CODE, FACILITY_ID.
// - SESIONES agrupan EJECUCIONES. Se permiten VARIAS ejecuciones en paralelo
//   (una activa por sesión, pero distintas sesiones a la vez).
// - Historial y logs por ejecución en disco; logs en vivo por SSE.
// Solo módulos nativos de Node.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INDEX_JS = path.join(PROJECT_ROOT, 'src', 'index.js');
const INDEX_HTML = path.join(__dirname, 'index.html');
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const PORT = Number(process.env.GUI_PORT || 4321);

const STATIC_ENV = { LOCALE: 'es-pe', COUNTRY_CODE: 'pe', FACILITY_ID: '115' };
const ASK_KEYS = [
  { key: 'EMAIL', secret: false },
  { key: 'PASSWORD', secret: true },
  { key: 'SCHEDULE_ID', secret: false },
  { key: 'REFRESH_DELAY', secret: false },
];

fs.mkdirSync(LOGS_DIR, { recursive: true });

const procs = new Map();     // runId -> proceso hijo en ejecución
let sessions = [];
const clients = new Set();

// ---------------- persistencia ----------------
function loadSessions() {
  try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { sessions = []; }
  if (!Array.isArray(sessions)) sessions = [];
  // al arrancar, ninguna ejecución sigue viva: normaliza estados colgados
  for (const s of sessions) for (const r of s.runs) if (r.status === 'running') { r.status = 'stopped'; if (!r.endedAt) r.endedAt = r.startedAt; }
}
function saveSessions() { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); }
function genId(prefix) { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function findSession(id) { return sessions.find((s) => s.id === id); }
function findRun(runId) {
  for (const s of sessions) { const r = s.runs.find((x) => x.id === runId); if (r) return { session: s, run: r }; }
  return null;
}
function sessionHasActiveRun(session) { return session.runs.some((r) => procs.has(r.id)); }
function logFile(runId) { return path.join(LOGS_DIR, `${runId}.jsonl`); }

function getDefaults() {
  let latest = null;
  for (const s of sessions) for (const r of s.runs) if (!latest || r.startedAt > latest.startedAt) latest = r;
  return {
    EMAIL: latest?.params?.email || '',
    SCHEDULE_ID: latest?.params?.scheduleId || '',
    REFRESH_DELAY: latest?.params?.refreshDelay || '3',
  };
}

// ---------------- logs / SSE ----------------
function appendLog(runId, line) {
  const entry = { t: Date.now(), line };
  try { fs.appendFileSync(logFile(runId), JSON.stringify(entry) + '\n'); } catch { /* noop */ }
  broadcast('log', { runId, ...entry });
}
function readLogs(runId) {
  try { return fs.readFileSync(logFile(runId), 'utf8').split(/\n/).filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch { /* cerrado */ } }
}
function statusPayload() { return { running: procs.size > 0, runningRunIds: [...procs.keys()] }; }
function broadcastStatus() { broadcast('status', statusPayload()); }

// ---------------- control del bot ----------------
function startBot(params) {
  const session = findSession(params.sessionId);
  if (!session) return { ok: false, error: 'Selecciona o crea una sesión primero.' };
  if (sessionHasActiveRun(session)) return { ok: false, error: 'Esta sesión ya tiene una ejecución en curso. Deténla o usa otra sesión.' };

  const current = (params.current || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(current)) return { ok: false, error: 'La fecha actual (-c) es obligatoria (formato YYYY-MM-DD).' };

  const creds = params.creds || {};
  const email = (creds.EMAIL || '').trim();
  const password = creds.PASSWORD || '';
  const scheduleId = (creds.SCHEDULE_ID || '').trim();
  const refreshDelay = (creds.REFRESH_DELAY || '').trim() || '3';
  const missing = [];
  if (!email) missing.push('Email');
  if (!password) missing.push('Contraseña');
  if (!scheduleId) missing.push('Schedule ID');
  if (missing.length) return { ok: false, error: 'Faltan datos obligatorios: ' + missing.join(', ') + '.' };

  const runParams = { current, target: (params.target || '').trim(), min: (params.min || '').trim(), dryRun: !!params.dryRun, email, scheduleId, refreshDelay };
  const args = [INDEX_JS, '-c', runParams.current];
  if (runParams.target) args.push('-t', runParams.target);
  if (runParams.min) args.push('-m', runParams.min);
  if (runParams.dryRun) args.push('--dry-run');

  const childEnv = { ...process.env, ...STATIC_ENV, EMAIL: email, PASSWORD: password, SCHEDULE_ID: scheduleId, REFRESH_DELAY: refreshDelay };

  const run = { id: genId('run'), startedAt: Date.now(), endedAt: null, status: 'running', params: runParams, command: `node src/index.js ${args.slice(1).join(' ')}` };
  session.runs.push(run);
  saveSessions();

  appendLog(run.id, `$ ${run.command}`);
  appendLog(run.id, `Fijos: LOCALE=${STATIC_ENV.LOCALE}  COUNTRY_CODE=${STATIC_ENV.COUNTRY_CODE}  FACILITY_ID=${STATIC_ENV.FACILITY_ID}`);

  const cp = spawn(process.execPath, args, { cwd: PROJECT_ROOT, env: childEnv });
  procs.set(run.id, cp);
  broadcast('runstart', { sessionId: session.id, run });
  broadcastStatus();

  let outBuf = '', errBuf = '';
  const handle = (chunk, isErr) => {
    let buf = (isErr ? errBuf : outBuf) + chunk.toString();
    const parts = buf.split(/\r?\n/); buf = parts.pop();
    for (const l of parts) appendLog(run.id, isErr ? `[err] ${l}` : l);
    if (isErr) errBuf = buf; else outBuf = buf;
  };
  cp.stdout.on('data', (c) => handle(c, false));
  cp.stderr.on('data', (c) => handle(c, true));

  cp.on('exit', (code, signal) => {
    if (outBuf) appendLog(run.id, outBuf);
    if (errBuf) appendLog(run.id, `[err] ${errBuf}`);
    if (signal === 'SIGTERM') { run.status = 'stopped'; appendLog(run.id, 'Ejecución detenida por el usuario.'); }
    else if (code === 0) { run.status = 'finished'; appendLog(run.id, 'Ejecución finalizada correctamente (objetivo alcanzado).'); }
    else { run.status = 'error'; appendLog(run.id, `Ejecución terminó con código ${code}.`); }
    run.endedAt = Date.now();
    procs.delete(run.id); saveSessions();
    broadcast('runend', { sessionId: session.id, run }); broadcastStatus();
  });
  cp.on('error', (err) => {
    appendLog(run.id, `Error al lanzar el bot: ${err.message}`);
    run.status = 'error'; run.endedAt = Date.now();
    procs.delete(run.id); saveSessions();
    broadcast('runend', { sessionId: session.id, run }); broadcastStatus();
  });

  return { ok: true, runId: run.id, sessionId: session.id };
}
function stopBot(runId) {
  const cp = procs.get(runId);
  if (!cp) return { ok: false, error: 'Esa ejecución no está en curso.' };
  cp.kill('SIGTERM');
  return { ok: true };
}

// ---------------- HTTP ----------------
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function sendResult(res, result) { sendJSON(res, result.ok ? 200 : 400, result); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    fs.readFile(INDEX_HTML, (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html no encontrado'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && p === '/api/config') {
    const defaults = getDefaults();
    const askFields = ASK_KEYS.map((f) => ({ key: f.key, secret: f.secret, value: f.secret ? '' : (defaults[f.key] || '') }));
    sendJSON(res, 200, { askFields, static: STATIC_ENV, sessions, ...statusPayload() });
    return;
  }

  if (req.method === 'GET' && p === '/api/sessions') { sendJSON(res, 200, { sessions, ...statusPayload() }); return; }

  if (req.method === 'POST' && p === '/api/sessions') {
    const body = await readBody(req);
    const name = (body.name || '').trim() || `Sesión ${sessions.length + 1}`;
    const session = { id: genId('ses'), name, createdAt: Date.now(), runs: [] };
    sessions.unshift(session); saveSessions();
    sendJSON(res, 200, { ok: true, session });
    return;
  }

  if (req.method === 'POST' && p === '/api/sessions/rename') {
    const body = await readBody(req);
    const s = findSession(body.id);
    if (!s) return sendJSON(res, 404, { ok: false, error: 'Sesión no encontrada' });
    s.name = (body.name || '').trim() || s.name; saveSessions();
    sendJSON(res, 200, { ok: true, session: s });
    return;
  }

  if (req.method === 'POST' && p === '/api/sessions/delete') {
    const body = await readBody(req);
    const s = findSession(body.id);
    if (!s) return sendJSON(res, 404, { ok: false, error: 'Sesión no encontrada' });
    if (sessionHasActiveRun(s)) return sendJSON(res, 400, { ok: false, error: 'Detén la ejecución en curso antes de borrar esta sesión.' });
    for (const r of s.runs) { try { fs.unlinkSync(logFile(r.id)); } catch { try { fs.writeFileSync(logFile(r.id), ''); } catch { /* noop */ } } }
    sessions = sessions.filter((x) => x.id !== s.id); saveSessions();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && p === '/api/logs') {
    const runId = url.searchParams.get('runId');
    const found = runId && findRun(runId);
    if (!found) return sendJSON(res, 404, { ok: false, error: 'Ejecución no encontrada' });
    sendJSON(res, 200, { ok: true, runId, run: found.run, logs: readLogs(runId) });
    return;
  }

  if (req.method === 'POST' && p === '/api/start') { sendResult(res, startBot(await readBody(req))); return; }
  if (req.method === 'POST' && p === '/api/stop') { const b = await readBody(req); sendResult(res, stopBot(b.runId)); return; }

  if (req.method === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    clients.add(res);
    res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

loadSessions();
server.listen(PORT, () => { console.log(`\n  US Visa Bot GUI  →  http://localhost:${PORT}\n`); });
