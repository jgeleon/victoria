import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/lib/config.js';

function validConfig(refreshDelay) {
  return {
    email: 'test@example.com',
    password: 'secret',
    scheduleId: '123',
    facilityId: '456',
    countryCode: 'ca',
    refreshDelay,
    requestTimeoutMs: 15000
  };
}

test('accepts a three-second refresh delay with a warning', t => {
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));

  assert.doesNotThrow(() => validateConfig(validConfig(3)));
  assert.deepEqual(warnings, ['Warning: REFRESH_DELAY below 10 seconds may trigger rate limiting']);
});

test('rejects non-positive and invalid refresh delays', () => {
  for (const refreshDelay of [0, -1, Number.NaN]) {
    assert.throws(
      () => validateConfig(validConfig(refreshDelay)),
      /REFRESH_DELAY must be a positive number/
    );
  }
});
