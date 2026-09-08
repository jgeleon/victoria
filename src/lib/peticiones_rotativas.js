/**
 * Módulo de peticiones rotativas inteligentes:
 * - Mantiene una IP residencial fija y persistente (keepAlive) para máxima velocidad y estabilidad de sesión.
 * - Si detecta un bloqueo (HTTP 429, 403, 503) o error de red (ECONNRESET, ETIMEDOUT, socket hang up),
 *   destruye la conexión y rota automáticamente a una nueva IP limpia al instante.
 *
 * Uso CLI:  node src/lib/peticiones_rotativas.js <url> [n_peticiones]
 */

import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fileURLToPath } from "node:url";
import { log } from "./utils.js";

// --- Proxy rotativo (Webshare Rotating Residential) -------------------------
const USER = process.env.PROXY_USER || "dfcbaylc";
const PASS = process.env.PROXY_PASS || "f22krtiwmj51";
const PAIS = process.env.PROXY_COUNTRY || "GB"; // PAIS: GB, PE, US...
const HOST = process.env.PROXY_HOST || "p.webshare.io:80";

export const PROXY_URL = process.env.PROXY_URL || `http://${USER}-${PAIS}-rotate:${PASS}@${HOST}`;

// Agente persistente activo para reutilizar IP y reducir latencia
let activeAgent = null;

/**
 * Obtiene el agente HTTP proxy activo o crea uno nuevo con keepAlive: true
 */
export function getProxyAgent() {
  if (!activeAgent) {
    activeAgent = new HttpsProxyAgent(PROXY_URL, {
      keepAlive: true,
      keepAliveMsecs: 30000,
      timeout: 15000
    });
  }
  return activeAgent;
}

/**
 * Fuerza el cambio inmediato a una nueva IP destruyendo la conexión actual.
 * @param {string} motivo - Razón del cambio para fines de registro
 */
export function rotarIp(motivo = "") {
  if (activeAgent) {
    try {
      activeAgent.destroy();
    } catch { /* noop */ }
    activeAgent = null;
  }
  if (motivo) {
    log(`🔄 [Proxy] Rotando IP inmediatamente (${motivo})`);
  }
}

/**
 * Realiza una petición HTTPS pasando por el proxy.
 * Reutiliza la IP para velocidad y rota instantáneamente ante bloqueos o fallos de red.
 *
 * @param {string} url - URL destino
 * @param {object} options - Opciones de fetch
 * @param {number} maxRetries - Intentos máximos en caso de bloqueo o error de red (default: 2)
 * @returns {Promise<Response>} - Respuesta estándar de fetch
 */
export async function fetchRotativo(url, options = {}, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const agent = getProxyAgent();

    const headers = {
      ...options.headers,
      'Connection': 'keep-alive'
    };

    try {
      const res = await fetch(url, {
        ...options,
        headers,
        agent
      });

      // Si la respuesta indica bloqueo o rate-limit por parte del servidor:
      if (res.status === 429 || res.status === 403 || res.status === 503) {
        const razon = res.status === 429 
          ? 'Límite de peticiones alcanzado (HTTP 429)' 
          : res.status === 403 
          ? 'Acceso denegado / Bloqueo (HTTP 403)' 
          : 'Servicio no disponible (HTTP 503)';

        log(`⚠️ IP bloqueada: ${razon}. Cambiando de IP inmediatamente...`);
        rotarIp();
        if (attempt < maxRetries) {
          log(`🔄 Reintentando petición con nueva IP (intento ${attempt + 1}/${maxRetries})...`);
          continue;
        }
      }

      return res;
    } catch (err) {
      log(`⚠️ Error de conexión en la IP actual (${err.message}). Cambiando de IP...`);
      rotarIp();
      if (attempt < maxRetries) {
        log(`🔄 Reintentando petición con nueva IP (intento ${attempt + 1}/${maxRetries})...`);
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

  console.log(`Probando peticiones a ${url} con IP persistente y rotación bajo demanda...`);
  for (let i = 1; i <= n; i++) {
    try {
      if (i === 3) {
        console.log("-> Simulando rotación forzada en iteración 3...");
        rotarIp("Prueba CLI");
      }
      const res = await fetchRotativo(url);
      const body = (await res.text()).slice(0, 120);
      console.log(`[${i}] ${res.status}  ${body}`);
    } catch (e) {
      console.log(`[${i}] ERROR: ${e.message}`);
    }
  }
}
