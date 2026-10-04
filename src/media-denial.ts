// ClaudeBWAI — macOS denial wording: name only the blocked devices and say where to fix it.
import type { MediaAccessState } from './bridge.js';
export type MediaDenial = { text: string; settings: 'camera' | 'microphone' | null };
export const GENERIC_DENIAL = 'Access was not granted. Your devices are off. Try again when you are ready.';
const blocked = (state: MediaAccessState): boolean => state === 'denied' || state === 'restricted';
export function denialMessage(status: { camera: MediaAccessState; microphone: MediaAccessState }): MediaDenial {
  const names = [...(blocked(status.camera) ? ['camera'] : []), ...(blocked(status.microphone) ? ['microphone'] : [])];
  if (!names.length) return { text: GENERIC_DENIAL, settings: null };
  return {
    text: `macOS is blocking BlastCast from your ${names.join(' and ')}. Turn BlastCast on in System Settings → Privacy & Security, then restart BlastCast.`,
    settings: blocked(status.camera) ? 'camera' : 'microphone',
  };
}
