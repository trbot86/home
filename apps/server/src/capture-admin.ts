import { Type } from '@sinclair/typebox';
import { isValid } from '@our-place/contracts';
import { provisionCaptureCredential } from './features/access/provision-capture.js';

const schema = Type.Object(
  {
    expectedInstallationId: Type.String({ minLength: 1, maxLength: 200 }),
    expectedServerEpoch: Type.String({ minLength: 1, maxLength: 200 }),
    username: Type.String({ minLength: 1, maxLength: 80 }),
    password: Type.String({ minLength: 12, maxLength: 256 }),
    displayName: Type.String({ minLength: 1, maxLength: 80 }),
    expiresAt: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

async function main() {
  if (process.env['CAPTURE_PROVISION_ENABLED'] !== '1') throw new Error();
  const dataRoot = process.env['DATA_ROOT'],
    outputFile = process.env['CAPTURE_CREDENTIAL_OUTPUT'];
  if (!dataRoot || !outputFile) throw new Error();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8192) throw new Error();
    chunks.push(bytes);
  }
  const config: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isValid(schema, config)) throw new Error();
  await provisionCaptureCredential({ dataRoot, outputFile, ...config });
  process.stdout.write('Capture credential created in the private output file.\n');
}
void main().catch(() => {
  // No credentials, account names, paths, or dependency exceptions in logs.
  process.stderr.write(
    'Capture provisioning failed. Check the private input, household state and output file.\n',
  );
  process.exitCode = 1;
});
