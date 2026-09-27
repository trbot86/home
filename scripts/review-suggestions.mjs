import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const host = JSON.parse(await readFile('.local/phone-trial/host.json', 'utf8'));
if (resolve(host.workspace) !== resolve('.')) throw new Error('Run from the household workspace');
const base = host.origin;
const options = await (await fetch(`${base}/api/auth/options`)).json();
if (options.mode !== 'trusted-network')
  throw new Error('This helper requires the private household profile picker');
const response = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { origin: base, 'content-type': 'application/json' },
  body: JSON.stringify({ username: options.profiles[0].username, clientKind: 'browser' }),
});
if (!response.ok) throw new Error(`Profile selection failed: ${response.status}`);
const headers = { origin: base, cookie: response.headers.get('set-cookie').split(';')[0] };
try {
  const session = await response.json();
  if (session.installationId !== host.installationId) throw new Error('Household identity mismatch');
  const shared = session.scopes.find((scope) => scope.kind === 'shared').scopeId;
  const result = await fetch(`${base}/api/cache/inbox`, { headers });
  if (!result.ok) throw new Error(`Suggestions unavailable: ${result.status}`);
  const cache = await result.json();
  console.log(
    JSON.stringify(
      cache.entries
        .filter(
          (entry) => entry.scopeId === shared && !entry.deletedAt && entry.category === 'app_suggestion',
        )
        .map((entry) => ({
          ...entry,
          discussion: {
            workflow: cache.suggestions?.workflows.find((w) => w.suggestionId === entry.inboxId) ?? null,
            messages: cache.suggestions?.messages.filter((m) => m.suggestionId === entry.inboxId) ?? [],
            questions: cache.suggestions?.questions.filter((q) => q.suggestionId === entry.inboxId) ?? [],
            work: cache.suggestions?.work.filter((w) => w.suggestionId === entry.inboxId) ?? [],
          },
        })),
      null,
      2,
    ),
  );
} finally {
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers });
}
