import { PublicFetchError, PublicWebFetcher } from '../../infrastructure/public-web.js';
import { Deferral, Rejection, Unauthenticated } from '../../application/errors.js';
import type { MediaService } from '../media/media.js';
import { RecipeImports } from './imports.js';
import { RecipeSourceReader } from './source-reader.js';

/** One bounded import at a time. Leases handle process death; abort/release handles graceful shutdown. */
export class RecipeImportWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<boolean> | undefined;
  private cancellation: AbortController | undefined;
  private stopped = true;
  private readonly reader: Pick<RecipeSourceReader, 'read'>;
  private readonly web: Pick<PublicWebFetcher, 'get'>;
  constructor(
    private readonly imports: RecipeImports,
    private readonly media: MediaService,
    private readonly options: {
      reader?: Pick<RecipeSourceReader, 'read'>;
      web?: Pick<PublicWebFetcher, 'get'>;
      report?: (error: unknown) => void;
    } = {},
  ) {
    this.web = options.web ?? new PublicWebFetcher();
    this.reader = options.reader ?? new RecipeSourceReader(this.web);
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => this.options.report?.(error))
        .finally(() => this.schedule(3000));
    }, delay);
    this.timer.unref();
  }
  tick(): Promise<boolean> {
    if (this.running) return this.running;
    this.cancellation = new AbortController();
    const cancellation = this.cancellation;
    this.running = this.run(cancellation.signal).finally(() => {
      this.running = undefined;
      if (this.cancellation === cancellation) this.cancellation = undefined;
    });
    return this.running;
  }
  private async run(shutdown: AbortSignal): Promise<boolean> {
    const claimed = this.imports.claim();
    if (!claimed) return false;
    const { context } = claimed,
      signal = AbortSignal.any([shutdown, AbortSignal.timeout(90000)]);
    try {
      if (this.imports.hasApplication(context)) {
        this.imports.apply(context);
        return true;
      }
      if (this.imports.abandonDeleted(context)) return true;
      let source = this.imports.source(context);
      if (!source) {
        source = await this.reader.read(claimed.sourceUrl, signal);
        signal.throwIfAborted();
        this.imports.saveSource(context, source);
      }
      for (const candidate of source.extraction.candidates) {
        if (this.imports.image(context.jobId, candidate.candidateId)) continue;
        for (const url of candidate.imageUrls.slice(0, 2)) {
          try {
            const image = await this.web.get(url, 'image', signal);
            signal.throwIfAborted();
            await this.media.importImage(context, candidate.candidateId, image.url, image.bytes);
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (
              !(error instanceof PublicFetchError) &&
              !(error instanceof Rejection) &&
              !(error instanceof Deferral)
            )
              throw error;
          }
        }
      }
      signal.throwIfAborted();
      if (this.imports.freezeApplication(context)) this.imports.apply(context);
    } catch (error) {
      try {
        if (shutdown.aborted) this.imports.release(context);
        else if (signal.aborted) this.imports.fail(context, 'import_timeout');
        else if (error instanceof PublicFetchError) this.imports.fail(context, error.code);
        else if (error instanceof Rejection) this.imports.fail(context, error.code);
        else if (!(error instanceof Unauthenticated)) {
          // A database/publication failure may be transient. Preserve the exact result for retry.
          this.imports.release(context);
          throw error;
        }
      } catch (finaliseError) {
        // Cancellation, restore, disablement or lease replacement may have revoked this worker.
        if (!(finaliseError instanceof Unauthenticated) && !(finaliseError instanceof Rejection))
          throw finaliseError;
      }
    }
    return true;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.cancellation?.abort();
    await this.running;
  }
}
