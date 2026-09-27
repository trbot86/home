import { createHash } from 'node:crypto';
import type { RecipeExtraction } from '@our-place/contracts';
import { PublicWebFetcher } from '../../infrastructure/public-web.js';
import { decodePublicHtml } from '../../infrastructure/html-text.js';
import { extractRecipeMetadata } from './extractor.js';

export type RecipeSourceResult = {
  extraction: RecipeExtraction;
  page: { mediaType: string; encoding: string; byteLength: number; sha256: string };
};

/** Retrieval and pure extraction only. Saving/applying a result belongs to the durable import job. */
export class RecipeSourceReader {
  constructor(private readonly web: Pick<PublicWebFetcher, 'get'> = new PublicWebFetcher()) {}

  async read(url: string, cancellation?: AbortSignal): Promise<RecipeSourceResult> {
    const page = await this.web.get(url, 'html', cancellation);
    const { html, encoding } = decodePublicHtml(page);
    cancellation?.throwIfAborted();
    return {
      extraction: extractRecipeMetadata(html, page.url),
      page: {
        mediaType: page.mediaType,
        encoding,
        byteLength: page.bytes.length,
        sha256: createHash('sha256').update(page.bytes).digest('hex'),
      },
    };
  }
}
