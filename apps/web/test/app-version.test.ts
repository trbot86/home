import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAppUpdate, differentPublishedBuild } from '../src/ui/app-version.js';

const installed = { version: '1.0', sha256: 'a'.repeat(64) };
test('compares complete APK fingerprints even when the version name is unchanged', async () => {
  assert.equal(await checkAppUpdate(installed, async () => ({ sha256: 'b'.repeat(64) })), 'available');
  assert.equal(await checkAppUpdate(installed, async () => installed), 'current');
  assert.equal(differentPublishedBuild(installed, { sha256: 'a'.repeat(63) + 'b' }), true);
  assert.deepEqual(installed, { version: '1.0', sha256: 'a'.repeat(64) });
});
test('missing, invalid and failed checks cannot claim an update or that the app is current', async () => {
  for (const sha256 of ['', 'bad', 'A'.repeat(64), 'a'.repeat(65)]) {
    assert.equal(await checkAppUpdate(installed, async () => ({ sha256 })), 'unavailable');
  }
  assert.equal(
    await checkAppUpdate(installed, async () => {
      throw new Error('offline');
    }),
    'unavailable',
  );
});
