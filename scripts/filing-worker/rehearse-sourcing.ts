// Explicit synthetic-only rehearsal. No household database or production provider configuration.
import assert from 'node:assert/strict';
import { resolve, isAbsolute } from 'node:path';
import { dockerJob } from './broker.mjs';
import { boundedInput, choiceKeys } from '../../apps/server/src/infrastructure/filing-codex-provider.js';
const docker = process.argv[2];
if (!docker || !isAbsolute(docker)) throw Error('Pass the absolute Docker executable path');
const input = boundedInput({
  purpose: 'ingredient_sources',
  instruction: '',
  text: JSON.stringify({ defaultStore: 'A typical Canadian supermarket', location: 'Canada' }),
  choices: ['All-purpose flour', 'Eggs', 'Food-grade sodium alginate for molecular gastronomy'].map(
    (label, i) => ({ key: String(i), label }),
  ),
});
const result = JSON.parse(
  await dockerJob(
    { docker, repository: resolve(import.meta.dirname, '../..') },
    Buffer.from(JSON.stringify({ version: 1, input, model: 'gpt-5.6-luna', effort: 'low' })),
    AbortSignal.timeout(40000),
  ),
);
const keys = choiceKeys(result, input);
assert(!keys.includes('0') && !keys.includes('1'), 'Ordinary groceries should stay with the default');
assert(keys.includes('2'), 'Expected the synthetic specialty ingredient to be flagged');
console.log(
  JSON.stringify({
    syntheticOnly: true,
    ordinaryIngredientsUseDefault: true,
    specialtyIngredientFlagged: true,
  }),
);
