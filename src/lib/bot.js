import fs from 'fs';
import path from 'path';
import { VisaHttpClient, VisaClientError } from './client.js';
import { log } from './utils.js';
import { withLoginSlot } from './limiter.js';

// Fechas fantasma: aparecen en days.json pero no se pueden reservar. Con N fallos dentro de
// la ventana, la fecha se ignora durante un tiempo (persistido entre procesos de la orden).
const GHOST_THRESHOLD = 5;
const GHOST_WINDOW_MS = 3 * 60 * 60 * 1000;
const GHOST_BLOCK_MS = 60 * 60 * 1000;

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
    this._authenticated = false; // solo se persisten cookies de una sesión ya autenticada
    this._reuseTried = false;    // la sesión en disco se intenta solo en el primer initialize del proceso
    this.reusedSession = false;  // la sesión actual vino de disco y aún no se validó con una consulta
    this.minDaysFromToday = Number(this.config.minDaysFromToday) || 0;
    this.dateFailuresFile = options.dateFailuresFile || this.config.dateFailuresFile || null;
    this.dateFailures = this._loadDateFailures();
    this.client.onCookiesChanged = () => { if (this._authenticated) this.saveSession(true); };
  }

  async initialize() {
    log('Initializing visa bot...');
    this._authenticated = false;

    // Sin verificación previa: la primera consulta de fechas valida la sesión. Si falla con
    // EAUTH, el bucle vuelve a initialize() y como _reuseTried ya es true, hace login.
    if (!this._reuseTried) {
      this._reuseTried = true;
      const age = this._tryReuseSession();
      if (age !== null) {
        this._authenticated = true;
        this.reusedSession = true;
        log(`♻️ Reutilizando sesión guardada de hace ${Math.round(age / 1000)}s (se valida en la primera consulta)`);
        this._logRescheduleLimit();
        return this.client.currentHeaders();
      }
    }

    this.reusedSession = false;
    await withLoginSlot(() => this.client.login());
    await this.client.verifyAccountContext(this.config.scheduleId);
    log('Authenticated schedule verified');
    this._authenticated = true;
    this.saveSession(true);
    this._logRescheduleLimit();
    this._assertRescheduleLeft();
    return this.client.currentHeaders();
  }

  // Diagnóstico: por qué el portal rechazó una sesión reutilizada
  describeRejectedSession(error) {
    const trace = (this.client.lastTrace || []).join(' | ') || 'sin traza';
    return `${error.message} · traza: ${trace}`;
  }

  _logRescheduleLimit() {
    const l = this.client.rescheduleLimit;
    if (!l) { log('🔢 Reprogramaciones restantes: el portal no lo indicó'); return; }
    log(`🔢 Reprogramaciones restantes según el portal: ${l.remaining ?? '?'}${l.max != null ? ` de ${l.max}` : ''}`);
  }

  _assertRescheduleLeft() {
    if (this.client.rescheduleLimit?.remaining === 0) {
      throw new VisaClientError('El portal indica 0 reprogramaciones restantes; no se puede reservar', 'ENOLIMIT');
    }
  }

  // Devuelve la edad en ms de la sesión importada, o null si no hay sesión reutilizable.
  _tryReuseSession() {
    if (!this.sessionFile) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      if (!data || data.email !== this.config.email) return null;
      const age = data.savedAt ? Date.now() - data.savedAt : 0;
      if (age > 30 * 60 * 1000) { log(`Sesión guardada descartada: tiene ${Math.round(age / 60000)} min (máx. 30)`); return null; }
      if (!this.client.importSession(data)) return null;
      this.client.rescheduleLimit = data.rescheduleLimit || null;
      return age;
    } catch {
      return null;
    }
  }

  // Cierre ordenado: si hay una petición en vuelo, el sitio ya rotó la cookie; hay que esperar
  // su respuesta para guardar la cookie nueva (la anterior queda invalidada).
  async shutdown(maxWaitMs = 5000) {
    this.client.stopping = true;
    const until = Date.now() + maxWaitMs;
    while (this.client.inFlight > 0 && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    this.saveSession(true);
  }

  saveSession(force = false) {
    if (!this.sessionFile || !this._authenticated) return;
    const now = Date.now();
    if (!force && now - this._lastSessionSave < 15000) return; // guarda como mucho cada 15 s
    this._lastSessionSave = now;
    try {
      const data = this.client.exportSession();
      data.email = this.config.email;
      data.rescheduleLimit = this.client.rescheduleLimit || null;
      data.savedAt = now;
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      fs.writeFileSync(this.sessionFile, JSON.stringify(data));
    } catch { /* noop */ }
  }

  async checkAvailableDates(sessionHeaders, currentBookedDate, minDate, maxDate) {
    const facilityIds = (this.config.facilityIds && this.config.facilityIds.length)
      ? this.config.facilityIds
      : [this.config.facilityId];

    let minKey = minDate ? dateKey(minDate) : null;
    // Nunca reservar a menos de N días de hoy (fecha de Lima)
    let floorDate = null;
    if (this.minDaysFromToday > 0) {
      floorDate = limaDate(Date.now() + this.minDaysFromToday * 86400000);
      const floorKey = dateKey(floorDate);
      if (minKey === null || floorKey > minKey) minKey = floorKey;
    }
    const now = Date.now();
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

      const rejected = { invalid: 0, beforeMin: 0, afterMax: 0, notEarlier: 0, ghost: 0 };
      let good = 0;
      for (const date of new Set(dates)) {
        let key;
        try { key = dateKey(date); } catch { rejected.invalid += 1; continue; }
        if (minKey !== null && key < minKey) { rejected.beforeMin += 1; continue; }
        if (maxKey !== null && key > maxKey) { rejected.afterMax += 1; continue; }
        if (currentKey !== null && key >= currentKey) { rejected.notEarlier += 1; continue; }
        if (this._ghostBlocked(facilityId, date, now)) { rejected.ghost += 1; continue; }
        candidates.push({ date, facilityId, key });
        good += 1;
      }
      log(`facility ${facilityId}: ${good} fechas válidas de ${dates.length} (rechazadas=${JSON.stringify(rejected)}${floorDate ? `, piso=${floorDate}` : ''})`);
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
      this._recordDateFailure(facilityId, date);
      return null;
    }

    this._assertRescheduleLeft();

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
    this._recordDateFailure(facilityId, date);
    return null;
  }

  _loadDateFailures() {
    if (!this.dateFailuresFile) return {};
    try { return JSON.parse(fs.readFileSync(this.dateFailuresFile, 'utf8')) || {}; } catch { return {}; }
  }

  _saveDateFailures() {
    if (!this.dateFailuresFile) return;
    try {
      fs.mkdirSync(path.dirname(this.dateFailuresFile), { recursive: true });
      fs.writeFileSync(this.dateFailuresFile, JSON.stringify(this.dateFailures));
    } catch { /* noop */ }
  }

  _ghostBlocked(facilityId, date, now = Date.now()) {
    const e = this.dateFailures[`${facilityId}:${date}`];
    return !!(e && e.blockedUntil && e.blockedUntil > now);
  }

  _recordDateFailure(facilityId, date, now = Date.now()) {
    const k = `${facilityId}:${date}`;
    // Otro proceso de la misma orden pudo haber escrito: partir del archivo
    this.dateFailures = { ...this._loadDateFailures(), ...this.dateFailures };
    let e = this.dateFailures[k];
    if (!e || now - e.windowStart > GHOST_WINDOW_MS) e = { count: 0, windowStart: now, blockedUntil: 0 };
    e.count += 1;
    if (e.count >= GHOST_THRESHOLD && !(e.blockedUntil > now)) {
      e.blockedUntil = now + GHOST_BLOCK_MS;
      log(`👻 Fecha ${date} @${facilityId} falló ${e.count} veces en 3 h: se ignora por ${GHOST_BLOCK_MS / 60000} min`);
    }
    this.dateFailures[k] = e;
    // limpia entradas viejas
    for (const [key, v] of Object.entries(this.dateFailures)) {
      if (now - v.windowStart > GHOST_WINDOW_MS && !(v.blockedUntil > now)) delete this.dateFailures[key];
    }
    this._saveDateFailures();
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

// Fecha YYYY-MM-DD en Lima (UTC-5, sin horario de verano)
export function limaDate(ms = Date.now()) {
  return new Date(ms - 5 * 3600000).toISOString().slice(0, 10);
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
