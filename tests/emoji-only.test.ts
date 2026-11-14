import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmojiOnly } from '../src/emoji-only.ts';

test('recognises emoji-only messages including joined and multi-codepoint emoji', () => {
  for (const value of ['😀', '😀 😂 ❤️', '👍🏽', '👩‍💻', '👨‍👩‍👧‍👦', '🇷🇺', '1️⃣', '☕\n🎉']) assert.equal(isEmojiOnly(value), true, value);
});

test('leaves normal text, numbers and empty messages at the usual size', () => {
  for (const value of ['', '  ', 'Привет 😀', '😀!', '123', '1😀', '@user 😀', 'https://example.com/😀']) assert.equal(isEmojiOnly(value), false, value);
});
