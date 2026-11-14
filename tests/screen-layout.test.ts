import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileScreenOrder, moveScreen } from '../src/screen-layout.ts';

test('joining, leaving, and SDK reordering do not disturb the viewer’s chosen screen order', () => {
  assert.deepEqual(reconcileScreenOrder(['b', 'a'], ['a', 'b', 'c']), ['b', 'a', 'c']);
  assert.deepEqual(reconcileScreenOrder(['b', 'a', 'c'], ['c', 'b']), ['b', 'c']);
  assert.deepEqual(reconcileScreenOrder(['b', 'b'], ['b', 'a']), ['b', 'a']);
  assert.deepEqual(reconcileScreenOrder(['b'], []), []);
});
test('moving screens in either direction preserves all streams and ignores stale drag targets', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(moveScreen(order, 'a', 'c'), ['b', 'c', 'a']);
  assert.deepEqual(moveScreen(order, 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveScreen(order, 'a', 'gone'), order);
  assert.deepEqual(moveScreen(order, 'gone', 'b'), order);
  assert.deepEqual(moveScreen(order, 'a', 'a'), order);
  assert.deepEqual(order, ['a', 'b', 'c']);
});
