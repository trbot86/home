import { useNavigationWrite } from '../NavigationHistory.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { ShoppingList } from '@our-place/contracts';
import type { ShoppingRun } from './shared.js';
export function QuickAdd({
  client,
  state,
  list,
  run,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  list: ShoppingList;
  run: ShoppingRun;
  onError: (error: unknown) => void;
}) {
  const writeEditor = useNavigationWrite(onError);
  const blank = () => ({ recordId: crypto.randomUUID(), label: '', quantity: '' });
  const [form, setForm] = useState(blank),
    [epoch, setEpoch] = useState(state.session!.serverEpoch),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const lock = useRef(false),
    key = `shopping:quick:${list.recordId}`,
    pending = state.pendingEdits.includes(form.recordId);
  useEffect(() => {
    let alive = true;
    void client
      .readEditor(key)
      .then((saved) => {
        if (!alive) return;
        if (saved) {
          const value = JSON.parse(saved.text);
          if (!['recordId', 'label', 'quantity'].every((field) => typeof value?.[field] === 'string'))
            throw new Error('Saved shopping draft needs recovery');
          setForm(value);
          setEpoch(saved.serverEpoch);
        }
        setReady(true);
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [client, key]);
  useEffect(() => {
    if (ready && state.shopping.entries.some((item) => item.recordId === form.recordId)) {
      setForm(blank());
      void client.clearEditor(key).catch(onError);
    }
  }, [client, ready, form.recordId, state.shopping.entries, key]);
  function update(field: 'label' | 'quantity', value: string) {
    const next = { ...form, [field]: value };
    setForm(next);
    void writeEditor(() => client.saveEditor(key, JSON.stringify(next), 1, epoch)).catch(onError);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      lock.current ||
      !ready ||
      !state.online ||
      pending ||
      epoch !== state.session!.serverEpoch ||
      !form.label.trim()
    )
      return;
    lock.current = true;
    setBusy(true);
    try {
      await writeEditor(() => client.saveEditor(key, JSON.stringify(form), 1, epoch));
      await run(
        form,
        'AddShoppingEntry',
        { ...form, listId: list.recordId, notes: '' },
        'Added to shopping',
        epoch,
      );
    } catch (error) {
      onError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="shopping-quick">
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className="shopping-quick-name">
          <span className="sr-only">Add a shopping item</span>
          <input
            value={form.label}
            maxLength={300}
            placeholder="Add something to this list…"
            disabled={!ready || busy || pending || !state.online}
            onChange={(event) => update('label', event.target.value)}
          />
        </label>
        <label className="shopping-quick-quantity">
          <span className="sr-only">Quick quantity</span>
          <input
            value={form.quantity}
            maxLength={120}
            placeholder="Quantity"
            disabled={!ready || busy || pending || !state.online}
            onChange={(event) => update('quantity', event.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={
            !ready ||
            busy ||
            pending ||
            !state.online ||
            !form.label.trim() ||
            epoch !== state.session!.serverEpoch
          }
        >
          Add item
        </button>
      </form>
      {(pending || !state.online) && <p className="fine">
        {pending
          ? 'Waiting for confirmation · your request is kept unchanged'
          : !state.online
            ? 'Read-only while offline. Inbox is available for new captures.'
            : ''}
      </p>}
      {epoch !== state.session!.serverEpoch && (
        <div className="notice">
          The server was restored. Review this draft before submitting.
          <button disabled={pending} onClick={() => setEpoch(state.session!.serverEpoch)}>
            Use current server
          </button>
        </div>
      )}
    </div>
  );
}
