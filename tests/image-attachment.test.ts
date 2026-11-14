import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeImage, MAX_IMAGE_BYTES } from '../server/image-attachment.ts';

test('validates a full-size image without overflowing the stack', () => {
  const image = Buffer.alloc(MAX_IMAGE_BYTES);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  assert.equal(decodeImage(image.toString('base64')).data.length, MAX_IMAGE_BYTES);
  assert.throws(() => decodeImage(Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')));
  assert.throws(() => decodeImage('A===') );
});
