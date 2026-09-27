import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const staged = process.argv.includes('--staged');
const paths = [...new Set(execFileSync('git', staged ? ['ls-files', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  .toString().split('\0').filter(Boolean))];
const errors = [];
const report = (path, rule) => errors.push(`${path}: ${rule}`);
const forbiddenPath = /(?:^|\/)(?:\.local|\.cache|\.tools|\.gradle|node_modules|build|dist|test-results|playwright-report|backup|backups)(?:\/|$)|\.(?:sqlite(?:3)?(?:-wal|-shm)?|db(?:3)?|apk|aab|apks|dump|backup|bak|tar|gz|zip|pem|key|p12|pfx|jks|keystore)$/i;
const blockedNames = /(?:^|\/)(?:accounts|credentials|secrets)\.json$|(?:^|\/)\.env(?:\..+)?$|local\.properties$|\.local\.(?:json|md)$/i;
const textRules = [
  ['private tailnet address', /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i],
  // Unix homes must begin at an absolute-path boundary, not inside a relative feature import.
  ['local user home path', /(?:[a-z]:[\\/]Users[\\/]|(?<![a-z0-9_.-])\/(?:home|Users)\/)[a-z0-9_.-]+/i],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['credential token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b/],
  ['credential embedded in URL', /https?:\/\/[^\s/]+:[^\s/@]+@/],
];
// Only known local runtime values are used; their contents are never printed.
const privateValues = [];
try {
  const config = JSON.parse(readFileSync('.local/phone-trial/host.json', 'utf8'));
  for (const key of ['origin', 'hostname', 'installationId', 'serverEpoch']) if (typeof config[key] === 'string' && config[key].length > 8) privateValues.push(config[key]);
  if (config.origin) privateValues.push(new URL(config.origin).hostname);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  const accounts = JSON.parse(readFileSync('.local/phone-trial/accounts.json', 'utf8'));
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/password|secret|token|credential/i.test(key) && typeof item === 'string' && item.length >= 8) privateValues.push(item);
      else visit(item);
    }
  }; visit(accounts);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const path of paths) {
  if (forbiddenPath.test(path) || (blockedNames.test(path) && !path.endsWith('.env.example'))) report(path, 'runtime, credential or export file');
  let bytes;
  try { bytes = staged ? execFileSync('git', ['show', `:${path}`], { maxBuffer: 4 * 1024 * 1024 }) : readFileSync(path); }
  catch { report(path, 'cannot inspect candidate bytes'); continue; }
  if (bytes.subarray(0, 16).toString() === 'SQLite format 3\0') report(path, 'SQLite database content');
  if (bytes.length > 2 * 1024 * 1024) report(path, 'unexpected large file');
  const binaryAllowed = path === 'apps/android/gradle/wrapper/gradle-wrapper.jar' || /^apps\/android\/app\/src\/main\/res\/[^/]+\/[^/]+\.png$/.test(path);
  if (path === 'apps/android/gradle/wrapper/gradle-wrapper.jar' && createHash('sha256').update(bytes).digest('hex') !== '7d3a4ac4de1c32b59bc6a4eb8ecb8e612ccd0cf1ae1e99f66902da64df296172') report(path, 'Gradle wrapper differs from verified official checksum');
  if (bytes.includes(0)) { if (!binaryAllowed) report(path, 'unreviewed binary'); continue; }
  const content = bytes.toString('utf8');
  for (const [rule, pattern] of textRules) if (pattern.test(content)) report(path, rule);
  if (privateValues.some(value => content.includes(value))) report(path, 'local deployment value or credential');
  // Exact reviewed IANA special-use ranges are public policy constants, never live addresses.
  // Any change to this one file loses the exception until its full contents are reviewed again.
  const standardNetworkPolicy = path === 'ops/alexa-network/non-public-v4.txt' &&
    createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex') ===
      '1ec11c882cb0b27b6f9122a92438c1609840b186a23687317888a31aaa6b2f31';
  for (const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const ip = match[0], parts = ip.split('.').map(Number);
    if (standardNetworkPolicy || parts.some(n => n > 255) || ip === '10.0.2.2') continue; // Standard network constants, never household addresses.
    if (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || (parts[0] === 169 && parts[1] === 254)) report(path, 'private network address');
  }
}
if (errors.length) { console.error([...new Set(errors)].join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${paths.length} ${staged ? 'indexed' : 'candidate'} source files contain no detected private deployment values, credentials or runtime data.`);
