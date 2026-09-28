import type { SuggestionSnapshot } from '@our-place/contracts';
export function suggestionCompleted(snapshot: SuggestionSnapshot, id: string): boolean {
  return snapshot.workflows.some(
    (w) => w.suggestionId === id && w.deletedAt === null && w.completedAt != null,
  );
}
export function suggestionStatus(snapshot: SuggestionSnapshot, id: string): string {
  if (suggestionCompleted(snapshot, id)) return 'Completed';
  const latest = snapshot.work.find((w) => w.suggestionId === id);
  const release = snapshot.releases?.find((r) => r.suggestionId === id && r.runId === latest?.runId);
  if (release && !['cancelled'].includes(release.state))
    return {
      queued: 'Preparing release',
      preparing: 'Preparing release',
      prepared: 'Ready to deploy',
      deploy_queued: 'Deployment queued',
      deploying: 'Deploying',
      released: 'Released',
      failed: 'Release needs attention',
      cancelled: 'Ready for review',
      uncertain: 'Release needs attention',
    }[release.state];
  const work = snapshot.work.filter((w) => w.suggestionId === id);
  if (work.some((w) => w.state === 'uncertain')) return 'Connection interrupted';
  if (work.some((w) => w.state === 'running')) return 'Working';
  if (work.some((w) => w.state === 'queued')) return 'Queued';
  if (work[0]?.state === 'failed') return 'Needs attention';
  const status = snapshot.workflows.find((w) => w.suggestionId === id)?.status ?? 'new';
  if (
    status === 'needs_input' &&
    !snapshot.questions.some((q) => q.suggestionId === id && q.state !== 'resolved')
  )
    return 'Ready to continue';
  return {
    new: 'New',
    queued: 'Queued',
    working: 'Working',
    needs_input: 'Needs your input',
    ready: 'Ready for review',
    released: 'Released',
  }[status];
}
