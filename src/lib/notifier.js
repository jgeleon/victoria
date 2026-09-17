import fetch from 'node-fetch';
import { log } from './utils.js';

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const MAX_RETRIES = 2;
const MIN_SEND_INTERVAL_MS = 3000; // minimum 3s between messages
const REQUEST_TIMEOUT_MS = 10000;

export class Notifier {
  constructor(config) {
    this.botToken = config.telegramBotToken;
    this.chatId = config.telegramChatId;
    this._lastSendTime = 0;
    this._rateLimitedUntil = 0;
  }

  isEnabled() {
    return !!(this.botToken && this.chatId);
  }

  async send(message, retries = 0) {
    if (!this.isEnabled()) return;

    // If we're currently rate-limited, skip non-critical messages
    const now = Date.now();
    if (now < this._rateLimitedUntil) {
      const waitSec = Math.ceil((this._rateLimitedUntil - now) / 1000);
      log(`Telegram rate-limited, ${waitSec}s remaining — skipping message`);
      return;
    }

    // Enforce minimum interval between sends to avoid bursts
    const elapsed = now - this._lastSendTime;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      const delay = MIN_SEND_INTERVAL_MS - elapsed;
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;

      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: message,
            parse_mode: 'HTML'
          }),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      this._lastSendTime = Date.now();

      if (response.ok) return;

      const body = await response.text();

      if (response.status === 429) {
        let retryAfter = 60; // default fallback
        try {
          const parsed = JSON.parse(body);
          if (parsed.parameters?.retry_after) {
            retryAfter = parsed.parameters.retry_after;
          }
        } catch (_) {}

        this._rateLimitedUntil = Date.now() + retryAfter * 1000;
        log(`Telegram rate limit hit — retry after ${retryAfter}s`);

        if (retries < MAX_RETRIES && retryAfter <= 60) {
          // Only auto-retry for short waits (<=60s)
          log(`Waiting ${retryAfter}s before retrying Telegram message...`);
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          return this.send(message, retries + 1);
        }

        log('Telegram retry_after too long or max retries reached — dropping message');
        return;
      }

      log(`Telegram notification failed (${response.status}): ${body}`);
    } catch (err) {
      log(`Telegram notification error: ${err.message}`);
    }
  }

  async notifyStarted(currentDate, targetDate, maxDate, minDate, dryRun) {
    let message = '<b>US Visa Bot Started</b>\n\n';

    if (maxDate) {
      const from = minDate || 'earliest available';
      message += `Searching for dates: <b>${from}</b> to <b>${maxDate}</b>`;
      if (currentDate) message += `\nCurrent booking: <b>${currentDate}</b>`;
    } else {
      message += `Monitoring for dates earlier than <b>${currentDate}</b>`;
      if (minDate) message += `\nMinimum date: <b>${minDate}</b>`;
    }

    if (targetDate) message += `\nTarget date: <b>${targetDate}</b>`;
    if (dryRun) message += `\n\n<i>Running in dry-run mode</i>`;
    return this.send(message);
  }

  async notifyBooked(date, time, dryRun) {
    const prefix = dryRun ? '[DRY RUN] ' : '';
    const message = `<b>${prefix}Appointment Booked!</b>\n\nDate: <b>${date}</b>\nTime: <b>${time}</b>`;
    return this.send(message);
  }

  async notifyError(errorMessage, cooldown) {
    let message = `<b>Bot Error</b>\n\n${escapeHtml(errorMessage)}`;
    if (cooldown) {
      message += `\n\nRestarting after ${cooldown}s cooldown...`;
    } else {
      message += `\n\nRetrying immediately...`;
    }
    return this.send(message);
  }
}
