// CodexBWAI — prompt once per newly available guest display, until the host chooses a source.
export class GuestScreenAttention {
  private active = new Set<string>();
  private pending = new Set<string>();

  update(ids: Iterable<string>): boolean {
    const current = new Set(ids);
    for (const id of current) if (!this.active.has(id)) this.pending.add(id);
    for (const id of this.pending) if (!current.has(id)) this.pending.delete(id);
    this.active = current;
    return this.pending.size > 0;
  }

  acknowledge(): void {
    this.pending.clear();
  }

  get needsSelection(): boolean {
    return this.pending.size > 0;
  }
}
