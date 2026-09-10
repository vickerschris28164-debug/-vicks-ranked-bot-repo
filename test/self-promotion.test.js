const test = require('node:test');
const assert = require('node:assert/strict');
const { isSelfPromotion } = require('../self-promotion');

test('detects common self-promotion links and phrases', () => {
  assert.equal(isSelfPromotion('Join my server: https://discord.gg/example'), true);
  assert.equal(isSelfPromotion('Subscribe to my channel and follow my stream!'), true);
  assert.equal(isSelfPromotion('Check out my shop: https://example.com'), true);
});

test('does not flag ordinary conversation or unrelated links', () => {
  assert.equal(isSelfPromotion('That match was really close.'), false);
  assert.equal(isSelfPromotion('The rules are at https://example.com/rules'), false);
  assert.equal(isSelfPromotion(''), false);
});