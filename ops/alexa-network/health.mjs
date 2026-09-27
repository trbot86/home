import { readFileSync } from 'node:fs';
const status = readFileSync('/proc/1/status', 'utf8');
if (
  !/^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status) ||
  !/^CapEff:\s+0+$/m.test(status) ||
  !/^CapBnd:\s+0+$/m.test(status) ||
  JSON.parse(readFileSync('/run/guard/policy.json', 'utf8')).policy !== 'alexa-public-egress-v1'
)
  process.exit(1);
