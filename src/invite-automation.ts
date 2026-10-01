// CodexBWAI — one automatic invitation for one explicitly started setup, never for arbitrary polling.
export type InviteSetupStatus = { ok: false } | { ok: true; phase: string; origin: string; invite: { expiresAt: number } | null };
export class InviteAutomation {
  private generation = 0;
  private origin: string | null = null;
  private pending = false;
  begin(): number { this.generation++; this.origin = null; this.pending = false; return this.generation; }
  cancel(): void { this.begin(); }
  accept(generation: number, value: InviteSetupStatus): boolean {
    if (generation !== this.generation || !value.ok || !['checking','outside-check','ready'].includes(value.phase) || !value.origin) return false;
    this.origin = value.origin; this.pending = true; return true;
  }
  take(value: InviteSetupStatus, now = Date.now()): boolean {
    if (!this.pending || !value.ok) return false;
    if (value.phase === 'off' || value.phase === 'blocked') { this.pending = false; return false; }
    if (value.origin !== this.origin || value.phase !== 'ready') return false;
    this.pending = false;
    return !(value.invite && value.invite.expiresAt > now);
  }
}
