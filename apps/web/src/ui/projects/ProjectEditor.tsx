import { SecureRecord } from '../SecureRecord.js';
import { ShareRecord } from '../ShareRecord.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { isValid, PageBlocks, type PageBlock, type Project, type ProjectRecord } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
import { linkableReferences } from '../RecordReferences.js';
import { Photo } from '../Photo.js';
import { readEditorBlocks } from './editor-blocks.js';

export function ProjectEditor({
  client,
  state,
  record,
  project,
  parentPageId = null,
  run,
  close,
  onSaved,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  record?: ProjectRecord;
  project?: Project;
  parentPageId?: string | null;
  run: RunRecordCommand;
  close: () => void;
  onSaved: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!,
    isPage = record?.kind === 'project_page' || !!project;
  const initial = () => ({
    recordId: record?.recordId ?? crypto.randomUUID(),
    scopeId: record?.scopeId ?? project?.scopeId ?? session.scopes.find((s) => s.kind === 'private')!.scopeId,
    title: record?.title ?? '',
    description: record?.kind === 'project' ? record.description : '',
    blocks: JSON.stringify(record?.kind === 'project_page' ? record.blocks : []),
  });
  const key =
    record?.recordId ??
    (project ? `projects:page:new:${project.recordId}:${parentPageId ?? 'root'}` : 'projects:new');
  const buffer = useSavedForm(client, key, initial, record?.revision ?? 1, session.serverEpoch, onError),
    form = buffer.values;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [search, setSearch] = useState('');
  const lock = useRef(false),
    finished = useRef(false);
  const pending = state.pendingEdits.includes(form.recordId),
    stale = (!!record && record.revision !== buffer.baseRevision) || buffer.epoch !== session.serverEpoch;
  let blocks: PageBlock[] = [];
  let invalid = false;
  try {
    blocks = readEditorBlocks(form.blocks);
  } catch {
    invalid = true;
  }
  const candidates = linkableReferences(state, form.scopeId)
    .filter((r) => `${r.label} ${r.title}`.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 100);
  const setBlocks = (next: PageBlock[]) => buffer.field('blocks', JSON.stringify(next));
  const replace = (id: string, next: PageBlock) =>
    setBlocks(blocks.map((b) => (b.blockId === id ? next : b)));
  const move = (index: number, offset: number) => {
    const next = [...blocks];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    setBlocks(next);
  };
  async function finish() {
    if (finished.current) return;
    finished.current = true;
    try {
      await buffer.clear();
      onSaved(form.recordId);
      close();
    } catch (error) {
      finished.current = false;
      onError(error);
    }
  }
  useEffect(() => {
    if (
      !record &&
      buffer.ready &&
      [...state.projects.projects, ...state.projects.pages].some((r) => r.recordId === form.recordId)
    )
      void finish();
  }, [record, buffer.ready, state.projects, form.recordId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || pending || stale || invalid || !buffer.ready || !state.online) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await buffer.save();
      if (!isValid(PageBlocks, blocks))
        throw new Error('Finish each web address or app reference before saving. Your draft is kept.');
      for (const block of blocks)
        if (block.kind === 'web_link') {
          const url = new URL(block.url);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
            throw new Error('Use an ordinary http or https link without a username or password.');
        }
      const target = { recordId: form.recordId },
        args = record ? { ...target, expectedRevision: buffer.baseRevision } : target;
      const outcome = isPage
        ? await run(
            target,
            record ? 'UpdateProjectPage' : 'CreateProjectPage',
            {
              ...args,
              ...(!record ? { projectId: project!.recordId, parentPageId } : {}),
              title: form.title.trim(),
              blocks,
            },
            'Page saved',
            buffer.epoch,
          )
        : await run(
            target,
            record ? 'UpdateProject' : 'CreateProject',
            {
              ...args,
              ...(!record ? { scopeId: form.scopeId } : {}),
              title: form.title.trim(),
              description: form.description,
            },
            'Project saved',
            buffer.epoch,
          );
      if (outcome?.status === 'Applied') await finish();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save. Your draft is kept.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const closeSaved = () => {
    if (!busy) void buffer.flush().then(close).catch(onError);
  };
  return (
    <RecordDialog
      client={client}
      title={record ? (isPage ? 'Edit page' : 'Edit project') : isPage ? 'New page' : 'New project'}
      subtitle="A place for the details"
      className="task-dialog project-editor"
      close={closeSaved}
    >
      {record && (
        <>
          <SecureRecord client={client} state={state} recordId={record.recordId} />
          <ShareRecord
            client={client}
            state={state}
            recordId={record.recordId}
            scopeId={record.scopeId}
            close={close}
          />
        </>
      )}
      <form
        className="task-form"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <fieldset disabled={!buffer.ready || busy || pending || record?.deletedAt != null}>
          <label>
            Title
            <input
              autoFocus
              required
              maxLength={300}
              value={form.title}
              aria-label="Title"
              onChange={(e) => buffer.field('title', e.target.value)}
            />
          </label>
          {!record && !isPage && (
            <label>
              Visibility
              <select
                aria-label="Visibility"
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
          {!isPage ? (
            <label>
              Description
              <textarea
                rows={5}
                maxLength={20000}
                value={form.description}
                aria-label="Description"
                onChange={(e) => buffer.field('description', e.target.value)}
              />
            </label>
          ) : (
            <>
              {blocks.map((block, index) => (
                <section
                  className="project-block-editor"
                  key={block.blockId}
                  aria-label={`Block ${index + 1}`}
                >
                  <div className="project-block-toolbar">
                    <strong>
                      {block.kind === 'text'
                        ? 'Text'
                        : block.kind === 'web_link'
                          ? 'Web link'
                          : block.kind === 'record_link'
                            ? 'App reference'
                            : 'Photo'}
                    </strong>
                    <div>
                      <button
                        type="button"
                        aria-label={`Move block ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move block ${index + 1} down`}
                        disabled={index === blocks.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove block ${index + 1}`}
                        onClick={() => setBlocks(blocks.filter((b) => b.blockId !== block.blockId))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {block.kind === 'text' ? (
                    <label>
                      Text
                      <textarea
                        rows={5}
                        maxLength={20000}
                        value={block.text}
                        aria-label="Text"
                        onChange={(e) => replace(block.blockId, { ...block, text: e.target.value })}
                      />
                    </label>
                  ) : block.kind === 'web_link' ? (
                    <>
                      <label>
                        Web address
                        <input
                          type="url"
                          required
                          maxLength={4096}
                          value={block.url}
                          aria-label="Web address"
                          placeholder="https://…"
                          onChange={(e) => replace(block.blockId, { ...block, url: e.target.value })}
                        />
                      </label>
                      <label>
                        Link title
                        <input
                          maxLength={300}
                          value={block.title}
                          aria-label="Link title"
                          onChange={(e) => replace(block.blockId, { ...block, title: e.target.value })}
                        />
                      </label>
                      <label>
                        Notes
                        <textarea
                          rows={2}
                          maxLength={10000}
                          value={block.notes}
                          aria-label="Notes"
                          onChange={(e) => replace(block.blockId, { ...block, notes: e.target.value })}
                        />
                      </label>
                    </>
                  ) : block.kind === 'record_link' ? (
                    <>
                      <label>
                        Reference
                        <select
                          required
                          value={block.recordId}
                          aria-label="Reference"
                          onChange={(e) => replace(block.blockId, { ...block, recordId: e.target.value })}
                        >
                          <option value="">Choose a record</option>
                          {!candidates.some((r) => r.recordId === block.recordId) && block.recordId && (
                            <option value={block.recordId}>
                              {linkableReferences(state, form.scopeId).find(
                                (r) => r.recordId === block.recordId,
                              )?.title ?? 'Retained reference (unavailable)'}
                            </option>
                          )}
                          {candidates.map((r) => (
                            <option key={r.recordId} value={r.recordId}>
                              {r.label} · {r.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Caption
                        <textarea
                          rows={2}
                          maxLength={1000}
                          value={block.caption}
                          aria-label="Caption"
                          onChange={(e) => replace(block.blockId, { ...block, caption: e.target.value })}
                        />
                      </label>
                    </>
                  ) : (
                    (() => {
                      const photo = record?.attachments.find((a) => a.attachmentId === block.attachmentId);
                      return photo ? (
                        <>
                          <Photo client={client} id={photo.mediaId} descriptor={photo} />
                          <p className="fine">
                            Removing this block removes this page’s photo placement when you save.
                          </p>
                        </>
                      ) : (
                        <p className="fine">Photo unavailable.</p>
                      );
                    })()
                  )}
                </section>
              ))}
              <label>
                Find an app reference
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search tasks, recipes, notes or pages"
                />
              </label>
              <div className="project-add-blocks" role="group" aria-label="Add page content">
                <button
                  type="button"
                  disabled={blocks.length >= 200}
                  onClick={() =>
                    setBlocks([...blocks, { blockId: crypto.randomUUID(), kind: 'text', text: '' }])
                  }
                >
                  + Text
                </button>
                <button
                  type="button"
                  disabled={blocks.length >= 200}
                  onClick={() =>
                    setBlocks([
                      ...blocks,
                      { blockId: crypto.randomUUID(), kind: 'web_link', url: '', title: '', notes: '' },
                    ])
                  }
                >
                  + Web link
                </button>
                <button
                  type="button"
                  disabled={blocks.length >= 200}
                  onClick={() =>
                    setBlocks([
                      ...blocks,
                      { blockId: crypto.randomUUID(), kind: 'record_link', recordId: '', caption: '' },
                    ])
                  }
                >
                  + App reference
                </button>
              </div>
              <p className="fine">
                Save the page, then use Photos to add camera or gallery images. Reorder their blocks here.
              </p>
            </>
          )}
        </fieldset>
        {!state.online && (
          <p className="notice">Your unfinished form is saved on this device. Reconnect to submit it.</p>
        )}
        {(stale || invalid || record?.deletedAt != null) && (
          <p className="notice" role="alert">
            {invalid ? 'This saved form needs recovery.' : 'This record changed since your draft began.'} Your
            draft is kept.{' '}
            <button
              type="button"
              disabled={busy || pending}
              onClick={() => void buffer.reset().catch(onError)}
            >
              Reload current version
            </button>
          </p>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={closeSaved}>
            Close · keep draft
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              pending ||
              !buffer.ready ||
              stale ||
              invalid ||
              !state.online ||
              !form.title.trim() ||
              record?.deletedAt != null
            }
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
