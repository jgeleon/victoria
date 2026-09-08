/**
 * Módulo de peticiones rotativas sobre un Pool Fijo de Proxies Residenciales:
 * - Cada request rota al siguiente proxy/slot del pool (Slot 1 -> Slot 2 -> ... -> Slot N).
 * - Las mismas IPs/slots se reutilizan ordenadamente entre ejecuciones y sesiones.
 * - Si un slot del pool recibe un bloqueo (429/403/503) o fallo de red, se salta de inmediato al siguiente slot.
 *
 * Uso CLI:  node src/lib/peticiones_rotativas.js <url> [n_peticiones]
 */

import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { log } from "./utils.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const LOCAL_PROXIES_FILE = path.join(PROJECT_ROOT, "Webshare residential proxies.txt");
const PROXY_LIST_URL = process.env.WEBSHARE_PROXY_LIST_URL || "";
const POOL_SIZE = parseInt(process.env.PROXY_POOL_SIZE || "20", 10);

// Pool de proxies cargados en memoria y caché de agentes
let proxyPool = [];
const agentCache = new Map();
let currentSlotIndex = 0;

/**
 * Parsea una línea de proxy en formato host:port:user:pass a URL de proxy
 */
function parseProxyLine(line) {
  const parts = line.trim().split(":");
  if (parts.length >= 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }
  return null;
}

/**
 * Carga o descarga la lista de proxies para conformar el pool fijo
 */
export function initProxyPool() {
  if (proxyPool.length > 0) return proxyPool;

  let rawLines = [];

  // 1. Intentar leer desde archivo local
  if (fs.existsSync(LOCAL_PROXIES_FILE)) {
    try {
      const content = fs.readFileSync(LOCAL_PROXIES_FILE, "utf8");
      rawLines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch (e) {
      log(`⚠️ No se pudo leer ${LOCAL_PROXIES_FILE}: ${e.message}`);
    }
  }

  // Parsear y limitar al tamaño del pool deseado
  for (const line of rawLines) {
    const parsed = parseProxyLine(line);
    if (parsed) proxyPool.push(parsed);
    if (proxyPool.length >= POOL_SIZE) break;
  }

  // Fallback si no hay lista
  if (proxyPool.length === 0) {
    const user = process.env.PROXY_USER || "dfcbaylc";
    const pass = process.env.PROXY_PASS || "f22krtiwmj51";
    const pais = process.env.PROXY_COUNTRY || "GB";
    const host = process.env.PROXY_HOST || "p.webshare.io:80";
    proxyPool.push(`http://${user}-${pais}-rotate:${pass}@${host}`);
  }

  return proxyPool;
}

/**
 * Obtiene el agente HttpsProxyAgent para una URL de proxy con keepAlive
 */
function getAgentForProxy(proxyUrl) {
  if (!agentCache.has(proxyUrl)) {
    agentCache.set(
      proxyUrl,
      new HttpsProxyAgent(proxyUrl, {
        keepAlive: true,
        keepAliveMsecs: 30000,
        timeout: 15000
      })
    );
  }
  return agentCache.get(proxyUrl);
}

/**
 * Descarta un agente fallido para renovar su conexión
 */
function resetAgentForProxy(proxyUrl) {
  if (agentCache.has(proxyUrl)) {
    try {
      agentCache.get(proxyUrl).destroy();
    } catch { /* noop */ }
    agentCache.delete(proxyUrl);
  }
}

/**
 * Reinicia el puntero del pool al inicio (ej. al comenzar un nuevo ciclo)
 */
export function resetPoolIndex() {
  currentSlotIndex = 0;
}

/**
 * Realiza una petición HTTPS rotando secuencialmente sobre el pool fijo de proxies.
 * Si un slot del pool es bloqueado, salta automáticamente al siguiente slot.
 *
 * @param {string} url - URL destino
 * @param {object} options - Opciones de fetch
 * @param {number} maxRetries - Intentos máximos en caso de bloqueo o error de red (default: 3)
 * @returns {Promise<Response>} - Respuesta estándar de fetch
 */
export async function fetchRotativo(url, options = {}, maxRetries = 3) {
  const pool = initProxyPool();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const slotNumber = (currentSlotIndex % pool.length) + 1;
    const proxyUrl = pool[currentSlotIndex % pool.length];
    currentSlotIndex = (currentSlotIndex + 1) % pool.length;

    const agent = getAgentForProxy(proxyUrl);
    const headers = {
      ...options.headers,
      "Connection": "keep-alive"
    };

    try {
      const res = await fetch(url, {
        ...options,
        headers,
        agent
      });

      // Si el servidor responde con bloqueo / rate-limit:
      if (res.status === 429 || res.status === 403 || res.status === 503) {
        const razon = res.status === 429
          ? "Límite de peticiones alcanzado (HTTP 429)"
          : res.status === 403
          ? "Acceso denegado / Bloqueo (HTTP 403)"
          : "Servicio no disponible (HTTP 503)";

        log(`⚠️ IP bloqueada en Slot ${slotNumber} (${razon}). Saltando al siguiente proxy del pool...`);
        resetAgentForProxy(proxyUrl);

        if (attempt < maxRetries) {
          log(`🔄 Reintentando en siguiente slot del pool (intento ${attempt + 1}/${maxRetries})...`);
          continue;
        }
      }

      return res;
    } catch (err) {
      log(`⚠️ Error de conexión en Slot ${slotNumber} (${err.message}). Saltando al siguiente proxy...`);
      resetAgentForProxy(proxyUrl);

      if (attempt < maxRetries) {
        log(`🔄 Reintentando en siguiente slot del pool (intento ${attempt + 1}/${maxRetries})...`);
        continue;
      }
      throw err;
    }
  }
}

// Export default para uso directo como sustituto de fetch
export default fetchRotativo;

// Compatibilidad con CLI si se ejecuta directamente: node src/lib/peticiones_rotativas.js <url> [n_peticiones]
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.argv[2] || "https://api.ipify.org";
  const n = parseInt(process.argv[3] || "6", 10);
  const pool = initProxyPool();

  console.log(`Pool activo: ${pool.length} proxies.`);
  console.log(`Probando ${n} peticiones en round-robin a ${url}...`);

  for (let i = 1; i <= n; i++) {
    try {
      const res = await fetchRotativo(url);
      const body = (await res.text()).slice(0, 120);
      console.log(`[Petición ${i}] HTTP ${res.status}  ${body}`);
    } catch (e) {
      console.log(`[Petición ${i}] ERROR: ${e.message}`);
    }
  }
}
