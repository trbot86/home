import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suggestionFixture } from './suggestion-fixture.js';
import {
  provisionSuggestionAgent,
  authenticateSuggestionAgent,
} from '../src/features/suggestions/agent-access.js';
import type { SuggestionReleaseManifest, SuggestionReleaseUpdate } from '@our-place/contracts';
const manifest: SuggestionReleaseManifest = {
  baseCommit: 'a'.repeat(40),
  sourceCommit: 'b'.repeat(40),
  candidateCommit: 'c'.repeat(40),
  imageId: 'sha256:' + 'd'.repeat(64),
  previousImageId: 'sha256:' + 'e'.repeat(64),
  apkSha256: 'f'.repeat(64),
  checks: ['Isolated test build passed'],
  preparedAt: 1000,
};
test('release approval pins the tested manifest, serializes releases, survives replay and fences restores', async () => {
  const f = await suggestionFixture();
  try {
    const agent = authenticateSuggestionAgent(
      f.db,
      provisionSuggestionAgent(f.db, 'Release test agent', f.now()).secret,
    );
    const work = f.service.suggestionWork,
      releases = f.service.suggestionRelease;
    const id = f.suggestion();
    assert.equal(
      f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id }).status,
      'Applied',
    );
    const run = work.claim(agent, randomUUID(), 'fixture-epoch').run!;
    const args = { releaseId: randomUUID(), suggestionId: id, runId: run.runId };
    assert.equal(f.run('PrepareSuggestionRelease', args).status, 'Rejected');
    work.report(agent, run.leaseToken, {
      reportId: randomUUID(),
      expectedServerEpoch: 'fixture-epoch',
      runId: run.runId,
      status: 'ready',
      summary: 'Implemented and tested.',
      messages: [],
      resolvedQuestionIds: [],
    });
    const request = f.envelope(args);
    assert.equal(f.service.writes.execute(f.a, 'PrepareSuggestionRelease', request).status, 'Applied');
    assert.equal(f.service.writes.execute(f.a, 'PrepareSuggestionRelease', request).status, 'Applied');
    assert.equal(f.run('PrepareSuggestionRelease', { ...args, releaseId: randomUUID() }).status, 'Rejected');
    assert.equal(
      f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id }).status,
      'Rejected',
    );
    assert.equal(f.run('PostSuggestionMessage', f.reply(id)).status, 'Applied', 'notes remain available');
    let job = releases.pending(agent, 'fixture-epoch')!;
    const update = (value: Partial<SuggestionReleaseUpdate>) =>
      releases.update(agent, {
        releaseId: job.releaseId,
        expectedServerEpoch: 'fixture-epoch',
        expectedRevision: job.revision,
        state: 'preparing',
        summary: 'Checking candidate',
        ...value,
      });
    const starting = update({});
    assert.deepEqual(update({}), starting, 'lost response replays transition');
    job = starting;
    assert.throws(() => update({ state: 'released' }), 'cannot skip preparation/approval');
    assert.throws(() => update({ state: 'prepared' }), 'manifest required');
    job = update({ state: 'prepared', summary: 'Ready to deploy', manifest });
    assert.equal(
      f.run('DeploySuggestionRelease', { releaseId: job.releaseId, manifestDigest: '0'.repeat(64) }).status,
      'Rejected',
    );
    const approval = f.envelope({ releaseId: job.releaseId, manifestDigest: job.manifestDigest });
    assert.equal(f.service.writes.execute(f.b, 'DeploySuggestionRelease', approval).status, 'Applied');
    assert.equal(f.service.writes.execute(f.b, 'DeploySuggestionRelease', approval).status, 'Applied');
    job = releases.pending(agent, 'fixture-epoch')!;
    assert.equal(job.state, 'deploy_queued');
    assert.throws(() =>
      update({ state: 'deploying', manifest: { ...manifest, sourceCommit: 'd'.repeat(40) } }),
    );
    job = update({ state: 'deploying' });
    assert.equal(f.run('CancelSuggestionRelease', { releaseId: job.releaseId }).status, 'Rejected');
    const other = authenticateSuggestionAgent(
      f.db,
      provisionSuggestionAgent(f.db, 'Other agent', f.now()).secret,
    );
    assert.equal(releases.pending(other, 'fixture-epoch'), null);
    assert.throws(() =>
      releases.update(other, {
        releaseId: job.releaseId,
        expectedServerEpoch: 'fixture-epoch',
        expectedRevision: job.revision,
        state: 'released',
        summary: 'Wrong agent',
      }),
    );
    assert.throws(() => update({ state: 'released', expectedServerEpoch: 'restored-epoch' }));
    job = update({ state: 'released', summary: 'Deployed and verified' });
    assert.equal(releases.pending(agent, 'fixture-epoch'), null);
    assert.equal(f.features.suggestions.snapshot(f.b).releases![0]!.state, 'released');
    assert.equal(f.features.suggestions.snapshot(f.b).activity![0]!.unread, true);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});
test('private release details are scoped and an interrupted deployment blocks automatic replacement', async () => {
  const f = await suggestionFixture();
  try {
    const agent = authenticateSuggestionAgent(
      f.db,
      provisionSuggestionAgent(f.db, 'Release test agent', f.now()).secret,
    );
    const id = f.suggestion(f.privateScope),
      work = f.service.suggestionWork,
      releases = f.service.suggestionRelease;
    f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id });
    const run = work.claim(agent, randomUUID(), 'fixture-epoch').run!;
    work.report(agent, run.leaseToken, {
      reportId: randomUUID(),
      expectedServerEpoch: 'fixture-epoch',
      runId: run.runId,
      status: 'ready',
      summary: 'Ready',
      messages: [],
      resolvedQuestionIds: [],
    });
    const args = { releaseId: randomUUID(), suggestionId: id, runId: run.runId };
    assert.throws(() => f.run('PrepareSuggestionRelease', args, f.b));
    assert.equal(f.run('PrepareSuggestionRelease', args).status, 'Applied');
    assert.equal(f.features.suggestions.snapshot(f.b).releases!.length, 0);
    let job = releases.pending(agent, 'fixture-epoch')!;
    job = releases.update(agent, {
      releaseId: job.releaseId,
      expectedServerEpoch: 'fixture-epoch',
      expectedRevision: job.revision,
      state: 'preparing',
      summary: 'Preparing',
    });
    job = releases.update(agent, {
      releaseId: job.releaseId,
      expectedServerEpoch: 'fixture-epoch',
      expectedRevision: job.revision,
      state: 'uncertain',
      summary: 'Host interrupted',
    });
    assert.equal(f.run('CancelSuggestionRelease', { releaseId: job.releaseId }).status, 'Rejected');
    assert.equal(f.run('PrepareSuggestionRelease', { ...args, releaseId: randomUUID() }).status, 'Rejected');
  } finally {
    await f.close();
  }
});
