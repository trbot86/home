import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { CommandKind, ShoppingList, ShoppingRecord } from '@our-place/contracts';
import { ShoppingDialog, shoppingRecords, type ShoppingRun } from './shared.js';
type Form = {
  recordId: string;
  scopeId: string;
  name: string;
  label: string;
  quantity: string;
  notes: string;
  model: string;
  productUrl: string;
  purpose: string;
};
export function ShoppingEditor({
  client,
  state,
  mode,
  record,
  list,
  run,
  close,
  onSaved,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  mode: 'list' | 'entry' | 'restock' | 'group';
  record?: ShoppingRecord;
  list?: ShoppingList;
  run: ShoppingRun;
  close: () => void;
  onSaved: (recordId: string) => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!;
  const initial = (): Form => ({
    recordId: record?.recordId ?? crypto.randomUUID(),
    scopeId:
      record?.scopeId ??
      (mode === 'entry' || mode === 'group' ? list?.scopeId : undefined) ??
      session.scopes.find((scope) => scope.kind === 'private')!.scopeId,
    name: record && 'name' in record ? record.name : mode === 'list' ? 'Groceries' : '',
    label: record?.kind === 'shopping_entry' ? record.label : '',
    quantity: record && 'quantity' in record ? record.quantity : '',
    notes: record && 'notes' in record ? record.notes : '',
    model: record?.kind === 'restock_item' ? record.model : '',
    productUrl: record?.kind === 'restock_item' ? (record.productUrl ?? '') : '',
    purpose: record?.kind === 'shopping_list' ? record.purpose : 'groceries',
  });
  const key =
    record?.recordId ??
    `shopping:new:${mode}:${mode === 'entry' || mode === 'group' ? list!.recordId : 'default'}`;
  const [form, setForm] = useState(initial),
    [baseRevision, setBaseRevision] = useState(record?.revision ?? 1),
    [baseEpoch, setBaseEpoch] = useState(session.serverEpoch);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submitLock = useRef(false),
    closeRef = useRef(() => {
      onSaved(form.recordId);
      close();
    });
  closeRef.current = () => {
    onSaved(form.recordId);
    close();
  };
  useEffect(() => {
    let alive = true;
    void client
      .readEditor(key)
      .then((saved) => {
        if (!alive) return;
        if (saved) {
          const parsed: unknown = JSON.parse(saved.text);
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            Object.keys(form).some((field) => typeof (parsed as Record<string, unknown>)[field] !== 'string')
          )
            throw new Error('Saved form needs recovery');
          const value = parsed as Form;
          if (record && value.recordId !== record.recordId)
            throw new Error('Saved form belongs to another record');
          setForm(value);
          setBaseRevision(saved.baseRevision);
          setBaseEpoch(saved.serverEpoch);
        }
        setReady(true);
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [client, key]);
  const pending = state.pendingEdits.includes(form.recordId),
    stale = (record && record.revision !== baseRevision) || session.serverEpoch !== baseEpoch;
  useEffect(() => {
    if (ready && !record && shoppingRecords(state.shopping).some((item) => item.recordId === form.recordId))
      void client
        .clearEditor(key)
        .then(() => closeRef.current())
        .catch(onError);
  }, [client, state.shopping, form.recordId, ready, record, key]);
  function update(field: keyof Form, value: string) {
    const next = { ...form, [field]: value };
    setForm(next);
    void client.saveEditor(key, JSON.stringify(next), baseRevision, baseEpoch).catch(onError);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy || pending || stale || !state.online || submitLock.current) return;
    submitLock.current = true;
    setBusy(true);
    setError('');
    try {
      await client.saveEditor(key, JSON.stringify(form), baseRevision, baseEpoch);
      const target = {
        recordId: form.recordId,
        ...(record ? { expectedRevision: baseRevision } : { scopeId: form.scopeId }),
      };
      let kind: CommandKind, args: unknown;
      if (mode === 'group') {
        kind = record ? 'UpdateShoppingGroup' : 'CreateShoppingGroup';
        args = {
          recordId: form.recordId,
          ...(record ? { expectedRevision: baseRevision } : { listId: list!.recordId }),
          name: form.name,
        };
      } else if (mode === 'list') {
        kind = record ? 'UpdateShoppingList' : 'CreateShoppingList';
        args = { ...target, name: form.name, purpose: form.purpose };
      } else if (mode === 'restock') {
        kind = record ? 'UpdateRestockItem' : 'CreateRestockItem';
        args = {
          ...target,
          name: form.name,
          model: form.model,
          quantity: form.quantity,
          notes: form.notes,
          productUrl: form.productUrl || null,
        };
      } else {
        kind = record ? 'UpdateShoppingEntry' : 'AddShoppingEntry';
        args = {
          recordId: form.recordId,
          ...(record ? { expectedRevision: baseRevision } : { listId: list!.recordId }),
          label: form.label,
          quantity: form.quantity,
          notes: form.notes,
        };
      }
      const outcome = await run(
        { recordId: form.recordId },
        kind,
        args,
        record ? 'Shopping details updated' : 'Added to shopping',
        baseEpoch,
      );
      if (outcome?.status === 'Applied') {
        await client.clearEditor(key);
        closeRef.current();
      } else
        setError(
          outcome?.status === 'Rejected'
            ? outcome.code.replaceAll('_', ' ')
            : 'Waiting for confirmation. This form is kept on this device.',
        );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
      submitLock.current = false;
    }
  }
  const disabled = !ready || busy || pending || !state.online;
  const field = (name: keyof Form, label: string, max = 300) => (
    <label className="shopping-field">
      {label}
      <input
        aria-label={label}
        value={form[name]}
        maxLength={max}
        required={name === 'name' || name === 'label'}
        onChange={(event) => update(name, event.target.value)}
      />
    </label>
  );
  return (
    <ShoppingDialog
      client={client}
      title={`${record ? 'Edit' : 'New'} ${mode === 'restock' ? 'restock product' : mode === 'list' ? 'list' : mode === 'group' ? 'group' : 'shopping item'}`}
      close={close}
    >
      <form
        className="shopping-form"
        onSubmit={(event) => {
          void submit(event);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <fieldset disabled={disabled}>
          {mode === 'entry' ? field('label', 'Item') : field('name', 'Name')}
          {mode === 'list' ? (
            <label className="shopping-field">
              Kind of list
              <select
                aria-label="Kind of list"
                value={form.purpose}
                onChange={(event) => update('purpose', event.target.value)}
              >
                {['groceries', 'household', 'wants', 'gifts'].map((value) => (
                  <option key={value} value={value}>
                    {value[0]!.toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            mode !== 'group' && field('quantity', 'Quantity', 120)
          )}
          {mode === 'restock' && (
            <>
              {field('model', 'Model or size', 500)}
              {field('productUrl', 'Product link (optional)', 4096)}
            </>
          )}
          {mode !== 'list' && mode !== 'group' && (
            <label className="shopping-field">
              Notes
              <textarea
                aria-label="Notes"
                rows={3}
                value={form.notes}
                maxLength={10000}
                onChange={(event) => update('notes', event.target.value)}
              />
            </label>
          )}
          {!record && mode !== 'entry' && mode !== 'group' && (
            <label className="shopping-field">
              Who can see this
              <select
                aria-label="Who can see this"
                value={form.scopeId}
                onChange={(event) => update('scopeId', event.target.value)}
              >
                {session.scopes.map((scope) => (
                  <option key={scope.scopeId} value={scope.scopeId}>
                    {scope.kind === 'shared' ? 'Shared' : 'Just me'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {stale && (
          <div className="notice">
            <p>This record or server changed since your draft began. Your form is kept.</p>
            <button
              type="button"
              disabled={!state.online || pending}
              onClick={() => {
                setForm(initial());
                setBaseRevision(record?.revision ?? 1);
                setBaseEpoch(session.serverEpoch);
                void client.clearEditor(key).catch(onError);
              }}
            >
              Reload latest
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <span className="fine">
            {pending
              ? 'Waiting for confirmation'
              : !state.online
                ? 'Connect to save; use Inbox for offline capture'
                : 'Unfinished details stay on this device · Ctrl ↵ to save'}
          </span>
          <button className="primary" disabled={disabled || !!stale}>
            {busy ? 'Saving…' : record ? 'Save changes' : 'Add'}
          </button>
        </div>
      </form>
    </ShoppingDialog>
  );
}
