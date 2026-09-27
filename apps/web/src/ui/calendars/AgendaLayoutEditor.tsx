import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AgendaLayout,
  agendaSectionKinds,
  defaultAgendaLayout,
  isValid,
  type AgendaLayout as Layout,
  type AgendaSectionKind,
  type SavedView,
} from '@our-place/contracts';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
export const agendaSectionNames: Record<AgendaSectionKind, string> = {
  tasks: 'Your tasks today',
  calendar: 'Calendar events',
  food_soon: 'Make soon recipes',
  project_next: 'Project priorities',
};

function readDraft(text: string): Layout | null {
  try {
    const value = JSON.parse(text);
    // An empty or temporarily out-of-range number remains editable in the durable draft.
    if (
      !Array.isArray(value?.sections) ||
      value.sections.some(
        (s: { limit?: unknown } | null) => typeof s?.limit !== 'number' || !Number.isFinite(s.limit),
      )
    )
      return null;
    if (
      !isValid(AgendaLayout, {
        ...value,
        sections: value.sections.map((s: object) => ({ ...s, limit: 1 })),
      }) ||
      new Set(value.sections.map((s: { kind: string }) => s.kind)).size !== agendaSectionKinds.length
    )
      return null;
    return value as Layout;
  } catch {
    return null;
  }
}

export function AgendaLayoutEditor({
  client,
  state,
  view,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  view: Extract<SavedView, { kind: 'agenda' }> | undefined;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!,
    scopeId = session.scopes.find((s) => s.kind === 'private')!.scopeId;
  const buffer = useSavedForm(
    client,
    'agenda:layout',
    () => ({ layout: JSON.stringify(view?.layout ?? defaultAgendaLayout()) }),
    view?.revision ?? 0,
    session.serverEpoch,
    onError,
  );
  const [busy, setBusy] = useState(false),
    lock = useRef(false),
    finished = useRef(false);
  const layout = readDraft(buffer.values.layout);
  const pending = state.pendingEdits.includes(scopeId),
    stale = (view?.revision ?? 0) !== buffer.baseRevision || buffer.epoch !== session.serverEpoch;
  const change = (value: Layout) => buffer.field('layout', JSON.stringify(value));
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
  // A reconciled receipt may update the snapshot after a lost reply; do not issue a second write.
  useEffect(() => {
    if (
      buffer.ready &&
      !pending &&
      view &&
      view.revision > buffer.baseRevision &&
      buffer.epoch === session.serverEpoch &&
      JSON.stringify(view.layout) === buffer.values.layout
    )
      void finish();
  }, [
    buffer.ready,
    pending,
    view,
    buffer.baseRevision,
    buffer.epoch,
    buffer.values.layout,
    session.serverEpoch,
  ]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !buffer.ready ||
      lock.current ||
      pending ||
      stale ||
      !state.online ||
      !layout ||
      !isValid(AgendaLayout, layout)
    )
      return;
    lock.current = true;
    setBusy(true);
    try {
      await buffer.save();
      const outcome = await run(
        { recordId: scopeId },
        'SetAgendaLayout',
        { scopeId, expectedViewRevision: buffer.baseRevision, layout },
        'Agenda layout saved',
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
  const closeSaved = () => {
    void buffer.flush().then(close).catch(onError);
  };
  if (!layout)
    return (
      <RecordDialog
        client={client}
        title="Customise your agenda"
        subtitle="Saved draft recovery"
        close={closeSaved}
      >
        <p role="alert">This saved layout draft cannot be opened. Your saved agenda is unchanged.</p>
        <button disabled={!buffer.ready || pending} onClick={() => void buffer.reset().catch(onError)}>
          Discard draft and load saved layout
        </button>
      </RecordDialog>
    );
  return (
    <RecordDialog
      client={client}
      title="Customise your agenda"
      subtitle={`For ${session.person.displayName} · syncs across your devices`}
      close={closeSaved}
      className="agenda-layout-dialog"
    >
      <form
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <p>
          Choose sections, their order and how much to show. Calendar and task filters stay separate from
          visibility.
        </p>
        {!state.online && (
          <p role="status">Offline · you can keep a draft here. Reconnect to save your layout.</p>
        )}
        {pending && (
          <p role="status">
            Checking the previous save.{' '}
            <button type="button" disabled={busy} onClick={() => void client.sync().catch(onError)}>
              Retry pending save
            </button>
          </p>
        )}
        {stale && !pending && (
          <p role="status">
            The saved layout changed on another device. Your draft is kept; load the current settings before
            saving.
          </p>
        )}
        <fieldset disabled={!buffer.ready || busy || pending}>
          <label>
            Default Home/Work view
            <select
              value={layout.context}
              onChange={(e) => change({ ...layout, context: e.target.value as Layout['context'] })}
            >
              <option value="both">Home + Work</option>
              <option value="home">Home</option>
              <option value="work">Work</option>
            </select>
          </label>
          <label>
            Default calendar range
            <select
              value={layout.days}
              onChange={(e) => change({ ...layout, days: Number(e.target.value) as Layout['days'] })}
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
          </label>
          <p className="fine">
            Recipe and project sections appear in Home or Home + Work. The calendar limit counts displayed
            entries across the selected days.
          </p>
          {layout.sections.map((section, index) => (
            <div className="agenda-layout-row" key={section.kind}>
              <label className="agenda-toggle">
                <input
                  type="checkbox"
                  checked={section.enabled}
                  onChange={(e) =>
                    change({
                      ...layout,
                      sections: layout.sections.map((s, i) =>
                        i === index ? { ...s, enabled: e.target.checked } : s,
                      ),
                    })
                  }
                />
                {agendaSectionNames[section.kind]}
              </label>
              <label>
                Items
                <input
                  aria-label={`${agendaSectionNames[section.kind]} item limit`}
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={section.limit || ''}
                  onChange={(e) =>
                    change({
                      ...layout,
                      sections: layout.sections.map((s, i) =>
                        i === index ? { ...s, limit: Number(e.target.value) } : s,
                      ),
                    })
                  }
                />
              </label>
              <div className="agenda-order">
                {([-1, 1] as const).map((offset) => (
                  <button
                    key={offset}
                    type="button"
                    disabled={index + offset < 0 || index + offset >= layout.sections.length}
                    aria-label={`Move ${agendaSectionNames[section.kind]} ${offset === -1 ? 'up' : 'down'}`}
                    onClick={() => {
                      const sections = [...layout.sections];
                      [sections[index], sections[index + offset]] = [
                        sections[index + offset]!,
                        sections[index]!,
                      ];
                      change({ ...layout, sections });
                    }}
                  >
                    {offset === -1 ? '↑' : '↓'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
        <div className="agenda-layout-actions">
          <button
            className="primary"
            disabled={
              !buffer.ready || busy || pending || stale || !state.online || !isValid(AgendaLayout, layout)
            }
          >
            Save layout
          </button>
          <button
            type="button"
            disabled={!buffer.ready || busy || pending}
            onClick={() => change(defaultAgendaLayout())}
          >
            Use default layout
          </button>
          <button
            type="button"
            disabled={!buffer.ready || busy || pending}
            onClick={() => void buffer.reset().catch(onError)}
          >
            Discard draft and load saved layout
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
