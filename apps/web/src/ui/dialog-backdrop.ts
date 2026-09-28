import type { MouseEvent } from 'react';

export function isDialogBackdropClick(event: MouseEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) return false;
  // The dialog itself receives clicks on both its padding and its backdrop.
  // Only coordinates outside its border box belong to the backdrop.
  const bounds = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  );
}
