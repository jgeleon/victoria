/**
 * Módulo de peticiones rotativas: cada request sale por una IP distinta del proxy rotativo.
 * Usa node-fetch y https-proxy-agent para compatibilidad y rotación por conexión.
 *
 * Uso CLI:  node src/lib/peticiones_rotativas.js <url> [n_peticiones]
 */

import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fileURLToPath } from "node:url";

// --- Proxy rotativo (Webshare Rotating Residential) -------------------------
const USER = process.env.PROXY_USER || "dfcbaylc";
const PASS = process.env.PROXY_PASS || "f22krtiwmj51";
const PAIS = process.env.PROXY_COUNTRY || "GB"; // PAIS: GB, PE, US...
const HOST = process.env.PROXY_HOST || "p.webshare.io:80";

export const PROXY_URL = process.env.PROXY_URL || `http://${USER}-${PAIS}-rotate:${PASS}@${HOST}`;

/**
 * Realiza una petición HTTPS pasando a través del proxy rotativo.
 * Crea un nuevo agente por petición para asegurar una IP diferente en cada llamada.
 *
 * @param {string} url - URL destino
 * @param {object} options - Opciones de fetch (headers, method, body, etc.)
 * @returns {Promise<Response>} - Respuesta estándar de fetch
 */
export async function fetchRotativo(url, options = {}) {
  const agent = new HttpsProxyAgent(PROXY_URL, {
    keepAlive: false
  });

  const headers = {
    ...options.headers,
    'Connection': 'close'
  };

  return fetch(url, {
    ...options,
    headers,
    agent
  });
}

// Export default para uso directo como sustituto de fetch
export default fetchRotativo;

// Compatibilidad con CLI si se ejecuta directamente: node src/lib/peticiones_rotativas.js <url> [n_peticiones]
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.argv[2] || "https://api.ipify.org";
  const n = parseInt(process.argv[3] || "5", 10);

  console.log(`Probando ${n} peticiones a ${url} con proxy rotativo...`);
  for (let i = 1; i <= n; i++) {
    try {
      const res = await fetchRotativo(url);
      const body = (await res.text()).slice(0, 120);
      console.log(`[${i}] ${res.status}  ${body}`);
    } catch (e) {
      console.log(`[${i}] ERROR: ${e.message}`);
    }
  }
}
