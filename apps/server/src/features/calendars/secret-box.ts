import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Keys are supplied by host configuration, never generated on missing/decryption-failed reads. */
export class CalendarSecretBox {
  private readonly keys: Map<string, Buffer>;
  constructor(
    private readonly currentKeyId: string,
    keys: ReadonlyMap<string, Uint8Array>,
  ) {
    this.keys = new Map(
      [...keys].map(([id, key]) => {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || key.byteLength !== 32)
          throw new Error('Invalid calendar key configuration');
        return [id, Buffer.from(key)];
      }),
    );
    if (!this.keys.has(currentKeyId)) throw new Error('Missing current calendar key');
  }
  seal(value: unknown, associatedData: string): string {
    const plaintext = JSON.stringify(value);
    if (Buffer.byteLength(plaintext) > 65536) throw new Error('Calendar secret payload too large');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentKeyId)!, nonce);
    cipher.setAAD(Buffer.from(associatedData));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return JSON.stringify({
      version: 1,
      keyId: this.currentKeyId,
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    });
  }
  open(sealed: string, associatedData: string): unknown {
    try {
      if (sealed.length > 131072) throw new Error();
      const envelope = JSON.parse(sealed) as Record<string, unknown>,
        key = this.keys.get(String(envelope.keyId));
      const decode = (field: string) => {
        const text = envelope[field];
        if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
        const bytes = Buffer.from(text, 'base64url');
        if (bytes.toString('base64url') !== text) throw new Error();
        return bytes;
      };
      const nonce = decode('nonce'),
        tag = decode('tag'),
        ciphertext = decode('ciphertext');
      if (
        envelope.version !== 1 ||
        !key ||
        nonce.length !== 12 ||
        tag.length !== 16 ||
        ciphertext.length > 65536
      )
        throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(associatedData));
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    } catch {
      throw new Error('Calendar secret unavailable');
    }
  }
}
