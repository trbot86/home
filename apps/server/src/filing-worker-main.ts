import { runFilingCodex } from './infrastructure/filing-codex-runner.js';

// One request per process. A host-owned launcher enters an isolated worker and
// runs this entry point, forwarding stdin/stdout and termination. Never run it
// under the household server or desktop account as a substitute for isolation.
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => controller.abort());
try {
  const timer = setTimeout(() => {
    controller.abort();
    process.stdin.destroy();
  }, 25_000);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 2 * 1024 * 1024) throw new Error();
      chunks.push(bytes);
    }
    const result = await runFilingCodex(JSON.parse(Buffer.concat(chunks).toString('utf8')), {
      executable: process.env['FILING_CODEX_EXECUTABLE'] ?? '',
      home: process.env['FILING_CODEX_HOME'] ?? '',
      temporaryRoot: process.env['FILING_WORKER_TEMP'] ?? '',
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(result));
  } finally {
    clearTimeout(timer);
  }
} catch {
  // Never expose model output, prompt text, credentials, paths or subprocess errors.
  process.stderr.write('Filing worker failed\n');
  process.exitCode = 1;
}
