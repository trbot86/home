/** Every physical deletion of original bytes must hold a deletion permit. */
export class MediaRetentionGate {
  private holds = 0;
  private readonly active = new Set<Promise<unknown>>();
  async hold(): Promise<() => void> {
    this.holds++;
    await Promise.allSettled([...this.active]);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.holds--;
      }
    };
  }
  async collect(action: () => Promise<void>): Promise<boolean> {
    if (this.holds > 0) return false;
    const work = Promise.resolve().then(action);
    this.active.add(work);
    try {
      await work;
      return true;
    } finally {
      this.active.delete(work);
    }
  }
}
