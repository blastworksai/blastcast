// CodexBWAI — make the provider's copy value safe to paste without weakening host validation.
const EXPRESS_TURN = /^(?:turn:)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.expressturn\.com):3478(?:\?transport=(udp|tcp))?$/;

export function normalizeExpressTurnAddress(value: string): string {
  const trimmed = value.trim();
  const match = EXPRESS_TURN.exec(trimmed);
  if (!match) return trimmed;
  return `turn:${match[1]}:3478?transport=${match[2] ?? 'udp'}`;
}
