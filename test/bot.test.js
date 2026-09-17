import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot, dateKey } from '../src/lib/bot.js';

const config = {
  countryCode: 'ca',
  email: 'test@example.com',
  password: 'secret',
  scheduleId: '123',
  facilityId: '456',
  requestTimeoutMs: 1000
};

test('dateKey validates strict real calendar dates', () => {
  assert.equal(dateKey('2026-01-01'), 20260101);
  assert.equal(dateKey('2027-04-30'), 20270430);
  assert.throws(() => dateKey('04/30/2027'), /YYYY-MM-DD/);
  assert.throws(() => dateKey('2026-02-30'), /Invalid calendar date/);
});

test('checkAvailableDates keeps every qualifying 2026 date', async () => {
  const client = {
    checkAvailableDate: async () => [
      '2027-04-30',
      '2026-12-31',
      '2026-01-01',
      '2025-12-31',
      '2026-01-01'
    ]
  };
  const bot = new Bot(config, { client });

  const dates = await bot.checkAvailableDates({}, '2027-04-30', '2026-01-01', '2026-12-31');

  assert.deepEqual(dates, ['2026-01-01', '2026-12-31']);
});

test('later dates are attempted when the earliest date has no times', async () => {
  const checkedDates = [];
  const client = {
    checkAvailableTimes: async (_headers, _schedule, _facility, date) => {
      checkedDates.push(date);
      return date === '2026-03-01' ? [] : ['09:00'];
    },
    book: async () => {}
  };
  const bot = new Bot(config, { client });

  const result = await bot.bookFirstAvailable({}, ['2026-03-01', '2026-04-01']);

  assert.deepEqual(checkedDates, ['2026-03-01', '2026-04-01']);
  assert.deepEqual(result, { booked: true, time: '09:00', date: '2026-04-01' });
});

test('authentication booking failures are not swallowed as slot races', async () => {
  const client = {
    checkAvailableTimes: async () => ['09:00', '10:00'],
    book: async () => {
      const error = new Error('session expired');
      error.code = 'EAUTH';
      throw error;
    }
  };
  const bot = new Bot(config, { client });

  await assert.rejects(() => bot.bookAppointment({}, '2026-04-01'), { code: 'EAUTH' });
});
