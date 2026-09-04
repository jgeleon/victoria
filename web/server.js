// Servidor web local para US Visa Bot — Dashboard de órdenes
// - Cada ORDEN guarda la config completa de un cliente (cliente, email,
//   contraseña, schedule, fechas) en disco local (web/data/orders.json,
//   ignorado por git) para iniciarse con un clic.
// - Valores FIJOS para todas las órdenes: LOCALE, COUNTRY_CODE, FACILITY_ID.
// - Una ejecución por orden; varias órdenes pueden correr en paralelo.
// - Logs por ejecución en disco y en vivo por SSE. Sin login.
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
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const PORT = Number(process.env.GUI_PORT || 4321);

const STATIC_ENV = { LOCALE: 'es-pe', COUNTRY_CODE: 'pe', FACILITY_ID: '115' };

fs.mkdirSync(LOGS_DIR, { recursive: true });

const procs = new Map();   // runId -> proceso hijo
let orders = [];
const clients = new Set(); // conexiones SSE

// ---------------- persistencia ----------------
function loadOrders() {
  try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { orders = []; }
  if (!Array.isArray(orders)) orders = [];
  for (const o of orders) {
    if (o.run && o.run.status === 'running' && !procs.has(o.run.id)) { o.run.status = 'stopped'; if (!o.run.endedAt) o.run.endedAt = o.run.startedAt; }
  }
}
function saveOrders() { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); }
function genId(prefix) { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function findOrder(id) { return orders.find((o) => o.id === id); }
function findOrderByRun(runId) { return orders.find((o) => o.run && o.run.id === runId); }
function orderRunning(o) { return !!(o.run && procs.has(o.run.id)); }
function logFile(runId) { return path.join(LOGS_DIR, `${runId}.jsonl`); }

// Vista pública de una orden (sin contraseña)
function publicOrder(o) {
  return {
    id: o.id, cliente: o.cliente, email: o.email, scheduleId: o.scheduleId,
    refreshDelay: o.refreshDelay, current: o.current, target: o.target, min: o.min,
    dryRun: o.dryRun, hasPassword: !!o.password,
    running: orderRunning(o),
    run: o.run ? { id: o.run.id, status: orderRunning(o) ? 'running' : o.run.status, startedAt: o.run.startedAt, endedAt: o.run.endedAt } : null,
  };
}

// ---------------- logs / SSE ----------------
function appendLog(runId, line) {
  const entry = { t: Date.now(), line };
  try { fs.appendFileSync(logFile(runId), JSON.stringify(entry) + '\n'); } catch { /* noop */ }
  broadcast('log', { runId, ...entry });
}
function readLogs(runId, limit = 0) {
  try {
    let lines = fs.readFileSync(logFile(runId), 'utf8').split(/\n/).filter(Boolean);
    const total = lines.length;
    if (limit > 0 && total > limit) lines = lines.slice(-limit);
    return { logs: lines.map((l) => JSON.parse(l)), total };
  } catch { return { logs: [], total: 0 }; }
}
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch { /* cerrado */ } }
}
function runningRunIds() { return [...procs.keys()]; }
function broadcastState() { broadcast('state', { runningRunIds: runningRunIds() }); }

// ---------------- validación ----------------
function validateOrder(b, { partial = false } = {}) {
  const errs = [];
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!partial || b.cliente !== undefined) if (!(b.cliente || '').trim()) errs.push('Cliente');
  if (!partial || b.email !== undefined) if (!(b.email || '').trim()) errs.push('Email');
  if (!partial || b.scheduleId !== undefined) if (!(b.scheduleId || '').trim()) errs.push('Schedule ID');
  if (!partial || b.current !== undefined) if (!isDate((b.current || '').trim())) errs.push('Fecha actual (YYYY-MM-DD)');
  return errs;
}

// ---------------- control del bot ----------------
function startOrder(id) {
  const o = findOrder(id);
  if (!o) return { ok: false, error: 'Orden no encontrada.' };
  if (orderRunning(o)) return { ok: false, error: 'Esta orden ya está en ejecución.' };
  if (!o.password) return { ok: false, error: 'Esta orden no tiene contraseña guardada. Edítala para agregarla.' };
  const errs = validateOrder(o);
  if (errs.length) return { ok: false, error: 'Faltan datos en la orden: ' + errs.join(', ') + '.' };

  const args = [INDEX_JS, '-c', o.current];
  if ((o.target || '').trim()) args.push('-t', o.target.trim());
  if ((o.min || '').trim()) args.push('-m', o.min.trim());
  if (o.dryRun) args.push('--dry-run');

  const childEnv = { ...process.env, ...STATIC_ENV, EMAIL: o.email, PASSWORD: o.password, SCHEDULE_ID: o.scheduleId, REFRESH_DELAY: (o.refreshDelay || '3') };

  // Una ejecución por orden: descarta la anterior
  if (o.run) { try { fs.unlinkSync(logFile(o.run.id)); } catch { try { fs.writeFileSync(logFile(o.run.id), ''); } catch { /* noop */ } } }
  const run = { id: genId('run'), startedAt: Date.now(), endedAt: null, status: 'running', command: `node src/index.js ${args.slice(1).join(' ')}` };
  o.run = run;
  saveOrders();

  appendLog(run.id, `$ ${run.command}`);
  appendLog(run.id, `Fijos: LOCALE=${STATIC_ENV.LOCALE}  COUNTRY_CODE=${STATIC_ENV.COUNTRY_CODE}  FACILITY_ID=${STATIC_ENV.FACILITY_ID}`);

  const cp = spawn(process.execPath, args, { cwd: PROJECT_ROOT, env: childEnv });
  procs.set(run.id, cp);
  broadcast('orderupdate', { order: publicOrder(o) });
  broadcastState();

  let outBuf = '', errBuf = '';
  const handle = (chunk, isErr) => {
    let buf = (isErr ? errBuf : outBuf) + chunk.toString();
    const parts = buf.split(/\r?\n/); buf = parts.pop();
    for (const l of parts) appendLog(run.id, isErr ? `[err] ${l}` : l);
    if (isErr) errBuf = buf; else outBuf = buf;
  };
  cp.stdout.on('data', (c) => handle(c, false));
  cp.stderr.on('data', (c) => handle(c, true));

  const finish = (status, msg) => {
    if (outBuf) appendLog(run.id, outBuf);
    if (errBuf) appendLog(run.id, `[err] ${errBuf}`);
    if (msg) appendLog(run.id, msg);
    run.status = status; run.endedAt = Date.now();
    procs.delete(run.id); saveOrders();
    broadcast('orderupdate', { order: publicOrder(o) });
    broadcastState();
  };
  cp.on('exit', (code, signal) => {
    if (signal === 'SIGTERM') finish('stopped', 'Ejecución detenida por el usuario.');
    else if (code === 0) finish('finished', 'Ejecución finalizada correctamente (objetivo alcanzado).');
    else finish('error', `Ejecución terminó con código ${code}.`);
  });
  cp.on('error', (err) => finish('error', `Error al lanzar el bot: ${err.message}`));

  return { ok: true, order: publicOrder(o) };
}
function stopOrder(id) {
  const o = findOrder(id);
  if (!o || !o.run) return { ok: false, error: 'Orden no encontrada.' };
  const cp = procs.get(o.run.id);
  if (!cp) return { ok: false, error: 'Esta orden no está en ejecución.' };
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
function sendResult(res, r) { sendJSON(res, r.ok ? 200 : 400, r); }

function applyFields(o, b, { isNew }) {
  if (b.cliente !== undefined) o.cliente = String(b.cliente).trim();
  if (b.email !== undefined) o.email = String(b.email).trim();
  if (b.scheduleId !== undefined) o.scheduleId = String(b.scheduleId).trim();
  if (b.refreshDelay !== undefined) o.refreshDelay = String(b.refreshDelay).trim() || '3';
  if (b.current !== undefined) o.current = String(b.current).trim();
  if (b.target !== undefined) o.target = String(b.target).trim();
  if (b.min !== undefined) o.min = String(b.min).trim();
  if (b.dryRun !== undefined) o.dryRun = !!b.dryRun;
  // contraseña: en edición solo se cambia si viene con valor; en alta se toma tal cual
  if (isNew) o.password = b.password || '';
  else if (b.password) o.password = b.password;
}

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

  if (req.method === 'GET' && p === '/api/state') {
    sendJSON(res, 200, { orders: orders.map(publicOrder), static: STATIC_ENV, runningRunIds: runningRunIds() });
    return;
  }

  if (req.method === 'GET' && p === '/api/order') {
    const o = findOrder(url.searchParams.get('id'));
    if (!o) return sendJSON(res, 404, { ok: false, error: 'Orden no encontrada' });
    // incluye contraseña para prefilling del formulario de edición (uso local)
    sendJSON(res, 200, { ok: true, order: { ...publicOrder(o), password: o.password || '' } });
    return;
  }

  if (req.method === 'POST' && p === '/api/orders') {
    const b = await readBody(req);
    const errs = validateOrder(b);
    if (!(b.password || '').trim()) errs.push('Contraseña');
    if (errs.length) return sendResult(res, { ok: false, error: 'Faltan datos: ' + errs.join(', ') + '.' });
    const o = { id: genId('ord'), createdAt: Date.now(), run: null };
    applyFields(o, b, { isNew: true });
    orders.unshift(o); saveOrders();
    sendJSON(res, 200, { ok: true, order: publicOrder(o) });
    return;
  }

  if (req.method === 'POST' && p === '/api/orders/update') {
    const b = await readBody(req);
    const o = findOrder(b.id);
    if (!o) return sendJSON(res, 404, { ok: false, error: 'Orden no encontrada' });
    if (orderRunning(o)) return sendResult(res, { ok: false, error: 'Detén la orden antes de editarla.' });
    const errs = validateOrder(b, { partial: true });
    if (errs.length) return sendResult(res, { ok: false, error: 'Datos inválidos: ' + errs.join(', ') + '.' });
    applyFields(o, b, { isNew: false });
    saveOrders();
    sendJSON(res, 200, { ok: true, order: publicOrder(o) });
    return;
  }

  if (req.method === 'POST' && p === '/api/orders/delete') {
    const b = await readBody(req);
    const o = findOrder(b.id);
    if (!o) return sendJSON(res, 404, { ok: false, error: 'Orden no encontrada' });
    if (orderRunning(o)) return sendResult(res, { ok: false, error: 'Detén la orden antes de borrarla.' });
    if (o.run) { try { fs.unlinkSync(logFile(o.run.id)); } catch { try { fs.writeFileSync(logFile(o.run.id), ''); } catch { /* noop */ } } }
    orders = orders.filter((x) => x.id !== o.id); saveOrders();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && p === '/api/start') { const b = await readBody(req); sendResult(res, startOrder(b.id)); return; }
  if (req.method === 'POST' && p === '/api/stop') { const b = await readBody(req); sendResult(res, stopOrder(b.id)); return; }

  if (req.method === 'GET' && p === '/api/logs') {
    const runId = url.searchParams.get('runId');
    if (!runId || !findOrderByRun(runId)) return sendJSON(res, 404, { ok: false, error: 'Ejecución no encontrada' });
    const { logs, total } = readLogs(runId, 1500);
    sendJSON(res, 200, { ok: true, runId, logs, total });
    return;
  }

  if (req.method === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify({ runningRunIds: runningRunIds() })}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

loadOrders();
server.listen(PORT, () => { console.log(`\n  US Visa Bot — Dashboard  →  http://localhost:${PORT}\n`); });
