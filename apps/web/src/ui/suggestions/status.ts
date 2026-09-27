import type { SuggestionSnapshot } from '@our-place/contracts';
export function suggestionStatus(snapshot: SuggestionSnapshot, id: string): string {
  const work = snapshot.work.filter((w) => w.suggestionId === id);
  if (work.some((w) => w.state === 'uncertain')) return 'Connection interrupted';
  if (work.some((w) => w.state === 'running')) return 'Working';
  if (work.some((w) => w.state === 'queued')) return 'Queued';
  if (work[0]?.state === 'failed') return 'Needs attention';
  const status = snapshot.workflows.find((w) => w.suggestionId === id)?.status ?? 'new';
  return {
    new: 'New',
    queued: 'Queued',
    working: 'Working',
    needs_input: 'Needs your input',
    ready: 'Ready for review',
    released: 'Released',
  }[status];
}
