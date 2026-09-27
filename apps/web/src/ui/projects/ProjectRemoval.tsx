import { useRef, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { ProjectRecord } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { descendants, pagePath, projectTarget } from './tree.js';

export function ProjectRemoval({
  client,
  state,
  record,
  restore,
  run,
  close,
  onDone,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  record: ProjectRecord;
  restore: boolean;
  run: RunRecordCommand;
  close: () => void;
  onDone: () => void;
  onError: (error: unknown) => void;
}) {
  const frozen = useRef({
    record,
    pages: (record.kind === 'project'
      ? state.projects.pages.filter((p) => p.projectId === record.recordId)
      : descendants(state.projects.pages, record.recordId)
    ).filter((p) => (restore ? p.deletedAt !== null : p.deletedAt === null)),
  }).current;
  const [selected, setSelected] = useState(new Set<string>()),
    [busy, setBusy] = useState(false),
    lock = useRef(false);
  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) for (const page of pagePath(frozen.pages, id)) next.add(page.recordId);
    else
      for (const pageId of [id, ...descendants(frozen.pages, id).map((p) => p.recordId)]) next.delete(pageId);
    setSelected(next);
  }
  async function submit() {
    if (lock.current || !state.online) return;
    lock.current = true;
    setBusy(true);
    const pages = (restore ? frozen.pages.filter((p) => selected.has(p.recordId)) : frozen.pages).map(
        projectTarget,
      ),
      isPage = frozen.record.kind === 'project_page';
    try {
      const result = await run(
        frozen.record,
        restore
          ? isPage
            ? 'RestoreProjectPage'
            : 'RestoreProject'
          : isPage
            ? 'DeleteProjectPage'
            : 'DeleteProject',
        { ...projectTarget(frozen.record), ...(isPage ? { descendants: pages } : { pages }) },
        restore ? 'Restored' : 'Moved to removed',
      );
      if (result?.status === 'Applied') {
        onDone();
        close();
      }
    } catch (error) {
      onError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <RecordDialog
      client={client}
      title={restore ? 'Restore from removed' : 'Remove from project'}
      subtitle={frozen.record.title}
      className="task-dialog"
      close={() => {
        if (!busy) close();
      }}
    >
      {restore ? (
        <>
          <p>
            Restore {frozen.record.kind === 'project' ? 'the project' : 'this page'}. Choose any nested pages
            you also want to bring back.
          </p>
          <div className="project-restore-list">
            {frozen.pages.map((page) => (
              <label key={page.recordId}>
                <input
                  type="checkbox"
                  checked={selected.has(page.recordId)}
                  disabled={busy}
                  onChange={(e) => toggle(page.recordId, e.target.checked)}
                />
                <span>
                  {pagePath(state.projects.pages, page.recordId)
                    .map((p) => p.title)
                    .join(' / ')}
                </span>
              </label>
            ))}
          </div>
        </>
      ) : (
        <p>
          This removes {frozen.record.kind === 'project' ? 'the project' : 'this page'} and{' '}
          {frozen.pages.length} active nested pages. Linked tasks, recipes and notes stay where they are. You
          can undo this change.
        </p>
      )}
      <div className="dialog-actions">
        <button disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className={restore ? 'primary' : 'danger'}
          disabled={busy || !state.online || state.pendingEdits.includes(record.recordId)}
          onClick={() => void submit()}
        >
          {restore ? 'Restore' : 'Remove'}
        </button>
      </div>
    </RecordDialog>
  );
}
