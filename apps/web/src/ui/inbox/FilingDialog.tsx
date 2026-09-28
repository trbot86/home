import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { emptyRecipeFields, filingOf, type FilingDestination, type InboxEntry } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
import { recordReferences } from '../RecordReferences.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import './filing.css';

export type FilingMode = 'task' | 'project' | 'shopping' | 'recipe';

export function FilingDialog({
  client,
  state,
  entry,
  initialMode,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  entry: InboxEntry;
  initialMode: FilingMode;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!;
  const initial = () => ({
    mode: initialMode as string,
    recordId: crypto.randomUUID(),
    occurrenceId: crypto.randomUUID(),
    blockId: crypto.randomUUID(),
    sourceBlockId: crypto.randomUUID(),
    title: entry.text.trim().split(/\r?\n/)[0]?.slice(0, 300) || '',
    notes: entry.text,
    context: 'home',
    targetDate: '',
    quantity: '',
    listId: '',
    groupId: '',
    projectId: '',
    parentPageId: '',
    targetId: '',
    search: '',
  });
  const buffer = useSavedForm(
      client,
      `inbox:filing:${entry.inboxId}`,
      initial,
      entry.revision,
      session.serverEpoch,
      onError,
    ),
    form = buffer.values;
  const [busy, setBusy] = useState(false),
    lock = useRef(false),
    finished = useRef(false);
  const pending = state.pendingEdits.includes(entry.inboxId),
    stale = entry.revision !== buffer.baseRevision || session.serverEpoch !== buffer.epoch;
  const lists = state.shopping.lists.filter((l) => l.deletedAt === null && l.scopeId === entry.scopeId);
  const projects = state.projects.projects.filter(
    (p) => p.deletedAt === null && !p.archived && p.scopeId === entry.scopeId,
  );
  const shared = new Set(session.scopes.filter((s) => s.kind === 'shared').map((s) => s.scopeId));
  const available = recordReferences(state).filter(
    (r) =>
      r.recordId !== entry.inboxId &&
      r.deletedAt === null &&
      (r.scopeId === entry.scopeId || shared.has(r.scopeId)),
  );
  const candidates = available.filter((r) =>
    `${r.title} ${r.label}`.toLowerCase().includes(form.search.toLowerCase()),
  );
  const options = candidates.slice(0, 100);
  const selected = available.find((r) => r.recordId === form.targetId);
  if (selected && !options.some((r) => r.recordId === selected.recordId)) options.unshift(selected);
  const destinationId = form.mode === 'existing' ? form.targetId : form.recordId;
  const valid =
    form.mode === 'existing'
      ? !!selected
      : !!form.title.trim() &&
        (form.mode === 'task' ||
          form.mode === 'recipe' ||
          (form.mode === 'shopping'
            ? lists.some((l) => l.recordId === form.listId)
            : form.mode === 'project' && projects.some((p) => p.recordId === form.projectId)));
  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    try {
      await buffer.clear();
      close();
    } catch (error) {
      finished.current = false;
      onError(error);
    }
  };
  useEffect(() => {
    if (
      buffer.ready &&
      !pending &&
      entry.revision > buffer.baseRevision &&
      buffer.epoch === session.serverEpoch &&
      filingOf(entry).filedAt !== null &&
      filingOf(entry).destinations.some((d) => d.recordId === destinationId)
    )
      void finish();
  }, [buffer.ready, pending, entry, buffer.baseRevision, buffer.epoch, session.serverEpoch, destinationId]);
  function destination(): FilingDestination {
    if (form.mode === 'recipe')
      return {
        kind: 'CreateRecipe',
        arguments: {
          ...emptyRecipeFields(),
          recordId: form.recordId,
          scopeId: entry.scopeId,
          title: form.title.trim(),
          description: form.notes,
          collectionIds: [],
        },
      };
    if (form.mode === 'existing') return { kind: 'existing', recordId: form.targetId };
    if (form.mode === 'shopping')
      return {
        kind: 'AddShoppingEntry',
        arguments: {
          recordId: form.recordId,
          listId: form.listId,
          groupId: form.groupId || null,
          label: form.title.trim(),
          quantity: form.quantity,
          notes: form.notes,
        },
      };
    if (form.mode === 'project')
      return {
        kind: 'CreateProjectPage',
        arguments: {
          recordId: form.recordId,
          projectId: form.projectId,
          parentPageId: form.parentPageId || null,
          title: form.title.trim(),
          blocks: [
            ...(form.notes.trim()
              ? [{ blockId: form.blockId, kind: 'text' as const, text: form.notes }]
              : []),
            {
              blockId: form.sourceBlockId,
              kind: 'record_link',
              recordId: entry.inboxId,
              caption: 'Original capture and photos',
            },
          ],
        },
      };
    return {
      kind: 'CreateTask',
      arguments: {
        recordId: form.recordId,
        occurrenceId: form.occurrenceId,
        scopeId: entry.scopeId,
        title: form.title.trim(),
        instructions: form.notes,
        context: form.context as 'home' | 'work',
        defaultAssigneeId: null,
        defaultPriority: 1,
        recurrence: null,
        assigneeId: null,
        priority: 1,
        deadlineDate: null,
        targetDate: form.targetDate || null,
        reviewDate: null,
      },
    };
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      lock.current ||
      pending ||
      stale ||
      !buffer.ready ||
      !state.online ||
      !valid ||
      entry.deletedAt !== null ||
      ((form.mode === 'shopping' || form.mode === 'recipe') && form.notes.length > 10000)
    )
      return;
    lock.current = true;
    setBusy(true);
    try {
      await buffer.save();
      const outcome = await run(
        { recordId: entry.inboxId },
        'FileInboxEntry',
        { inboxId: entry.inboxId, expectedRevision: buffer.baseRevision, destination: destination() },
        'Note filed',
        buffer.epoch,
      );
      if (outcome?.status === 'Applied') await finish();
    } catch (error) {
      onError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <RecordDialog
      client={client}
      title="File this note"
      subtitle={shared.has(entry.scopeId) ? 'Shared with us' : 'Just me'}
      close={() => void buffer.flush().then(close).catch(onError)}
      className="filing-dialog"
    >
      <p>
        The original note and photos stay saved in Filed. New items keep the same visibility, with a link back
        to this capture.
      </p>
      <details>
        <summary>Original capture</summary>
        <p className="filing-original">{entry.text || 'Photo note'}</p>
        <AttachmentGallery client={client} attachments={entry.attachments} />
      </details>
      {pending && (
        <p role="status">
          Checking the previous filing.{' '}
          <button disabled={busy} onClick={() => void client.sync().catch(onError)}>
            Retry filing
          </button>
        </p>
      )}
      {stale && !pending && (
        <p role="status">
          This note changed since the filing draft began. Your draft is kept.{' '}
          <button onClick={() => void buffer.reset().catch(onError)}>
            Discard draft and load current note
          </button>
        </p>
      )}
      {!state.online && (
        <p role="status">Offline · your filing draft stays on this device. Reconnect to file.</p>
      )}
      <form
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
      >
        <fieldset disabled={!buffer.ready || busy || pending || entry.deletedAt !== null}>
          <label>
            Destination
            <select
              aria-label="Filing destination"
              value={form.mode}
              onChange={(e) => buffer.field('mode', e.target.value)}
            >
              <option value="task">New task</option>
              <option value="shopping">Shopping item</option>
              <option value="project">New project page</option>
              <option value="recipe">New recipe</option>
              <option value="existing">Link to something saved</option>
            </select>
          </label>
          {form.mode === 'existing' ? (
            <>
              <label>
                Find a destination
                <input value={form.search} onChange={(e) => buffer.field('search', e.target.value)} />
              </label>
              <label>
                Saved item
                <select
                  aria-label="Saved item"
                  value={form.targetId}
                  onChange={(e) => buffer.field('targetId', e.target.value)}
                  required
                >
                  <option value="">Choose an item</option>
                  {options.map((r) => (
                    <option key={r.recordId} value={r.recordId}>
                      {r.label}: {r.title.slice(0, 100)}
                    </option>
                  ))}
                </select>
              </label>
              {candidates.length > 100 && (
                <p className="fine">Showing 100 matches. Narrow the search to find another item.</p>
              )}
              <p className="fine">
                Linking keeps the saved item unchanged. Your original note and photos retain their own
                visibility.
              </p>
            </>
          ) : (
            <>
              <label>
                {form.mode === 'shopping' ? 'Item name' : 'Title'}
                <input
                  required
                  maxLength={300}
                  value={form.title}
                  onChange={(e) => buffer.field('title', e.target.value)}
                />
              </label>
              {form.mode === 'task' && (
                <>
                  <label>
                    Home/Work
                    <select
                      aria-label="Home/Work"
                      value={form.context}
                      onChange={(e) => buffer.field('context', e.target.value)}
                    >
                      <option value="home">Home</option>
                      <option value="work">Work</option>
                    </select>
                  </label>
                  <label>
                    Aim for (optional)
                    <input
                      type="date"
                      value={form.targetDate}
                      onChange={(e) => buffer.field('targetDate', e.target.value)}
                    />
                  </label>
                  <p className="fine">
                    Assignment, recurrence and further planning are available in Tasks after filing.
                  </p>
                </>
              )}
              {form.mode === 'shopping' && (
                <>
                  <label>
                    Shopping list
                    <select
                      aria-label="Shopping list"
                      required
                      value={form.listId}
                      onChange={(e) => {
                        buffer.field('listId', e.target.value);
                        buffer.field('groupId', '');
                      }}
                    >
                      <option value="">Choose a list</option>
                      {lists.map((l) => (
                        <option key={l.recordId} value={l.recordId}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!lists.length && (
                    <p>
                      Create a shopping list with this note’s visibility in Shopping first. Your filing draft
                      will stay here.
                    </p>
                  )}
                  <label>
                    Shopping group
                    <select
                      aria-label="Shopping group"
                      value={form.groupId}
                      onChange={(e) => buffer.field('groupId', e.target.value)}
                    >
                      <option value="">No group</option>
                      {state.shopping.groups
                        .filter((g) => g.listId === form.listId && g.deletedAt === null)
                        .map((g) => (
                          <option key={g.recordId} value={g.recordId}>
                            {g.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Quantity
                    <input
                      maxLength={120}
                      value={form.quantity}
                      onChange={(e) => buffer.field('quantity', e.target.value)}
                    />
                  </label>
                </>
              )}
              {form.mode === 'project' && (
                <>
                  <label>
                    Project
                    <select
                      aria-label="Project"
                      required
                      value={form.projectId}
                      onChange={(e) => {
                        buffer.field('projectId', e.target.value);
                        buffer.field('parentPageId', '');
                      }}
                    >
                      <option value="">Choose a project</option>
                      {projects.map((p) => (
                        <option key={p.recordId} value={p.recordId}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!projects.length && (
                    <p>
                      Create a project with this note’s visibility in Projects first. Your filing draft will
                      stay here.
                    </p>
                  )}
                  <label>
                    Inside page
                    <select
                      aria-label="Inside page"
                      value={form.parentPageId}
                      onChange={(e) => buffer.field('parentPageId', e.target.value)}
                    >
                      <option value="">Project overview</option>
                      {state.projects.pages
                        .filter((p) => p.projectId === form.projectId && p.deletedAt === null)
                        .map((p) => (
                          <option key={p.recordId} value={p.recordId}>
                            {p.title}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              {form.mode === 'recipe' && (
                <p className="fine">
                  Review the title and notes before filing. Add ingredients and steps in Food afterwards.
                </p>
              )}
              <label>
                Details
                <textarea
                  aria-label="Details"
                  rows={5}
                  maxLength={form.mode === 'shopping' || form.mode === 'recipe' ? 10000 : 20000}
                  value={form.notes}
                  onChange={(e) => buffer.field('notes', e.target.value)}
                />
              </label>
              {(form.mode === 'shopping' || form.mode === 'recipe') && form.notes.length > 10000 && (
                <p role="alert">
                  These details have a 10,000-character limit. Shorten these details; the complete original
                  stays saved.
                </p>
              )}
            </>
          )}
        </fieldset>
        <div className="filing-actions">
          <button
            className="primary"
            disabled={
              !buffer.ready ||
              busy ||
              pending ||
              stale ||
              !state.online ||
              !valid ||
              entry.deletedAt !== null ||
              ((form.mode === 'shopping' || form.mode === 'recipe') && form.notes.length > 10000)
            }
          >
            File note
          </button>
          <button type="button" disabled={busy || pending} onClick={() => void buffer.reset().catch(onError)}>
            Discard filing draft
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
