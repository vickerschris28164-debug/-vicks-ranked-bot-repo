const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGuildIds } = require('../command-registration');

test('parseGuildIds trims and filters empty guild IDs', () => {
  assert.deepEqual(parseGuildIds('123, 456, ,789'), ['123', '456', '789']);
  assert.deepEqual(parseGuildIds(''), []);
  assert.deepEqual(parseGuildIds(undefined), []);
});
