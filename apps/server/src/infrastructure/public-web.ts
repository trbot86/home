import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';

export type PublicFetchKind = 'html' | 'image';
export type PublicFetchResult = { url: string; mediaType: string; contentType: string; bytes: Buffer };
export type PublicAddress = { address: string; family: 4 | 6 };
type Resolver = (hostname: string) => Promise<PublicAddress[]>;
type Sender = (
  url: URL,
  options: RequestOptions,
  response: (value: IncomingMessage) => void,
) => ClientRequest;
export class PublicFetchError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The same URL rules apply to a page, image and every redirect target. */
export function publicWebUrl(input: string, base?: string): URL {
  let url: URL;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    throw new PublicFetchError('invalid_url');
  }
  if (
    input.length > 4096 ||
    url.href.length > 4096 ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new PublicFetchError('unsupported_url');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !host ||
    host.endsWith('.') ||
    host.includes('%') ||
    (!isIP(host) && !host.includes('.')) ||
    ['localhost', 'local', 'localdomain', 'internal', 'home.arpa', 'ts.net'].some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  )
    throw new PublicFetchError('non_public_url');
  if (isIP(host) && !isPublicAddress(host)) throw new PublicFetchError('non_public_address');
  url.hash = '';
  return url;
}
export function isPublicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  return (
    parsed.range() === 'unicast' &&
    (parsed.kind() === 'ipv4' || (parsed as ipaddr.IPv6).match(ipaddr.IPv6.parse('2000::'), 3))
  );
}
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Bounded public GETs with pinned DNS. It sends no household cookies, credentials or referrer. */
export class PublicWebFetcher {
  private readonly resolve: Resolver;
  private readonly send: Sender;
  private readonly timeoutMs: number;
  constructor(options: { resolve?: Resolver; send?: Sender; timeoutMs?: number } = {}) {
    this.resolve =
      options.resolve ??
      (async (host) =>
        (await lookup(host, { all: true })).map((item) => ({
          address: item.address,
          family: item.family as 4 | 6,
        })));
    this.send =
      options.send ??
      ((url, options, response) =>
        (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, response));
    this.timeoutMs = options.timeoutMs ?? 15000;
  }
  async get(input: string, kind: PublicFetchKind, cancellation?: AbortSignal): Promise<PublicFetchResult> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
    const visited = new Set<string>();
    let url = publicWebUrl(input);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        signal.throwIfAborted();
        if (visited.has(url.href)) throw new PublicFetchError('redirect_loop');
        visited.add(url.href);
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const literalFamily = isIP(host);
        const addresses = literalFamily
          ? [{ address: host, family: literalFamily as 4 | 6 }]
          : await untilAbort(this.resolve(host), signal);
        if (
          !addresses.length ||
          addresses.some((item) => !isPublicAddress(item.address) || isIP(item.address) !== item.family)
        )
          throw new PublicFetchError('non_public_address');
        const address = addresses[0]!;
        const result = await this.request(url, kind, address, signal);
        if ('redirect' in result) {
          if (redirects === 3) throw new PublicFetchError('too_many_redirects');
          const next = publicWebUrl(result.redirect, url.href);
          if (url.protocol === 'https:' && next.protocol !== 'https:')
            throw new PublicFetchError('insecure_redirect');
          url = next;
        } else return { ...result, url: url.href };
      }
      throw new PublicFetchError('too_many_redirects');
    } catch (error) {
      if (cancellation?.aborted) throw new PublicFetchError('cancelled');
      if (deadline.aborted) throw new PublicFetchError('request_timeout');
      if (error instanceof PublicFetchError) throw error;
      throw new PublicFetchError('fetch_failed');
    }
  }
  private async request(
    url: URL,
    kind: PublicFetchKind,
    address: PublicAddress,
    signal: AbortSignal,
  ): Promise<{ redirect: string } | Omit<PublicFetchResult, 'url'>> {
    const maxBytes = kind === 'html' ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
    // Never resolve again when connecting: a changed DNS answer cannot turn this into a local request.
    const pinnedLookup: LookupFunction = (_host, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    let request: ClientRequest | undefined, response: IncomingMessage | undefined;
    const abort = () => request?.destroy(new PublicFetchError('request_aborted'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        request = this.send(
          url,
          {
            method: 'GET',
            agent: false,
            lookup: pinnedLookup,
            family: address.family,
            rejectUnauthorized: true,
            maxHeaderSize: 16384,
            headers: {
              accept:
                kind === 'html' ? 'text/html, application/xhtml+xml' : 'image/jpeg, image/png, image/webp',
              'accept-encoding': 'gzip, deflate, br',
              'user-agent': 'OurPlaceRecipeImporter/1.0',
            },
          },
          resolve,
        );
        request.on('error', reject);
        request.end();
        if (signal.aborted) abort();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (!response.headers.location) throw new PublicFetchError('invalid_redirect');
        return { redirect: response.headers.location };
      }
      if (response.statusCode !== 200) throw new PublicFetchError('http_error');
      const contentType = response.headers['content-type'] ?? '';
      const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
      const accepted =
        kind === 'html' ? ['text/html', 'application/xhtml+xml'] : ['image/jpeg', 'image/png', 'image/webp'];
      if (!accepted.includes(mediaType)) throw new PublicFetchError('unsupported_content_type');
      const length = response.headers['content-length'];
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes))
        throw new PublicFetchError('response_too_large');
      const encoding = (response.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
      const decoder =
        encoding === 'gzip'
          ? createGunzip()
          : encoding === 'deflate'
            ? createInflate()
            : encoding === 'br'
              ? createBrotliDecompress()
              : null;
      if (!decoder && encoding !== 'identity') throw new PublicFetchError('unsupported_content_encoding');
      const decoded = decoder ?? response;
      let wireBytes = 0,
        decodedBytes = 0;
      const chunks: Buffer[] = [];
      const fail = (error: Error) => {
        decoded.destroy(error);
        response?.destroy(error);
      };
      response.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length;
        if (wireBytes > maxBytes) fail(new PublicFetchError('response_too_large'));
      });
      if (decoder) {
        response.on('error', fail);
        response.on('aborted', () => fail(new PublicFetchError('truncated_response')));
        response.pipe(decoder);
      }
      try {
        for await (const chunk of decoded) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          decodedBytes += bytes.length;
          if (decodedBytes > maxBytes) throw new PublicFetchError('response_too_large');
          chunks.push(bytes);
        }
        if (!response.complete) throw new PublicFetchError('truncated_response');
        return { mediaType, contentType, bytes: Buffer.concat(chunks) };
      } catch (error) {
        if (error instanceof PublicFetchError) throw error;
        if (response.aborted && !response.complete) throw new PublicFetchError('truncated_response');
        throw error;
      } finally {
        decoded.destroy();
      }
    } finally {
      signal.removeEventListener('abort', abort);
      response?.destroy();
      request?.destroy();
    }
  }
}
