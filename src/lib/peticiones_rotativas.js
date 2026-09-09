/**
 * Módulo de peticiones rotativas sobre Pools Dinámicos de Proxies Residenciales:
 * - Soporta generación de N listas/pools de IPs según el parámetro PROXY_POOLS_COUNT (ej. 2, 3, etc.).
 * - Ciclo 1 -> usa Pool #1 (ej. Slots 1..20)
 * - Ciclo 2 -> usa Pool #2 (ej. Slots 21..40)
 * - Ciclo 3 -> reutiliza Pool #1 (Slots 1..20) si POOLS_COUNT=2, o Pool #3 si POOLS_COUNT=3.
 * - Durante la ejecución de un ciclo, cada petición rota en round-robin por los slots de ese pool activo.
 * - Si un slot es bloqueado (429/403/503) o sufre un fallo de red, salta automáticamente al siguiente slot.
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
const STATE_FILE = path.join(PROJECT_ROOT, "web", "data", "cycle_pool_state.json");

const POOLS_COUNT = parseInt(process.env.PROXY_POOLS_COUNT || "2", 10);
const POOL_SIZE = parseInt(process.env.PROXY_POOL_SIZE || "20", 10);

// Pool de proxies cargados en memoria y caché de agentes
let activeProxyPool = [];
let activePoolNumber = 1;
let slotStartNumber = 1;
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
 * Obtiene o persiste el índice del pool para ejecuciones independientes
 */
function resolvePoolNumber() {
  if (process.env.PROXY_POOL_INDEX) {
    const num = parseInt(process.env.PROXY_POOL_INDEX, 10);
    return isFinite(num) && num > 0 ? ((num - 1) % POOLS_COUNT) + 1 : 1;
  }

  // Si no se pasó por env, persistir en archivo para rotar entre llamadas
  let lastIndex = 0;
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      lastIndex = Number(data.lastPoolIndex || 0);
    }
  } catch { /* noop */ }

  const nextIndex = (lastIndex % POOLS_COUNT) + 1;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastPoolIndex: nextIndex }));
  } catch { /* noop */ }

  return nextIndex;
}

/**
 * Carga o descarga la lista de proxies para conformar el pool fijo
 */
export function initProxyPool() {
  if (activeProxyPool.length > 0) return activeProxyPool;

  activePoolNumber = resolvePoolNumber();
  let allLines = [];

  // 1. Intentar leer desde archivo local
  if (fs.existsSync(LOCAL_PROXIES_FILE)) {
    try {
      const content = fs.readFileSync(LOCAL_PROXIES_FILE, "utf8");
      allLines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    } catch (e) {
      log(`⚠️ No se pudo leer ${LOCAL_PROXIES_FILE}: ${e.message}`);
    }
  }

  // Parsear todos los proxies disponibles
  const allProxies = [];
  for (const line of allLines) {
    const parsed = parseProxyLine(line);
    if (parsed) allProxies.push(parsed);
  }

  // Calcular el rango del pool activo para este ciclo
  const startIndex = (activePoolNumber - 1) * POOL_SIZE;
  const endIndex = startIndex + POOL_SIZE;
  slotStartNumber = startIndex + 1;

  if (allProxies.length > 0) {
    activeProxyPool = allProxies.slice(startIndex, endIndex);
    // Si la lista no cubre todo, circular desde el inicio
    if (activeProxyPool.length === 0) {
      activeProxyPool = allProxies.slice(0, POOL_SIZE);
      slotStartNumber = 1;
    }
  }

  // Fallback si no hay lista
  if (activeProxyPool.length === 0) {
    const user = process.env.PROXY_USER || "dfcbaylc";
    const pass = process.env.PROXY_PASS || "f22krtiwmj51";
    const pais = process.env.PROXY_COUNTRY || "GB";
    const host = process.env.PROXY_HOST || "p.webshare.io:80";
    activeProxyPool.push(`http://${user}-${pais}-rotate:${pass}@${host}`);
  }

  const slotEndNumber = slotStartNumber + activeProxyPool.length - 1;
  log(`🌐 [Proxy Pool] Ciclo activo usando Pool #${activePoolNumber} de ${POOLS_COUNT} (${activeProxyPool.length} proxies, Slots ${slotStartNumber} al ${slotEndNumber})`);

  return activeProxyPool;
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
 * Realiza una petición HTTPS rotando secuencialmente sobre el pool activo de proxies.
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
    const currentLocalIndex = currentSlotIndex % pool.length;
    const globalSlotNumber = slotStartNumber + currentLocalIndex;
    const proxyUrl = pool[currentLocalIndex];
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

        log(`⚠️ IP bloqueada en Slot ${globalSlotNumber} (${razon}). Saltando al siguiente proxy del pool...`);
        resetAgentForProxy(proxyUrl);

        if (attempt < maxRetries) {
          log(`🔄 Reintentando en siguiente slot del pool (intento ${attempt + 1}/${maxRetries})...`);
          continue;
        }
      }

      return res;
    } catch (err) {
      log(`⚠️ Error de conexión en Slot ${globalSlotNumber} (${err.message}). Saltando al siguiente proxy...`);
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
  const n = parseInt(process.argv[3] || "4", 10);
  const pool = initProxyPool();

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
