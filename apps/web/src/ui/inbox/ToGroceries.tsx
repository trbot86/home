import { useRef, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { InboxEntry, ShoppingList } from '@our-place/contracts';

/** A manual destination shortcut, independent of AI suggestions or consent. */
export function ToGroceries({
  client,
  state,
  entry,
  run,
  reviewDraft,
}: {
  client: ClientPlatform;
  state: ClientState;
  entry: InboxEntry;
  run: RunRecordCommand;
  reviewDraft: () => void;
}) {
  const [picker, setPicker] = useState(false),
    [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState(''),
    [draft, setDraft] = useState(false);
  const lock = useRef(false);
  const shared = state.session!.scopes.find((s) => s.kind === 'shared')!.scopeId;
  const lists = state.shopping.lists.filter(
    (l) => l.scopeId === shared && l.purpose === 'groceries' && l.deletedAt === null,
  );
  const disabled = !state.online || state.pendingEdits.includes(entry.inboxId) || busy;
  async function file(list: ShoppingList) {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setIssue('');
    setDraft(false);
    try {
      if (await client.readEditor(`inbox:filing:${entry.inboxId}`)) {
        setDraft(true);
        setIssue('Your unfinished filing draft is kept. Review it before filing.');
        return;
      }
      if (entry.text.length > 10000) {
        setIssue('This note is too long for a shopping item. Use To shopping to edit the item first.');
        return;
      }
      const security = await client.recordSecurity(entry.inboxId);
      if (entry.scopeId !== shared && security.effective) {
        setIssue('This Secure note stays private. Turn off Secure or use a private shopping list.');
        return;
      }
      const result = await run(
        { recordId: entry.inboxId },
        'FileInboxEntry',
        {
          inboxId: entry.inboxId,
          expectedRevision: entry.revision,
          destination: {
            kind: 'AddShoppingEntry',
            arguments: {
              recordId: crypto.randomUUID(),
              listId: list.recordId,
              groupId: null,
              label: entry.text.trim().split(/\r?\n/)[0]?.slice(0, 300) || 'Captured note',
              quantity: '',
              notes: entry.text,
            },
          },
          suggestedTarget: { recordId: list.recordId, expectedRevision: list.revision },
          ...(entry.scopeId !== shared ? { shareToGroceries: true } : {}),
        },
        'Added to groceries',
        state.session!.serverEpoch,
      );
      if (result?.status === 'Applied') setPicker(false);
    } catch {
      setIssue('Could not confirm grocery filing. Your note is kept; reconnect and refresh before retrying.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="grocery-shortcut">
      <button
        type="button"
        disabled={disabled || !lists.length}
        title={
          lists.length
            ? 'Add an item to shared groceries; the source note keeps its visibility'
            : 'Create a shared grocery list in Shopping first'
        }
        onClick={() => (lists.length === 1 ? void file(lists[0]!) : setPicker(!picker))}
      >
        {busy ? 'Adding…' : 'To groceries'}
      </button>
      {picker && (
        <div className="filing-advice-picker" role="group" aria-label="Choose grocery list">
          {lists.map((list) => (
            <button type="button" key={list.recordId} disabled={disabled} onClick={() => void file(list)}>
              {list.name} · Shared
            </button>
          ))}
          <button type="button" disabled={busy} onClick={() => setPicker(false)}>
            Cancel
          </button>
        </div>
      )}
      {issue && <p role="status">{issue}</p>}
      {draft && (
        <button type="button" onClick={reviewDraft}>
          Review filing draft
        </button>
      )}
    </div>
  );
}
