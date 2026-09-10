import { Bot } from '../lib/bot.js';
import { getConfig } from '../lib/config.js';
import { log, sleep, isSocketHangupError } from '../lib/utils.js';

const RETRY_DELAY = 5; // segundos entre reintentos de login/sesión

export async function botCommand(options) {
  const config = getConfig();
  const bot = new Bot(config, { dryRun: options.dryRun });
  let currentBookedDate = options.current;
  const targetDate = options.target;
  const minDate = options.min;

  log(`Initializing with current date ${currentBookedDate}`);

  if (options.dryRun) {
    log(`[DRY RUN MODE] Bot will only log what would be booked without actually booking`);
  }

  if (targetDate) {
    log(`Target date: ${targetDate}`);
  }

  if (minDate) {
    log(`Minimum date: ${minDate}`);
  }

  // Login inicial: reintentar indefinidamente hasta lograrlo (nunca detener por login)
  let sessionHeaders = null;
  while (!sessionHeaders) {
    try {
      sessionHeaders = await bot.initialize();
    } catch (err) {
      if (err.isBlock) {
        log(`🛑 DETENIDO POR BLOQUEO: Bloqueo al iniciar sesión (${err.message})`);
        process.exit(2);
      }
      log(`⚠️ Login inicial fallido: ${err.message}. Reintentando en ${RETRY_DELAY} s...`);
      await sleep(RETRY_DELAY);
    }
  }

  while (true) {
    try {
      const availableDate = await bot.checkAvailableDate(
        sessionHeaders,
        currentBookedDate,
        minDate
      );

      if (availableDate) {
        const booked = await bot.bookAppointment(sessionHeaders, availableDate);

        if (booked) {
          currentBookedDate = availableDate;
          options = { ...options, current: currentBookedDate };

          if (targetDate && availableDate <= targetDate) {
            log(`Target date reached! Successfully booked appointment on ${availableDate}`);
            process.exit(0);
          }
        }
      }

      await sleep(config.refreshDelay);
    } catch (err) {
      // ÚNICO caso de detención: bloqueo real de la página (HTTP 429/403/503)
      if (err.isBlock) {
        log(`🛑 DETENIDO POR BLOQUEO: ${err.message}`);
        process.exit(2);
      }

      // Todo lo demás (sesión expirada, cookie nula, red, login fallido, etc.)
      // → renovar sesión en bucle sin detener el bot
      log(`⚠️ Error recuperable: ${err.message}. Re-autenticando...`);
      let renewed = false;
      while (!renewed) {
        await sleep(RETRY_DELAY);
        try {
          sessionHeaders = await bot.initialize();
          log(`✅ Sesión renovada correctamente.`);
          renewed = true;
        } catch (loginErr) {
          if (loginErr.isBlock) {
            log(`🛑 DETENIDO POR BLOQUEO: Bloqueo al re-autenticar (${loginErr.message})`);
            process.exit(2);
          }
          log(`⚠️ Re-autenticación fallida: ${loginErr.message}. Reintentando en ${RETRY_DELAY} s...`);
        }
      }
    }
  }
}
