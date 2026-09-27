import { useEffect, useState } from 'react';
import { LinkedText } from '../LinkedText.js';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { HistoryEntry, ShoppingRecord } from '@our-place/contracts';
import { date } from '../format.js';
import { ShoppingDialog, shoppingLabel, type ShoppingRun } from './shared.js';
export function ShoppingHistory({
  client,
  state,
  record,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  record: ShoppingRecord;
  run: ShoppingRun;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const [history, setHistory] = useState<HistoryEntry<ShoppingRecord>[]>([]);
  useEffect(() => {
    let alive = true;
    if (state.online)
      void client
        .shoppingHistory(record.recordId)
        .then((value) => {
          if (alive) setHistory(value);
        })
        .catch(onError);
    return () => {
      alive = false;
    };
  }, [client, record.recordId, record.revision, state.online]);
  return (
    <ShoppingDialog client={client} title="Shopping history" close={close}>
      <div className="history-list">
        {!history.length && (
          <p className="fine">{state.online ? 'Loading history…' : 'Connect to read history.'}</p>
        )}
        {history.map((item) => (
          <article key={item.changeSetId}>
            <div className="history-dot" />
            <div>
              <div className="history-meta">
                <strong>{item.actor.displayName}</strong>
                <span>{date(item.recordedAt)}</span>
              </div>
              <p className="fine">
                {item.kind === 'PurchaseShoppingEntry'
                  ? 'Marked purchased'
                  : item.kind === 'UndoChangeSet'
                    ? 'Undid a change'
                    : item.kind === 'RedoChangeSet'
                      ? 'Redid a change'
                      : item.kind.startsWith('Delete')
                        ? 'Deleted'
                        : item.kind.startsWith('Restore')
                          ? 'Restored'
                          : item.kind.startsWith('Update')
                            ? 'Changed details'
                            : item.kind === 'MoveShoppingEntry'
                              ? 'Moved to another list'
                              : 'Added'}
              </p>
              <p className="historical-text">
                {shoppingLabel(item.version)}
                {'quantity' in item.version && item.version.quantity ? ` · ${item.version.quantity}` : ''}
              </p>
              {'notes' in item.version && item.version.notes && (
                <p className="historical-text fine">
                  <LinkedText client={client} text={item.version.notes} />
                </p>
              )}
              <div className="history-actions">
                <button
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(
                        [
                          shoppingLabel(item.version),
                          'quantity' in item.version ? item.version.quantity : '',
                          'notes' in item.version ? item.version.notes : '',
                        ]
                          .filter(Boolean)
                          .join('\n'),
                      )
                      .catch(onError);
                  }}
                >
                  Copy details
                </button>
                {(item.canUndo || item.canRedo) && (
                  <button
                    disabled={!state.online || state.pendingEdits.includes(record.recordId)}
                    onClick={() => {
                      void run(
                        record,
                        item.canRedo ? 'RedoChangeSet' : 'UndoChangeSet',
                        { changeSetId: item.changeSetId },
                        item.canRedo ? 'Change redone' : 'Change undone',
                      );
                    }}
                  >
                    {item.canRedo ? 'Redo' : 'Undo this change'}
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </ShoppingDialog>
  );
}
