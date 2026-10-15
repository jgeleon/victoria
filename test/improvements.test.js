import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Response } from 'node-fetch';
import { VisaHttpClient, parseRescheduleLimit, describeNetworkError, parseCurrentAppointment } from '../src/lib/client.js';
import { Bot, limaDate } from '../src/lib/bot.js';
import { createNapper, errorSpacingSeconds, focusDelaySeconds, gridDelaySeconds, parseFocusWindow, parsePhase, saturationDelaySeconds } from '../src/commands/bot.js';

function response(body, options, url) {
  const r = new Response(body, options);
  Object.defineProperty(r, 'url', { value: url });
  return r;
}
const cfg = (o = {}) => ({ countryCode: 'pe', email: 'a@b.com', password: 'x', scheduleId: '123', facilityId: '115', requestTimeoutMs: 1000, ...o });
const groupsPage = (date = '10 November, 2026', time = '09:00') =>
  `<a href='/en-pe/niv/schedule/123/continue_actions'>Continue</a><p class='consular-appt'><strong>Consular Appointment:</strong> ${date}, ${time} Lima Local Time at Lima</p>`;
const INSTRUCTIONS = 'https://ais.usvisa-info.com/en-pe/niv/schedule/123/appointment/instructions';
const FORM = '<html><head><meta name="csrf-token" content="meta"></head><body><form><input name="authenticity_token" value="fresh"><select name="appointments[consulate_appointment][date]"></select></form></body></html>';

// ---------- reserva ----------
test('booking POST sends commit and no empty CAS fields', async () => {
  let body;
  const mockFetch = async (url, opts) => {
    if (opts?.method !== 'POST') return response(groupsPage(), { status: 200 }, String(url));
    body = new URLSearchParams(opts.body.toString());
    return response('ok', { status: 200 }, INSTRUCTIONS);
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'tok';
  await client.book({}, '123', '115', '2026-11-10', '09:00');
  assert.equal(body.get('commit'), 'Reschedule');
  assert.equal(body.has('appointments[asc_appointment][date]'), false);
  assert.equal(body.get('authenticity_token'), 'tok');
});

test('booking responses are classified without trusting loose text', () => {
  const client = new VisaHttpClient('pe', 'a@b.com', 'x');
  assert.equal(client._classifyBooking(INSTRUCTIONS, '<p>?</p>'), 'ok');
  assert.equal(client._classifyBooking('https://x/es-pe/niv/schedule/1/appointment', '<p>Usted ha programado exitosamente su cita</p>'), 'claimed');
  assert.equal(client._classifyBooking('https://x/es-pe/niv/schedule/1/appointment', '<p>La fecha ya no está disponible</p>'), 'slot');
  assert.equal(client._classifyBooking('https://x/en-pe/niv/schedule/1/appointment', FORM), 'form');
  // caso Carol: una página que solo menciona la fecha y la hora intentadas NO es una reserva
  assert.equal(client._classifyBooking('https://x/en-pe/niv/schedule/1/appointment', '<p>2026-11-13 10:15</p>'), 'unknown');
});

test('unrecognized booking response never sends a second POST', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    calls.push(opts?.method || 'GET');
    if (opts?.method === 'POST') return response('<p>respuesta desconocida</p>', { status: 200 }, String(url));
    return response(groupsPage('20 May, 2027'), { status: 200 }, String(url));
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'tok';
  await assert.rejects(() => client.book({}, '123', '115', '2026-11-10', '09:00'), { code: 'EBOOKING_UNVERIFIED' });
  assert.equal(calls.filter(m => m === 'POST').length, 1);
});

test('CSRF 422 on the fast path retries with a fresh token from the form', async () => {
  const calls = [];
  const mockFetch = async (url, opts) => {
    const method = opts?.method || 'GET';
    calls.push(`${method} ${new URL(url).search}`);
    if (method === 'POST' && calls.length === 1) return response('bad token', { status: 422 }, String(url));
    if (method === 'GET' && url.includes('/account')) return response(groupsPage(), { status: 200 }, String(url));
    if (method === 'GET') return response(FORM, { status: 200 }, String(url));
    return response('ok', { status: 200 }, INSTRUCTIONS);
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'stale';
  await client.book({}, '123', '115', '2026-11-10', '09:00');
  assert.equal(calls.length, 4); // POST(422) + GET formulario + POST + GET Grupos
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

// ---------- confirmación de la reserva en la página de Grupos ----------
test('Carol case: the portal answers with the form and the appointment did not change -> never "booked"', async () => {
  const posts = [];
  const mockFetch = async (url, opts) => {
    if (opts?.method === 'POST') { posts.push(1); return response(FORM + '<p>2026-11-13 10:15</p>', { status: 200 }, String(url)); }
    if (url.includes('/account')) return response(groupsPage('20 May, 2027'), { status: 200 }, String(url));
    return response(FORM, { status: 200 }, String(url));
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'tok';
  await assert.rejects(() => client.book({}, '123', '115', '2026-11-13', '10:15'), { code: 'EFORM_REJECTED' });
  assert.equal(posts.length, 1); // formulario devuelto y la cita no cambió: rechazado, sin reintentar el POST
});

test('a redirect to /instructions that the groups page does not confirm stops as unverified', async () => {
  const mockFetch = async (url, opts) => {
    if (opts?.method === 'POST') return response('ok', { status: 200 }, INSTRUCTIONS);
    return response(groupsPage('20 May, 2027'), { status: 200 }, String(url));
  };
  const client = new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: mockFetch });
  client.csrfToken = 'tok';
  await assert.rejects(() => client.book({}, '123', '115', '2026-11-13', '10:15'), { code: 'EBOOKING_UNVERIFIED' });
});

test('current appointment is read from the groups page (en / es, several groups)', () => {
  assert.deepEqual(parseCurrentAppointment(groupsPage('20 May, 2027', '09:00'), '123'), { date: '2027-05-20', time: '09:00' });
  const es = "<a href='/es-pe/niv/schedule/123/continue_actions'>Continuar</a><p class='consular-appt'><strong>Cita Consular:</strong> 20 mayo, 2027, 09:00 Lima Hora Local at Lima</p>";
  assert.deepEqual(parseCurrentAppointment(es, '123'), { date: '2027-05-20', time: '09:00' });
  const two = "<a href='/x/schedule/111/continue_actions'></a><p class='consular-appt'><strong>Consular Appointment:</strong> 1 March, 2027, 08:00</p>" +
              "<a href='/x/schedule/123/continue_actions'></a><p class='consular-appt'><strong>Consular Appointment:</strong> 7 June, 2027, 10:30</p>";
  assert.deepEqual(parseCurrentAppointment(two, '123'), { date: '2027-06-07', time: '10:30' });
  assert.equal(parseCurrentAppointment('<p>sin cita</p>', '123'), null);
});

test('when the order and the portal disagree, the earliest current date is used', async () => {
  const client = { checkAvailableDate: async () => ['2026-11-13', '2027-01-10', '2027-03-01'] };
  const bot = new Bot(cfg(), { client });
  bot.portalCurrentDate = '2027-01-31';
  const dates = await bot.checkAvailableDates({}, '2027-05-20', null, null);
  assert.deepEqual(dates.map(d => d.date), ['2026-11-13', '2027-01-10']);
});

// ---------- flota ----------
test('dates shared by another order are filtered with this order rules', () => {
  const bot = new Bot(cfg({ onlyBusinessDay: true }), { client: {} });
  const days = [
    { date: '2026-11-13', business_day: true },
    { date: '2026-11-14', business_day: false }, // no hábil: esta orden lo excluye
    { date: '2027-08-01', business_day: true },  // no es anterior a la cita actual
  ];
  assert.deepEqual(bot.filterSharedDates('115', days, '2027-05-20', null, null), [{ date: '2026-11-13', facilityId: '115' }]);
  assert.deepEqual(bot.filterSharedDates('999', days, '2027-05-20', null, null), []); // otro consulado
});

test('poll turns spread orders evenly across the period', () => {
  const base = Date.UTC(2026, 9, 14, 12, 0, 0); // borde exacto de un periodo de 4 s
  const near = (a, b) => Math.abs(a - b) < 0.15;
  assert.ok(near(gridDelaySeconds(4, 0, base + 100), 3.9));   // turno 0: próximo borde
  assert.ok(near(gridDelaySeconds(4, 0.5, base + 100), 1.9)); // turno 1/2: 2 s después del borde
  assert.equal(parsePhase('0.25'), 0.25);
  assert.equal(parsePhase('1'), null);
  assert.equal(parsePhase(''), null);
});

// ---------- saturación vs bloqueo ----------
test('transient failures are classified as saturation, offline or network', async () => {
  const fail = (makeError) => new VisaHttpClient('pe', 'a@b.com', 'x', { fetch: async () => makeError() });
  const kindOf = async (client) => { try { await client.checkAvailableDate({}, '123', '115'); } catch (e) { return `${e.code}/${e.kind}`; } };
  assert.equal(await kindOf(fail(() => response('busy', { status: 503 }, 'https://x'))), 'ETRANSIENT/saturation');
  assert.equal(await kindOf(fail(() => { const e = new Error('x'); e.code = 'ECONNREFUSED'; throw e; })), 'ETRANSIENT/network');
  assert.equal(await kindOf(fail(() => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; })), 'ETRANSIENT/offline');
});

test('saturation keeps searching with short retries and only slows down if it lasts', () => {
  assert.ok(saturationDelaySeconds(1) >= 1 && saturationDelaySeconds(1) < 2);
  assert.equal(saturationDelaySeconds(20), 3);
  assert.equal(saturationDelaySeconds(50), 10);
});

// ---------- revalidación y límite mínimo ----------
test('a date that stopped being valid is never posted', async () => {
  let posted = false;
  const client = { checkAvailableTimes: async () => ['10:15'], book: async () => { posted = true; } };
  const bot = new Bot(cfg(), { client });
  bot.setSearchRange({ current: '2027-05-20', min: '2026-11-01', max: null });
  bot.portalCurrentDate = '2026-11-10'; // la cita real resultó ser anterior a la fecha encontrada
  assert.equal(await bot.bookAppointment({}, '2026-11-13', '115'), null);
  assert.equal(posted, false);
  assert.match(bot._revalidateBeforePost('2026-10-20'), /anterior al mínimo/);
  assert.equal(bot._revalidateBeforePost('2026-11-05'), null);
});

test('an appointment already at the minimum limit cannot be improved', () => {
  const bot = new Bot(cfg(), { client: {} });
  bot.setSearchRange({ current: '2026-12-01', min: '2026-12-01', max: null });
  assert.deepEqual(bot.improvementImpossible(), { current: '2026-12-01', limit: '2026-12-01' });
  bot.setSearchRange({ current: '2027-05-20', min: '2026-12-01', max: null });
  assert.equal(bot.improvementImpossible(), null);
  bot.portalCurrentDate = '2026-11-25'; // el portal dice que ya está antes del mínimo
  assert.equal(bot.improvementImpossible().current, '2026-11-25');
});
