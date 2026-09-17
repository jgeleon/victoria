import fetch from 'node-fetch';
import https from 'https';
import cheerio from 'cheerio';
import { log } from './utils.js';
import { getBaseUri } from './config.js';

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
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
  }

  async login() {
    log('Logging in');
    this.cookies.clear();

    const signInUrl = `${this.baseUri}/users/sign_in`;
    const signInResponse = await this._request(signInUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml' }
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
      body: new URLSearchParams(loginData)
    });
    let loginHtml = await loginResponse.text();
    const javascriptRedirect = this._javascriptRedirect(loginHtml);

    if (javascriptRedirect) {
      loginResponse = await this._request(new URL(javascriptRedirect, signInUrl), {
        headers: { Accept: 'text/html,application/xhtml+xml' }
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

  async checkAvailableDate(_headers, scheduleId, facilityId) {
    const url = new URL(`${this.baseUri}/schedule/${encodeURIComponent(scheduleId)}/appointment/days/${encodeURIComponent(facilityId)}.json`);
    url.searchParams.set('appointments[expedite]', 'false');

    const data = await this._jsonRequest(url, scheduleId);

    if (!Array.isArray(data)) {
      throw new VisaClientError('Unexpected appointment-days response: expected an array', 'ESCHEMA');
    }

    const dates = data.map(item => item?.date);
    if (dates.some(date => typeof date !== 'string')) {
      throw new VisaClientError('Unexpected appointment-days response: invalid date entry', 'ESCHEMA');
    }

    log(`##DATES##${JSON.stringify(data)}`);
    return dates;
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
    const appointmentResponse = await this._request(url, {
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    const appointmentHtml = await appointmentResponse.text();
    const csrfToken = this._extractCsrfToken(appointmentHtml, appointmentResponse.url);

    const bookingData = {
      utf8: '✓',
      authenticity_token: csrfToken,
      confirmed_limit_message: '1',
      use_consulate_appointment_capacity: 'true',
      'appointments[consulate_appointment][facility_id]': facilityId,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      'appointments[asc_appointment][facility_id]': '',
      'appointments[asc_appointment][date]': '',
      'appointments[asc_appointment][time]': ''
    };

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

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let response;

      try {
        response = await this.fetch(url, {
          ...requestOptions,
          agent,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            ...COMMON_HEADERS,
            ...requestOptions.headers,
            ...(this.cookies.size ? { Cookie: this._cookieHeader() } : {})
          }
        });
      } catch (error) {
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
