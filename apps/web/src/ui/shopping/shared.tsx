import { useEffect, useRef, type ReactNode } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { CommandKind, CommandOutcome, ShoppingRecord, ShoppingSnapshot } from '@our-place/contracts';
import { Icon } from '../Icon.js';
export type ShoppingRun = (
  target: { recordId: string },
  kind: CommandKind,
  args: unknown,
  label: string,
  epoch?: string,
) => Promise<CommandOutcome | null>;
export const shoppingRecords = (snapshot: ShoppingSnapshot): ShoppingRecord[] => [
  ...snapshot.lists,
  ...snapshot.entries,
  ...snapshot.restockItems,
  ...snapshot.purchases,
  ...(snapshot.groups ?? []),
];
export const shoppingLabel = (record: ShoppingRecord) =>
  record.kind === 'shopping_entry'
    ? record.label
    : record.kind === 'purchase'
      ? record.items.map((item) => item.label).join(', ')
      : record.name;
export const shoppingKind = (record: ShoppingRecord) =>
  ({
    shopping_list: 'List',
    shopping_entry: 'Item',
    restock_item: 'Restock product',
    purchase: 'Purchase',
    shopping_group: 'Group',
  })[record.kind];
export function ShoppingDialog({
  client,
  title,
  close,
  children,
}: {
  client: ClientPlatform;
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  useEffect(
    () =>
      client.onBack?.(() => {
        closeRef.current();
        return true;
      }, 'dialog'),
    [client],
  );
  return (
    <dialog
      ref={ref}
      className="entry-dialog shopping-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="dialog-header">
        <div>
          <p className="eyebrow">Shopping & restocking</p>
          <h2>{title}</h2>
        </div>
        <button aria-label="Close shopping dialog" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
