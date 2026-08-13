import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('test runner', () => {
  it('is wired correctly', () => {
    assert.strictEqual(1 + 1, 2);
  });
});
