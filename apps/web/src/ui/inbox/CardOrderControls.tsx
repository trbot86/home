import { useEffect, useRef, useState } from 'react';

export function CardOrderControls({
  id,
  ids,
  disabled,
  move,
  highlight,
}: {
  id: string;
  ids: string[];
  disabled: boolean;
  move: (from: string, to: string) => void;
  highlight: (id: string | null) => void;
}) {
  const pointer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const index = ids.indexOf(id);
  const cancel = () => {
    pointer.current = null;
    setDragging(false);
    highlight(null);
  };
  useEffect(() => {
    cancel();
  }, [ids.join(), disabled]);
  useEffect(() => () => highlight(null), []);
  const targetAt = (x: number, y: number) => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-card-id]')?.dataset.cardId;
    return target && ids.includes(target) ? target : null;
  };
  return (
    <div className="card-order-controls" role="group" aria-label="Card position">
      <button
        type="button"
        className="card-drag-handle"
        aria-label="Drag to reorder card"
        aria-pressed={dragging}
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key === 'Escape') cancel();
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = event.pointerId;
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (pointer.current !== event.pointerId) return;
          highlight(targetAt(event.clientX, event.clientY));
          if (event.clientY < 70) window.scrollBy(0, -24);
          else if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 24);
        }}
        onPointerUp={(event) => {
          if (pointer.current !== event.pointerId) return;
          const target = targetAt(event.clientX, event.clientY);
          cancel();
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (target && target !== id) move(id, target);
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
      >
        ⠿
      </button>
      <button
        type="button"
        aria-label="Move card up"
        disabled={disabled || index <= 0}
        onClick={() => move(id, ids[index - 1]!)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Move card down"
        disabled={disabled || index >= ids.length - 1}
        onClick={() => move(id, ids[index + 1]!)}
      >
        ↓
      </button>
    </div>
  );
}
