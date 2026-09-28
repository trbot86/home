import { useRef, useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import { suggestionCompleted } from './status.js';

export function SuggestionCompletionButton({
  client,
  state,
  id,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  id: string;
  onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const completed = suggestionCompleted(state.suggestions, id);
  const workflow = state.suggestions.workflows.find((w) => w.suggestionId === id);
  const working = state.suggestions.work.some(
    (w) => w.suggestionId === id && ['queued', 'running', 'uncertain'].includes(w.state),
  );
  const releasing = state.suggestions.releases?.some(
    (r) =>
      r.suggestionId === id &&
      ['queued', 'preparing', 'prepared', 'deploy_queued', 'deploying', 'uncertain'].includes(r.state),
  );
  async function toggle() {
    if (lock.current || !state.session) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await client.command(
        'suggestion-completion-' + id,
        'SetSuggestionCompleted',
        {
          suggestionId: id,
          expectedRevision: workflow?.revision ?? 0,
          completed: !completed,
        },
        state.session.serverEpoch,
      );
      await client.refresh();
      if (result.status === 'Rejected')
        throw new Error(
          result.code === 'suggestion_changed'
            ? 'This suggestion changed. Review the update and try again.'
            : result.code.replaceAll('_', ' '),
        );
      if (result.status !== 'Applied')
        throw new Error('Waiting for confirmation. Refresh to check this suggestion.');
    } catch (error) {
      onError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <button
      disabled={
        busy ||
        !state.online ||
        state.pendingEdits.includes('suggestion-completion-' + id) ||
        (!completed && (working || releasing))
      }
      title={
        !completed && (working || releasing)
          ? 'Finish or cancel the current work before completing this suggestion.'
          : undefined
      }
      onClick={() => void toggle()}
    >
      {completed ? 'Reopen' : 'Mark completed'}
    </button>
  );
}
