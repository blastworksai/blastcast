// ClaudeBWAI — guest-page platform helpers for phones: timeout signals without AbortSignal.timeout (iOS < 16),
// a Screen Wake Lock manager, and a coarse mobile-device hint.
type TimeoutCapable = { timeout?: (ms: number) => AbortSignal };
export function timeoutSignal(ms: number, signalApi: TimeoutCapable = AbortSignal as unknown as TimeoutCapable): AbortSignal {
  if (typeof signalApi.timeout === 'function') return signalApi.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    let reason: unknown;
    try { reason = new DOMException('The operation timed out.', 'TimeoutError'); } catch { /* old engines: default AbortError */ }
    controller.abort(reason);
  }, ms);
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

export interface WakeSentinelLike { release(): Promise<void>; addEventListener?(type: 'release', listener: () => void): void }
export interface WakeLockHost {
  navigator: { wakeLock?: { request(type: 'screen'): Promise<WakeSentinelLike> } };
  document: { visibilityState: string; addEventListener(type: 'visibilitychange', listener: () => void): void };
}
// Holds a screen wake lock while wanted. Browsers drop the lock whenever the page is hidden, so it is re-requested on return.
export class WakeLockManager {
  private wanted = false;
  private sentinel: WakeSentinelLike | null = null;
  private requesting = false;
  private retry = false;
  constructor(private readonly host: WakeLockHost) {
    host.document.addEventListener('visibilitychange', () => { if (host.document.visibilityState === 'visible') { if (this.requesting) this.retry = true; void this.acquire(); } });
  }
  get supported(): boolean { return Boolean(this.host.navigator.wakeLock && typeof this.host.navigator.wakeLock.request === 'function'); }
  get held(): boolean { return this.sentinel !== null; }
  setWanted(wanted: boolean): void {
    if (wanted === this.wanted) return;
    this.wanted = wanted;
    if (wanted) void this.acquire(); else void this.release();
  }
  async acquire(): Promise<void> {
    if (!this.wanted || !this.supported || this.sentinel || this.requesting || this.host.document.visibilityState !== 'visible') return;
    this.requesting = true;
    try {
      const sentinel = await this.host.navigator.wakeLock!.request('screen');
      if (!this.wanted) { await sentinel.release().catch(() => {}); return; }
      this.sentinel = sentinel;
      sentinel.addEventListener?.('release', () => { if (this.sentinel === sentinel) this.sentinel = null; });
    } catch { /* denied (low battery, policy): the call must never break */ }
    finally {
      this.requesting = false;
      if (this.retry) { this.retry = false; void this.acquire(); }
    }
  }
  async release(): Promise<void> {
    const sentinel = this.sentinel; this.sentinel = null;
    if (sentinel) await sentinel.release().catch(() => {});
  }
}

export interface MobileHost { matchMedia?: (query: string) => { matches: boolean }; navigator: { userAgent?: string } }
export function isPhoneUserAgent(userAgent?: string): boolean {
  return /\b(iPhone|iPad|iPod|Android)\b/i.test(userAgent ?? '');
}
export function isMobileDevice(host: MobileHost): boolean {
  let coarse = false;
  try { coarse = Boolean(host.matchMedia?.('(pointer:coarse)').matches); } catch { /* treat as not coarse */ }
  return coarse || isPhoneUserAgent(host.navigator.userAgent);
}
