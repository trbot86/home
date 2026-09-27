import { resolve, join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { isValid } from '@our-place/contracts';
import { openDatabase, migrate, installation } from './infrastructure/database.js';
import { provisionHousehold } from './features/access/access.js';

const schema = Type.Object(
  {
    people: Type.Array(
      Type.Object(
        {
          username: Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-z0-9_-]+$' }),
          displayName: Type.String({ minLength: 1, maxLength: 80 }),
          password: Type.String({ minLength: 12, maxLength: 256 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: 2 },
    ),
  },
  { additionalProperties: false },
);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8192) throw new Error('Bootstrap input too large');
}
const config: unknown = JSON.parse(input);
if (!isValid(schema, config))
  throw new Error(
    'Provide JSON on stdin with exactly two people: username, displayName, password (12+ characters)',
  );
if (new Set(config.people.map((p) => p.username)).size !== 2) throw new Error('Usernames must be distinct');
const db = openDatabase(
  join(resolve(process.env['DATA_ROOT'] ?? '../../.local/data'), 'db/household.sqlite'),
);
try {
  migrate(db);
  await provisionHousehold(db, config.people);
  process.stdout.write('Created household and two accounts. Credentials were not logged.\n');
  process.stdout.write(`EXPECTED_INSTALLATION_ID=${installation(db).installation_id}\n`);
} finally {
  db.close();
}
