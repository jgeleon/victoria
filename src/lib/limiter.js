// Limitador de tasa GLOBAL compartido entre todas las órdenes (procesos hijos).
// Token-bucket persistido en un archivo común (RATE_LIMIT_FILE). Opt-in:
// si no hay archivo o GLOBAL_MAX_RPS<=0, es un no-op (comportamiento normal).
// Es "best-effort": ante cualquier problema o espera excesiva, deja pasar la
// petición (nunca bloquea el bot indefinidamente).
import fs from 'fs';

const FILE = process.env.RATE_LIMIT_FILE || null;
const RPS = Number(process.env.GLOBAL_MAX_RPS || 0);
const BURST = Math.max(1, Number(process.env.GLOBAL_MAX_BURST || Math.ceil(RPS) || 1));
const MAX_WAIT_MS = 4000;

export function rateLimitEnabled() {
  return !!FILE && RPS > 0;
}

export async function rateLimit() {
  if (!rateLimitEnabled()) return;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      let bucket = { tokens: BURST, ts: Date.now() };
      try { bucket = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* archivo nuevo */ }
      const now = Date.now();
      const elapsed = Math.max(0, (now - (bucket.ts || now)) / 1000);
      let tokens = Math.min(BURST, (Number(bucket.tokens) || 0) + elapsed * RPS);
      if (tokens >= 1) {
        tokens -= 1;
        try { fs.writeFileSync(FILE, JSON.stringify({ tokens, ts: now })); } catch { /* noop */ }
        return;
      }
      try { fs.writeFileSync(FILE, JSON.stringify({ tokens, ts: now })); } catch { /* noop */ }
      const waitMs = Math.min(500, Math.ceil(((1 - tokens) / RPS) * 1000)) + Math.floor(Math.random() * 40);
      await new Promise(r => setTimeout(r, waitMs));
    } catch {
      return; // cualquier error -> proceder sin limitar
    }
  }
  // superado el máximo de espera -> proceder igual
}

// ---------------- límite de logins simultáneos ----------------
// Todas las órdenes salen por la misma IP: muchos logins juntos provocan bloqueos del portal.
// Semáforo entre procesos con archivos de "slot" en LOGIN_LOCK_DIR (opt-in, best-effort).
const LOCK_DIR = process.env.LOGIN_LOCK_DIR || null;
const MAX_LOGINS = Math.max(1, Number(process.env.MAX_CONCURRENT_LOGINS || 2));
const LOCK_STALE_MS = 60000;     // un slot más viejo que esto es de un proceso que murió
const LOCK_MAX_WAIT_MS = 90000;  // nunca esperar más que esto: se sigue sin slot

let heldSlot = null;
process.on('exit', () => { if (heldSlot) { try { fs.unlinkSync(heldSlot); } catch { /* noop */ } } });

function tryAcquire() {
  for (let i = 0; i < MAX_LOGINS; i++) {
    const file = `${LOCK_DIR}/login-${i}.lock`;
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return file;
    } catch {
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(file);
      } catch { /* noop */ }
    }
  }
  return null;
}

export async function withLoginSlot(fn) {
  if (LOCK_DIR) {
    try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch { /* noop */ }
    const start = Date.now();
    let waited = false;
    while (!(heldSlot = tryAcquire()) && Date.now() - start < LOCK_MAX_WAIT_MS) {
      waited = true;
      await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 200)));
    }
    if (waited) console.log(`[${new Date().toISOString()}] ⏳ Esperé ${Math.round((Date.now() - start) / 1000)}s por un turno de login`);
  }
  try {
    // jitter: separa logins de órdenes que arrancan juntas
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1500)));
    return await fn();
  } finally {
    if (heldSlot) { try { fs.unlinkSync(heldSlot); } catch { /* noop */ } heldSlot = null; }
  }
}
