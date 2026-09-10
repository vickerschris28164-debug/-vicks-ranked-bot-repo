const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGuildIds,
  toCommandPayloads,
  shouldUseGuildScopedRegistration,
  resolveGuildIdsForRegistration,
} = require('../command-registration');

test('parseGuildIds trims and filters empty guild IDs', () => {
  assert.deepEqual(parseGuildIds('123, 456, ,789'), ['123', '456', '789']);
  assert.deepEqual(parseGuildIds(''), []);
  assert.deepEqual(parseGuildIds(undefined), []);
});

test('toCommandPayloads converts builders to JSON payloads', () => {
  const commands = [{ toJSON: () => ({ name: 'test' }) }, { name: 'raw' }];
  assert.deepEqual(toCommandPayloads(commands), [{ name: 'test' }, { name: 'raw' }]);
});

test('shouldUseGuildScopedRegistration skips global registration when guilds are being targeted', () => {
  assert.equal(shouldUseGuildScopedRegistration(['123'], []), true);
  assert.equal(shouldUseGuildScopedRegistration([], ['456']), true);
  assert.equal(shouldUseGuildScopedRegistration([], []), false);
});

test('resolveGuildIdsForRegistration uses discovered guilds and skips inaccessible configured guilds', () => {
  assert.deepEqual(resolveGuildIdsForRegistration(['111', '222'], ['222', '333']), ['222']);
  assert.deepEqual(resolveGuildIdsForRegistration([], ['222', '333']), ['222', '333']);
  assert.deepEqual(resolveGuildIdsForRegistration(['111'], [], false), []);
});

test('resolveGuildIdsForRegistration can force configured guild IDs when allowed', () => {
  assert.deepEqual(resolveGuildIdsForRegistration(['111', '222'], ['222', '333'], true), ['222', '333', '111']);
  assert.deepEqual(resolveGuildIdsForRegistration(['111'], [], true), ['111']);
});
