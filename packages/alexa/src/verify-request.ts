import { verify } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { rootCertificates } from 'node:tls';
import forge from 'node-forge';
import { fetchBoundedText } from './bounded-fetch.js';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Only Amazon's documented certificate origin, with no redirect or credential forwarding. */
export function certificateUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid certificate URL');
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 's3.amazonaws.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith('/echo.api/')
  )
    throw new Error('Invalid certificate URL');
  return url.href;
}

/**
 * Implements Amazon's HTTPS verification requirements with standard crypto and PKI libraries.
 * Dependencies are injectable for isolated tests; production never loads roots/clock from config.
 * Certificate downloads and the cache are bounded; every use revalidates the chain's dates.
 */
export function createRequestVerifier(
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    trustRoots?: readonly string[];
  } = {},
) {
  const now = options.now ?? Date.now;
  const roots = forge.pki.createCaStore();
  for (const pem of options.trustRoots ?? rootCertificates) {
    // Like Amazon's Node SDK, forge supports RSA roots; unsupported roots grant no trust.
    try {
      roots.addCertificate(pem);
    } catch {
      /* unsupported root */
    }
  }
  const cache = new Map<string, { pem: string; expires: number }>();
  const pending = new Map<string, Promise<string>>();
  const download = async (url: string): Promise<string> => {
    const cached = cache.get(url);
    if (cached && cached.expires > now()) return cached.pem;
    cache.delete(url);
    const current = pending.get(url);
    if (current) return current;
    if (pending.size >= 8) throw new Error('Verification busy');
    const task = fetchBoundedText(url, {
      timeoutMs: 2000,
      maxBytes: 32 * 1024,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    pending.set(url, task);
    try {
      return await task;
    } finally {
      pending.delete(url);
    }
  };

  return async (body: Buffer, headers: IncomingHttpHeaders): Promise<unknown> => {
    try {
      if (body.length > 64 * 1024) throw new Error();
      const signature = headers['signature-256'];
      if (
        typeof signature !== 'string' ||
        signature.length > 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
        signature.length % 4 !== 0
      )
        throw new Error();
      const url = certificateUrl(headers['signaturecertchainurl']);
      const event: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      const timestamp = object(object(event)?.request)?.timestamp;
      const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      if (!Number.isSafeInteger(time) || time < 0 || Math.abs(now() - time) > 150_000) throw new Error();
      const pem = await download(url);
      const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
      const blocks = pem.match(pattern);
      if (!blocks || blocks.length > 6 || pem.replace(pattern, '').trim()) throw new Error();
      const chain = blocks.map((block) => forge.pki.certificateFromPem(block));
      const leaf = chain[0]!;
      const san = leaf.getExtension('subjectAltName') as {
        altNames?: { type: number; value: string }[];
      } | null;
      if (!san?.altNames?.some((name) => name.type === 2 && name.value === 'echo-api.amazon.com'))
        throw new Error();
      if (!forge.pki.verifyCertificateChain(roots, chain, { validityCheckDate: new Date(now()) }))
        throw new Error();
      // Verify the exact received bytes, never reserialized JSON. SHA-1 signatures are not accepted.
      if (!verify('RSA-SHA256', body, blocks[0]!, Buffer.from(signature, 'base64'))) throw new Error();
      if (Math.abs(now() - time) > 150_000) throw new Error();
      if (cache.size >= 16 && !cache.has(url)) cache.delete(cache.keys().next().value!);
      cache.set(url, {
        pem,
        expires: Math.min(now() + 300_000, ...chain.map((cert) => +cert.validity.notAfter)),
      });
      return event;
    } catch {
      // Do not propagate certificate URLs, note text or attacker-controlled parser messages.
      throw new Error('Alexa request verification failed');
    }
  };
}
