import { useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { useNavigationState } from '../NavigationHistory.js';
import { CompactSearch } from '../CompactSearch.js';
import { AttachmentDialog, type AttachmentSaved } from '../AttachmentDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { CaptureSources } from '../inbox/FilingLinks.js';
import { LinkedText } from '../LinkedText.js';
import { ShareRecord } from '../ShareRecord.js';
import { SecureRecord } from '../SecureRecord.js';
import { NoteEditor } from './NoteEditor.js';
import { NoteHistory } from './NoteHistory.js';
import './notes.css';

export function Thoughts({
  client,
  state,
  run,
  onError,
  onPhotosSaved,
  initialRecordId,
}: {
  client: ClientPlatform;
  state: ClientState;
  run: RunRecordCommand;
  onError: (e: unknown) => void;
  onPhotosSaved: AttachmentSaved;
  initialRecordId?: string | null;
}) {
  const [selected, setSelected] = useNavigationState<string | null>(
    'thoughts.selected',
    initialRecordId ?? null,
  );
  const [editor, setEditor] = useNavigationState<'new' | 'edit' | null>('thoughts.editor', null);
  const [search, setSearch] = useState(''),
    [scope, setScope] = useState('all'),
    [category, setCategory] = useState('all'),
    [deleted, setDeleted] = useState(false);
  const [photos, setPhotos] = useState(false),
    [history, setHistory] = useState(false),
    [confirm, setConfirm] = useState(false);
  const notes = state.notes ?? [],
    note = notes.find((n) => n.recordId === selected);
  const categories = [
    ...new Set(
      notes
        .filter(
          (n) =>
            (deleted ? n.deletedAt !== null : n.deletedAt === null) &&
            (scope === 'all' || scope === n.scopeId),
        )
        .map((n) => n.category)
        .filter(Boolean),
    ),
  ].sort();
  const visible = notes.filter(
    (n) =>
      (deleted ? n.deletedAt !== null : n.deletedAt === null) &&
      (scope === 'all' || scope === n.scopeId) &&
      (category === 'all' || n.category === category) &&
      `${n.title}\n${n.body}\n${n.category}`.toLowerCase().includes(search.toLowerCase()),
  );
  const blocked = !state.online || (!!note && state.pendingEdits.includes(note.recordId));
  const editNote = editor === 'edit' ? note : undefined;
  return (
    <section aria-label="Thoughts" className="thoughts-section">
      <div className="thoughts-toolbar">
        <CompactSearch
          label="Search thoughts"
          placeholder="Find a thought…"
          value={search}
          onChange={setSearch}
        />
        <select
          aria-label="Thought visibility"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setCategory('all');
            setSelected(null);
          }}
        >
          <option value="all">Shared + mine</option>
          {state.session!.scopes.map((s) => (
            <option key={s.scopeId} value={s.scopeId}>
              {s.kind === 'shared' ? 'Shared' : 'Just me'}
            </option>
          ))}
        </select>
        <select
          aria-label="Thought category"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setSelected(null);
          }}
        >
          <option value="all">All categories</option>
          <option value="">Uncategorized</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          aria-pressed={deleted}
          onClick={() => {
            setDeleted(!deleted);
            setCategory('all');
            setSelected(null);
          }}
        >
          {deleted ? 'Show active' : 'Deleted'}
        </button>
        <button className="primary" disabled={!state.online} onClick={() => setEditor('new')}>
          New thought
        </button>
      </div>
      {!state.online && (
        <p className="notice">Saved thoughts are available offline. Reconnect to make changes.</p>
      )}
      <div className={`thoughts-layout ${note ? 'has-detail' : ''}`}>
        <div className="thoughts-list">
          {visible.map((n) => (
            <button
              className="thought-card"
              key={n.recordId}
              aria-pressed={selected === n.recordId}
              onClick={() => {
                setSelected(n.recordId);
                setConfirm(false);
              }}
            >
              <strong>{n.title}</strong>
              {n.body.trim() !== n.title.trim() && <span className="thought-preview">{n.body}</span>}
              <span className="fine">
                {n.category || 'Uncategorized'} ·{' '}
                {state.session!.scopes.find((s) => s.scopeId === n.scopeId)?.kind === 'shared'
                  ? 'Shared'
                  : 'Just me'}
                {n.attachments.length ? ' · Photos' : ''}
              </span>
            </button>
          ))}
          {!visible.length && (
            <p>
              {search
                ? 'No matching thoughts.'
                : deleted
                  ? 'No deleted thoughts.'
                  : 'No thoughts saved here yet.'}
            </p>
          )}
        </div>
        {note && (
          <article className="thought-detail" aria-label="Thought details">
            <div className="thoughts-toolbar">
              <h2>{note.title}</h2>
              <button onClick={() => setSelected(null)} aria-label="Close thought">
                ×
              </button>
            </div>
            {note.body.trim() && note.body.trim() !== note.title.trim() && (
              <p className="historical-text">
                <LinkedText client={client} text={note.body} />
              </p>
            )}
            {note.category && <p className="fine">{note.category}</p>}
            <AttachmentGallery client={client} attachments={note.attachments} />
            <div className="thoughts-toolbar">
              {note.deletedAt === null ? (
                <>
                  <button disabled={blocked} onClick={() => setEditor('edit')}>
                    Edit
                  </button>
                  <button disabled={blocked} onClick={() => setPhotos(true)}>
                    Photos
                  </button>
                  <button disabled={blocked} onClick={() => setConfirm(true)}>
                    Delete
                  </button>
                </>
              ) : (
                <button
                  disabled={blocked}
                  onClick={() =>
                    void run(
                      note,
                      'RestoreNote',
                      { recordId: note.recordId, expectedRevision: note.revision },
                      'Thought restored',
                    )
                  }
                >
                  Restore
                </button>
              )}
              <button disabled={!state.online} onClick={() => setHistory(true)}>
                History
              </button>
            </div>
            {confirm && note.deletedAt === null && (
              <div className="notice">
                Delete this thought? You can restore it from Deleted.
                <div className="thoughts-toolbar">
                  <button onClick={() => setConfirm(false)}>Keep thought</button>
                  <button
                    disabled={blocked}
                    onClick={() =>
                      void run(
                        note,
                        'DeleteNote',
                        { recordId: note.recordId, expectedRevision: note.revision },
                        'Thought deleted',
                      ).then((r) => {
                        if (r?.status === 'Applied') {
                          setConfirm(false);
                          setSelected(null);
                        }
                      })
                    }
                  >
                    Delete thought
                  </button>
                </div>
              </div>
            )}
            <CaptureSources recordId={note.recordId} state={state} collapsed />
            {note.deletedAt === null && (
              <details className="thought-privacy">
                <summary>Privacy &amp; sharing</summary>
                <SecureRecord client={client} state={state} recordId={note.recordId} />
                <ShareRecord
                  client={client}
                  state={state}
                  recordId={note.recordId}
                  scopeId={note.scopeId}
                  close={() => {}}
                />
              </details>
            )}
          </article>
        )}
      </div>
      {editor && (editor === 'new' || editNote) && (
        <NoteEditor
          client={client}
          state={state}
          note={editNote}
          run={run}
          onError={onError}
          close={() => setEditor(null)}
          saved={(id) => {
            setDeleted(false);
            setScope('all');
            setCategory('all');
            setSearch('');
            setSelected(id);
          }}
        />
      )}
      {photos && note && (
        <AttachmentDialog
          client={client}
          target={note}
          title={note.title}
          online={state.online}
          serverEpoch={state.session!.serverEpoch}
          pending={state.pendingEdits.includes(note.recordId)}
          close={() => setPhotos(false)}
          onSaved={onPhotosSaved}
        />
      )}
      {history && note && (
        <NoteHistory
          client={client}
          state={state}
          note={note}
          run={run}
          close={() => setHistory(false)}
          onError={onError}
        />
      )}
    </section>
  );
}
