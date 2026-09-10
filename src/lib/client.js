import fetch from './peticiones_rotativas.js';
import cheerio from 'cheerio';
import { log } from './utils.js';
import { getBaseUri } from './config.js';

// Common headers
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'close',
  'Cache-Control': 'no-store'
};

export class VisaHttpClient {
  constructor(countryCode, email, password) {
    this.baseUri = getBaseUri(countryCode);
    this.email = email;
    this.password = password;
  }

  // Public API methods
  async login() {
    log('Logging in');

    const anonymousHeaders = await this._anonymousRequest(`${this.baseUri}/users/sign_in`)
      .then(response => this._extractHeaders(response));

    const loginData = {
      'utf8': '✓',
      'user[email]': this.email,
      'user[password]': this.password,
      'policy_confirmed': '1',
      'commit': 'Sign In'
    };

    return this._submitForm(`${this.baseUri}/users/sign_in`, anonymousHeaders, loginData)
    
      .then(res => ({
        ...anonymousHeaders,
        'Cookie': this._extractRelevantCookies(res)
      }));
  }

  async checkAvailableDate(headers, scheduleId, facilityId) {
    const url = `${this.baseUri}/schedule/${scheduleId}/appointment/days/${facilityId}.json?appointments[expedite]=false`;
    
    log(`───────────────────────────────────────────`);
    log(`📤 REQUEST  GET ${url}`);
    return this._jsonRequest(url, headers)
      .then(data => {
        log(`📥 RESPONSE (${data.length} fechas)`);
        log(`##DATES##${JSON.stringify(data)}`);
        log(`───────────────────────────────────────────`);
        return data.map(item => item.date);
      });
  }

  async checkAvailableTime(headers, scheduleId, facilityId, date) {
    const url = `${this.baseUri}/schedule/${scheduleId}/appointment/times/${facilityId}.json?date=${date}&appointments[expedite]=false`;
    
    log(`───────────────────────────────────────────`);
    log(`📤 REQUEST  GET ${url}`);
    return this._jsonRequest(url, headers)
      .then(data => {
        const _times = (data['business_times'] || data['available_times'] || []);
        log(`📥 RESPONSE (${_times.length} horarios para ${date})`);
        log(`##TIMES##${JSON.stringify({ date, times: _times })}`);
        log(`───────────────────────────────────────────`);
        return data['business_times'][0] || data['available_times'][0];
      });
  }

  async book(headers, scheduleId, facilityId, date, time) {
    const url = `${this.baseUri}/schedule/${scheduleId}/appointment`;

    const bookingHeaders = await this._anonymousRequest(url, headers)
      .then(response => this._extractHeaders(response));

    const bookingData = {
      'utf8': '✓',
      'authenticity_token': bookingHeaders['X-CSRF-Token'],
      'confirmed_limit_message': '1',
      'use_consulate_appointment_capacity': 'true',
      'appointments[consulate_appointment][facility_id]': facilityId,
      'appointments[consulate_appointment][date]': date,
      'appointments[consulate_appointment][time]': time,
      'appointments[asc_appointment][facility_id]': '',
      'appointments[asc_appointment][date]': '',
      'appointments[asc_appointment][time]': ''
    };

    return this._submitFormWithRedirect(url, bookingHeaders, bookingData);
  }

  // Devuelve la IP pública de salida del servidor (para registro/observabilidad).
  async getPublicIp() {
    try {
      const r = await fetch('https://api.ipify.org?format=json', { headers: { Accept: 'application/json' } });
      const j = await r.json();
      return j.ip || null;
    } catch { return null; }
  }

  // Private request methods
  async _anonymousRequest(url, headers = {}) {
    return fetch(url, {
      headers: {
        "User-Agent": "",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "close",
        ...headers
      }
    });
  }

  async _jsonRequest(url, headers = {}) {
    const res = await fetch(url, {
      headers: {
        ...headers,
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest"
      },
      cache: "no-store"
    });

    if (res.status === 429 || res.status === 403 || res.status === 503) {
      const err = new Error(`HTTP ${res.status} - Bloqueo de servidor o límite de peticiones alcanzado`);
      err.isBlock = true;
      throw err;
    }

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('sign_in')) {
        const sessionErr = new Error('Sesión expirada (servidor devolvió página de inicio de sesión)');
        sessionErr.isSessionExpired = true;
        throw sessionErr;
      }
      throw new Error(`Respuesta inesperada del servidor: ${text.slice(0, 100)}`);
    }

    return this._handleErrors(data);
  }

  async _submitForm(url, headers = {}, formData = {}) {
    return fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: new URLSearchParams(formData)
    });
  }

  async _submitFormWithRedirect(url, headers = {}, formData = {}) {
    return fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(formData)
    });
  }

  // Private utility methods
  async _extractHeaders(res) {
    if (res.status === 429 || res.status === 403 || res.status === 503) {
      throw new Error(`HTTP ${res.status} al iniciar sesión - Bloqueo detectado`);
    }
    const cookies = this._extractRelevantCookies(res);
    const html = await res.text();
    const $ = cheerio.load(html);
    const csrfToken = $('meta[name="csrf-token"]').attr('content');

    return {
      ...COMMON_HEADERS,
      "Cookie": cookies,
      "X-CSRF-Token": csrfToken,
      "Referer": this.baseUri,
      "Referrer-Policy": "strict-origin-when-cross-origin"
    };
  }

  _extractRelevantCookies(res) {
    const parsedCookies = this._parseCookies(res.headers.get('set-cookie'));
    if (!parsedCookies['_yatri_session']) {
      const err = new Error('Sesión expirada (servidor no devolvió cookie de sesión — posible redirección al login)');
      err.isSessionExpired = true;
      throw err;
    }
    return `_yatri_session=${parsedCookies['_yatri_session']}`;
  }

  _parseCookies(cookies) {
    const parsedCookies = {};
    if (!cookies) return parsedCookies; // guard contra null cuando no hay Set-Cookie

    cookies.split(';').map(c => c.trim()).forEach(c => {
      const [name, value] = c.split('=', 2);
      parsedCookies[name] = value;
    });

    return parsedCookies;
  }

  _handleErrors(response) {
    const errorMessage = response['error'];

    if (errorMessage) {
      throw new Error(errorMessage);
    }

    return response;
  }
}
