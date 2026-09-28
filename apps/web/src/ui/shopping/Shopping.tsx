import { useNavigationState } from '../NavigationHistory.js';
import { useState } from 'react';
import { LinkedText, WebLink } from '../LinkedText.js';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { ShoppingRecord } from '@our-place/contracts';
import { Icon } from '../Icon.js';
import { ShoppingItems } from './ShoppingItems.js';
import { ShoppingEditor } from './ShoppingEditor.js';
import { ShoppingHistory } from './ShoppingHistory.js';
import { QuickAdd } from './QuickAdd.js';
import { ShoppingDialog, shoppingKind, shoppingLabel, shoppingRecords, type ShoppingRun } from './shared.js';
import './shopping.css';
import { AttachmentDialog, type AttachmentSaved } from '../AttachmentDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
type Tab = 'needed' | 'purchased' | 'restock' | 'deleted';
type Editor = { mode: 'list' | 'entry' | 'restock' | 'group'; record?: ShoppingRecord };
export function Shopping({
  client,
  state,
  run,
  onError,
  onOpenRecipe,
  onPhotosSaved,
  initialRecordId,
}: {
  client: ClientPlatform;
  state: ClientState;
  run: ShoppingRun;
  onError: (error: unknown) => void;
  onOpenRecipe: (id: string) => void;
  onPhotosSaved: AttachmentSaved;
  initialRecordId?: string | null;
}) {
  const initial = shoppingRecords(state.shopping).find((r) => r.recordId === initialRecordId);
  const [selectedList, setSelectedList] = useNavigationState(
      `Shopping.${initialRecordId ?? ''}.selectedList`,
      initial?.kind === 'shopping_list'
        ? initial.recordId
        : initial && 'listId' in initial
          ? initial.listId
          : '',
    ),
    [tab, setTab] = useNavigationState<Tab>(
      `Shopping.${initialRecordId ?? ''}.tab`,
      initial?.deletedAt != null
        ? 'deleted'
        : initial?.kind === 'restock_item'
          ? 'restock'
          : initial?.kind === 'purchase' ||
              (initial?.kind === 'shopping_entry' && initial.state === 'purchased')
            ? 'purchased'
            : 'needed',
    ),
    [search, setSearch] = useState(
      initial?.kind === 'shopping_entry' || initial?.kind === 'restock_item' ? shoppingLabel(initial) : '',
    ),
    [limit, setLimit] = useState(40);
  const [editor, setEditor] = useNavigationState<Editor | null>(
      `Shopping.${initialRecordId ?? ''}.editor`,
      null,
    ),
    [historyId, setHistoryId] = useNavigationState<string | null>(
      `Shopping.${initialRecordId ?? ''}.historyId`,
      initial?.kind === 'purchase' ? initial.recordId : null,
    ),
    [working, setWorking] = useState<string | null>(null);
  const [removingGroup, setRemovingGroup] = useNavigationState<string | null>(
    `Shopping.${initialRecordId ?? ''}.removingGroup`,
    null,
  );
  const [photosId, setPhotosId] = useNavigationState<string | null>(
    `Shopping.${initialRecordId ?? ''}.photosId`,
    null,
  );
  const snapshot = state.shopping,
    lists = snapshot.lists.filter((list) => !list.deletedAt),
    list = lists.find((item) => item.recordId === selectedList) ?? lists[0];
  const records = shoppingRecords(snapshot),
    history = records.find((record) => record.recordId === historyId);
  const photos = records.find(
    (record) =>
      record.recordId === photosId && (record.kind === 'restock_item' || record.kind === 'purchase'),
  );
  const openPhotos = (record: ShoppingRecord) => {
    setHistoryId(null);
    setPhotosId(record.recordId);
  };
  const updatedEditor = editor?.record
    ? records.find((record) => record.recordId === editor.record!.recordId)
    : undefined;
  const disabled = (id: string) => !state.online || state.pendingEdits.includes(id) || working === id;
  async function action(
    record: ShoppingRecord,
    kind: Parameters<ShoppingRun>[1],
    args: unknown,
    label: string,
  ) {
    if (disabled(record.recordId)) return;
    setWorking(record.recordId);
    try {
      await run(record, kind, args, label);
    } finally {
      setWorking(null);
    }
  }
  const matches = (record: ShoppingRecord) =>
    [shoppingLabel(record), 'notes' in record ? record.notes : '', 'model' in record ? record.model : '']
      .join(' ')
      .toLowerCase()
      .includes(search.toLowerCase());
  const entries = snapshot.entries
    .filter(
      (item) =>
        !item.deletedAt &&
        item.listId === list?.recordId &&
        item.state === (tab === 'purchased' ? 'purchased' : 'needed') &&
        (matches(item) || (snapshot.groups ?? []).some((g) => g.recordId === item.groupId && matches(g))),
    )
    .sort((a, b) => a.position - b.position || a.recordId.localeCompare(b.recordId));
  const groups = (snapshot.groups ?? [])
    .filter(
      (g) =>
        !g.deletedAt &&
        g.listId === list?.recordId &&
        (matches(g) || entries.some((e) => e.groupId === g.recordId)) &&
        (tab !== 'purchased' || entries.some((e) => e.groupId === g.recordId)),
    )
    .sort((a, b) => a.position - b.position);
  const removing = (snapshot.groups ?? []).find((g) => g.recordId === removingGroup);
  const products = snapshot.restockItems.filter(
    (item) => !item.deletedAt && (!list || item.scopeId === list.scopeId) && matches(item),
  );
  const deleted = records.filter(
    (item) => item.kind !== 'purchase' && item.deletedAt !== null && matches(item),
  );
  const neededCount = snapshot.entries.filter(
    (item) => !item.deletedAt && item.listId === list?.recordId && item.state === 'needed',
  ).length;
  const count = tab === 'restock' ? products.length : tab === 'deleted' ? deleted.length : entries.length;
  const scopeName = (scopeId: string) =>
    state.session!.scopes.find((scope) => scope.scopeId === scopeId)?.kind === 'private'
      ? 'Just me'
      : 'Shared';
  const edit = (record: ShoppingRecord) =>
    setEditor({
      mode:
        record.kind === 'shopping_list'
          ? 'list'
          : record.kind === 'restock_item'
            ? 'restock'
            : record.kind === 'shopping_group'
              ? 'group'
              : 'entry',
      record,
    });
  const remove = (record: ShoppingRecord) => {
    if (record.kind === 'shopping_group') {
      setRemovingGroup(record.recordId);
      return;
    }
    void action(
      record,
      'DeleteShoppingRecord',
      { recordId: record.recordId, expectedRevision: record.revision },
      'Moved to shopping trash',
    );
  };
  const tools = (record: ShoppingRecord) => (
    <div className="shopping-actions">
      <button disabled={disabled(record.recordId)} onClick={() => edit(record)}>
        Edit
      </button>
      <button onClick={() => setHistoryId(record.recordId)}>History</button>
      {record.kind === 'restock_item' && <button onClick={() => openPhotos(record)}>Product photos</button>}
      <button
        aria-label={`Delete ${shoppingLabel(record)}`}
        disabled={disabled(record.recordId)}
        onClick={() => remove(record)}
      >
        <Icon name="trash" size={16} />
      </button>
    </div>
  );
  return (
    <section className="shopping" aria-label="Shopping and restocking">
      <div className="shopping-toolbar">
        <label className="shopping-list-picker">
          <span className="sr-only">Shopping list</span>
          <select
            aria-label="Shopping list"
            value={list?.recordId ?? ''}
            onChange={(event) => {
              setSelectedList(event.target.value);
              setLimit(40);
              setSearch('');
            }}
          >
            {!lists.length && <option value="">No lists yet</option>}
            {lists.map((item) => (
              <option key={item.recordId} value={item.recordId}>
                {item.name}
                {scopeName(item.scopeId) === 'Just me' ? ' · Just me' : ''}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={!state.online} onClick={() => setEditor({ mode: 'list' })}>
          <Icon name="plus" size={17} /> New list
        </button>
      </div>
      {list && (
        <div className="shopping-list-heading">
          <div>
            <p className="eyebrow">
              {scopeName(list.scopeId)} · {list.purpose}
            </p>
            <h2>
              {list.name}
              <span className="shopping-total">{neededCount} needed</span>
            </h2>
          </div>
          {tools(list)}
        </div>
      )}
      <div className="shopping-tabs" role="group" aria-label="Shopping views">
        {(['needed', 'purchased', 'restock', 'deleted'] as const).map((value) => (
          <button
            key={value}
            aria-pressed={tab === value}
            onClick={() => {
              setTab(value);
              setLimit(40);
              setSearch('');
            }}
          >
            {
              { needed: 'Need to buy', purchased: 'Purchased', restock: 'Restock shelf', deleted: 'Deleted' }[
                value
              ]
            }
          </button>
        ))}
      </div>
      {list && tab === 'needed' && (
        <QuickAdd key={list.recordId} client={client} state={state} list={list} run={run} onError={onError} />
      )}
      <div className="shopping-filter">
        <label className="search">
          <Icon name="search" size={17} />
          <input
            aria-label="Search shopping"
            placeholder={tab === 'restock' ? 'Find a restock product…' : 'Find an item…'}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(40);
            }}
          />
        </label>
        {tab === 'restock' ? (
          <button disabled={!state.online} onClick={() => setEditor({ mode: 'restock' })}>
            <Icon name="plus" size={16} /> New product
          </button>
        ) : tab === 'needed' && list ? (
          <div className="shopping-actions">
            <button disabled={!state.online} onClick={() => setEditor({ mode: 'group' })}>
              New group
            </button>
            <button disabled={!state.online} onClick={() => setEditor({ mode: 'entry' })}>
              Add with notes
            </button>
          </div>
        ) : null}
      </div>
      {!list && tab !== 'deleted' && tab !== 'restock' ? (
        <div className="shopping-empty">
          <Icon name="shopping" size={38} />
          <h3>A place for what you need.</h3>
          <p>Create a list for groceries, the house, things you want, or gifts.</p>
          <button className="primary" disabled={!state.online} onClick={() => setEditor({ mode: 'list' })}>
            Create a list
          </button>
        </div>
      ) : count === 0 && !((tab === 'needed' || tab === 'purchased') && groups.length) ? (
        <div className="shopping-empty">
          <Icon name={tab === 'restock' ? 'refresh' : 'check'} size={30} />
          <h3>
            {search
              ? 'No matches'
              : tab === 'needed'
                ? 'All caught up.'
                : tab === 'purchased'
                  ? 'Purchases will appear here.'
                  : tab === 'restock'
                    ? 'Remember the exact product.'
                    : 'Nothing deleted.'}
          </h3>
          <p>
            {tab === 'restock'
              ? 'Save the model, size and link once. Tap Need this next time.'
              : tab === 'needed'
                ? 'Add something above, or pick from your restock shelf.'
                : tab === 'purchased'
                  ? 'Check an item off when you buy it. We’ll keep who bought it and when.'
                  : 'Your records keep their history.'}
          </p>
        </div>
      ) : null}
      {(tab === 'needed' || tab === 'purchased') && list && (
        <ShoppingItems
          key={list.recordId + ':' + tab + ':' + search}
          client={client}
          state={state}
          entries={entries}
          groups={groups}
          searching={!!search}
          initialGroupId={initial?.kind === 'shopping_group' ? initial.recordId : null}
          disabled={disabled}
          action={action}
          tools={tools}
          onOpenRecipe={onOpenRecipe}
          onPhotos={openPhotos}
          onHistory={(record) => setHistoryId(record.recordId)}
        />
      )}
      {tab === 'restock' && (
        <div className="restock-grid">
          {products.slice(0, limit).map((product) => {
            const existing = snapshot.entries.some(
              (item) =>
                !item.deletedAt &&
                item.listId === list?.recordId &&
                item.restockItemId === product.recordId &&
                item.state === 'needed',
            );
            return (
              <article className="restock-card" key={product.recordId}>
                <div className="restock-card-heading">
                  <Icon name="refresh" />
                  <span className="scope-badge">{scopeName(product.scopeId)}</span>
                </div>
                <h3>{product.name}</h3>
                <AttachmentGallery client={client} attachments={product.attachments ?? []} />
                {product.model && <p>{product.model}</p>}
                {product.quantity && <p className="fine">Usually {product.quantity}</p>}
                {product.notes && (
                  <p className="shopping-notes">
                    <LinkedText client={client} text={product.notes} />
                  </p>
                )}
                {product.productUrl && (
                  <WebLink client={client} href={product.productUrl}>
                    Open product link ↗
                  </WebLink>
                )}
                <button
                  className="primary restock-need"
                  disabled={!list || disabled(product.recordId) || existing}
                  onClick={() => {
                    if (list)
                      void action(
                        product,
                        'NeedRestockItem',
                        {
                          recordId: crypto.randomUUID(),
                          listId: list.recordId,
                          restockItemId: product.recordId,
                          expectedRestockRevision: product.revision,
                        },
                        'Added from restock shelf',
                      );
                  }}
                >
                  {existing ? 'Already on this list' : list ? 'Need this' : 'Choose a list first'}
                </button>
                {tools(product)}
              </article>
            );
          })}
        </div>
      )}
      {tab === 'deleted' && (
        <div className="shopping-rows">
          {deleted.slice(0, limit).map((record) => (
            <article className="shopping-row" key={record.recordId}>
              <div className="shopping-row-body">
                <p className="fine">
                  {shoppingKind(record)} · {scopeName(record.scopeId)}
                </p>
                <h3>{shoppingLabel(record)}</h3>
              </div>
              <div className="shopping-actions">
                <button
                  disabled={disabled(record.recordId)}
                  onClick={() => {
                    void action(
                      record,
                      record.kind === 'shopping_group' ? 'RestoreShoppingGroup' : 'RestoreShoppingRecord',
                      { recordId: record.recordId, expectedRevision: record.revision },
                      'Restored',
                    );
                  }}
                >
                  Restore
                </button>
                <button onClick={() => setHistoryId(record.recordId)}>History</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {(tab === 'restock' || tab === 'deleted') && count > limit && (
        <button className="load-more" onClick={() => setLimit((value) => value + 40)}>
          Show more · {count - limit} remaining
        </button>
      )}
      <p className="shopping-footnote fine">
        {state.online ? 'Shared changes refresh across devices.' : 'Offline · showing the last saved lists.'}{' '}
        Buying a replacement doesn’t mark it installed.
      </p>
      {editor && (
        <ShoppingEditor
          client={client}
          state={state}
          mode={editor.mode}
          {...(updatedEditor ? { record: updatedEditor } : {})}
          {...(list ? { list } : {})}
          run={run}
          close={() => setEditor(null)}
          onSaved={(id) => {
            if (editor.mode === 'list' && !editor.record) {
              setSelectedList(id);
              setTab('needed');
              setSearch('');
            }
          }}
          onError={onError}
        />
      )}
      {photos && (
        <AttachmentDialog
          client={client}
          target={photos}
          title={shoppingLabel(photos)}
          online={state.online}
          serverEpoch={state.session!.serverEpoch}
          pending={state.pendingEdits.includes(photos.recordId)}
          close={() => setPhotosId(null)}
          onSaved={onPhotosSaved}
        />
      )}
      {history && (
        <ShoppingHistory
          client={client}
          state={state}
          record={history}
          run={run}
          close={() => setHistoryId(null)}
          onError={onError}
          onPhotos={openPhotos}
        />
      )}
      {removing && (
        <ShoppingDialog client={client} title="Remove group" close={() => setRemovingGroup(null)}>
          <p>Remove “{removing.name}”? Its items will stay on the list, ungrouped.</p>
          <div className="dialog-footer">
            <button onClick={() => setRemovingGroup(null)}>Keep group</button>
            <button
              disabled={disabled(removing.recordId)}
              onClick={() => {
                void action(
                  removing,
                  'DeleteShoppingGroup',
                  {
                    recordId: removing.recordId,
                    expectedRevision: removing.revision,
                    members: snapshot.entries
                      .filter((e) => !e.deletedAt && e.groupId === removing.recordId)
                      .map((e) => ({ recordId: e.recordId, expectedRevision: e.revision })),
                  },
                  'Group removed; items kept',
                ).then(() => setRemovingGroup(null));
              }}
            >
              Remove group, keep items
            </button>
          </div>
        </ShoppingDialog>
      )}
    </section>
  );
}
