// Servidor web local para US Visa Bot — Dashboard de órdenes
// - Cada ORDEN guarda la config de un cliente (cliente, email, contraseña,
//   schedule, fechas, y opcionalmente duración/intervalo de ciclo) en disco
//   local (web/data/orders.json, ignorado por git) e inicia con un clic.
// - Valores FIJOS para todas: LOCALE, COUNTRY_CODE, FACILITY_ID.
// - CICLO por orden: corre durante 'duración' min, se detiene, y revive cada
//   'intervalo' min, en bucle, hasta que el usuario lo detiene.
// - Logs por orden en disco (continuos entre ciclos) y en vivo por SSE. Sin login.
// Solo módulos nativos de Node.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const INDEX_JS = path.join(PROJECT_ROOT, 'src', 'index.js');
const INDEX_HTML = path.join(__dirname, 'index.html');
const PORT = Number(process.env.PORT || process.env.GUI_PORT || 4321);

// Carpeta de datos: usa DATA_DIR (ideal: un disco persistente). Si no se puede
// escribir ahí (p. ej. falta montar el disco en la nube), cae a una temporal
// para que el panel al menos arranque, avisando que NO será persistente.
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
let dataPersistent = true;
try {
  fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
} catch (e) {
  const fallback = path.join(os.tmpdir(), 'usvisabot-data');
  fs.mkdirSync(path.join(fallback, 'logs'), { recursive: true });
  dataPersistent = false;
  console.warn(`\n  ⚠️  No se pudo escribir en DATA_DIR="${DATA_DIR}" (${e.code}).` +
    `\n      Usando carpeta temporal "${fallback}" — los datos NO serán persistentes.` +
    `\n      En Render: agrega un Disk con Mount Path = esa ruta (o "/data") y vuelve a desplegar.\n`);
  DATA_DIR = fallback;
}
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

const STATIC_ENV = { LOCALE: 'es-pe', COUNTRY_CODE: 'pe', FACILITY_ID: '115' };


// orderId -> controlador de ciclo { runId, child, phase, timers, flags, durationMs, intervalMs }
const cycles = new Map();
let orders = [];
let bookings = [];
const clients = new Set();

// ---------------- persistencia ----------------
function loadOrders() {
  try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { orders = []; }
  if (!Array.isArray(orders)) orders = [];
  for (const o of orders) {
    if (o.run && o.run.status === 'running' && !cycles.has(o.id)) { o.run.status = 'stopped'; if (!o.run.endedAt) o.run.endedAt = o.run.startedAt; }
  }
}
function saveOrders() { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); }
function loadBookings() { try { bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8')); } catch { bookings = []; } if (!Array.isArray(bookings)) bookings = []; }
function saveBookings() { fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2)); }
function genId(prefix) { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
function findOrder(id) { return orders.find((o) => o.id === id); }
function findOrderByRun(runId) { return orders.find((o) => o.run && o.run.id === runId); }
function orderRunning(o) { return cycles.has(o.id); }
function logFile(runId) { return path.join(LOGS_DIR, `${runId}.jsonl`); }
function numOrEmpty(v) { const n = parseFloat(v); return isFinite(n) && n > 0 ? n : 0; }

function publicOrder(o) {
  const ctrl = cycles.get(o.id);
  let runStatus = o.run ? o.run.status : null;
  if (o.run && ctrl) runStatus = ctrl.phase; // 'running' | 'paused'
  const run = o.run ? { id: o.run.id, status: runStatus, startedAt: o.run.startedAt, endedAt: o.run.endedAt } : null;
  if (run && ctrl && ctrl.phase === 'paused' && ctrl.reviveAt) run.reviveAt = ctrl.reviveAt;
  return {
    id: o.id, cliente: o.cliente, email: o.email, scheduleId: o.scheduleId,
    refreshDelay: o.refreshDelay, current: o.current, target: o.target, min: o.min, dryRun: o.dryRun,
    durationMin: o.durationMin || '', intervalMin: o.intervalMin || '',
    hasPassword: !!o.password, running: orderRunning(o), run,
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
function detectBooking(o, line) {
  const m = line.match(/booked time at (\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
  if (!m) return;
  const date = m[1], time = m[2];
  if (bookings.some((b) => b.orderId === o.id && b.date === date && b.time === time)) return; // evita duplicado
  const bk = { id: genId('bk'), orderId: o.id, cliente: o.cliente, email: o.email, scheduleId: o.scheduleId, date, time, bookedAt: Date.now() };
  bookings.unshift(bk); saveBookings();
  if (o.run) appendLog(o.run.id, `🎫 CITA RESERVADA: ${date} ${time}`);
  broadcast('booking', { booking: bk });
  // Al reservar, detener la orden: no debe seguir buscando ni revivir.
  const ctrl = cycles.get(o.id);
  if (ctrl) {
    ctrl.booked = true;
    if (ctrl.pauseTimer) { clearTimeout(ctrl.pauseTimer); ctrl.pauseTimer = null; }
    if (ctrl.durationTimer) { clearTimeout(ctrl.durationTimer); ctrl.durationTimer = null; }
    if (ctrl.child) ctrl.child.kill('SIGTERM');
    else endCycle(o, ctrl, 'booked', '🎫 Cita reservada. Proceso detenido.');
  }
}
function runningOrderIds() { return [...cycles.keys()]; }
function broadcastState() { broadcast('state', { runningOrderIds: runningOrderIds() }); }
function pushOrderUpdate(o) { broadcast('orderupdate', { order: publicOrder(o) }); }

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

// ---------------- supervisor de ciclos ----------------
function spawnChild(o) {
  const args = [INDEX_JS, '-c', o.current];
  if ((o.target || '').trim()) args.push('-t', o.target.trim());
  if ((o.min || '').trim()) args.push('-m', o.min.trim());
  if (o.dryRun) args.push('--dry-run');
  const env = { ...process.env, ...STATIC_ENV, EMAIL: o.email, PASSWORD: o.password, SCHEDULE_ID: o.scheduleId, REFRESH_DELAY: (o.refreshDelay || '3') };
  return { cp: spawn(process.execPath, args, { cwd: PROJECT_ROOT, env }), command: `node src/index.js ${args.slice(1).join(' ')}` };
}

function startOrder(id) {
  const o = findOrder(id);
  if (!o) return { ok: false, error: 'Orden no encontrada.' };
  if (orderRunning(o)) return { ok: false, error: 'Esta orden ya está en ejecución.' };
  if (!o.password) return { ok: false, error: 'Esta orden no tiene contraseña guardada. Edítala para agregarla.' };
  const errs = validateOrder(o);
  if (errs.length) return { ok: false, error: 'Faltan datos en la orden: ' + errs.join(', ') + '.' };

  // Log continuo por sesión de ciclo: nuevo run.id, se descarta el anterior
  if (o.run) { try { fs.unlinkSync(logFile(o.run.id)); } catch { try { fs.writeFileSync(logFile(o.run.id), ''); } catch { /* noop */ } } }
  const runId = genId('run');
  o.run = { id: runId, startedAt: Date.now(), endedAt: null, status: 'running' };

  const durationMs = numOrEmpty(o.durationMin) * 60000;
  const intervalMs = numOrEmpty(o.intervalMin) * 60000;
  const ctrl = { runId, child: null, phase: 'running', durationTimer: null, pauseTimer: null, userStopped: false, durationMs, intervalMs, cycleStart: 0 };
  cycles.set(o.id, ctrl);
  saveOrders();

  appendLog(runId, `Fijos: LOCALE=${STATIC_ENV.LOCALE}  COUNTRY_CODE=${STATIC_ENV.COUNTRY_CODE}  FACILITY_ID=${STATIC_ENV.FACILITY_ID}`);
  if (durationMs > 0 && intervalMs > 0) appendLog(runId, `♻️ Ciclo activo: corre ${o.durationMin} min, revive cada ${o.intervalMin} min.`);
  else if (durationMs > 0) appendLog(runId, `⏱️ Ejecución limitada a ${o.durationMin} min (sin repetición).`);

  runCycle(o, ctrl);
  pushOrderUpdate(o); broadcastState();
  return { ok: true, order: publicOrder(o) };
}

function runCycle(o, ctrl) {
  if (ctrl.userStopped) return;
  const { cp, command } = spawnChild(o);
  ctrl.child = cp; ctrl.phase = 'running'; ctrl.cycleStart = Date.now();
  appendLog(ctrl.runId, `$ ${command}`);
  appendLog(ctrl.runId, `▶ Ciclo iniciado${ctrl.durationMs > 0 ? ` (dura ${o.durationMin} min)` : ''}`);
  pushOrderUpdate(o);

  if (ctrl.durationMs > 0) {
    ctrl.durationTimer = setTimeout(() => { if (ctrl.child) { ctrl.durationHit = true; ctrl.child.kill('SIGTERM'); } }, ctrl.durationMs);
  }

  let outBuf = '', errBuf = '';
  const handle = (chunk, isErr) => {
    let buf = (isErr ? errBuf : outBuf) + chunk.toString();
    const parts = buf.split(/\r?\n/); buf = parts.pop();
    for (const l of parts) { appendLog(ctrl.runId, isErr ? `[err] ${l}` : l); if (!isErr) detectBooking(o, l); }
    if (isErr) errBuf = buf; else outBuf = buf;
  };
  cp.stdout.on('data', (c) => handle(c, false));
  cp.stderr.on('data', (c) => handle(c, true));

  cp.on('exit', (code, signal) => {
    if (outBuf) appendLog(ctrl.runId, outBuf);
    if (errBuf) appendLog(ctrl.runId, `[err] ${errBuf}`);
    ctrl.child = null;
    if (ctrl.durationTimer) { clearTimeout(ctrl.durationTimer); ctrl.durationTimer = null; }
    ctrl.durationHit = false;

    if (ctrl.booked) { endCycle(o, ctrl, 'booked', '🎫 Cita reservada. Proceso detenido.'); return; }
    if (ctrl.userStopped) { endCycle(o, ctrl, 'stopped', '⏹ Detenido por el usuario.'); return; }
    if (code === 0) { endCycle(o, ctrl, 'finished', '✅ Objetivo alcanzado. Ciclo finalizado.'); return; }

    // El ciclo terminó (por duración o por sí solo). ¿Reprogramar?
    if (ctrl.intervalMs > 0) {
      const wait = Math.max(0, ctrl.intervalMs - (Date.now() - ctrl.cycleStart));
      ctrl.phase = 'paused';
      ctrl.reviveAt = Date.now() + wait;
      appendLog(ctrl.runId, `⏸ Ciclo detenido. Revive en ${Math.round(wait / 1000)} s…`);
      pushOrderUpdate(o); broadcastState();
      ctrl.pauseTimer = setTimeout(() => { ctrl.pauseTimer = null; runCycle(o, ctrl); pushOrderUpdate(o); broadcastState(); }, wait);
    } else {
      // duración sin intervalo: cae y queda detenida
      endCycle(o, ctrl, 'stopped', '⏹ Tiempo de ejecución cumplido. Detenida.');
    }
  });
}

function endCycle(o, ctrl, status, msg) {
  if (msg) appendLog(ctrl.runId, msg);
  if (ctrl.durationTimer) clearTimeout(ctrl.durationTimer);
  if (ctrl.pauseTimer) clearTimeout(ctrl.pauseTimer);
  cycles.delete(o.id);
  if (o.run) { o.run.status = status; o.run.endedAt = Date.now(); }
  saveOrders();
  pushOrderUpdate(o); broadcastState();
}

function stopOrder(id) {
  const o = findOrder(id);
  if (!o) return { ok: false, error: 'Orden no encontrada.' };
  const ctrl = cycles.get(o.id);
  if (!ctrl) return { ok: false, error: 'Esta orden no está en ejecución.' };
  ctrl.userStopped = true;
  if (ctrl.pauseTimer) { clearTimeout(ctrl.pauseTimer); ctrl.pauseTimer = null; }
  if (ctrl.durationTimer) { clearTimeout(ctrl.durationTimer); ctrl.durationTimer = null; }
  if (ctrl.child) { ctrl.child.kill('SIGTERM'); }        // el exit handler llama endCycle
  else { endCycle(o, ctrl, 'stopped', '⏹ Detenido por el usuario.'); } // estaba en pausa
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
function serveFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('no encontrado'); return; }
    res.writeHead(200, { 'Content-Type': type }); res.end(buf);
  });
}

function applyFields(o, b, { isNew }) {
  if (b.cliente !== undefined) o.cliente = String(b.cliente).trim();
  if (b.email !== undefined) o.email = String(b.email).trim();
  if (b.scheduleId !== undefined) o.scheduleId = String(b.scheduleId).trim();
  if (b.refreshDelay !== undefined) o.refreshDelay = String(b.refreshDelay).trim() || '3';
  if (b.current !== undefined) o.current = String(b.current).trim();
  if (b.target !== undefined) o.target = String(b.target).trim();
  if (b.min !== undefined) o.min = String(b.min).trim();
  if (b.dryRun !== undefined) o.dryRun = !!b.dryRun;
  if (b.durationMin !== undefined) o.durationMin = String(b.durationMin).trim();
  if (b.intervalMin !== undefined) o.intervalMin = String(b.intervalMin).trim();
  if (isNew) o.password = b.password || '';
  else if (b.password) o.password = b.password;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    fs.readFile(INDEX_HTML, (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html no encontrado'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && p === '/manifest.webmanifest') { serveFile(res, path.join(__dirname, 'manifest.webmanifest'), 'application/manifest+json; charset=utf-8'); return; }
  if (req.method === 'GET' && p === '/sw.js') { serveFile(res, path.join(__dirname, 'sw.js'), 'application/javascript; charset=utf-8'); return; }
  if (req.method === 'GET' && p.startsWith('/icons/')) { serveFile(res, path.join(__dirname, 'icons', path.basename(p)), 'image/png'); return; }

  if (req.method === 'GET' && p === '/api/state') {
    sendJSON(res, 200, { orders: orders.map(publicOrder), static: STATIC_ENV, runningOrderIds: runningOrderIds(), persistent: dataPersistent, dataDir: DATA_DIR });
    return;
  }

  if (req.method === 'GET' && p === '/api/order') {
    const o = findOrder(url.searchParams.get('id'));
    if (!o) return sendJSON(res, 404, { ok: false, error: 'Orden no encontrada' });
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

  if (req.method === 'GET' && p === '/api/bookings') { sendJSON(res, 200, { bookings }); return; }

  if (req.method === 'POST' && p === '/api/bookings/delete') {
    const b = await readBody(req);
    bookings = bookings.filter((x) => x.id !== b.id); saveBookings();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && p === '/api/bookings/clear') {
    bookings = []; saveBookings();
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('\n');
    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify({ runningOrderIds: runningOrderIds() })}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

function clearLogsHourly() {
  try {
    const activeRunIds = new Set(orders.filter((o) => o.run).map((o) => o.run.id));
    for (const f of fs.readdirSync(LOGS_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const runId = f.slice(0, -6);
      const fp = path.join(LOGS_DIR, f);
      if (activeRunIds.has(runId)) { try { fs.writeFileSync(fp, ''); } catch { /* noop */ } appendLog(runId, '🧹 Logs limpiados automáticamente (cada 1 hora).'); }
      else { try { fs.unlinkSync(fp); } catch { try { fs.writeFileSync(fp, ''); } catch { /* noop */ } } }
    }
  } catch { /* noop */ }
}
setInterval(clearLogsHourly, 60 * 60 * 1000); // cada 1 hora

loadOrders();
loadBookings();
server.listen(PORT, () => { console.log(`\n  US Visa Bot — Dashboard  →  http://localhost:${PORT}\n`); });
