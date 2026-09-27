import { open } from 'node:fs/promises';
import { parseReceiverConfig } from './config.js';
import { createSocketCaptureSink } from './capture-socket.js';
import { buildAlexaReceiver } from './receiver.js';

async function start() {
  if (process.env['ALEXA_ENABLED'] !== '1') throw new Error();
  const filename = process.env['ALEXA_CONFIG_FILE'];
  const port = Number(process.env['ALEXA_PORT']);
  if (!filename || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  const file = await open(filename, 'r');
  const buffer = Buffer.alloc(16 * 1024 + 1);
  let size: number;
  try {
    ({ bytesRead: size } = await file.read(buffer, 0, buffer.length, 0));
  } finally {
    await file.close();
  }
  if (size > 16 * 1024) throw new Error();
  const config = parseReceiverConfig(JSON.parse(buffer.subarray(0, size).toString('utf8')));
  const bindingId = 'household-capture';
  const app = await buildAlexaReceiver({
    skillId: config.skillId,
    users: new Map(
      config.alexaUserIds.map((id) => [id, { bindingId, expectedServerEpoch: config.expectedServerEpoch }]),
    ),
    capture: createSocketCaptureSink({
      socketPath: config.captureSocketPath,
      token: config.captureToken,
      bindingId,
    }),
  });
  await app.listen({ host: process.env['ALEXA_HOST'] ?? '127.0.0.1', port });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.close();
    });
}
void start().catch(() => {
  // Never print config values, paths, request bodies or dependency exceptions.
  process.stderr.write('Alexa receiver could not start. Check its private configuration and listener.\n');
  process.exitCode = 1;
});
