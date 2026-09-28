import type { InboxEntry } from '@our-place/contracts';

export function personalCardOrder(entries: InboxEntry[], saved: string[]) {
  const positions = new Map(saved.map((id, index) => [id, index]));
  return [...entries].sort((a, b) => {
    const left = positions.get(a.inboxId),
      right = positions.get(b.inboxId);
    // Newly captured cards stay discoverable above the saved order.
    if (left === undefined && right === undefined)
      return b.createdAt - a.createdAt || b.inboxId.localeCompare(a.inboxId);
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left - right;
  });
}

/** Reorder visible slots only, preserving filtered, deleted and paginated cards. */
export function moveVisibleCard(all: string[], visible: string[], from: string, to: string) {
  const source = visible.indexOf(from),
    target = visible.indexOf(to);
  if (source < 0 || target < 0 || source === target) return all;
  const moved = [...visible];
  moved.splice(source, 1);
  moved.splice(target, 0, from);
  const selected = new Set(visible);
  let index = 0;
  return all.map((id) => (selected.has(id) ? moved[index++]! : id));
}
