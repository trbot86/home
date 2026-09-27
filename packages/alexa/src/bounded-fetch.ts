/** An overall deadline includes both response headers and body consumption. */
export async function fetchBoundedText(
  url: string,
  options: { timeoutMs: number; maxBytes: number; fetch?: typeof fetch },
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await (options.fetch ?? fetch)(url, {
          redirect: 'error',
          signal: controller.signal,
          headers: { accept: 'application/x-pem-file, text/plain' },
        });
        if (response.status !== 200 || !response.body) throw new Error('Fetch failed');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > options.maxBytes) {
            void reader.cancel().catch(() => {});
            throw new Error('Response too large');
          }
          chunks.push(value);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Fetch timed out'));
        }, options.timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
