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
    const facilityIds = (this.config.facilityIds && this.config.facilityIds.length)
      ? this.config.facilityIds
      : [this.config.facilityId];

    const minKey = minDate ? dateKey(minDate) : null;
    const maxKey = maxDate ? dateKey(maxDate) : null;
    const currentKey = currentBookedDate ? dateKey(currentBookedDate) : null;

    const candidates = [];
    for (const facilityId of facilityIds) {
      let dates;
      try {
        dates = await this.client.checkAvailableDate(
          sessionHeaders,
          this.config.scheduleId,
          facilityId,
          { onlyBusinessDay: this.config.onlyBusinessDay }
        );
      } catch (err) {
        // Un consulado puede fallar sin tumbar al resto; los bloqueos/sesión sí se propagan.
        if (['EAUTH', 'ERATELIMIT', 'EBLOCK'].includes(err?.code)) throw err;
        log(`facility ${facilityId}: error consultando fechas (${err.message})`);
        continue;
      }

      if (!dates || dates.length === 0) { log(`facility ${facilityId}: sin fechas`); continue; }

      const rejected = { invalid: 0, beforeMin: 0, afterMax: 0, notEarlier: 0 };
      let good = 0;
      for (const date of new Set(dates)) {
        let key;
        try { key = dateKey(date); } catch { rejected.invalid += 1; continue; }
        if (minKey !== null && key < minKey) { rejected.beforeMin += 1; continue; }
        if (maxKey !== null && key > maxKey) { rejected.afterMax += 1; continue; }
        if (currentKey !== null && key >= currentKey) { rejected.notEarlier += 1; continue; }
        candidates.push({ date, facilityId, key });
        good += 1;
      }
      log(`facility ${facilityId}: ${good} fechas válidas de ${dates.length} (rechazadas=${JSON.stringify(rejected)})`);
    }

    if (candidates.length === 0) {
      log('No qualifying dates across facilities');
      return [];
    }

    candidates.sort((a, b) => a.key - b.key);
    const seen = new Set();
    const result = [];
    for (const c of candidates) {
      const k = `${c.facilityId}:${c.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      result.push({ date: c.date, facilityId: c.facilityId });
    }
    log(`Total ${result.length} fechas candidatas; más temprana: ${result[0].date} (facility ${result[0].facilityId})`);
    return result;
  }

  async bookAppointment(sessionHeaders, date, facilityId = this.config.facilityId) {
    const bookedKey = `${facilityId}:${date}`;
    if (this.bookedDates.has(bookedKey)) {
      log(`date ${date} @${facilityId} was already booked this session, skipping`);
      return null;
    }

    let times = await this.client.checkAvailableTimes(
      sessionHeaders,
      this.config.scheduleId,
      facilityId,
      date
    );

    if (!times || times.length === 0) {
      log(`no available time slots for date ${date} @${facilityId}`);
      return null;
    }

    if (this.dryRun) {
      const time = times[0];
      log(`[DRY RUN] Would book appointment at ${date} ${time} @${facilityId} (not actually booking)`);
      this.bookedDates.add(bookedKey);
      return { booked: true, time };
    }

    let retriedTimes = false;
    while (true) {
      for (const time of times) {
        try {
          await this.client.book(
            sessionHeaders,
            this.config.scheduleId,
            facilityId,
            date,
            time
          );

          this.bookedDates.add(bookedKey);
          log(`booked time at ${date} ${time}`);
          return { booked: true, time };
        } catch (err) {
          log(`failed to book ${date} ${time}: ${err.message}`);
          if (err.code !== 'ESLOT_UNAVAILABLE') throw err;
        }
      }

      // Todos los horarios se los llevó otro (carrera de cupo): reintenta una vez re-pidiendo horarios.
      if (!retriedTimes) {
        retriedTimes = true;
        log(`slot race on all times for ${date} @${facilityId}; refetching times once`);
        times = await this.client.checkAvailableTimes(sessionHeaders, this.config.scheduleId, facilityId, date);
        if (times && times.length) continue;
      }
      break;
    }

    log(`all available time slots failed for date ${date} @${facilityId}`);
    return null;
  }

  async bookFirstAvailable(sessionHeaders, candidates) {
    for (const c of candidates) {
      const date = typeof c === 'string' ? c : c.date;
      const facilityId = typeof c === 'string' ? this.config.facilityId : c.facilityId;
      const result = await this.bookAppointment(sessionHeaders, date, facilityId);
      if (result) return { ...result, date, facilityId };
      log(`No usable times remained for ${date} @${facilityId}; checking the next candidate`);
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
