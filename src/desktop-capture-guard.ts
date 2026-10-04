// ClaudeBWAI — the screen reaches BlastCast only through Share screen and its picker. Chromium still honours the
// legacy getUserMedia({video:{mandatory:{chromeMediaSource:'desktop'}}}) form, whose permission request the main
// process cannot tell apart from getDisplayMedia's (boundary.cjs createDisplayPermission), so the studio refuses it here.
// Defence in depth since 3 Oct 2026: a fresh same-origin iframe has its own unpatched MediaDevices.prototype, and calling it
// on the studio's mediaDevices still makes a main-frame request (Codex review). The main process now closes that: a desktop
// grant needs a pick armed in the isolated picker first (chooseScreen), and a grant the display-media handler did not
// serve crashes the studio renderer (boundary.cjs createDisplayPermission).
export function asksForDesktop(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 6) return false;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'chromeMediaSource' || key === 'chromeMediaSourceId') return true;
    if (asksForDesktop(inner, depth + 1)) return true;
  }
  return false;
}
export function guardDesktopCapture(devices: MediaDevices | undefined = globalThis.navigator?.mediaDevices): void {
  if (!devices || typeof devices.getUserMedia !== 'function') return;
  // Both the instance and its prototype: MediaDevices.prototype.getUserMedia.call(devices, …) reaches the native method otherwise.
  const proto = Object.getPrototypeOf(devices) as MediaDevices | null;
  const native = devices.getUserMedia;
  const refuse = () => Promise.reject(new DOMException('Share your screen with Share screen.', 'NotAllowedError'));
  const guarded = function (this: MediaDevices, constraints?: MediaStreamConstraints) {
    return asksForDesktop(constraints) ? refuse() : native.call(this ?? devices, constraints);
  };
  for (const target of [proto, devices]) {
    if (target && Object.getOwnPropertyDescriptor(target, 'getUserMedia')?.configurable !== false) {
      Object.defineProperty(target, 'getUserMedia', { configurable: false, writable: false, value: guarded });
    }
  }
  const legacy = globalThis.navigator as unknown as Record<string, unknown> | undefined;
  for (const name of ['webkitGetUserMedia', 'getUserMedia']) if (legacy && name in legacy) Object.defineProperty(legacy, name, { configurable: false, writable: false, value: undefined });
}
guardDesktopCapture();
