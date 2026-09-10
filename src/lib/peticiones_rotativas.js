/**
 * Módulo de peticiones rotativas:
 * - Cada request sale por una IP distinta del proxy rotativo de Webshare.
 * - Conexión sin persistencia (keepAlive: false, Connection: close) para forzar una IP nueva por cada petición.
 * - Reintento automático con nueva IP inmediata ante bloqueos (HTTP 429, 403, 503) o caídas de conexión.
 *
 * Uso CLI:  node src/lib/peticiones_rotativas.js <url> [n_peticiones]
 */

import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { log } from "./utils.js";

dotenv.config();

// --- Proxy rotativo (Webshare Rotating Residential) -------------------------
const USER = process.env.PROXY_USER || "dfcbaylc";
const PASS = process.env.PROXY_PASS || "f22krtiwmj51";
const PAIS = process.env.PROXY_COUNTRY || "US"; // PAIS: US, PE, GB...
const HOST = process.env.PROXY_HOST || "p.webshare.io:80";

export const PROXY_URL = process.env.PROXY_URL || `http://${USER}-${PAIS}-rotate:${PASS}@${HOST}`;

/**
 * Realiza una petición HTTPS pasando por el proxy rotativo.
 * Crea un agente nuevo por petición para asegurar una IP diferente en cada llamada.
 *
 * @param {string} url - URL destino
 * @param {object} options - Opciones de fetch
 * @param {number} maxRetries - Intentos máximos en caso de bloqueo o error de red (default: 2)
 * @returns {Promise<Response>} - Respuesta estándar de fetch
 */
export async function fetchRotativo(url, options = {}, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const agent = new HttpsProxyAgent(PROXY_URL, {
      keepAlive: false
    });

    const headers = {
      ...options.headers,
      "Connection": "close"
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
          ? "Límite de peticiones alcanzado (HTTP 429)"
          : res.status === 403
          ? "Acceso denegado / Bloqueo (HTTP 403)"
          : "Servicio no disponible (HTTP 503)";

        log(`⚠️ IP bloqueada: ${razon}. Cambiando de IP inmediatamente...`);

        if (attempt < maxRetries) {
          log(`🔄 Reintentando petición con nueva IP (intento ${attempt + 1}/${maxRetries})...`);
          continue;
        }
      }

      return res;
    } catch (err) {
      log(`⚠️ Error de conexión en la IP actual (${err.message}). Cambiando de IP...`);

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
  const n = parseInt(process.argv[3] || "5", 10);

  console.log(`Probando ${n} peticiones a ${url} con rotación de IP por cada request...`);
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
