import fetch from 'node-fetch';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import cheerio from 'cheerio';
import { log } from './utils.js';
import { getBaseUri } from './config.js';
import { rateLimit } from './limiter.js';

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

// Proxy SOLO para el login/re-login (cuando la sesión murió y hay que re-autenticar).
// Activo por defecto; se apaga con USE_PROXY=false. Las peticiones normales
// (fechas/horarios/reserva) siempre salen por la IP directa del servidor.
function loginProxyEnabled() {
  const v = String(process.env.USE_PROXY ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}
function proxyUrl() {
  if (process.env.PROXY_URL) return process.env.PROXY_URL;
  const user = process.env.PROXY_USER || 'dfcbaylc';
  const pass = process.env.PROXY_PASS || 'f22krtiwmj51';
  const country = process.env.PROXY_COUNTRY || 'US';
  const host = process.env.PROXY_HOST || 'p.webshare.io:80';
  return `http://${user}-${country}-rotate:${pass}@${host}`;
}
function makeProxyAgent() {
  try { return new HttpsProxyAgent(proxyUrl(), { keepAlive: false }); }
  catch { return null; }
}
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
];
const USER_AGENT = USER_AGENTS[0];

// Client hints que manda Chrome real (Safari/Firefox no los mandan). Reducen bloqueos del WAF.
function clientHints(userAgent) {
  const m = /Chrome\/(\d+)/.exec(userAgent || '');
  if (!m) return {};
  const platform = /Windows/.test(userAgent) ? 'Windows' : /Mac OS X/.test(userAgent) ? 'macOS' : 'Linux';
  return {
    'sec-ch-ua': `"Not(A:Brand";v="8", "Chromium";v="${m[1]}", "Google Chrome";v="${m[1]}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`
  };
}

// Timeouts por tipo de petición. El POST de reserva nunca se corta pronto: abortarlo deja
// la duda de si el portal ya lo procesó.
const TIMEOUT_PAGE_MS = 10000;
const TIMEOUT_JSON_MS = 10000;
const TIMEOUT_BOOKING_MS = 60000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);

const COMMON_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

export class VisaClientError extends Error {
  constructor(message, code, options = {}) {
    super(message);
    this.name = 'VisaClientError';
    this.code = code;
    Object.assign(this, options);
  }
}

export class VisaHttpClient {
  constructor(countryCode, email, password, options = {}) {
    this.baseUri = getBaseUri(countryCode);
    this.email = email;
    this.password = password;
    this.requestTimeoutMs = options.requestTimeoutMs || 15000;
    this.fetch = options.fetch || fetch;
    this.cookies = new Map();
    this.csrfToken = null;
    this.inFlight = 0;      // peticiones esperando respuesta (para el cierre ordenado)
    this.stopping = false;  // en cierre: no se inician peticiones nuevas
    this.userAgent = options.userAgent || USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    this.lang = /\/es-/.test(this.baseUri) ? 'es' : 'en';
    this.rescheduleLimit = null; // { max, remaining } leído de la página de advertencia del portal
    this.lastTrace = [];         // "status url" de la última petición (diagnóstico de sesión)
  }

  exportSession() {
    return { cookies: Object.fromEntries(this.cookies), csrfToken: this.csrfToken };
  }

  importSession(data) {
    if (!data || typeof data !== 'object') return false;
    this.cookies.clear();
    for (const [k, v] of Object.entries(data.cookies || {})) this.cookies.set(k, v);
    this.csrfToken = data.csrfToken || null;
    return this.cookies.size > 0;
  }

  currentHeaders() {
    return this._sessionHeaders();
  }

  async login() {
    log('Logging in');
    log(loginProxyEnabled() ? '🔀 Login vía proxy rotativo (US)' : '🏠 Login por IP directa');
    this.cookies.clear();

    const signInUrl = `${this.baseUri}/users/sign_in`;
    const signInResponse = await this._request(signInUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      useProxy: true
    });
    const signInHtml = await signInResponse.text();
    const csrfToken = this._extractCsrfToken(signInHtml, signInResponse.url);

    const loginData = {
      utf8: '✓',
      'user[email]': this.email,
      'user[password]': this.password,
      policy_confirmed: '1',
      commit: 'Sign In'
    };

    let loginResponse = await this._request(signInUrl, {
      method: 'POST',
      headers: {
        Accept: 'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: new URL(this.baseUri).origin,
        Referer: signInUrl,
        'X-CSRF-Token': csrfToken,
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: new URLSearchParams(loginData),
      useProxy: true
    });
    let loginHtml = await loginResponse.text();
    const javascriptRedirect = this._javascriptRedirect(loginHtml);

    // Errores que NO se arreglan reintentando: cada intento fallido suma al bloqueo de la cuenta
    const lockMatch = /account is locked until ([^<.]+)/i.exec(loginHtml) || /cuenta (?:est[aá] )?bloqueada hasta ([^<.]+)/i.exec(loginHtml);
    if (lockMatch) {
      throw new VisaClientError(`Cuenta bloqueada por el portal hasta ${lockMatch[1].trim()}`, 'ELOCKED');
    }
    if (!javascriptRedirect && (loginHtml.includes('sign_in_form') || /invalid email or password|correo electr[oó]nico o contrase[nñ]a (?:no v[aá]lidos|inv[aá]lidos)/i.test(loginHtml))) {
      throw new VisaClientError('Email o contraseña incorrectos', 'ECREDENTIALS');
    }

    if (javascriptRedirect) {
      loginResponse = await this._request(new URL(javascriptRedirect, signInUrl), {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        useProxy: true
      });
      loginHtml = await loginResponse.text();
    }

    if (this._isSignInPage(loginResponse.url, loginHtml)) {
      throw new VisaClientError('Login failed: the visa site returned the sign-in page', 'EAUTH');
    }

    this.csrfToken = this._findCsrfToken(loginHtml) || csrfToken;
    return this._sessionHeaders();
  }

  async verifyAccountContext(scheduleId) {
    // Sin confirmed_limit_message: el portal muestra la advertencia con "Le quedan N intentos"
    const response = await this._request(this._appointmentUrl(scheduleId), {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      timeoutMs: TIMEOUT_PAGE_MS
    });
    const html = await response.text();

    if (this._isSignInPage(response.url, html)) {
      throw new VisaClientError('Session expired while verifying the appointment schedule', 'EAUTH');
    }

    this.csrfToken = this._findCsrfToken(html) || this.csrfToken;
    const limit = parseRescheduleLimit(html);
    if (limit.max !== null || limit.remaining !== null) this.rescheduleLimit = limit;
    return html;
  }

  async checkAvailableDate(_headers, scheduleId, facilityId, { onlyBusinessDay = false } = {}) {
    const url = new URL(`${this.baseUri}/schedule/${encodeURIComponent(scheduleId)}/appointment/days/${encodeURIComponent(facilityId)}.json`);
    url.searchParams.set('appointments[expedite]', 'false');

    const data = await this._jsonRequest(url, scheduleId);

    if (!Array.isArray(data)) {
      throw new VisaClientError('Unexpected appointment-days response: expected an array', 'ESCHEMA');
    }
    if (data.some(item => typeof item?.date !== 'string')) {
      throw new VisaClientError('Unexpected appointment-days response: invalid date entry', 'ESCHEMA');
    }

    log(`##DATES##${JSON.stringify(data)}`);
    const items = onlyBusinessDay ? data.filter(item => item.business_day !== false) : data;
    return items.map(item => item.date);
  }

  async checkAvailableTimes(_headers, scheduleId, facilityId, date) {
    const url = new URL(`${this.baseUri}/schedule/${encodeURIComponent(scheduleId)}/appointment/times/${encodeURIComponent(facilityId)}.json`);
    url.searchParams.set('date', date);
    url.searchParams.set('appointments[expedite]', 'false');

    const data = await this._jsonRequest(url, scheduleId);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new VisaClientError('Unexpected appointment-times response: expected an object', 'ESCHEMA');
    }

    const availableTimes = data.available_times;
    const businessTimes = data.business_times;
    if (availableTimes !== undefined && !Array.isArray(availableTimes)) {
      throw new VisaClientError('Unexpected appointment-times response: invalid available_times', 'ESCHEMA');
    }
    if (businessTimes !== undefined && !Array.isArray(businessTimes)) {
      throw new VisaClientError('Unexpected appointment-times response: invalid business_times', 'ESCHEMA');
    }

    const times = availableTimes?.length ? availableTimes : (businessTimes || []);
    const uniqueTimes = [...new Set(times.filter(time => typeof time === 'string' && time.trim()))];
    log(`##TIMES##${JSON.stringify({ date, times: uniqueTimes })}`);
    return uniqueTimes;
  }

  async book(_headers, scheduleId, facilityId, date, time) {
    const url = this._appointmentUrl(scheduleId);
    const formUrl = this._appointmentFormUrl(scheduleId);

    // Intento rápido: reutiliza el CSRF cacheado y evita el GET previo a la reserva
    if (this.csrfToken) {
      let fast = null;
      try {
        fast = await this._postBooking(url, formUrl, this._buildBookingData(this.csrfToken, facilityId, date, time));
      } catch (err) {
        // 422 = token CSRF rechazado: el portal NO procesó la reserva, se reintenta con token fresco
        if (!(err?.code === 'EHTTP' && err.status === 422)) throw err;
        log('Token CSRF rechazado (422); pidiendo el formulario para un token fresco');
      }
      if (fast) {
        const outcome = this._classifyBooking(fast.response.url, fast.body, date, time);
        if (outcome === 'ok') return fast.response;
        if (outcome === 'slot') throw new VisaClientError('Booking failed; the slot became unavailable', 'ESLOT_UNAVAILABLE');
        if (outcome === 'unknown') {
          // No sabemos si reservó: un segundo POST podría gastar otra reprogramación (en Perú son limitadas)
          throw new VisaClientError('Booking response could not be classified; stopping to avoid a duplicate reschedule', 'EBOOKING_UNVERIFIED');
        }
        // 'auth' / 'form' -> el portal no procesó la reserva; reintenta con token fresco
      }
    }

    // Camino con token fresco: GET al formulario de cita -> POST
    const appointmentResponse = await this._request(formUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      timeoutMs: TIMEOUT_PAGE_MS
    });
    const appointmentHtml = await appointmentResponse.text();
    if (this._isSignInPage(appointmentResponse.url, appointmentHtml)) {
      throw new VisaClientError('Session expired while loading the appointment form', 'EAUTH');
    }
    this.csrfToken = this._findAuthenticityToken(appointmentHtml) || this._extractCsrfToken(appointmentHtml, appointmentResponse.url);

    const { response, body } = await this._postBooking(url, formUrl, this._buildBookingData(this.csrfToken, facilityId, date, time));
    const outcome = this._classifyBooking(response.url, body, date, time);
    if (outcome === 'ok') return response;
    if (outcome === 'auth') throw new VisaClientError('Session expired while booking', 'EAUTH');
    if (outcome === 'slot') throw new VisaClientError('Booking failed; the slot became unavailable', 'ESLOT_UNAVAILABLE');
    if (outcome === 'form') throw new VisaClientError('Booking failed; the portal re-rendered the appointment form', 'ESLOT_UNAVAILABLE');

    const verified = await this._verifyBookedDate(scheduleId, date, time);
    if (!verified) {
      throw new VisaClientError('Booking response could not be verified; stopping to avoid a duplicate reschedule', 'EBOOKING_UNVERIFIED');
    }
    return response;
  }

  _buildBookingData(csrfToken, facilityId, date, time) {
    return {
      utf8: '✓',
      authenticity_token: csrfToken,
      confirmed_limit_message: '1',
      use_consulate_appointment_capacity: 'true',
      'appointments[consulate_appointment][facility_id]': facilityId,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      // Perú no usa CAS: el formulario real no trae campos asc_appointment.
      // commit = texto del botón; es-pe lo exige (reprogramaciones limitadas).
      commit: this.lang === 'es' ? 'Reprogramar' : 'Reschedule'
    };
  }

  async _postBooking(url, referer, bookingData) {
    let response;
    try {
      response = await this._request(url, {
        method: 'POST',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Origin: new URL(this.baseUri).origin,
          Referer: referer,
          'X-CSRF-Token': bookingData.authenticity_token
        },
        body: new URLSearchParams(bookingData),
        timeoutMs: TIMEOUT_BOOKING_MS
      });
    } catch (err) {
      // Timeout o caída de red durante el POST: no se sabe si el portal lo procesó
      if (err?.code === 'ETRANSIENT') {
        throw new VisaClientError(`Booking POST did not complete (${err.message}); the portal may have processed it`, 'EBOOKING_UNVERIFIED', { cause: err });
      }
      throw err;
    }
    const body = await response.text();
    return { response, body };
  }

  // Clasifica la respuesta de reserva sin lanzar:
  //   'ok'      reservó (redirección a /instructions o texto de éxito)
  //   'slot'    el portal dijo que el cupo ya no está
  //   'auth'    sesión caída (no procesó)
  //   'form'    volvió el formulario de cita sin éxito (no procesó)
  //   'unknown' no se reconoce: NO se debe repetir el POST
  _classifyBooking(url, body, date, time) {
    if (/\/appointment\/instructions/.test(String(url))) return 'ok';
    if (this._isSignInPage(url, body)) return 'auth';
    const normalized = cheerio.load(body)('body').text().toLowerCase();
    if (BOOKING_FAILURES.some(m => normalized.includes(m))) return 'slot';
    const positive = BOOKING_SUCCESS.some(m => normalized.includes(m)) ||
      (normalized.includes(date.toLowerCase()) && normalized.includes(time.toLowerCase()));
    if (positive) return 'ok';
    if (String(body).includes('appointments[consulate_appointment][date]')) return 'form';
    return 'unknown';
  }

  _looksLikeChallenge(html = '') {
    const t = String(html).toLowerCase();
    return t.includes('cloudflare') || t.includes('cf-chl') || t.includes('just a moment') ||
      t.includes('attention required') || t.includes('captcha') || t.includes('access denied') ||
      t.includes('/cdn-cgi/') || t.includes('are you a human') || t.includes('unusual traffic');
  }

  async _jsonRequest(url, scheduleId) {
    const startedAt = Date.now();
    const response = await this._request(url, {
      headers: {
        Accept: 'application/json, text/javascript',
        Referer: this._appointmentUrl(scheduleId),
        'X-Requested-With': 'XMLHttpRequest',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty'
      },
      timeoutMs: TIMEOUT_JSON_MS
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const text = await response.text();

    if (this._isSignInPage(response.url, text)) {
      throw new VisaClientError('Session expired: received the sign-in page for appointment data', 'EAUTH');
    }
    if (!contentType.includes('json')) {
      if (this._looksLikeChallenge(text)) {
        throw new VisaClientError('Visa site returned a WAF/anti-bot challenge instead of JSON', 'EBLOCK');
      }
      throw new VisaClientError(`Expected JSON appointment data but received ${contentType || 'unknown content type'}`, 'ESCHEMA');
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new VisaClientError('Visa site returned malformed JSON appointment data', 'ESCHEMA');
    }

    if (data?.error) {
      throw new VisaClientError(String(data.error), this._errorCodeFromMessage(data.error));
    }

    log(`Appointment API ${response.status} in ${Date.now() - startedAt}ms`);
    return data;
  }

  async _request(initialUrl, options = {}) {
    // En cierre no se inicia nada nuevo: el proceso sale en cuanto se guarde la sesión
    if (this.stopping) await new Promise(() => {});
    this.inFlight += 1;
    try {
      return await this._requestOnce(initialUrl, options);
    } finally {
      this.inFlight -= 1;
    }
  }

  async _requestOnce(initialUrl, options = {}) {
    let url = String(initialUrl);
    let requestOptions = { ...options, headers: { ...options.headers } };
    let usingProxy = !!options.useProxy && loginProxyEnabled();
    let proxyFellBack = false;
    const timeoutMs = options.timeoutMs || this.requestTimeoutMs;
    delete requestOptions.useProxy;
    delete requestOptions.timeoutMs;
    this.lastTrace = [];

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await rateLimit();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const requestAgent = url.startsWith('http:') ? undefined : (usingProxy ? (makeProxyAgent() || keepAliveAgent) : keepAliveAgent);
      let response;

      try {
        response = await this.fetch(url, {
          ...requestOptions,
          agent: requestAgent,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            ...COMMON_HEADERS,
            'User-Agent': this.userAgent,
            ...clientHints(this.userAgent),
            ...(usingProxy ? { Connection: 'close' } : {}),
            ...requestOptions.headers,
            ...(this.cookies.size ? { Cookie: this._cookieHeader() } : {})
          }
        });
      } catch (error) {
        if (usingProxy && !proxyFellBack && error?.name !== 'AbortError' && error?.type !== 'aborted') {
          proxyFellBack = true;
          usingProxy = false;
          log(`Proxy de login falló (${error.message}); reintentando el login por IP directa`);
          continue;
        }
        if (error?.name === 'AbortError' || error?.type === 'aborted') {
          throw new VisaClientError(`Request timed out after ${timeoutMs}ms`, 'ETRANSIENT', { cause: error });
        }
        throw new VisaClientError(`Network request failed [${describeNetworkError(error)}]: ${error.message}`, 'ETRANSIENT', { cause: error, netCode: error?.code });
      } finally {
        clearTimeout(timeout);
      }

      this._storeCookies(response);
      this.lastTrace.push(`${response.status} ${new URL(url).pathname}${REDIRECT_STATUSES.has(response.status) ? ` -> ${response.headers.get('location') || '?'}` : ''}`);

      if (REDIRECT_STATUSES.has(response.status) && response.headers.get('location')) {
        if (redirectCount === 5) {
          throw new VisaClientError('Too many redirects from visa site', 'EHTTP');
        }
        const redirectUrl = new URL(response.headers.get('location'), url);
        if (redirectUrl.origin !== new URL(this.baseUri).origin) {
          throw new VisaClientError('Visa site redirected to an unexpected origin', 'EHTTP');
        }
        url = redirectUrl.toString();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestOptions.method === 'POST')) {
          requestOptions = { headers: { Accept: requestOptions.headers.Accept } };
        }
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new VisaClientError(`Visa site rejected the session with HTTP ${response.status}`, 'EAUTH', { status: response.status });
      }
      if (response.status === 429) {
        throw new VisaClientError('Visa site rate limit reached', 'ERATELIMIT', {
          status: response.status,
          retryAfterSeconds: this._retryAfterSeconds(response)
        });
      }
      if (TRANSIENT_STATUSES.has(response.status)) {
        throw new VisaClientError(`Visa site returned HTTP ${response.status}`, 'ETRANSIENT', { status: response.status });
      }
      if (!response.ok) {
        throw new VisaClientError(`Visa site returned HTTP ${response.status}`, 'EHTTP', { status: response.status });
      }

      return response;
    }

    throw new VisaClientError('Unexpected redirect handling failure', 'EHTTP');
  }

  _storeCookies(response) {
    const rawCookies = response.headers.raw?.()['set-cookie'] || [];
    let changed = false;
    for (const header of rawCookies) {
      const normalizedHeader = String(header);
      const cookiePart = normalizedHeader.split(';', 1)[0];
      const separator = cookiePart.indexOf('=');
      if (separator <= 0) continue;
      const name = cookiePart.slice(0, separator).trim();
      const value = cookiePart.slice(separator + 1).trim();
      if (value && !/;\s*max-age=0(?:;|$)/i.test(normalizedHeader)) {
        if (this.cookies.get(name) !== value) { this.cookies.set(name, value); changed = true; }
      } else if (this.cookies.delete(name)) changed = true;
    }
    // El sitio rota la cookie de sesión en cada respuesta: avisar para persistirla al instante
    if (changed && this.onCookiesChanged) {
      try { this.onCookiesChanged(); } catch { /* noop */ }
    }
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  _sessionHeaders() {
    return {
      ...COMMON_HEADERS,
      Cookie: this._cookieHeader(),
      ...(this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {}),
      Referer: this.baseUri,
      Origin: new URL(this.baseUri).origin
    };
  }

  _findCsrfToken(html) {
    return cheerio.load(html)('meta[name="csrf-token"]').attr('content');
  }

  _extractCsrfToken(html, url) {
    const token = this._findCsrfToken(html);
    if (!token) {
      throw new VisaClientError(`Missing CSRF token from ${url}`, 'EAUTH');
    }
    return token;
  }

  _isSignInPage(url, html = '') {
    const normalized = String(html).toLowerCase();
    return String(url).includes('/users/sign_in') ||
      normalized.includes('name="user[email]"') ||
      normalized.includes('name="user[password]"');
  }

  _javascriptRedirect(body = '') {
    return String(body).match(/window\.location\.href\s*=\s*["']([^"']+)["']/)?.[1] || null;
  }

  _handleBookingResponse(html) {
    const normalized = cheerio.load(html)('body').text().toLowerCase();
    const matched = BOOKING_FAILURES.find(message => normalized.includes(message));
    if (matched) {
      throw new VisaClientError(`Booking failed; visa site response included "${matched}"`, 'ESLOT_UNAVAILABLE');
    }
  }

  async _verifyBookedDate(scheduleId, date, time) {
    const response = await this._request(this._appointmentFormUrl(scheduleId), {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      timeoutMs: TIMEOUT_PAGE_MS
    });
    const html = (await response.text()).toLowerCase();
    const text = cheerio.load(html)('body').text().toLowerCase();
    const dateForms = [date.toLowerCase(), ...humanDates(date, this.lang)];
    const hasDate = dateForms.some(d => html.includes(d) || text.includes(d));
    return hasDate && (html.includes(time.toLowerCase()) || text.includes(time.toLowerCase()));
  }

  _retryAfterSeconds(response) {
    const value = response.headers.get('retry-after');
    if (!value) return 60;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const retryDate = Date.parse(value);
    return Number.isFinite(retryDate) ? Math.max(1, Math.ceil((retryDate - Date.now()) / 1000)) : 60;
  }

  _errorCodeFromMessage(message) {
    const normalized = String(message).toLowerCase();
    if (normalized.includes('sign in') || normalized.includes('session') || normalized.includes('csrf')) return 'EAUTH';
    if (normalized.includes('too many') || normalized.includes('rate limit')) return 'ERATELIMIT';
    if (normalized.includes('temporar') || normalized.includes('try again')) return 'ETRANSIENT';
    return 'EHTTP';
  }

  _appointmentUrl(scheduleId) {
    return `${this.baseUri}/schedule/${encodeURIComponent(scheduleId)}/appointment`;
  }

  // Formulario de cita. Sin confirmed_limit_message el portal muestra antes la advertencia de límite.
  _appointmentFormUrl(scheduleId) {
    const commit = this.lang === 'es' ? 'Continuar' : 'Continue';
    return `${this._appointmentUrl(scheduleId)}?confirmed_limit_message=1&commit=${commit}`;
  }

  _findAuthenticityToken(html) {
    return cheerio.load(html)('input[name="authenticity_token"]').attr('value');
  }
}

const BOOKING_FAILURES = [
  'not available', 'no longer available', 'please try again', 'unable to', 'invalid appointment',
  'no está disponible', 'ya no está disponible', 'no esta disponible', 'intente de nuevo', 'inténtelo de nuevo', 'no se pudo'
];
const BOOKING_SUCCESS = [
  'successfully', 'appointment confirmation', 'programado exitosamente', 'programó exitosamente', 'reprogramado exitosamente'
];

const MONTHS = {
  en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
};

// "2028-02-04" -> ["4 february, 2028", "04 february, 2028", ...] como lo escribe el portal
export function humanDates(ymd, lang = 'en') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return [];
  const [, y, mo, d] = m;
  const month = (MONTHS[lang] || MONTHS.en)[Number(mo) - 1];
  const days = [String(Number(d)), d];
  return days.flatMap(day => [`${day} ${month}, ${y}`, `${day} ${month} ${y}`, `${day} de ${month} de ${y}`]);
}

/**
 * Tope de reprogramaciones, leído de la página de ADVERTENCIA (/appointment sin
 * confirmed_limit_message). Texto real de es-pe:
 *   "Hay un numero maximo de 2 cancelaciones/reprogramaciones ... Le quedan 1 intentos ..."
 */
export function parseRescheduleLimit(html) {
  const entities = { '&nbsp;': ' ', '&aacute;': 'a', '&eacute;': 'e', '&iacute;': 'i', '&oacute;': 'o', '&uacute;': 'u', '&ntilde;': 'n', '&amp;': '&' };
  const t = String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, e => entities[e.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ');
  const max = t.match(/n[uú]mero m[aá]ximo de\s+(\d+)/i) ?? t.match(/maximum (?:number )?of\s+(\d+)\s+(?:cancellation|reschedul)/i);
  const remaining = t.match(/le quedan\s+(\d+)/i) ??
    t.match(/you have\s+(\d+)\s+(?:attempts?|reschedules?)\s+remaining/i) ??
    t.match(/(\d+)\s+(?:attempts?|intentos?)\s+(?:remaining|restantes?)/i) ??
    t.match(/you have\s+(\d+)\s+(?:attempts?|reschedules?)\s+left/i);
  return { max: max ? Number(max[1]) : null, remaining: remaining ? Number(remaining[1]) : null };
}

// Con varias IPs por host (Node 20+), node-fetch deja "reason:" vacío y la causa real
// queda solo en error.code. La traducimos para que el log diga qué pasó.
const NETWORK_ERRORS = {
  ECONNREFUSED: 'el portal rechazó la conexión (posible bloqueo de la IP)',
  ETIMEDOUT: 'el portal no aceptó la conexión a tiempo (posible bloqueo de la IP)',
  ECONNRESET: 'el portal cortó la conexión (posible bloqueo de la IP)',
  EPIPE: 'el portal cortó la conexión mientras se enviaba',
  ENOTFOUND: 'fallo de DNS: no se encontró el portal',
  EAI_AGAIN: 'fallo temporal de DNS',
  EHOSTUNREACH: 'sin ruta de red hacia el portal',
  ENETUNREACH: 'sin conexión a internet',
  ENETDOWN: 'sin conexión a internet',
};
export function describeNetworkError(error) {
  const code = error?.code || error?.errno || error?.cause?.code || '';
  if (NETWORK_ERRORS[code]) return `${code}: ${NETWORK_ERRORS[code]}`;
  if (/socket hang up/i.test(error?.message || '')) return 'socket hang up: el portal cerró la conexión sin responder';
  return code || 'sin código';
}
