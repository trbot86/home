import type { CalendarsRepository } from './calendars.js';
import type { CalendarSynchronizer } from './synchronizer.js';

/** One bounded fetch at a time; restart timing and stale-publication guards live in the repository. */
export class CalendarWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<boolean> | undefined;
  private cancellation: AbortController | undefined;
  private stopped = true;
  constructor(
    private readonly calendars: CalendarsRepository,
    private readonly sync: CalendarSynchronizer,
    private readonly now: () => number = Date.now,
    private readonly report: () => void = () => {},
  ) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch(this.report)
        .finally(() => this.schedule(3000));
    }, delay);
    this.timer.unref();
  }
  tick(): Promise<boolean> {
    if (this.running) return this.running;
    const cancellation = (this.cancellation = new AbortController());
    this.running = this.run(cancellation.signal).finally(() => {
      this.running = undefined;
      if (this.cancellation === cancellation) this.cancellation = undefined;
    });
    return this.running;
  }
  private async run(signal: AbortSignal) {
    const work = this.calendars.nextSyncWork();
    if (!work) return false;
    if (work.kind === 'discover') await this.sync.discover(work.id, signal);
    else {
      const day = 86400000,
        midnight = Math.floor(this.now() / day) * day;
      // Extra boundary days cover civil dates in calendars on either side of UTC.
      await this.sync.refresh(work.id, { from: midnight - 8 * day, until: midnight + 62 * day }, signal);
    }
    return true;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.cancellation?.abort();
    await this.running;
  }
}
