import { Bot, dateKey } from '../lib/bot.js';
import { getConfig } from '../lib/config.js';
import { Notifier } from '../lib/notifier.js';
import { log, sleep } from '../lib/utils.js';

const SESSION_BACKOFF_SECONDS = [15, 30, 60, 90];
const TRANSIENT_BACKOFF_SECONDS = [5, 10, 20, 30];
const JITTER_FACTOR = 0.1;

export async function botCommand(rawOptions) {
  const options = validateOptions(rawOptions);
  const config = getConfig();
  const bot = new Bot(config, { dryRun: options.dryRun });
  const notifier = new Notifier(config);

  if (notifier.isEnabled()) log('Telegram notifications enabled');
  logSearchOptions(options);
  await notifier.notifyStarted(options.current, options.target, options.max, options.min, options.dryRun);

  let sessionFailureCount = 0;

  while (true) {
    let sessionHeaders;
    try {
      sessionHeaders = await bot.initialize();
      sessionFailureCount = 0;
    } catch (error) {
      if (isPermanentError(error)) throw error;
      sessionFailureCount += 1;
      const delay = backoffSeconds(SESSION_BACKOFF_SECONDS, sessionFailureCount);
      log(`Login/session initialization failed: ${error.message}. Retrying in ${delay}s`);
      await notifier.notifyError(error.message, delay);
      await sleep(delay);
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

        const result = await bot.bookFirstAvailable(sessionHeaders, availableDates);
        if (result) {
          await notifier.notifyBooked(result.date, result.time, options.dryRun);
          log(`Successfully ${options.dryRun ? 'found' : 'booked'} appointment on ${result.date} at ${result.time}`);
          return;
        }

        if (options.once) {
          log('One-time availability check completed with no qualifying bookable slot');
          return;
        }

        await sleep(jitterSeconds(config.refreshDelay));
      } catch (error) {
        if (error.code === 'EAUTH') {
          log(`Session expired: ${error.message}. Logging in again`);
          break;
        }

        if (error.code === 'ERATELIMIT') {
          const delay = Math.max(30, Number(error.retryAfterSeconds) || 60);
          log(`Visa site rate limit reached. Waiting ${delay}s as requested by the server`);
          await notifier.notifyError(error.message, delay);
          await sleep(delay);
          continue;
        }

        if (error.code === 'ETRANSIENT') {
          transientFailureCount += 1;
          const delay = backoffSeconds(TRANSIENT_BACKOFF_SECONDS, transientFailureCount);
          log(`Transient visa-site failure: ${error.message}. Retrying in ${delay}s`);
          if (transientFailureCount >= TRANSIENT_BACKOFF_SECONDS.length) break;
          await sleep(delay);
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
  return ['ESCHEMA', 'ECONFIG', 'EBOOKING_UNVERIFIED', 'EHTTP'].includes(error?.code);
}

function backoffSeconds(steps, failureCount) {
  return jitterSeconds(steps[Math.min(Math.max(failureCount - 1, 0), steps.length - 1)]);
}

function jitterSeconds(baseSeconds) {
  const min = Math.max(1, baseSeconds * (1 - JITTER_FACTOR));
  const max = baseSeconds * (1 + JITTER_FACTOR);
  return Number((Math.random() * (max - min) + min).toFixed(1));
}
