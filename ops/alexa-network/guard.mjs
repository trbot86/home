import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

// Run only in the dedicated rehearsal/ingress namespace, never with host networking.
if (process.env.ALEXA_NETWORK_GUARD !== 'isolated-namespace' || process.getuid() !== 0)
  throw new Error('Dedicated namespace setup is required');
const ranges = readFileSync('/guard/non-public-v4.txt', 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#'));
if (
  ranges.length !== 15 ||
  !ranges.every((range) => {
    const [ip, prefix] = range.split('/');
    return isIP(ip) === 4 && /^\d+$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= 32;
  })
)
  throw new Error('Invalid destination policy');
const v4 = [
  '*filter',
  ':INPUT DROP [0:0]',
  ':FORWARD DROP [0:0]',
  ':OUTPUT DROP [0:0]',
  '-A INPUT -i lo -j ACCEPT',
  '-A OUTPUT -o lo -j ACCEPT',
  ...ranges.map((range) => `-A OUTPUT -d ${range} -j REJECT`),
  '-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
  '-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
  '-A INPUT -p udp --dport 41641 -j ACCEPT',
  '-A OUTPUT -p tcp --dport 443 -j ACCEPT',
  // Public DNS and Tailscale's UDP transports. Private destinations were rejected above.
  '-A OUTPUT -p udp -j ACCEPT',
  '-A OUTPUT -p tcp --dport 53 -j ACCEPT',
  'COMMIT',
  '',
].join('\n');
const v6 = [
  '*filter',
  ':INPUT DROP [0:0]',
  ':FORWARD DROP [0:0]',
  ':OUTPUT DROP [0:0]',
  '-A INPUT -i lo -j ACCEPT',
  '-A OUTPUT -o lo -j ACCEPT',
  'COMMIT',
  '',
].join('\n');
execFileSync('iptables-restore', ['--wait', '5'], { input: v4 });
execFileSync('ip6tables-restore', ['--wait', '5'], { input: v6 });
const installed = execFileSync('iptables-save', ['-t', 'filter'], { encoding: 'utf8' });
const installed6 = execFileSync('ip6tables-save', ['-t', 'filter'], { encoding: 'utf8' });
for (const chain of ['INPUT', 'FORWARD', 'OUTPUT']) {
  if (!installed.includes(`:${chain} DROP`) || !installed6.includes(`:${chain} DROP`))
    throw new Error('Firewall installation failed');
}
for (const range of ranges)
  if (!installed.includes(`-d ${range} -j REJECT`)) throw new Error('Destination restriction missing');
writeFileSync(
  '/run/guard/policy.json',
  JSON.stringify({
    policy: 'alexa-public-egress-v1',
    ipv4Rules: ranges.length,
    ipv6: 'loopback-only',
    digest: createHash('sha256')
      .update(installed + installed6)
      .digest('hex'),
  }),
  { mode: 0o444 },
);
