import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Response } from 'node-fetch';
import { VisaHttpClient, parseRescheduleLimit, describeNetworkError } from '../src/lib/client.js';
import { Bot, limaDate } from '../src/lib/bot.js';
import { createNapper, errorSpacingSeconds, focusDelaySeconds, parseFocusWindow } from '../src/commands/bot.js';

function response(body, options, url) {
  const r = new Response(body, options);
  Object.defineProperty(r, 'url', { value: url });
  return r;
}
const cfg = (o = {}) => ({ countryCode: 'pe', email: 'a@b.com', password: 'x', scheduleId: '123', facilityId: '115', requestTimeoutMs: 1000, ...o });
const FORM = '<html><head><meta name="csrf-token" content="meta"></head><body><form><input name="authenticity_token" value="fresh"><select name="appointments[consulate_appointment][date]"></select></form></body></html>';

// ---------- reserva ----------
test('booking POST sends commit and no empty CAS fields', async () => {
  let body;
  const mockFetch = async (url, opts) => {
    body = new URLSearchParams(opts.body.toString());
    return response('ok', { status: 200 }, 'https://ais.usvisa-info.com/en-pe/niv/schedule/123/appointment/instructions');
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'tok';
  await client.book({}, '123', '115', '2026-11-10', '09:00');
  assert.equal(body.get('commit'), 'Reschedule');
  assert.equal(body.has('appointments[asc_appointment][date]'), false);
  assert.equal(body.get('authenticity_token'), 'tok');
});

test('redirect to /instructions counts as success', () => {
  const client = new VisaHttpClient('pe', 'a@b.com', 'x');
  assert.equal(client._classifyBooking('https://x/en-pe/niv/schedule/1/appointment/instructions', '<p>?</p>', '2026-11-10', '09:00'), 'ok');
  assert.equal(client._classifyBooking('https://x/es-pe/niv/schedule/1/appointment', '<p>Usted ha programado exitosamente su cita</p>', '2026-11-10', '09:00'), 'ok');
  assert.equal(client._classifyBooking('https://x/es-pe/niv/schedule/1/appointment', '<p>La fecha ya no está disponible</p>', '2026-11-10', '09:00'), 'slot');
  assert.equal(client._classifyBooking('https://x/en-pe/niv/schedule/1/appointment', FORM, '2026-11-10', '09:00'), 'form');
  assert.equal(client._classifyBooking('https://x/en-pe/niv/schedule/1/appointment', '<p>algo raro</p>', '2026-11-10', '09:00'), 'unknown');
});

test('unrecognized booking response never sends a second POST', async () => {
  const methods = [];
  const mockFetch = async (url, opts) => {
    methods.push(opts?.method || 'GET');
    return response('<p>respuesta desconocida</p>', { status: 200 }, String(url));
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'tok';
  await assert.rejects(() => client.book({}, '123', '115', '2026-11-10', '09:00'), { code: 'EBOOKING_UNVERIFIED' });
  assert.deepEqual(methods, ['POST']);
});

test('CSRF 422 on the fast path retries with a fresh token from the form', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    const method = opts?.method || 'GET';
    calls.push(`${method} ${new URL(url).search}`);
    if (method === 'POST' && calls.length === 1) return response('bad token', { status: 422 }, String(url));
    if (method === 'GET') return response(FORM, { status: 200 }, String(url));
    return response('ok', { status: 200 }, 'https://ais.usvisa-info.com/en-pe/niv/schedule/123/appointment/instructions');
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'stale';
  await client.book({}, '123', '115', '2026-11-10', '09:00');
  assert.equal(calls.length, 3);
  assert.match(calls[1], /^GET \?confirmed_limit_message=1&commit=Continue$/);
  assert.equal(client.csrfToken, 'fresh');
});

// ---------- login ----------
function loginFetch(postBody) {
  const responses = [
    response('<meta name="csrf-token" content="t">', { status: 200, headers: { 'set-cookie': '_yatri_session=a; Path=/' } }, 'https://ais.usvisa-info.com/en-pe/niv/users/sign_in'),
    response(postBody, { status: 200 }, 'https://ais.usvisa-info.com/en-pe/niv/users/sign_in'),
  ];
  return async () => responses.shift();
}

test('wrong password is a permanent ECREDENTIALS error', async () => {
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: loginFetch('$("#sign_in_form").html("<p>Invalid email or password.</p>")') });
  await assert.rejects(() => client.login(), { code: 'ECREDENTIALS' });
});

test('locked account is a permanent ELOCKED error', async () => {
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: loginFetch('Your account is locked until 2026-10-07 18:00 UTC.') });
  await assert.rejects(() => client.login(), { code: 'ELOCKED' });
});

// ---------- tope de reprogramaciones ----------
test('reschedule limit is parsed from the es-pe warning page', () => {
  const html = '<p>Hay un n&uacute;mero m&aacute;ximo de 2 cancelaciones/reprogramaciones permitidas por este servicio. Le quedan 1 intentos antes de alcanzar el l&iacute;mite.</p>';
  assert.deepEqual(parseRescheduleLimit(html), { max: 2, remaining: 1 });
  assert.deepEqual(parseRescheduleLimit('<p>nada</p>'), { max: null, remaining: null });
});

test('zero reschedules left blocks booking with ENOLIMIT', async () => {
  const client = {
    rescheduleLimit: { max: 2, remaining: 0 },
    checkAvailableTimes: async () => ['09:00'],
    book: async () => { throw new Error('must not book'); }
  };
  const bot = new Bot(cfg(), { client });
  await assert.rejects(() => bot.bookAppointment({}, '2026-11-10', '115'), { code: 'ENOLIMIT' });
});

// ---------- fechas ----------
test('dates closer than minDaysFromToday are rejected', async () => {
  const today = limaDate();
  const plus = (n) => limaDate(Date.now() + n * 86400000);
  const client = { checkAvailableDate: async () => [plus(1), plus(2), plus(3), plus(10)] };
  const bot = new Bot(cfg({ minDaysFromToday: 3 }), { client });
  const dates = await bot.checkAvailableDates({}, plus(60), null, null);
  assert.deepEqual(dates.map(d => d.date), [plus(3), plus(10)]);
  assert.ok(today < plus(3));
});

test('a date failing 5 times is ignored (persisted across processes)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vb-')), 'df.json');
  const client = { checkAvailableTimes: async () => [], checkAvailableDate: async () => ['2027-01-05', '2027-01-20'] };
  const bot = new Bot(cfg({ dateFailuresFile: file }), { client });
  for (let i = 0; i < 5; i++) await bot.bookAppointment({}, '2027-01-05', '115');
  const bot2 = new Bot(cfg({ dateFailuresFile: file }), { client });
  const dates = await bot2.checkAvailableDates({}, '2027-06-01', null, null);
  assert.deepEqual(dates.map(d => d.date), ['2027-01-20']);
});

// ---------- ritmo ----------
test('error spacing grows with consecutive errors', () => {
  assert.equal(errorSpacingSeconds(0), 0);
  assert.equal(errorSpacingSeconds(4), 0);
  assert.equal(errorSpacingSeconds(5), 60);
  assert.equal(errorSpacingSeconds(20), 120);
  assert.equal(errorSpacingSeconds(40), 300);
  assert.equal(errorSpacingSeconds(99), 600);
});

test('focus window waits for second 13 when outside the window', () => {
  const win = parseFocusWindow('13-26');
  assert.deepEqual(win, { start: 13, end: 26 });
  const base = Date.UTC(2026, 9, 7, 12, 0, 0);
  assert.equal(focusDelaySeconds(1, win, base + 14000), 1);            // s15: dentro
  assert.equal(focusDelaySeconds(1, win, base + 30000), 43);           // s31 -> espera a s13 del minuto siguiente
  assert.equal(focusDelaySeconds(1, win, base + 5000), 8);             // s6 -> s13
  assert.equal(focusDelaySeconds(2, null, base), 2);
});

test('a booking POST that times out stops as unverified instead of retrying', async () => {
  const mockFetch = async () => { const e = new Error('socket hang up'); throw e; };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'tok';
  await assert.rejects(() => client.book({}, '123', '115', '2026-11-10', '09:00'), { code: 'EBOOKING_UNVERIFIED' });
});

test('a mode switch wakes the bot from its current pause', async () => {
  const napper = createNapper();
  const start = Date.now();
  const pause = napper.nap(30);
  setTimeout(() => napper.wake(), 50);
  await pause;
  assert.ok(Date.now() - start < 1000);
});

test('when every facility fails the poll is an error, not "no dates"', async () => {
  const client = { checkAvailableDate: async () => { const e = new Error('Network request failed'); e.code = 'ETRANSIENT'; throw e; } };
  const bot = new Bot(cfg(), { client });
  await assert.rejects(() => bot.checkAvailableDates({}, '2027-06-01', null, null), { code: 'ETRANSIENT' });
});

test('network errors with an empty reason show their real cause', async () => {
  assert.match(describeNetworkError({ code: 'ECONNREFUSED', message: 'request to x failed, reason: ' }), /ECONNREFUSED: el portal rechazó/);
  assert.match(describeNetworkError({ code: 'ETIMEDOUT' }), /no aceptó la conexión a tiempo/);
  assert.equal(describeNetworkError({}), 'sin código');
  const mockFetch = async () => { const e = new Error('request to https://x failed, reason: '); e.code = 'ECONNREFUSED'; throw e; };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  await assert.rejects(() => client.checkAvailableDate({}, '123', '115'), (err) => err.code === 'ETRANSIENT' && /\[ECONNREFUSED: el portal rechazó la conexión/.test(err.message));
});
