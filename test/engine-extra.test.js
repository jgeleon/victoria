import test from 'node:test';
import assert from 'node:assert/strict';
import { Response } from 'node-fetch';
import { VisaHttpClient } from '../src/lib/client.js';
import { Bot } from '../src/lib/bot.js';

function response(body, options, url) {
  const r = new Response(body, options);
  Object.defineProperty(r, 'url', { value: url });
  return r;
}
const cfg = (o = {}) => ({ countryCode: 'pe', email: 'a@b.com', password: 'x', scheduleId: '123', facilityId: '115', requestTimeoutMs: 1000, ...o });

test('WAF/challenge HTML is classified as EBLOCK (not fatal ESCHEMA)', async () => {
  const mockFetch = async url => response('<html><head><title>Just a moment...</title></head><body>cloudflare /cdn-cgi/ checking your browser</body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } }, String(url));
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  await assert.rejects(() => client.checkAvailableDate({}, '123', '115'), { code: 'EBLOCK' });
});

test('onlyBusinessDay filters out non-business days', async () => {
  const payload = JSON.stringify([{ date: '2026-10-01', business_day: true }, { date: '2026-10-02', business_day: false }]);
  const mockFetch = async url => response(payload, { status: 200, headers: { 'content-type': 'application/json' } }, String(url));
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  assert.deepEqual(await client.checkAvailableDate({}, '123', '115'), ['2026-10-01', '2026-10-02']);
  assert.deepEqual(await client.checkAvailableDate({}, '123', '115', { onlyBusinessDay: true }), ['2026-10-01']);
});

test('multi-facility search combines and sorts candidates by date', async () => {
  const client = {
    checkAvailableDate: async (_h, _s, facility) => (facility === '1' ? ['2026-05-10'] : ['2026-03-01'])
  };
  const bot = new Bot(cfg({ facilityIds: ['1', '2'] }), { client });
  const candidates = await bot.checkAvailableDates({}, '2027-01-01', null, null);
  assert.deepEqual(candidates, [{ date: '2026-03-01', facilityId: '2' }, { date: '2026-05-10', facilityId: '1' }]);
});

test('slot race: refetches times once and books on retry', async () => {
  let timesCalls = 0;
  const client = {
    checkAvailableTimes: async () => { timesCalls += 1; return timesCalls === 1 ? ['09:00'] : ['10:00']; },
    book: async (_h, _s, _f, _date, time) => {
      if (time === '09:00') { const e = new Error('slot gone'); e.code = 'ESLOT_UNAVAILABLE'; throw e; }
    }
  };
  const bot = new Bot(cfg({ facilityIds: ['1'] }), { client });
  const result = await bot.bookAppointment({}, '2026-03-01', '1');
  assert.deepEqual(result, { booked: true, time: '10:00' });
  assert.equal(timesCalls, 2);
});

test('fast booking reuses cached CSRF without a pre-GET', async () => {
  const requests = [];
  const mockFetch = async (url, opts) => {
    requests.push((opts && opts.method) || 'GET');
    return response('<html><body>Your appointment has been successfully booked.</body></html>', { status: 200 }, String(url));
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'cached-token';
  await client.book({}, '123', '115', '2026-05-10', '09:00');
  assert.deepEqual(requests, ['POST']); // solo POST, sin GET previo
});
