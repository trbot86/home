import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isValid, OutcomeSchema } from '../src/index.js';
test('shared Kotlin and TypeScript outcome fixtures agree', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/outcomes.json', import.meta.url), 'utf8')) as { name: string; valid: boolean; outcome: unknown }[];
  for (const fixture of fixtures) assert.equal(isValid(OutcomeSchema, fixture.outcome), fixture.valid, fixture.name);
});
