import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionNames } from '../server/mentions.ts';

test('mentions match whole usernames and ignore emails and duplicates', () => {
  assert.deepEqual(mentionNames('Привет, @Alice и (@bob_2)! @ALICE test@example.com слово@ignored @ab'), ['alice', 'bob_2']);
  assert.deepEqual(mentionNames('@abcdefghijklmnopqrstuvwxy @member_123'), ['member_123']);
});
