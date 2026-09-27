import { MIMEType } from 'node:util';
import sniffHtmlEncoding from 'html-encoding-sniffer';
import { PublicFetchError, type PublicFetchResult } from './public-web.js';

/** Decode before parsing metadata; never silently replace malformed characters in ingredient amounts. */
export function decodePublicHtml(page: PublicFetchResult): { html: string; encoding: string } {
  if (!['text/html', 'application/xhtml+xml'].includes(page.mediaType))
    throw new PublicFetchError('unsupported_content_type');
  if (page.bytes.length > 2 * 1024 * 1024) throw new PublicFetchError('response_too_large');
  try {
    const charset = new MIMEType(page.contentType).params.get('charset');
    const xml = page.mediaType === 'application/xhtml+xml';
    // Version 6 handles HTML meta/BOM/transport declarations. XML declaration sniffing is not
    // in the published package, so supply its bounded declaration/signature as the fallback.
    const prefix = page.bytes.subarray(0, 512).toString('latin1');
    const xmlDeclaration = /^<\?xml\s[^?]*\bencoding\s*=\s*(["'])([A-Za-z][A-Za-z0-9._-]*)\1[^?]*\?>/.exec(
      prefix,
    )?.[2];
    const xmlSignature = page.bytes.subarray(0, 4).equals(Buffer.from([0, 60, 0, 63]))
      ? 'UTF-16BE'
      : page.bytes.subarray(0, 4).equals(Buffer.from([60, 0, 63, 0]))
        ? 'UTF-16LE'
        : undefined;
    const encoding = sniffHtmlEncoding(page.bytes, {
      xml,
      ...(charset ? { transportLayerEncodingLabel: charset } : {}),
      // Modern pages without a declaration generally use UTF-8. Invalid bytes fail rather than guessing.
      defaultEncoding: (xml ? (xmlSignature ?? xmlDeclaration) : undefined) ?? 'UTF-8',
    });
    const html = new TextDecoder(encoding, { fatal: true }).decode(page.bytes);
    return { html, encoding };
  } catch {
    throw new PublicFetchError('invalid_text_encoding');
  }
}
