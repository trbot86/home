import { useEffect, useRef, type ReactNode } from 'react';
import type { ClientPlatform } from '@our-place/client';
import { Icon } from './Icon.js';
export function RecordDialog({
  client,
  title,
  subtitle,
  closeLabel = 'Close dialog',
  className = '',
  close,
  children,
}: {
  client: ClientPlatform;
  title: string;
  subtitle: string;
  closeLabel?: string;
  className?: string;
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
      className={`entry-dialog ${className}`}
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
          <p className="eyebrow">{subtitle}</p>
          <h2>{title}</h2>
        </div>
        <button aria-label={closeLabel} onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
