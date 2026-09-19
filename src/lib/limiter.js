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
