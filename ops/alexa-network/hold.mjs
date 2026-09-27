import { readFileSync } from 'node:fs';
const status = readFileSync('/proc/self/status', 'utf8');
if (process.getuid() !== 1000 || !/^CapEff:\s+0+$/m.test(status) || !/^CapBnd:\s+0+$/m.test(status))
  throw new Error('Namespace holder must have no capabilities');
setInterval(() => {}, 60_000);
process.on('SIGTERM', () => process.exit(0));
