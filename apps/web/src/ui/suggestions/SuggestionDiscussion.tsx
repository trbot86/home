import { useRef, useState } from 'react';
import type { ClientPlatform, ClientState, Draft } from '@our-place/client';
import type { InboxEntry, SuggestionMessage } from '@our-place/contracts';
import { LinkedText } from '../LinkedText.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { CaptureMedia } from '../CaptureMedia.js';
import { Photo } from '../Photo.js';
import { usePhotoTransfer } from '../usePhotoTransfer.js';
import { validatePhotoFiles } from '../photo-input.js';
import { date } from '../format.js';
import './suggestions.css';

const labels = {
  new: 'New',
  queued: 'Queued',
  working: 'Working',
  needs_input: 'Needs your input',
  ready: 'Ready for review',
  released: 'Released',
};
export function SuggestionDiscussion({
  client,
  state,
  entry,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  entry: InboxEntry;
  onError: (e: unknown) => void;
}) {
  const [questionId, setQuestionId] = useState<string | null>(null),
    [older, setOlder] = useState<SuggestionMessage[]>([]),
    [allLoaded, setAllLoaded] = useState(false),
    [busy, setBusy] = useState(false);
  const snapshot = state.suggestions,
    workflow = snapshot.workflows.find((w) => w.suggestionId === entry.inboxId);
  const messages = [
    ...new Map(
      [...older, ...snapshot.messages.filter((m) => m.suggestionId === entry.inboxId)].map((m) => [
        m.recordId,
        m,
      ]),
    ).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const questions = snapshot.questions.filter((q) => q.suggestionId === entry.inboxId),
    work = snapshot.work.filter((w) => w.suggestionId === entry.inboxId);
  const queued = work.filter((w) => w.state === 'queued'),
    running = work.find((w) => w.state === 'running'),
    uncertain = work.find((w) => w.state === 'uncertain'),
    failed = work.find((w) => w.state === 'failed');
  const active = entry.deletedAt === null && entry.category === 'app_suggestion',
    bridgeRecent = !!snapshot.bridgeSeenAt && Date.now() - snapshot.bridgeSeenAt < 180_000;
  const drafts = state.drafts.filter(
    (d) =>
      d.replyTarget?.suggestionId === entry.inboxId &&
      !snapshot.messages.some((m) => m.recordId === d.draftId),
  );
  async function action(kind: 'RequestSuggestionWork' | 'CancelSuggestionWork', requestId?: string) {
    setBusy(true);
    try {
      const result = await client.command(
        entry.inboxId,
        kind,
        kind === 'RequestSuggestionWork'
          ? { recordId: crypto.randomUUID(), suggestionId: entry.inboxId }
          : { requestId },
        state.session!.serverEpoch,
      );
      if (result.status === 'Rejected') throw new Error(result.code.replaceAll('_', ' '));
      await client.refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="suggestion-discussion" aria-label="Suggestion discussion">
      <div className="suggestion-original">
        <p className="eyebrow">Original suggestion</p>
        <LinkedText client={client} text={entry.text} />
        <AttachmentGallery client={client} attachments={entry.attachments} />
      </div>
      <div className="suggestion-summary">
        <span className="scope-badge">{running ? 'Working' : labels[workflow?.status ?? 'new']}</span>
        <p>
          {workflow?.summary ||
            'No development update yet. Add details here or request work when you’re ready.'}
        </p>
        {workflow?.status === 'ready' && (
          <p className="fine">Ready for review does not mean an update has been released.</p>
        )}
        {queued.length > 0 && (
          <div className="notice">
            <p>
              {running
                ? 'Follow-up saved; waiting for the current work to finish.'
                : bridgeRecent
                  ? 'Saved; waiting for the agent.'
                  : 'Saved for review; waiting for the development host.'}
            </p>
            <button
              disabled={!state.online || busy}
              onClick={() => {
                void (async () => {
                  for (const q of queued) await action('CancelSuggestionWork', q.requestId);
                })();
              }}
            >
              Cancel queued work
            </button>
          </div>
        )}
        {uncertain && (
          <p className="notice">
            The agent connection was interrupted. Its progress needs to be checked before work continues.
          </p>
        )}
        {failed && !running && (
          <p className="notice">
            {failed.issue || 'The last attempt could not finish. Your discussion is saved.'}
          </p>
        )}
        {active && (
          <button
            disabled={!state.online || busy || !!queued.length}
            onClick={() => {
              void action('RequestSuggestionWork');
            }}
          >
            {running ? 'Queue another round' : 'Work on this'}
          </button>
        )}
      </div>
      {questions.some((q) => q.state !== 'resolved') && (
        <section aria-label="Questions" className="suggestion-questions">
          <h3>Questions</h3>
          {questions
            .filter((q) => q.state !== 'resolved')
            .map((q) => (
              <article key={q.questionId}>
                <p>
                  <LinkedText client={client} text={q.text} />
                </p>
                <p className="fine">
                  {q.state === 'answered'
                    ? 'Answer saved; awaiting the agent’s review'
                    : 'Waiting for your answer'}
                </p>
                {q.choices.length > 0 && (
                  <ul>
                    {q.choices.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
                {active && (
                  <button onClick={() => setQuestionId(q.questionId)}>Reply to this question</button>
                )}
              </article>
            ))}
        </section>
      )}
      <h3>Discussion</h3>
      {!allLoaded && messages.length >= snapshot.messagesPerSuggestion && (
        <button
          disabled={!state.online || busy}
          onClick={() => {
            setBusy(true);
            void client
              .suggestionMessages(entry.inboxId, messages[0]!.sequence)
              .then((items) => {
                setOlder([...items, ...older]);
                if (items.length < 100) setAllLoaded(true);
              })
              .catch(onError)
              .finally(() => setBusy(false));
          }}
        >
          Load earlier messages
        </button>
      )}
      {!messages.length && (
        <p className="fine">Follow-ups, decisions and development updates will appear here.</p>
      )}
      <ol className="suggestion-timeline">
        {messages.map((m) => (
          <li key={m.recordId} className={m.authorKind === 'agent' ? 'agent-message' : ''}>
            <div className="suggestion-message-heading">
              <strong>{m.authorName}</strong>
              <time dateTime={new Date(m.createdAt).toISOString()}>{date(m.createdAt)}</time>
              {m.messageType === 'question' && (
                <span className="scope-badge">
                  Question · {questions.find((q) => q.questionId === m.recordId)?.state ?? 'unanswered'}
                </span>
              )}
            </div>
            {m.deletedAt !== null ? (
              <p className="fine">Message retracted</p>
            ) : (
              <>
                {m.replyToQuestionId && (
                  <p className="fine">
                    In reply to:{' '}
                    {questions.find((q) => q.questionId === m.replyToQuestionId)?.text ??
                      'an earlier question'}
                  </p>
                )}
                <p>
                  <LinkedText client={client} text={m.text || 'Requested another round of work.'} />
                </p>
                <AttachmentGallery client={client} attachments={m.attachments} />
              </>
            )}
          </li>
        ))}
      </ol>
      {drafts
        .filter((d) => d.state !== 'DRAFT' || d.replyTarget?.questionId !== questionId)
        .map((d) => (
          <div className="notice" key={d.draftId}>
            <p>
              {d.state === 'DRAFT'
                ? 'Unfinished reply'
                : d.state === 'SUBMITTED'
                  ? 'Waiting to upload'
                  : d.state === 'REJECTED'
                    ? 'Reply needs attention'
                    : 'Reply saved'}
            </p>
            <p>{d.text}</p>
            {d.state === 'DRAFT' && (
              <button onClick={() => setQuestionId(d.replyTarget!.questionId)}>Continue this reply</button>
            )}
            {d.state === 'REJECTED' && (
              <>
                <p>
                  {d.outcome?.status === 'Rejected'
                    ? d.outcome.code.replaceAll('_', ' ')
                    : 'The server could not accept this reply.'}
                </p>
                <button
                  onClick={() => {
                    void client
                      .copyRejectedDraft(d.draftId)
                      .then(() => setQuestionId(d.replyTarget!.questionId))
                      .catch(onError);
                  }}
                >
                  Copy to a new draft
                </button>
              </>
            )}
            {d.state === 'SUBMITTED' && state.recoveryRequired && (
              <button
                onClick={() => {
                  void client.recoverDraft(d.draftId).catch(onError);
                }}
              >
                Recover reply after restore
              </button>
            )}
          </div>
        ))}
      {active ? (
        <ReplyComposer
          key={`${entry.inboxId}:${questionId ?? 'note'}`}
          client={client}
          entry={entry}
          state={state}
          questionId={questionId}
          clearQuestion={() => setQuestionId(null)}
          onError={onError}
        />
      ) : (
        <p className="fine">
          Discussion is retained. Move this entry back to app suggestions to continue work.
        </p>
      )}
    </section>
  );
}
function ReplyComposer({
  client,
  entry,
  state,
  questionId,
  clearQuestion,
  onError,
}: {
  client: ClientPlatform;
  entry: InboxEntry;
  state: ClientState;
  questionId: string | null;
  clearQuestion: () => void;
  onError: (e: unknown) => void;
}) {
  const initial = state.drafts.find(
    (d) =>
      d.state === 'DRAFT' &&
      d.replyTarget?.suggestionId === entry.inboxId &&
      d.replyTarget.questionId === questionId,
  );
  const [draft, setDraft] = useState<Draft | undefined>(initial),
    [text, setText] = useState(initial?.text ?? ''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const current = useRef(initial),
    queue = useRef<Promise<unknown>>(Promise.resolve());
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.current.then(work);
    queue.current = next.catch(() => {});
    return next;
  }
  async function ensure() {
    if (!current.current)
      current.current = await client.createDraft(entry.scopeId, 'app_suggestion', {
        suggestionId: entry.inboxId,
        questionId,
        requestWork: true,
      });
    return current.current;
  }
  async function addPhotos(files: File[]) {
    setBusy(true);
    try {
      await serial(async () => {
        let d = await ensure();
        validatePhotoFiles(files, d.attachments.length);
        for (const file of files) d = await client.addPhoto(d.draftId, file);
        current.current = d;
        setDraft(d);
      });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  const transfer = usePhotoTransfer({
    disabledReason: busy ? 'Wait for this reply to finish saving.' : null,
    onFiles: addPhotos,
    onError,
  });
  // Native photo acquisition updates the shared state while this form stays mounted.
  const displayed = state.drafts.find((d) => d.draftId === draft?.draftId) ?? draft;
  async function submit(requestWork: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await serial(async () => {
        const d = await ensure();
        await client.saveDraft(d.draftId, text, entry.scopeId);
        await client.submitDraft(d.draftId, requestWork);
        current.current = undefined;
        setDraft(undefined);
        setText('');
        setNotice(
          state.online
            ? 'Reply saved on this device; uploading…'
            : 'Reply saved on this device; waiting to upload.',
        );
      });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={`suggestion-reply ${transfer.dragging ? 'photo-drop-active' : ''}`}
      {...transfer.handlers}
      onSubmit={(e) => {
        e.preventDefault();
        void submit(true);
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void submit(true);
        }
      }}
    >
      <label htmlFor="suggestion-reply-text">{questionId ? 'Your answer' : 'Add a follow-up'}</label>
      {questionId && (
        <button type="button" onClick={clearQuestion}>
          Write a general note
        </button>
      )}
      <textarea
        id="suggestion-reply-text"
        rows={4}
        maxLength={20000}
        value={text}
        disabled={busy}
        placeholder="Details, an answer, or a new idea…"
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          setNotice('');
          void serial(async () => {
            const d = await ensure();
            const saved = await client.saveDraft(d.draftId, value, entry.scopeId);
            current.current = saved;
            setDraft(saved);
          }).catch(onError);
        }}
      />
      {!!displayed?.attachments.length && (
        <div className="capture-photos">
          {displayed.attachments.map((a) => (
            <div key={a.mediaId}>
              <Photo client={client} id={a.mediaId} descriptor={a} />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void serial(async () => {
                    const d = await client.removePhoto(displayed.draftId, a.mediaId);
                    current.current = d;
                    setDraft(d);
                  }).catch(onError);
                }}
              >
                Remove photo
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="suggestion-reply-actions">
        {draft ? (
          <CaptureMedia
            client={client}
            draftId={draft.draftId}
            category="app_suggestion"
            allowDictation={false}
            busy={busy}
            addPhotos={addPhotos}
            onError={onError}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              void serial(async () => setDraft(await ensure())).catch(onError);
            }}
          >
            Add photos
          </button>
        )}
        <button
          type="button"
          disabled={busy || (!text.trim() && !displayed?.attachments.length)}
          onClick={() => {
            void submit(false);
          }}
        >
          Add note
        </button>
        <button className="primary" disabled={busy || (!text.trim() && !displayed?.attachments.length)}>
          {busy ? 'Saving…' : 'Reply & continue work'}
        </button>
      </div>
      <p className="fine" role="status">
        {notice ||
          'Unfinished replies and photos are kept on this device. Ctrl+Enter sends a reply and requests work.'}
      </p>
    </form>
  );
}
