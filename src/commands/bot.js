import { Bot, dateKey } from '../lib/bot.js';
import { getConfig } from '../lib/config.js';
import { Notifier } from '../lib/notifier.js';
import { log, sleep } from '../lib/utils.js';

const SESSION_BACKOFF_SECONDS = [15, 30, 60, 90];
const TRANSIENT_BACKOFF_SECONDS = [5, 10, 20, 30];
const BLOCK_COOLDOWN_SECONDS = [30, 120, 300, 600];
const JITTER_FACTOR = 0.2;

// Con errores seguidos se espacian los intentos: insistir contra un bloqueo lo alarga.
// Se vuelve al ritmo normal con el primer sondeo exitoso.
export function errorSpacingSeconds(streak) {
  if (streak < 5) return 0;
  if (streak < 15) return 60;
  if (streak < 30) return 120;
  if (streak < 50) return 300;
  return 600;
}

// Ventana de liberación (ej. "13-26": segundos 13 a 25 de cada minuto). Fuera de ella se
// espera al próximo inicio en vez de consultar.
export function parseFocusWindow(value) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const start = Number(m[1]), end = Number(m[2]);
  return start < end && end <= 60 ? { start, end } : null;
}

export function focusDelaySeconds(baseSeconds, win, nowMs = Date.now()) {
  if (!win) return baseSeconds;
  const at = nowMs + baseSeconds * 1000;
  const sec = Math.floor((at % 60000) / 1000);
  if (sec >= win.start && sec < win.end) return baseSeconds;
  const inMinute = at % 60000;
  let wait = win.start * 1000 - inMinute;
  if (wait <= 0) wait += 60000;
  return (at - nowMs + wait) / 1000;
}

export async function botCommand(rawOptions) {
  const options = validateOptions(rawOptions);
  const config = getConfig();
  const bot = new Bot(config, { dryRun: options.dryRun, sessionFile: process.env.SESSION_FILE });
  const notifier = new Notifier(config);
  const focusWindow = parseFocusWindow(process.env.FOCUS_WINDOW);

  // El supervisor corta los ciclos/boost con SIGTERM: esperar la petición en vuelo y
  // persistir la última cookie antes de salir
  process.once('SIGTERM', async () => {
    log('🔒 Cerrando: guardando la sesión antes de salir');
    await bot.shutdown();
    process.exit(143);
  });

  if (notifier.isEnabled()) log('Telegram notifications enabled');
  logSearchOptions(options);
  await notifier.notifyStarted(options.current, options.target, options.max, options.min, options.dryRun);

  if (focusWindow) log(`🎯 Consultas concentradas en los segundos ${focusWindow.start}-${focusWindow.end - 1} de cada minuto`);

  let errorStreak = 0;
  const pause = async (delay, reason) => {
    const spacing = errorSpacingSeconds(errorStreak);
    if (spacing > delay) {
      log(`🐢 ${errorStreak} errores seguidos: espero ${spacing}s antes de reintentar (${reason})`);
      delay = spacing;
    }
    await sleep(delay);
  };

  let sessionFailureCount = 0;
  let blockFailureCount = 0;
  let pollCount = 0;
  let candidatesSeen = 0;
  let metricsAt = Date.now();

  while (true) {
    let sessionHeaders;
    try {
      sessionHeaders = await bot.initialize();
      sessionFailureCount = 0;
    } catch (error) {
      if (isPermanentError(error)) throw error;
      sessionFailureCount += 1;
      errorStreak += 1;
      const delay = backoffSeconds(SESSION_BACKOFF_SECONDS, sessionFailureCount);
      log(`Login/session initialization failed: ${error.message}. Retrying in ${delay}s`);
      await notifier.notifyError(error.message, delay);
      await pause(delay, 'login');
      continue;
    }

    let transientFailureCount = 0;

    while (true) {
      try {
        const availableDates = await bot.checkAvailableDates(
          sessionHeaders,
          options.current,
          options.min,
          options.max
        );
        transientFailureCount = 0;
        blockFailureCount = 0;
        errorStreak = 0;
        bot.reusedSession = false;
        pollCount += 1;
        candidatesSeen += availableDates.length;
        if (Date.now() - metricsAt >= 60000) {
          log(`📊 Métricas: ${pollCount} sondeos en ${Math.round((Date.now() - metricsAt) / 1000)}s · fechas candidatas acumuladas=${candidatesSeen}`);
          metricsAt = Date.now(); pollCount = 0; candidatesSeen = 0;
        }
        bot.saveSession();

        const result = await bot.bookFirstAvailable(sessionHeaders, availableDates);
        if (result) {
          await notifier.notifyBooked(result.date, result.time, options.dryRun);
          log(`Successfully ${options.dryRun ? 'found' : 'booked'} appointment on ${result.date} at ${result.time}${result.facilityId ? ` (facility ${result.facilityId})` : ''}`);
          return;
        }

        if (options.once) {
          log('One-time availability check completed with no qualifying bookable slot');
          return;
        }

        await sleep(focusDelaySeconds(jitterSeconds(config.refreshDelay), focusWindow));
      } catch (error) {
        if (error.code === 'EAUTH') {
          if (bot.reusedSession) {
            log(`🔍 El portal rechazó la sesión reutilizada: ${bot.describeRejectedSession(error)}`);
            bot.reusedSession = false;
          }
          log(`Session expired: ${error.message}. Logging in again`);
          break;
        }
        if (isPermanentError(error)) throw error;
        errorStreak += 1;

        if (error.code === 'ERATELIMIT') {
          const delay = Math.max(30, Number(error.retryAfterSeconds) || 60);
          log(`Visa site rate limit reached. Waiting ${delay}s as requested by the server`);
          await notifier.notifyError(error.message, delay);
          await pause(delay, 'rate limit');
          continue;
        }

        if (error.code === 'EBLOCK') {
          blockFailureCount += 1;
          const delay = BLOCK_COOLDOWN_SECONDS[Math.min(blockFailureCount - 1, BLOCK_COOLDOWN_SECONDS.length - 1)];
          log(`WAF/anti-bot challenge detectado. Enfriando ${delay}s y renovando sesión (bloqueo #${blockFailureCount})`);
          await notifier.notifyError('WAF/anti-bot challenge', delay);
          await pause(delay, 'WAF');
          break;
        }

        if (error.code === 'ETRANSIENT') {
          transientFailureCount += 1;
          const delay = backoffSeconds(TRANSIENT_BACKOFF_SECONDS, transientFailureCount);
          log(`Transient visa-site failure: ${error.message}. Retrying in ${delay}s`);
          if (transientFailureCount >= TRANSIENT_BACKOFF_SECONDS.length) break;
          await pause(delay, 'error transitorio');
          continue;
        }

        throw error;
      }
    }
  }
}

export function validateOptions(rawOptions = {}) {
  const options = { ...rawOptions };

  if (options.target && options.max && options.target !== options.max) {
    throw new Error('--target and --max cannot specify different upper bounds');
  }
  if (options.target && !options.max) options.max = options.target;
  if (!options.current && !options.max) {
    throw new Error('Provide --current or --max to define an upper date bound');
  }

  for (const [name, value] of [['current', options.current], ['min', options.min], ['max', options.max]]) {
    if (value) {
      try {
        dateKey(value);
      } catch (error) {
        throw new Error(`Invalid --${name}: ${error.message}`);
      }
    }
  }

  if (options.min && options.max && dateKey(options.min) > dateKey(options.max)) {
    throw new Error('--min must be on or before --max');
  }

  return options;
}

function logSearchOptions(options) {
  if (options.current) log(`Current booked date: ${options.current}`);
  if (options.min) log(`Minimum date: ${options.min}`);
  if (options.max) log(`Maximum date: ${options.max}`);
  if (options.dryRun) log('[DRY RUN MODE] No reschedule will be submitted');
}

function isPermanentError(error) {
  return ['ESCHEMA', 'ECONFIG', 'EBOOKING_UNVERIFIED', 'EHTTP', 'ECREDENTIALS', 'ELOCKED', 'ENOLIMIT'].includes(error?.code);
}

function backoffSeconds(steps, failureCount) {
  return jitterSeconds(steps[Math.min(Math.max(failureCount - 1, 0), steps.length - 1)]);
}

function jitterSeconds(baseSeconds) {
  const min = Math.max(1, baseSeconds * (1 - JITTER_FACTOR));
  const max = baseSeconds * (1 + JITTER_FACTOR);
  return Number((Math.random() * (max - min) + min).toFixed(1));
}
