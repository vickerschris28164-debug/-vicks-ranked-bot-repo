const SELF_PROMOTION_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i,
  /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be|twitch\.tv|kick\.com|tiktok\.com)\/[^\s]+/i,
  /\b(?:subscribe|follow|stream(?:ing)?|watch me|check out my|join my|support my|buy my|use my code|commission me)\b/i,
  /\b(?:my channel|my server|my stream|my shop|my store|my page|my podcast|my content)\b/i,
];

function isSelfPromotion(content) {
  if (typeof content !== 'string' || content.trim().length === 0) return false;
  return SELF_PROMOTION_PATTERNS.some((pattern) => pattern.test(content));
}

module.exports = { isSelfPromotion };