import fs from 'fs';
import path from 'path';
import { VisaHttpClient } from './client.js';
import { log } from './utils.js';

export class Bot {
  constructor(config, options = {}) {
    this.config = config;
    this.dryRun = options.dryRun || false;
    this.bookedDates = new Set();
    this.client = options.client || new VisaHttpClient(
      this.config.countryCode,
      this.config.email,
      this.config.password,
      { requestTimeoutMs: this.config.requestTimeoutMs }
    );
    this.sessionFile = options.sessionFile || process.env.SESSION_FILE || null;
    this._lastSessionSave = 0;
  }

  async initialize() {
    log('Initializing visa bot...');

    if (this._tryReuseSession()) {
      try {
        await this.client.verifyAccountContext(this.config.scheduleId);
        log('♻️ Reutilizando sesión guardada (sin volver a iniciar sesión)');
        this.saveSession(true);
        return this.client.currentHeaders();
      } catch (error) {
        if (error?.code === 'EAUTH') {
          log('La sesión guardada expiró; iniciando sesión de nuevo');
        } else {
          throw error;
        }
      }
    }

    const sessionHeaders = await this.client.login();
    await this.client.verifyAccountContext(this.config.scheduleId);
    log('Authenticated schedule verified');
    this.saveSession(true);
    return sessionHeaders;
  }

  _tryReuseSession() {
    if (!this.sessionFile) return false;
    try {
      const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      if (!data || data.email !== this.config.email) return false;
      if (data.savedAt && (Date.now() - data.savedAt) > 30 * 60 * 1000) return false; // caché válido 30 min
      return this.client.importSession(data);
    } catch {
      return false;
    }
  }

  saveSession(force = false) {
    if (!this.sessionFile) return;
    const now = Date.now();
    if (!force && now - this._lastSessionSave < 15000) return; // guarda como mucho cada 15 s
    this._lastSessionSave = now;
    try {
      const data = this.client.exportSession();
      data.email = this.config.email;
      data.savedAt = now;
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      fs.writeFileSync(this.sessionFile, JSON.stringify(data));
    } catch { /* noop */ }
  }

  async checkAvailableDates(sessionHeaders, currentBookedDate, minDate, maxDate) {
    const dates = await this.client.checkAvailableDate(
      sessionHeaders,
      this.config.scheduleId,
      this.config.facilityId
    );

    if (!dates || dates.length === 0) {
      log("no dates available");
      return [];
    }

    const minKey = minDate ? dateKey(minDate) : null;
    const maxKey = maxDate ? dateKey(maxDate) : null;
    const currentKey = currentBookedDate ? dateKey(currentBookedDate) : null;
    const rejected = { invalid: 0, beforeMin: 0, afterMax: 0, notEarlier: 0 };
    const goodDates = [];

    for (const date of new Set(dates)) {
      let key;
      try {
        key = dateKey(date);
      } catch {
        rejected.invalid += 1;
        continue;
      }
      if (minKey !== null && key < minKey) {
        rejected.beforeMin += 1;
        continue;
      }
      if (maxKey !== null && key > maxKey) {
        rejected.afterMax += 1;
        continue;
      }
      if (currentKey !== null && key >= currentKey) {
        rejected.notEarlier += 1;
        continue;
      }
      goodDates.push(date);
    }

    if (goodDates.length === 0) {
      log(`No qualifying dates from ${dates.length} returned; rejected=${JSON.stringify(rejected)}`);
      return [];
    }

    goodDates.sort();
    log(`Found ${goodDates.length} qualifying dates from ${dates.length} returned: ${goodDates.join(', ')}`);
    return goodDates;
  }

  async bookAppointment(sessionHeaders, date) {
    if (this.bookedDates.has(date)) {
      log(`date ${date} was already booked this session, skipping`);
      return null;
    }

    const times = await this.client.checkAvailableTimes(
      sessionHeaders,
      this.config.scheduleId,
      this.config.facilityId,
      date
    );

    if (!times || times.length === 0) {
      log(`no available time slots for date ${date}`);
      return null;
    }

    if (this.dryRun) {
      const time = times[0];
      log(`[DRY RUN] Would book appointment at ${date} ${time} (not actually booking)`);
      this.bookedDates.add(date);
      return { booked: true, time };
    }

    for (const time of times) {
      try {
        await this.client.book(
          sessionHeaders,
          this.config.scheduleId,
          this.config.facilityId,
          date,
          time
        );

        this.bookedDates.add(date);
        log(`booked time at ${date} ${time}`);
        return { booked: true, time };
      } catch (err) {
        log(`failed to book ${date} ${time}: ${err.message}`);
        if (err.code !== 'ESLOT_UNAVAILABLE') {
          throw err;
        }
      }
    }

    log(`all available time slots failed for date ${date}`);
    return null;
  }

  async bookFirstAvailable(sessionHeaders, dates) {
    for (const date of dates) {
      const result = await this.bookAppointment(sessionHeaders, date);
      if (result) return { ...result, date };
      log(`No usable times remained for ${date}; checking the next candidate`);
    }
    return null;
  }

}

export function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date "${value}"; expected YYYY-MM-DD`);
  }

  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date "${value}"`);
  }

  return year * 10000 + month * 100 + day;
}
