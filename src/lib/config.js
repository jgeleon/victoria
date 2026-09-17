import dotenv from 'dotenv';

dotenv.config();

export function getConfig() {
  const config = {
    email: process.env.EMAIL?.trim(),
    password: process.env.PASSWORD,
    scheduleId: process.env.SCHEDULE_ID?.trim(),
    facilityId: process.env.FACILITY_ID?.trim(),
    countryCode: process.env.COUNTRY_CODE?.trim().toLowerCase(),
    refreshDelay: Number(process.env.REFRESH_DELAY || 20),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID
  };

  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  const required = ['email', 'password', 'scheduleId', 'facilityId', 'countryCode'];
  const missing = required.filter(key => !config[key]);

  if (missing.length > 0) {
    throw configError(`Missing required environment variables: ${missing.map(k => k.toUpperCase()).join(', ')}`);
  }

  if (!/^[a-z]{2}$/.test(config.countryCode)) {
    throw configError('COUNTRY_CODE must be a two-letter country code');
  }
  if (!/^\d+$/.test(config.scheduleId) || !/^\d+$/.test(config.facilityId)) {
    throw configError('SCHEDULE_ID and FACILITY_ID must contain only digits');
  }
  if (!Number.isFinite(config.refreshDelay) || config.refreshDelay <= 0) {
    throw configError('REFRESH_DELAY must be a positive number');
  }
  if (config.refreshDelay < 10) {
    console.warn('Warning: REFRESH_DELAY below 10 seconds may trigger rate limiting');
  }
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 1000) {
    throw configError('REQUEST_TIMEOUT_MS must be at least 1000 milliseconds');
  }
}

function configError(message) {
  const error = new Error(message);
  error.code = 'ECONFIG';
  return error;
}

export function getBaseUri(countryCode) {
  return `https://ais.usvisa-info.com/en-${countryCode}/niv`;
}
