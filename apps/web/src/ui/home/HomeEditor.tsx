import { SecureRecord } from '../SecureRecord.js';
import { ShareRecord } from '../ShareRecord.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { CommandKind, HomeAsset, MaintenanceRecord } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
import { localDateTime } from '../tasks/shared.js';

export function HomeEditor({
  client,
  state,
  mode,
  asset,
  service,
  run,
  close,
  onSaved,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  mode: 'asset' | 'service';
  asset?: HomeAsset;
  service?: MaintenanceRecord;
  run: RunRecordCommand;
  close: () => void;
  onSaved: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!,
    record = mode === 'asset' ? asset : service;
  const initial = () => ({
    recordId: record?.recordId ?? crypto.randomUUID(),
    scopeId: asset?.scopeId ?? session.scopes.find((scope) => scope.kind === 'private')!.scopeId,
    name: asset?.name ?? '',
    model: asset?.model ?? '',
    serial: asset?.serial ?? '',
    location: asset?.location ?? '',
    acquiredDate: asset?.acquiredDate ?? '',
    notes: mode === 'asset' ? (asset?.notes ?? '') : (service?.notes ?? ''),
    occurredAt: localDateTime(service?.occurredAt ?? Date.now()),
    costAmount: service?.costAmount ?? '',
    currency: service?.currency ?? '',
  });
  const buffer = useSavedForm(
    client,
    record?.recordId ?? (mode === 'asset' ? 'home:asset:new' : `home:service:new:${asset!.recordId}`),
    initial,
    record?.revision ?? 1,
    session.serverEpoch,
    onError,
  );
  const form = buffer.values,
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false),
    finished = useRef(false);
  const pending = state.pendingEdits.includes(form.recordId);
  const stale = (record && record.revision !== buffer.baseRevision) || buffer.epoch !== session.serverEpoch;
  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    try {
      await buffer.clear();
      onSaved(mode === 'asset' ? form.recordId : asset!.recordId);
      close();
    } catch (error) {
      finished.current = false;
      onError(error);
    }
  };
  useEffect(() => {
    if (
      !record &&
      buffer.ready &&
      [...state.home.assets, ...state.home.serviceRecords].some((row) => row.recordId === form.recordId)
    )
      void finish();
  }, [record, buffer.ready, state.home, form.recordId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!buffer.ready || lock.current || pending || stale || !state.online) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await buffer.save();
      let kind: CommandKind, args: unknown;
      if (mode === 'asset') {
        const fields = {
          name: form.name,
          model: form.model,
          serial: form.serial,
          location: form.location,
          acquiredDate: form.acquiredDate || null,
          notes: form.notes,
        };
        kind = record ? 'UpdateHomeAsset' : 'CreateHomeAsset';
        args = {
          recordId: form.recordId,
          ...(record ? { expectedRevision: buffer.baseRevision } : { scopeId: form.scopeId }),
          ...fields,
        };
      } else {
        const occurredAt =
          service && (service.completionId || form.occurredAt === localDateTime(service.occurredAt))
            ? service.occurredAt
            : new Date(form.occurredAt).getTime();
        if (!Number.isFinite(occurredAt) || localDateTime(occurredAt) !== form.occurredAt) {
          setError('Choose a valid local date and time.');
          return;
        }
        if (!!form.costAmount !== !!form.currency) {
          setError('Enter both a cost and its currency, or leave both blank.');
          return;
        }
        const fields = {
          occurredAt,
          notes: form.notes,
          costAmount: form.costAmount || null,
          currency: form.currency ? form.currency.toUpperCase() : null,
        };
        kind = record ? 'UpdateMaintenanceRecord' : 'CreateMaintenanceRecord';
        args = {
          recordId: form.recordId,
          ...(record
            ? { expectedRevision: buffer.baseRevision }
            : { scopeId: asset!.scopeId, assetId: asset!.recordId }),
          ...fields,
        };
      }
      const outcome = await run(
        { recordId: form.recordId },
        kind,
        args,
        mode === 'asset'
          ? record
            ? 'Asset updated'
            : 'Asset added'
          : record
            ? 'Service entry updated'
            : 'Service recorded',
        buffer.epoch,
      );
      if (outcome?.status === 'Applied') await finish();
      else
        setError(
          outcome?.status === 'Rejected'
            ? outcome.code.replaceAll('_', ' ')
            : 'Waiting for confirmation. Your details are kept.',
        );
    } catch (error) {
      onError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const disabled = !buffer.ready || busy || pending || !state.online;
  const field = (key: keyof typeof form, label: string, type = 'text', required = false) => (
    <label className="task-field">
      {label}
      <input
        aria-label={label}
        type={type}
        value={form[key]}
        maxLength={300}
        required={required}
        onChange={(event) => buffer.field(key, event.target.value)}
      />
    </label>
  );
  return (
    <RecordDialog
      client={client}
      title={
        mode === 'asset'
          ? record
            ? 'Edit asset'
            : 'New asset'
          : record
            ? 'Edit service entry'
            : 'Record past service'
      }
      subtitle={mode === 'asset' ? 'A home for the details' : asset!.name}
      className="task-dialog"
      close={() => {
        void buffer.flush().then(close).catch(onError);
      }}
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
          {mode === 'asset' ? (
            <>
              {field('name', 'Asset name', 'text', true)}
              <div className="task-form-row">
                {field('model', 'Model')}
                {field('serial', 'Serial number')}
              </div>
              <div className="task-form-row">
                {field('location', 'Location')}
                {field('acquiredDate', 'Acquired on', 'date')}
              </div>
              {!record && (
                <label className="task-field">
                  Who can see this
                  <select
                    aria-label="Who can see this"
                    value={form.scopeId}
                    onChange={(event) => buffer.field('scopeId', event.target.value)}
                  >
                    {session.scopes.map((scope) => (
                      <option value={scope.scopeId} key={scope.scopeId}>
                        {scope.kind === 'shared' ? 'Shared' : 'Just me'}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          ) : (
            <>
              <label className="task-field">
                Service performed at
                <input
                  aria-label="Service performed at"
                  type="datetime-local"
                  required
                  readOnly={!!service?.completionId}
                  value={form.occurredAt}
                  onChange={(event) => buffer.field('occurredAt', event.target.value)}
                />
              </label>
              <p className="fine">
                {service?.completionId
                  ? 'This time comes from the task completion.'
                  : 'This records past work without completing a current task or moving its next date.'}
              </p>
              <div className="task-form-row">
                <label className="task-field">
                  Cost (optional)
                  <input
                    aria-label="Cost (optional)"
                    inputMode="decimal"
                    pattern="(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,4})?"
                    value={form.costAmount}
                    onChange={(event) => buffer.field('costAmount', event.target.value)}
                  />
                </label>
                <label className="task-field">
                  Currency
                  <input
                    aria-label="Currency"
                    placeholder="e.g. CAD"
                    maxLength={3}
                    pattern="[A-Za-z]{3}"
                    value={form.currency}
                    onChange={(event) => buffer.field('currency', event.target.value.toUpperCase())}
                  />
                </label>
              </div>
            </>
          )}
          <label className="task-field">
            {mode === 'asset' ? 'Asset notes' : 'Service notes'}
            <textarea
              aria-label={mode === 'asset' ? 'Asset notes' : 'Service notes'}
              rows={5}
              maxLength={20000}
              value={form.notes}
              onChange={(event) => buffer.field('notes', event.target.value)}
            />
          </label>
        </fieldset>
        {stale && (
          <div className="notice">
            This record changed. Your unfinished text is kept.
            <button
              type="button"
              disabled={pending || !state.online}
              onClick={() => {
                void buffer.reset().catch(onError);
              }}
            >
              Reload latest
            </button>
          </div>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <span className="fine">
            {pending ? 'Waiting for confirmation' : 'Unfinished text stays on this device · Ctrl ↵ to save'}
          </span>
          <button className="primary" disabled={disabled || !!stale}>
            {busy ? 'Saving…' : record ? 'Save changes' : mode === 'asset' ? 'Add asset' : 'Record service'}
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
