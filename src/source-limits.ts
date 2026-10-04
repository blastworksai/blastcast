// ClaudeBWAI — the one home for the source-recording limits and shapes shared by the guest page (src/*.ts)
// and the desktop main process (desktop/*.cjs). scripts/build.mjs also writes dist/source-limits.json from
// THIS module, so the CommonJS side reads the same values and never keeps a copy.
export const SOURCE_PIECE_BYTES = 64 * 1024;
export const SOURCE_RETAINED_BYTES = 2 * 1024 ** 3;
export const SOURCE_MAX_BYTES = 16 * 1024 ** 3;
export const SOURCE_EPISODE_MAX_BYTES = 128 * 1024 ** 3;
export const SOURCE_MAX_CHUNKS = 100000;
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UUID = new RegExp(`^${UUID_PATTERN}$`);
export const SOURCE_CHUNK_KEYS: string[] = ['episodeId','epochId','sequence','byteLength','sha256','startMonoMs','endMonoMs'];
