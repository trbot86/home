import { useState } from 'react';
import { LinkedText, WebLink } from '../LinkedText.js';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { ShoppingRecord } from '@our-place/contracts';
import { Icon } from '../Icon.js';
import { date } from '../format.js';
import { ShoppingEditor } from './ShoppingEditor.js';
import { ShoppingHistory } from './ShoppingHistory.js';
import { QuickAdd } from './QuickAdd.js';
import { shoppingKind, shoppingLabel, shoppingRecords, type ShoppingRun } from './shared.js';
import './shopping.css';
type Tab = 'needed' | 'purchased' | 'restock' | 'deleted';
type Editor = { mode: 'list' | 'entry' | 'restock'; record?: ShoppingRecord };
export function Shopping({
  client,
  state,
  run,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  run: ShoppingRun;
  onError: (error: unknown) => void;
}) {
  const [selectedList, setSelectedList] = useState(''),
    [tab, setTab] = useState<Tab>('needed'),
    [search, setSearch] = useState(''),
    [limit, setLimit] = useState(40);
  const [editor, setEditor] = useState<Editor | null>(null),
    [historyId, setHistoryId] = useState<string | null>(null),
    [working, setWorking] = useState<string | null>(null);
  const snapshot = state.shopping,
    lists = snapshot.lists.filter((list) => !list.deletedAt),
    list = lists.find((item) => item.recordId === selectedList) ?? lists[0];
  const records = shoppingRecords(snapshot),
    history = records.find((record) => record.recordId === historyId);
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
        matches(item),
    )
    .sort((a, b) => a.position - b.position || a.recordId.localeCompare(b.recordId));
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
      mode: record.kind === 'shopping_list' ? 'list' : record.kind === 'restock_item' ? 'restock' : 'entry',
      record,
    });
  const remove = (record: ShoppingRecord) => {
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
          <button disabled={!state.online} onClick={() => setEditor({ mode: 'entry' })}>
            Add with notes
          </button>
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
      ) : count === 0 ? (
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
        <div className="shopping-rows">
          {entries.slice(0, limit).map((item) => {
            const purchase = snapshot.purchases.find(
              (p) => !p.deletedAt && p.items.some((line) => line.shoppingEntryId === item.recordId),
            );
            const product = snapshot.restockItems.find((p) => p.recordId === item.restockItemId);
            return (
              <article
                className={`shopping-row ${item.state === 'purchased' ? 'is-purchased' : ''}`}
                key={item.recordId}
              >
                {item.state === 'needed' ? (
                  <button
                    className="shopping-check"
                    aria-label={`Bought ${item.label}`}
                    disabled={disabled(item.recordId)}
                    onClick={() => {
                      void action(
                        item,
                        'PurchaseShoppingEntry',
                        {
                          recordId: item.recordId,
                          expectedRevision: item.revision,
                          purchaseId: crypto.randomUUID(),
                          purchaseItemId: crypto.randomUUID(),
                          boughtAt: Date.now(),
                        },
                        'Purchase recorded',
                      );
                    }}
                  >
                    <Icon name="check" size={22} />
                  </button>
                ) : (
                  <span className="shopping-check checked">
                    <Icon name="check" size={22} />
                  </span>
                )}
                <div className="shopping-row-body">
                  <div className="shopping-item-title">
                    <h3>{item.label}</h3>
                    {item.quantity && <span>{item.quantity}</span>}
                  </div>
                  {item.notes && (
                    <p className="shopping-notes">
                      <LinkedText client={client} text={item.notes} />
                    </p>
                  )}
                  {product && (
                    <p className="fine">
                      {product.model || 'From your restock shelf'}
                      {product.productUrl && (
                        <>
                          {' '}
                          ·{' '}
                          <WebLink client={client} href={product.productUrl}>
                            Product link
                          </WebLink>
                        </>
                      )}
                    </p>
                  )}
                  {purchase && (
                    <p className="fine">
                      Bought by {purchase.buyerName} · {date(purchase.boughtAt)}
                    </p>
                  )}
                  {state.pendingEdits.includes(item.recordId) && (
                    <p className="fine" role="status">
                      Waiting for confirmation…
                    </p>
                  )}
                  <div className="shopping-row-footer">
                    {tools(item)}
                    {lists.some(
                      (other) => other.scopeId === item.scopeId && other.recordId !== item.listId,
                    ) && (
                      <select
                        aria-label={`Move ${item.label} to list`}
                        value=""
                        disabled={disabled(item.recordId)}
                        onChange={(event) => {
                          if (event.target.value)
                            void action(
                              item,
                              'MoveShoppingEntry',
                              {
                                recordId: item.recordId,
                                expectedRevision: item.revision,
                                listId: event.target.value,
                              },
                              'Moved to list',
                            );
                        }}
                      >
                        <option value="">Move to…</option>
                        {lists
                          .filter((other) => other.scopeId === item.scopeId && other.recordId !== item.listId)
                          .map((other) => (
                            <option key={other.recordId} value={other.recordId}>
                              {other.name}
                            </option>
                          ))}
                      </select>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
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
                      'RestoreShoppingRecord',
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
      {count > limit && (
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
      {history && (
        <ShoppingHistory
          client={client}
          state={state}
          record={history}
          run={run}
          close={() => setHistoryId(null)}
          onError={onError}
        />
      )}
    </section>
  );
}
