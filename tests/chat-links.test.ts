import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks, isTrustedService } from '../src/chat-links.ts';

test('links preserve surrounding text and punctuation', () => {
  assert.deepEqual(splitLinks('Смотри https://example.com/test, и www.example.org!'), [
    { text: 'Смотри ' }, { text: 'https://example.com/test', href: 'https://example.com/test' },
    { text: ', и ' }, { text: 'www.example.org', href: 'https://www.example.org/' }, { text: '!' },
  ]);
});
test('only actual HTTPS service hosts are trusted', () => {
  const trusted = (s: string) => isTrustedService(new URL(s), 'https://chat.nioservices.website');
  assert.equal(trusted('https://nioservices.website/'), true);
  assert.equal(trusted('https://chat.nioservices.website/'), true);
  assert.equal(trusted('https://nioservices.website.evil.example/'), false);
  assert.equal(trusted('https://nioservices.website@evil.example/'), false);
  assert.equal(trusted('http://nioservices.website/'), false);
});
