import { useState, type ReactNode } from 'react';
import { CaptureSources } from '../inbox/FilingLinks.js';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { ShoppingEntry, ShoppingGroup, ShoppingRecord } from '@our-place/contracts';
import { Icon } from '../Icon.js';
import { WebLink } from '../LinkedText.js';
import { date } from '../format.js';
import type { ShoppingRun } from './shared.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import type { Attachment } from '@our-place/contracts';

type Props = {
  client: ClientPlatform;
  state: ClientState;
  entries: ShoppingEntry[];
  groups: ShoppingGroup[];
  searching: boolean;
  initialGroupId?: string | null;
  disabled: (id: string) => boolean;
  action: (
    record: ShoppingRecord,
    kind: Parameters<ShoppingRun>[1],
    args: unknown,
    label: string,
  ) => Promise<void>;
  tools: (record: ShoppingRecord) => ReactNode;
  onOpenRecipe: (id: string) => void;
  onPhotos: (record: ShoppingRecord) => void;
  onHistory: (record: ShoppingRecord) => void;
  onEdit: (record: ShoppingRecord) => void;
};
function Photos({ client, photos, label }: { client: ClientPlatform; photos: Attachment[]; label: string }) {
  const [open, setOpen] = useState(false);
  if (!photos.length) return null;
  return (
    <details className="shopping-source" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {label} · {photos.length}
      </summary>
      {open && <AttachmentGallery client={client} attachments={photos} />}
    </details>
  );
}
function Group({ group, items, props }: { group: ShoppingGroup; items: ShoppingEntry[]; props: Props }) {
  const [open, setOpen] = useState(props.searching || props.initialGroupId === group.recordId),
    [limit, setLimit] = useState(20);
  const source = group.sourceRecipe,
    recipe = props.state.recipes.recipes.find((r) => r.recordId === source?.recipeId && r.deletedAt === null);
  return (
    <details className="shopping-group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <strong>{group.name}</strong>
        <span>
          {items.length} {items[0]?.state === 'purchased' ? 'purchased' : 'needed'}
        </span>
      </summary>
      <div className="shopping-group-content">
        <div className="shopping-row-footer">
          {source ? (
            recipe ? (
              <button className="shopping-recipe-link" onClick={() => props.onOpenRecipe(recipe.recordId)}>
                Recipe: {source.title}
              </button>
            ) : (
              <span className="fine">Recipe: {source.title} · deleted</span>
            )
          ) : (
            <span className="fine">Items stay on the list if you remove this group.</span>
          )}
          {props.tools(group)}
        </div>
        {items.slice(0, limit).map((item) => (
          <Entry key={item.recordId} item={item} props={props} />
        ))}
        {!items.length && (
          <p className="fine">No items in this view. Use an item’s Group menu to put it here.</p>
        )}
        {items.length > limit && (
          <button className="load-more" onClick={() => setLimit((n) => n + 20)}>
            Show more in {group.name} · {items.length - limit} remaining
          </button>
        )}
      </div>
    </details>
  );
}
export function ShoppingEntryDetails({
  item,
  props,
}: {
  item: ShoppingEntry;
  props: Pick<
    Props,
    'client' | 'state' | 'action' | 'disabled' | 'tools' | 'onOpenRecipe' | 'onPhotos' | 'onHistory'
  >;
}) {
  const { client, state, action, disabled, tools, onOpenRecipe } = props,
    snapshot = state.shopping;
  const purchase = snapshot.purchases.find(
    (p) => !p.deletedAt && p.items.some((i) => i.shoppingEntryId === item.recordId),
  );
  const product = snapshot.restockItems.find(
    (p) => p.recordId === item.restockItemId && p.scopeId === item.scopeId && p.deletedAt === null,
  );
  const lists = snapshot.lists.filter(
    (l) => !l.deletedAt && l.scopeId === item.scopeId && l.recordId !== item.listId,
  );
  const groups = (snapshot.groups ?? []).filter((g) => !g.deletedAt && g.listId === item.listId);
  const move = (listId: string, groupId?: string | null) =>
    void action(
      item,
      'MoveShoppingEntry',
      {
        recordId: item.recordId,
        expectedRevision: item.revision,
        listId,
        ...(groupId !== undefined ? { groupId } : {}),
      },
      'Moved shopping item',
    );
  return (
    <div className="shopping-entry-details">
      <CaptureSources recordId={item.recordId} state={state} collapsed />
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
      {product && <Photos client={client} photos={product.attachments ?? []} label="Product photos" />}
      {!!item.recipeSources?.length && (
        <details className="shopping-source">
          <summary>From a recipe</summary>
          {item.recipeSources.map((source) => {
            const recipe = state.recipes.recipes.find((r) => r.recordId === source.recipeId && !r.deletedAt);
            return (
              <div key={source.sourceId}>
                <p className="fine">
                  {recipe ? (
                    <button onClick={() => onOpenRecipe(recipe.recordId)}>
                      Recipe: {source.recipeTitle}
                    </button>
                  ) : (
                    `${source.recipeTitle} · recipe deleted`
                  )}
                </p>
                <p className="shopping-notes">{source.ingredientText}</p>
                <p className="fine">
                  Saved from recipe version {source.recipeRevision}
                  {source.quantitySnapshot ? ` · Shopping quantity: ${source.quantitySnapshot}` : ''}
                </p>
              </div>
            );
          })}
        </details>
      )}
      {purchase && (
        <div className="shopping-purchase">
          <p className="fine">
            Bought by {purchase.buyerName} · {date(purchase.boughtAt)}
          </p>
          <Photos client={client} photos={purchase.attachments ?? []} label="Receipt photos" />
          <div className="shopping-actions">
            <button onClick={() => props.onPhotos(purchase)}>Receipt photos</button>
            <button onClick={() => props.onHistory(purchase)}>Purchase history</button>
          </div>
        </div>
      )}
      {state.pendingEdits.includes(item.recordId) && (
        <p className="fine" role="status">
          Waiting for confirmation…
        </p>
      )}
      <div className="shopping-row-footer">
        {tools(item)}
        <div className="shopping-move-controls">
          {!!groups.length && (
            <label className="fine">
              Group
              <select
                aria-label={`Group for ${item.label}`}
                value={item.groupId ?? ''}
                disabled={disabled(item.recordId)}
                onChange={(e) => move(item.listId, e.target.value || null)}
              >
                <option value="">Ungrouped</option>
                {groups.map((g) => (
                  <option key={g.recordId} value={g.recordId}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!!lists.length && (
            <select
              aria-label={`Move ${item.label} to list`}
              value=""
              disabled={disabled(item.recordId)}
              onChange={(e) => {
                if (e.target.value) move(e.target.value);
              }}
            >
              <option value="">Move to…</option>
              {lists.map((l) => (
                <option key={l.recordId} value={l.recordId}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}
function Entry({ item, props }: { item: ShoppingEntry; props: Props }) {
  return (
    <article className={`shopping-row ${item.state === 'purchased' ? 'is-purchased' : ''}`}>
      {item.state === 'needed' ? (
        <button
          className="shopping-check"
          aria-label={`Bought ${item.label}`}
          disabled={props.disabled(item.recordId)}
          onClick={() =>
            void props.action(
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
            )
          }
        >
          <Icon name="check" size={22} />
        </button>
      ) : (
        <span className="shopping-check checked">
          <Icon name="check" size={22} />
        </span>
      )}
      <button
        type="button"
        className="shopping-item-open"
        onClick={() => props.onEdit(item)}
        aria-label={`Edit ${item.label}`}
      >
        <span className="shopping-item-title">
          <strong>{item.label}</strong>
          {item.quantity && <span>{item.quantity}</span>}
          {item.notes.trim() && item.notes.trim() !== item.label.trim() && (
            <span aria-label="Has description">
              <Icon name="inbox" size={16} />
            </span>
          )}
        </span>
      </button>
    </article>
  );
}

export function ShoppingItems(props: Props) {
  const [limit, setLimit] = useState(40);
  const ungrouped = props.entries.filter((item) => !item.groupId);
  const units = [
    ...ungrouped.map((item) => ({ item, group: null })),
    ...props.groups.map((group) => ({ item: null, group })),
  ];
  return (
    <div className="shopping-rows">
      {units
        .slice(0, limit)
        .map((unit) =>
          unit.item ? (
            <Entry key={unit.item.recordId} item={unit.item} props={props} />
          ) : (
            <Group
              key={unit.group!.recordId}
              group={unit.group!}
              items={props.entries.filter((item) => item.groupId === unit.group!.recordId)}
              props={props}
            />
          ),
        )}
      {units.length > limit && (
        <button className="load-more" onClick={() => setLimit((n) => n + 40)}>
          Show more · {units.length - limit} items or groups remaining
        </button>
      )}
    </div>
  );
}
