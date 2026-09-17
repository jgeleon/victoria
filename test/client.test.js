import test from 'node:test';
import assert from 'node:assert/strict';
import { Response } from 'node-fetch';
import { VisaHttpClient } from '../src/lib/client.js';

function response(body, options, url) {
  const result = new Response(body, options);
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

test('login carries rotated cookies across redirects', async () => {
  const requests = [];
  const responses = [
    response('<meta name="csrf-token" content="first">', {
      status: 200,
      headers: { 'set-cookie': '_yatri_session=anonymous; Path=/; HttpOnly' }
    }, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in'),
    response('window.location.href="/en-ca/niv/account"', {
      status: 200,
      headers: {
        'content-type': 'text/javascript',
        'set-cookie': '_yatri_session=authenticated; Path=/; HttpOnly'
      }
    }, 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in'),
    response('<meta name="csrf-token" content="second"><main>Account</main>', {
      status: 200
    }, 'https://ais.usvisa-info.com/en-ca/niv/account')
  ];
  const mockFetch = async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  };
  const client = new VisaHttpClient('ca', 'test@example.com', 'secret', { fetch: mockFetch });

  const headers = await client.login();

  assert.match(requests[1].options.headers.Cookie, /_yatri_session=anonymous/);
  assert.match(requests[2].options.headers.Cookie, /_yatri_session=authenticated/);
  assert.match(headers.Cookie, /_yatri_session=authenticated/);
});

test('appointment dates reject HTML login responses', async () => {
  const mockFetch = async url => response(
    '<form><input name="user[email]"></form>',
    { status: 200, headers: { 'content-type': 'text/html' } },
    String(url)
  );
  const client = new VisaHttpClient('ca', 'test@example.com', 'secret', { fetch: mockFetch });

  await assert.rejects(
    () => client.checkAvailableDate({}, '123', '456'),
    { code: 'EAUTH' }
  );
});

test('requests are aborted after the configured timeout', async () => {
  const mockFetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const client = new VisaHttpClient('ca', 'test@example.com', 'secret', {
    fetch: mockFetch,
    requestTimeoutMs: 20
  });

  await assert.rejects(
    () => client.checkAvailableDate({}, '123', '456'),
    { code: 'ETRANSIENT' }
  );
});

test('available_times are preferred over business_times', async () => {
  const mockFetch = async url => response(JSON.stringify({
    available_times: ['10:00'],
    business_times: ['09:00']
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }, String(url));
  const client = new VisaHttpClient('ca', 'test@example.com', 'secret', { fetch: mockFetch });

  const times = await client.checkAvailableTimes({}, '123', '456', '2026-04-01');

  assert.deepEqual(times, ['10:00']);
});

test('HTTP 429 exposes the server retry delay', async () => {
  const mockFetch = async url => response('', {
    status: 429,
    headers: { 'retry-after': '45' }
  }, String(url));
  const client = new VisaHttpClient('ca', 'test@example.com', 'secret', { fetch: mockFetch });

  await assert.rejects(
    () => client.checkAvailableDate({}, '123', '456'),
    error => error.code === 'ERATELIMIT' && error.retryAfterSeconds === 45
  );
});

test('malformed appointment date schemas fail instead of appearing empty', async () => {
  const mockFetch = async url => response(JSON.stringify({ dates: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }, String(url));
  const client = new VisaHttpClient('ca', 'test@example.com', 'secret', { fetch: mockFetch });

  await assert.rejects(
    () => client.checkAvailableDate({}, '123', '456'),
    { code: 'ESCHEMA' }
  );
});
