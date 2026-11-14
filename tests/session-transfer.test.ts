import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTransfers } from '../server/session-transfer.ts';

test('desktop session transfer expires, is single-use and replaces earlier codes', () => {
  let time = 1000;
  const transfers = createSessionTransfers(() => time);
  const first = transfers.issue('session-a');
  const replacement = transfers.issue('session-a');
  assert.equal(transfers.consume(first), undefined);
  assert.equal(transfers.consume(replacement), 'session-a');
  assert.equal(transfers.consume(replacement), undefined);
  const expired = transfers.issue('session-b');
  time += 600_000;
  assert.equal(transfers.consume(expired), undefined);
  assert.equal(transfers.consume('invalid'), undefined);
});
