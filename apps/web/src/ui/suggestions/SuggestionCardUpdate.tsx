import type { SuggestionSnapshot } from '@our-place/contracts';
import './suggestions.css';

export function suggestionUnread(snapshot: SuggestionSnapshot, id: string): boolean {
  return snapshot.activity?.find((a) => a.suggestionId === id)?.unread ?? false;
}
export function SuggestionCardUpdate({
  snapshot,
  id,
  open,
}: {
  snapshot: SuggestionSnapshot;
  id: string;
  open: () => void;
}) {
  const latestWork = snapshot.work.find((w) => w.suggestionId === id);
  const summary =
    snapshot.releases?.find((r) => r.suggestionId === id && r.runId === latestWork?.runId)?.summary ||
    (latestWork?.state === 'failed' ? latestWork.issue : null) ||
    snapshot.workflows.find((w) => w.suggestionId === id)?.summary;
  if (!summary) return null;
  const line = summary.replace(/\s+/g, ' ').trim();
  return (
    <button className="suggestion-card-update" title={line} onClick={open}>
      <span className="suggestion-card-update-label">Latest update</span>
      <span className="suggestion-card-update-text">{line}</span>
    </button>
  );
}
