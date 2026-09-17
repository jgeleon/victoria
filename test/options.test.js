import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOptions } from '../src/commands/bot.js';

test('validates the requested 2026 range', () => {
  const options = validateOptions({
    current: '2027-04-30',
    min: '2026-01-01',
    max: '2026-12-31'
  });

  assert.equal(options.max, '2026-12-31');
});

test('target is a deprecated max alias', () => {
  const options = validateOptions({ current: '2027-04-30', target: '2026-12-31' });
  assert.equal(options.max, '2026-12-31');
});

test('rejects malformed and inverted ranges', () => {
  assert.throws(() => validateOptions({ current: '04/30/2027' }), /Invalid --current/);
  assert.throws(
    () => validateOptions({ min: '2026-12-31', max: '2026-01-01' }),
    /--min must be on or before --max/
  );
});
