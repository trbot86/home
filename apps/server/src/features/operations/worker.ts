import type { Sqlite } from '../../infrastructure/database.js';
import type { MediaService } from '../media/media.js';
import type { BackupCoordinator } from './backups.js';

/** One in-process worker. Network backup transport remains the host's responsibility. */
export class OperationsWorker {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | null = null;
  constructor(
    private readonly db: Sqlite,
    private readonly media: MediaService,
    private readonly backups: BackupCoordinator,
    private readonly options: {
      backupsEnabled: boolean;
      backupHour: number;
      report: (error: unknown) => void;
      now?: () => number;
    },
  ) {
    if (!Number.isInteger(options.backupHour) || options.backupHour < 0 || options.backupHour > 23)
      throw new Error('BACKUP_HOUR must be 0–23');
  }
  start(): void {
    this.timer = setInterval(() => this.schedule(), 60000);
    this.timer.unref();
    this.schedule();
  }
  private schedule(): void {
    if (this.active) return;
    const work = this.tick();
    this.active = work;
    void work.catch(this.options.report).finally(() => {
      if (this.active === work) this.active = null;
    });
  }
  async tick(): Promise<void> {
    await this.media.collect();
    if (!this.options.backupsEnabled) return;
    const now = (this.options.now ?? Date.now)();
    const cutoff = new Date(now);
    cutoff.setHours(this.options.backupHour, 0, 0, 0);
    if (now < cutoff.getTime()) return;
    const latest = this.db
      .prepare('SELECT started_at,state FROM backup_runs ORDER BY started_at DESC,rowid DESC LIMIT 1')
      .get() as { started_at: number; state: string } | undefined;
    if (
      latest &&
      (latest.started_at > now - 3600000 ||
        (latest.state === 'complete' && latest.started_at >= cutoff.getTime()))
    )
      return;
    await this.backups.create();
    await this.backups.prune();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.active?.catch(() => {});
  }
}
