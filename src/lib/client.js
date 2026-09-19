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
    this.userAgent = options.userAgent || USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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
    const response = await this._request(this._appointmentUrl(scheduleId), {
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    const html = await response.text();

    if (this._isSignInPage(response.url, html)) {
      throw new VisaClientError('Session expired while verifying the appointment schedule', 'EAUTH');
    }

    this.csrfToken = this._findCsrfToken(html) || this.csrfToken;
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

  async book(_headers, scheduleId, facilityId, date, time, options = {}) {
    const url = this._appointmentUrl(scheduleId);

    // ASC (biometría) opt-in: solo si se configuró un facility de ASC
    let asc = null;
    if (options.ascFacilityId) {
      asc = await this._resolveAsc(scheduleId, options.ascFacilityId, facilityId, date, time);
    }

    // Intento rápido: reutiliza el CSRF cacheado y evita el GET previo a la reserva
    if (this.csrfToken) {
      const fast = await this._postBooking(url, this.csrfToken, this._buildBookingData(this.csrfToken, facilityId, date, time, asc));
      const outcome = this._classifyBooking(fast.response.url, fast.body, date, time);
      if (outcome === 'ok') return fast.response;
      if (outcome === 'slot') throw new VisaClientError('Booking failed; the slot became unavailable', 'ESLOT_UNAVAILABLE');
      // 'auth' / 'retry' -> reintenta con token fresco
    }

    // Camino con token fresco (GET a la página de cita -> POST -> verificación)
    const appointmentResponse = await this._request(url, {
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    const appointmentHtml = await appointmentResponse.text();
    this.csrfToken = this._extractCsrfToken(appointmentHtml, appointmentResponse.url);

    const { response, body } = await this._postBooking(url, this.csrfToken, this._buildBookingData(this.csrfToken, facilityId, date, time, asc));

    if (this._isSignInPage(response.url, body)) {
      throw new VisaClientError('Session expired while booking', 'EAUTH');
    }

    this._handleBookingResponse(body);

    const confirmationText = cheerio.load(body)('body').text().toLowerCase();
    const hasPositiveConfirmation = confirmationText.includes('successfully') ||
      confirmationText.includes('appointment confirmation') ||
      (confirmationText.includes(date.toLowerCase()) && confirmationText.includes(time.toLowerCase()));

    if (!hasPositiveConfirmation) {
      const verified = await this._verifyBookedDate(scheduleId, date, time);
      if (!verified) {
        throw new VisaClientError('Booking response could not be verified; stopping to avoid a duplicate reschedule', 'EBOOKING_UNVERIFIED');
      }
    }

    return response;
  }

  _buildBookingData(csrfToken, facilityId, date, time, asc) {
    return {
      utf8: '✓',
      authenticity_token: csrfToken,
      confirmed_limit_message: '1',
      use_consulate_appointment_capacity: 'true',
      'appointments[consulate_appointment][facility_id]': facilityId,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      'appointments[asc_appointment][facility_id]': asc?.facilityId || '',
      'appointments[asc_appointment][date]': asc?.date || '',
      'appointments[asc_appointment][time]': asc?.time || ''
    };
  }

  async _postBooking(url, csrfToken, bookingData) {
    const response = await this._request(url, {
      method: 'POST',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: new URL(this.baseUri).origin,
        Referer: url,
        'X-CSRF-Token': csrfToken
      },
      body: new URLSearchParams(bookingData)
    });
    const body = await response.text();
    return { response, body };
  }

  // Clasifica la respuesta de reserva sin lanzar: 'ok' | 'slot' | 'auth' | 'retry'
  _classifyBooking(url, body, date, time) {
    if (this._isSignInPage(url, body)) return 'auth';
    const normalized = cheerio.load(body)('body').text().toLowerCase();
    const failures = ['not available', 'no longer available', 'please try again', 'unable to', 'invalid appointment'];
    if (failures.some(m => normalized.includes(m))) return 'slot';
    const positive = normalized.includes('successfully') ||
      normalized.includes('appointment confirmation') ||
      (normalized.includes(date.toLowerCase()) && normalized.includes(time.toLowerCase()));
    return positive ? 'ok' : 'retry';
  }

  // ASC (Application Support Center) — best-effort, patrón estándar de usvisa-info.
  // Si algo falla, devuelve null y se reserva sin ASC (comportamiento por defecto).
  async _resolveAsc(scheduleId, ascFacilityId, consulateFacilityId, date, time) {
    try {
      const daysUrl = new URL(`${this.baseUri}/schedule/${encodeURIComponent(scheduleId)}/appointment/days/${encodeURIComponent(ascFacilityId)}.json`);
      daysUrl.searchParams.set('consulate_id', consulateFacilityId);
      daysUrl.searchParams.set('consulate_date', date);
      daysUrl.searchParams.set('consulate_time', time);
      daysUrl.searchParams.set('appointments[expedite]', 'false');
      const days = await this._jsonRequest(daysUrl, scheduleId);
      const ascDate = Array.isArray(days) && days.length ? days[0]?.date : null;
      if (!ascDate) { log('ASC: sin días disponibles; se reserva sin ASC'); return null; }

      const timesUrl = new URL(`${this.baseUri}/schedule/${encodeURIComponent(scheduleId)}/appointment/times/${encodeURIComponent(ascFacilityId)}.json`);
      timesUrl.searchParams.set('date', ascDate);
      timesUrl.searchParams.set('consulate_id', consulateFacilityId);
      timesUrl.searchParams.set('consulate_date', date);
      timesUrl.searchParams.set('consulate_time', time);
      timesUrl.searchParams.set('appointments[expedite]', 'false');
      const t = await this._jsonRequest(timesUrl, scheduleId);
      const ascTime = (t?.available_times?.length ? t.available_times : (t?.business_times || []))[0];
      if (!ascTime) { log('ASC: sin horarios disponibles; se reserva sin ASC'); return null; }

      log(`ASC seleccionado: ${ascDate} ${ascTime} (facility ${ascFacilityId})`);
      return { facilityId: ascFacilityId, date: ascDate, time: ascTime };
    } catch (e) {
      log(`ASC: no se pudo resolver (${e.message}); se reserva sin ASC`);
      return null;
    }
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
      }
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
    let url = String(initialUrl);
    let requestOptions = { ...options, headers: { ...options.headers } };
    let usingProxy = !!options.useProxy && loginProxyEnabled();
    let proxyFellBack = false;
    delete requestOptions.useProxy;

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await rateLimit();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const requestAgent = usingProxy ? (makeProxyAgent() || keepAliveAgent) : keepAliveAgent;
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
          throw new VisaClientError(`Request timed out after ${this.requestTimeoutMs}ms`, 'ETRANSIENT', { cause: error });
        }
        throw new VisaClientError(`Network request failed: ${error.message}`, 'ETRANSIENT', { cause: error });
      } finally {
        clearTimeout(timeout);
      }

      this._storeCookies(response);

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
    for (const header of rawCookies) {
      const normalizedHeader = String(header);
      const cookiePart = normalizedHeader.split(';', 1)[0];
      const separator = cookiePart.indexOf('=');
      if (separator <= 0) continue;
      const name = cookiePart.slice(0, separator).trim();
      const value = cookiePart.slice(separator + 1).trim();
      if (value && !/;\s*max-age=0(?:;|$)/i.test(normalizedHeader)) this.cookies.set(name, value);
      else this.cookies.delete(name);
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
    const failures = ['not available', 'no longer available', 'please try again', 'unable to', 'invalid appointment'];
    const matched = failures.find(message => normalized.includes(message));
    if (matched) {
      throw new VisaClientError(`Booking failed; visa site response included "${matched}"`, 'ESLOT_UNAVAILABLE');
    }
  }

  async _verifyBookedDate(scheduleId, date, time) {
    const response = await this._request(this._appointmentUrl(scheduleId), {
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    const html = (await response.text()).toLowerCase();
    const text = cheerio.load(html)('body').text().toLowerCase();
    return (html.includes(date.toLowerCase()) || text.includes(date.toLowerCase())) &&
      (html.includes(time.toLowerCase()) || text.includes(time.toLowerCase()));
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
}
