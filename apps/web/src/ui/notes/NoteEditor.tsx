import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { Note } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';

export function NoteEditor({
  client,
  state,
  note,
  run,
  close,
  saved,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  note?: Note | undefined;
  run: RunRecordCommand;
  close: () => void;
  saved: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!;
  const buffer = useSavedForm(
    client,
    note?.recordId ?? 'notes:new',
    () => ({
      recordId: note?.recordId ?? crypto.randomUUID(),
      scopeId: note?.scopeId ?? session.scopes.find((s) => s.kind === 'private')!.scopeId,
      title: note?.title ?? '',
      body: note?.body ?? '',
      category: note?.category ?? '',
    }),
    note?.revision ?? 0,
    session.serverEpoch,
    onError,
  );
  const form = buffer.values;
  const [busy, setBusy] = useState(false);
  const lock = useRef(false),
    finished = useRef(false);
  const pending = state.pendingEdits.includes(form.recordId);
  const stale = (note && note.revision !== buffer.baseRevision) || buffer.epoch !== session.serverEpoch;
  async function finish() {
    if (finished.current) return;
    finished.current = true;
    try {
      await buffer.clear();
      saved(form.recordId);
      close();
    } catch (error) {
      finished.current = false;
      onError(error);
    }
  }
  useEffect(() => {
    if (!note && buffer.ready && (state.notes ?? []).some((n) => n.recordId === form.recordId)) void finish();
  }, [note, buffer.ready, state.notes, form.recordId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !buffer.ready || pending || stale || !state.online || !form.title.trim()) return;
    lock.current = true;
    setBusy(true);
    try {
      await buffer.save();
      const fields = { title: form.title.trim(), body: form.body, category: form.category.trim() };
      const result = await run(
        { recordId: form.recordId },
        note ? 'UpdateNote' : 'CreateNote',
        note
          ? { recordId: note.recordId, expectedRevision: buffer.baseRevision, ...fields }
          : { recordId: form.recordId, scopeId: form.scopeId, ...fields },
        note ? 'Thought updated' : 'Thought saved',
        buffer.epoch,
      );
      if (result?.status === 'Applied') await finish();
    } catch (error) {
      onError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const categories = [
    ...new Set(
      (state.notes ?? [])
        .filter((n) => !n.deletedAt && n.scopeId === form.scopeId)
        .map((n) => n.category)
        .filter(Boolean),
    ),
  ].sort();
  return (
    <RecordDialog
      client={client}
      title={note ? 'Edit thought' : 'New thought'}
      subtitle=""
      close={close}
      className="task-dialog"
    >
      <form
        className="task-form"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
      >
        <fieldset
          disabled={
            !buffer.ready ||
            busy ||
            pending ||
            !!stale ||
            (note?.deletedAt !== undefined && note.deletedAt !== null)
          }
        >
          <label>
            Title
            <input
              autoFocus
              value={form.title}
              maxLength={300}
              required
              onChange={(e) => buffer.field('title', e.target.value)}
            />
          </label>
          <label>
            Note
            <textarea
              aria-label="Note"
              value={form.body}
              rows={9}
              maxLength={20000}
              onChange={(e) => buffer.field('body', e.target.value)}
            />
          </label>
          <label>
            Category
            <input
              list="thought-categories"
              placeholder="Optional"
              value={form.category}
              maxLength={120}
              onChange={(e) => buffer.field('category', e.target.value)}
            />
          </label>
          <datalist id="thought-categories">
            {categories.map((category) => (
              <option key={category} value={category} />
            ))}
          </datalist>
          {!note && (
            <label>
              Who can see this
              <select
                aria-label="Who can see this"
                value={form.scopeId}
                onChange={(e) => buffer.field('scopeId', e.target.value)}
              >
                {session.scopes.map((s) => (
                  <option key={s.scopeId} value={s.scopeId}>
                    {s.kind === 'shared' ? 'Shared' : 'Just me'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {stale && (
          <p className="notice">
            This thought changed. Your unfinished text is kept. Copy anything you need, then{' '}
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText([form.title, form.body, form.category].join('\n\n'))
                  .catch(onError)
              }
            >
              Copy draft
            </button>{' '}
            <button type="button" onClick={() => void buffer.reset().catch(onError)}>
              Load latest version
            </button>
          </p>
        )}
        {!state.online && (
          <p className="notice">Reconnect to save. Your unfinished text stays on this device.</p>
        )}
        <div className="dialog-footer">
          <button type="button" onClick={close}>
            Close
          </button>
          <button
            className="primary"
            disabled={!buffer.ready || busy || pending || !!stale || !state.online || !form.title.trim()}
          >
            {busy ? 'Saving…' : 'Save thought'}
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
