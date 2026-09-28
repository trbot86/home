import { useRef, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { emptyRecipeFields } from '@our-place/contracts';
import type { FilingAdvice, FilingAdviceReview, FilingDestination, InboxEntry } from '@our-place/contracts';
import { recordReferences } from '../RecordReferences.js';

/** Explicit clicks use the ordinary durable command/receipt/undo path. */
export function FilingAdviceActions({
  client,
  state,
  entry,
  review,
  run,
  disabled,
  edit,
  done,
}: {
  client: ClientPlatform;
  state: ClientState;
  entry: InboxEntry;
  review: FilingAdviceReview;
  run: RunRecordCommand;
  disabled: boolean;
  edit: (choice: FilingAdvice, preserveDraft?: boolean) => void;
  done: () => void;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState('');
  const [picker, setPicker] = useState<FilingAdvice | null>(null);
  const refs = recordReferences(state).filter((r) => r.scopeId === entry.scopeId && r.deletedAt === null);
  const lists = state.shopping.lists.filter((r) => r.scopeId === entry.scopeId && r.deletedAt === null);
  const projects = state.projects.projects.filter(
    (r) => r.scopeId === entry.scopeId && r.deletedAt === null && !r.archived,
  );
  function label(choice: FilingAdvice) {
    if (choice.kind === 'category')
      return { tasks: 'Tasks', shopping: 'Shopping', projects: 'Projects', recipes: 'Recipes' }[
        choice.category
      ];
    const target = refs.find((r) => r.recordId === choice.recordId);
    return target ? `${target.label}: ${target.title}` : 'Unavailable destination';
  }
  async function apply(offered: FilingAdvice, selected?: FilingAdvice) {
    if (lock.current || disabled || !state.online) return;
    lock.current = true;
    setBusy(true);
    setIssue('');
    try {
      // An existing edited form must never be silently discarded by a shortcut.
      if (await client.readEditor(`inbox:filing:${entry.inboxId}`)) {
        setIssue('Your unfinished filing draft is kept. Review it before filing.');
        edit(selected ?? offered, true);
        return;
      }
      const current = (await client.filingAdvice(entry.inboxId)).review;
      if (
        current?.state !== 'complete' ||
        current.attempt !== review.attempt ||
        !current.choices.some((c) => JSON.stringify(c) === JSON.stringify(offered))
      )
        throw Error('Suggestions changed. Refresh before filing.');
      let choice = selected ?? offered;
      if (choice.kind === 'category' && (choice.category === 'shopping' || choice.category === 'projects')) {
        const targets = choice.category === 'shopping' ? lists : projects;
        if (targets.length !== 1) {
          setPicker(offered);
          return;
        }
        choice = { kind: 'existing', recordId: targets[0]!.recordId, revision: targets[0]!.revision };
      }
      const title = entry.text.trim().split(/\r?\n/)[0]?.slice(0, 300) || 'Captured note';
      const id = crypto.randomUUID();
      let destination: FilingDestination;
      const guard =
        choice.kind === 'existing'
          ? { recordId: choice.recordId, expectedRevision: choice.revision }
          : undefined;
      if (choice.kind === 'category' && choice.category === 'recipes') {
        destination = {
          kind: 'CreateRecipe',
          arguments: {
            ...emptyRecipeFields(),
            recordId: id,
            scopeId: entry.scopeId,
            title,
            description: entry.text,
            collectionIds: [],
          },
        };
      } else if (choice.kind === 'category') {
        destination = {
          kind: 'CreateTask',
          arguments: {
            recordId: id,
            occurrenceId: crypto.randomUUID(),
            scopeId: entry.scopeId,
            title,
            instructions: entry.text,
            context: 'home',
            defaultAssigneeId: null,
            defaultPriority: 1,
            recurrence: null,
            assigneeId: null,
            priority: 1,
            deadlineDate: null,
            targetDate: null,
            reviewDate: null,
          },
        };
      } else {
        const target = refs.find((r) => r.recordId === choice.recordId);
        if (!target) throw Error('This destination is no longer available.');
        if (target.kind === 'shopping_list') {
          if (entry.text.length > 10000) {
            edit(choice);
            return;
          }
          destination = {
            kind: 'AddShoppingEntry',
            arguments: {
              recordId: id,
              listId: target.recordId,
              groupId: null,
              label: title,
              quantity: '',
              notes: entry.text,
            },
          };
        } else if (target.kind === 'project' || target.kind === 'project_page') {
          const page = state.projects.pages.find((p) => p.recordId === target.recordId);
          destination = {
            kind: 'CreateProjectPage',
            arguments: {
              recordId: id,
              projectId: page?.projectId ?? target.recordId,
              parentPageId: page?.recordId ?? null,
              title,
              blocks: [
                { blockId: crypto.randomUUID(), kind: 'text', text: entry.text },
                {
                  blockId: crypto.randomUUID(),
                  kind: 'record_link',
                  recordId: entry.inboxId,
                  caption: 'Original capture and photos',
                },
              ],
            },
          };
        } else
          destination = { kind: 'existing', recordId: target.recordId, expectedRevision: choice.revision };
      }
      const result = await run(
        { recordId: entry.inboxId },
        'FileInboxEntry',
        {
          inboxId: entry.inboxId,
          expectedRevision: entry.revision,
          destination,
          ...(guard ? { suggestedTarget: guard } : {}),
        },
        'Note filed',
        state.session!.serverEpoch,
      );
      if (result?.status === 'Applied') {
        setPicker(null);
        done();
      }
    } catch (error) {
      setIssue(
        error instanceof Error && /^(Suggestions changed|This destination)/.test(error.message)
          ? error.message
          : 'Could not file this note. Your note is kept; refresh before trying again.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const targets = picker?.kind === 'category' && picker.category === 'shopping' ? lists : projects;
  return (
    <div className="filing-advice-actions">
      <div className="filing-advice-buttons" aria-label="Suggested destinations">
        {review.choices.slice(0, 3).map((choice, index) => (
          <button
            key={index}
            type="button"
            disabled={disabled || busy || !state.online}
            aria-label={`File to ${label(choice)}`}
            title={`File to ${label(choice)}`}
            onClick={() => void apply(choice)}
          >
            {label(choice)}
          </button>
        ))}
      </div>
      {picker && (
        <div role="group" aria-label="Choose suggested destination" className="filing-advice-picker">
          <p>
            {targets.length
              ? 'Choose where to file:'
              : 'Create a destination with the same visibility first, or choose another suggestion.'}
          </p>
          {targets.map((target) => (
            <button
              type="button"
              key={target.recordId}
              disabled={disabled || busy || !state.online}
              onClick={() =>
                void apply(picker, { kind: 'existing', recordId: target.recordId, revision: target.revision })
              }
            >
              {'name' in target ? target.name : target.title}
            </button>
          ))}
          <button type="button" onClick={() => setPicker(null)}>
            Cancel
          </button>
        </div>
      )}
      {issue && <p role="status">{issue}</p>}
    </div>
  );
}
