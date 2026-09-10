import { Bot } from '../lib/bot.js';
import { getConfig } from '../lib/config.js';
import { log, sleep, isSocketHangupError } from '../lib/utils.js';

const COOLDOWN = 30; // segundos de espera solo tras un error de conexión (socket hang up)
const RETRY_DELAY = 5; // segundos de espera antes de reintentar tras error de sesión/login (evita bucle a máxima velocidad)

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

  let sessionHeaders = null;
  try {
    sessionHeaders = await bot.initialize();
  } catch (err) {
    log(`🛑 DETENIDO POR BLOQUEO: Error al iniciar sesión (${err.message})`);
    process.exit(2);
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
          // Update current date to the new available date
          currentBookedDate = availableDate;

          options = {
            ...options,
            current: currentBookedDate
          };

          if (targetDate && availableDate <= targetDate) {
            log(`Target date reached! Successfully booked appointment on ${availableDate}`);
            process.exit(0);
          }
        }
      }

      await sleep(config.refreshDelay);
    } catch (err) {
      if (err.isSessionExpired || /sesión expirada|session|sign_in/i.test(err.message)) {
        log(`⚠️ Sesión expirada del portal. Re-autenticando sesión automáticamente...`);
        try {
          await sleep(2);
          sessionHeaders = await bot.initialize();
          continue;
        } catch (loginErr) {
          log(`🛑 DETENIDO POR BLOQUEO: No se pudo re-autenticar (${loginErr.message})`);
          process.exit(2);
        }
      }

      // Bloqueo real (HTTP 429, 403, 503, socket hang up agotado)
      log(`🛑 DETENIDO POR BLOQUEO: ${err.message}`);
      process.exit(2);
    }
  }
}
