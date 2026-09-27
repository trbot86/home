import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { hasFileTransfer } from './photo-input.js';

/** Only file-bearing transfers are consumed; normal text paste/drop remains native. */
export function usePhotoTransfer({
  disabledReason,
  onFiles,
  onError,
}: {
  disabledReason: string | null;
  onFiles: (files: File[]) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [dragging, setDragging] = useState(false),
    depth = useRef(0);
  function receive(data: DataTransfer) {
    const files = Array.from(data.files);
    if (disabledReason) {
      onError(new Error(disabledReason));
      return;
    }
    if (!files.length) {
      onError(new Error('Drop image files here. Folders cannot be added.'));
      return;
    }
    void onFiles(files).catch(onError);
  }
  return {
    dragging: dragging && !disabledReason,
    handlers: {
      onPaste(event: ClipboardEvent<HTMLElement>) {
        if (!hasFileTransfer(event.clipboardData)) return;
        event.preventDefault();
        event.stopPropagation();
        receive(event.clipboardData);
      },
      onDragEnter(event: DragEvent<HTMLElement>) {
        if (!hasFileTransfer(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current++;
        setDragging(true);
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!hasFileTransfer(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = disabledReason ? 'none' : 'copy';
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!depth.current) return;
        event.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDragging(false);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        depth.current = 0;
        setDragging(false);
        if (!hasFileTransfer(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        receive(event.dataTransfer);
      },
    },
  };
}

/** Keep a file dropped outside an editor from navigating away from the app. */
export function useFileDropGuard(onError: (error: unknown) => void) {
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    const drag = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || !hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'none';
    };
    const drop = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || !hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      report.current(new Error('Drop photos in the capture box or an open Photos & receipts editor.'));
    };
    window.addEventListener('dragover', drag);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', drag);
      window.removeEventListener('drop', drop);
    };
  }, []);
}
