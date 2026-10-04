// ClaudeBWAI — CommonJS door onto src/source-limits.ts; scripts/build.mjs writes dist/source-limits.json from it.
const limits = require('../dist/source-limits.json');
const UUID_PATTERN = limits.UUID_PATTERN;
module.exports = {
  PIECE: limits.SOURCE_PIECE_BYTES, RETAINED: limits.SOURCE_RETAINED_BYTES, SOURCE: limits.SOURCE_MAX_BYTES,
  EPISODE: limits.SOURCE_EPISODE_MAX_BYTES, CHUNKS: limits.SOURCE_MAX_CHUNKS,
  CHUNK_KEYS: limits.SOURCE_CHUNK_KEYS, UUID_PATTERN, UUID: new RegExp(`^${UUID_PATTERN}$`),
};
