import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  NavigationOrder,
  navigationSections,
  isValid,
  type NavigationSection,
  type SavedView,
} from '@our-place/contracts';
import { navigationItems } from './navigation.js';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { RecordDialog } from './RecordDialog.js';
import { useSavedForm } from './useSavedForm.js';
function readDraft(text: string): NavigationSection[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return isValid(NavigationOrder, value) ? value : null;
  } catch {
    return null;
  }
}

export function NavigationOrderEditor({
  client,
  state,
  view,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  view: Extract<SavedView, { kind: 'navigation' }> | undefined;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!,
    scopeId = session.scopes.find((s) => s.kind === 'private')!.scopeId;
  const buffer = useSavedForm(
    client,
    'navigation:order',
    () => ({ layout: JSON.stringify(view?.order ?? [...navigationSections]) }),
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
  const change = (value: NavigationSection[]) => buffer.field('layout', JSON.stringify(value));
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
      JSON.stringify(view.order) === buffer.values.layout
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
      !isValid(NavigationOrder, layout)
    )
      return;
    lock.current = true;
    setBusy(true);
    try {
      await buffer.save();
      const outcome = await run(
        { recordId: scopeId },
        'SetNavigationOrder',
        { scopeId, expectedViewRevision: buffer.baseRevision, order: layout },
        'Navigation order saved',
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
        title="Reorder navigation"
        subtitle="Saved draft recovery"
        close={closeSaved}
      >
        <p role="alert">This saved order draft cannot be opened. Your saved navigation is unchanged.</p>
        <button disabled={!buffer.ready || pending} onClick={() => void buffer.reset().catch(onError)}>
          Discard draft and load saved order
        </button>
      </RecordDialog>
    );
  return (
    <RecordDialog
      client={client}
      title="Reorder navigation"
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
        <p>Move sections up or down, then save your order.</p>
        {!state.online && (
          <p role="status">Offline · you can keep a draft here. Reconnect to save your order.</p>
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
            The saved order changed on another device. Your draft is kept; load the current settings before
            saving.
          </p>
        )}
        <fieldset disabled={!buffer.ready || busy || pending}>
          <legend>Section order</legend>
          {layout.map((id, index) => {
            const label = navigationItems.find((item) => item.id === id)!.label;
            return (
              <div className="navigation-order-row" key={id}>
                <span>{label}</span>
                <div className="agenda-order">
                  {([-1, 1] as const).map((offset) => (
                    <button
                      key={offset}
                      type="button"
                      disabled={index + offset < 0 || index + offset >= layout.length}
                      aria-label={`Move ${label} ${offset === -1 ? 'up' : 'down'}`}
                      onClick={() => {
                        const next = [...layout];
                        [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
                        change(next);
                      }}
                    >
                      {offset === -1 ? '↑' : '↓'}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </fieldset>
        <div className="agenda-layout-actions">
          <button
            className="primary"
            disabled={
              !buffer.ready || busy || pending || stale || !state.online || !isValid(NavigationOrder, layout)
            }
          >
            Save order
          </button>
          <button
            type="button"
            disabled={!buffer.ready || busy || pending}
            onClick={() => change([...navigationSections])}
          >
            Use default order
          </button>
          <button
            type="button"
            disabled={!buffer.ready || busy || pending}
            onClick={() => void buffer.reset().catch(onError)}
          >
            Discard draft and load saved order
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
