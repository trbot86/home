import { useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { ProjectPage } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { descendants, pagePath, projectTarget } from './tree.js';

export function MovePage({
  client,
  state,
  page,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  page: ProjectPage;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  // Freeze the tree being moved when the dialog opens; a partner edit must be reviewed.
  const frozen = useRef({
    target: projectTarget(page),
    descendants: descendants(state.projects.pages, page.recordId).map(projectTarget),
  }).current;
  const [projectId, setProjectId] = useState(page.projectId),
    [parentId, setParentId] = useState(page.parentPageId ?? ''),
    [busy, setBusy] = useState(false);
  const excluded = new Set([page.recordId, ...frozen.descendants.map((p) => p.recordId)]);
  const projects = state.projects.projects.filter((p) => p.scopeId === page.scopeId && p.deletedAt === null),
    pages = state.projects.pages.filter(
      (p) => p.projectId === projectId && p.deletedAt === null && !excluded.has(p.recordId),
    );
  const blocked = busy || !state.online || state.pendingEdits.includes(page.recordId);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    setBusy(true);
    try {
      const result = await run(
        page,
        'MoveProjectPage',
        { ...frozen.target, projectId, parentPageId: parentId || null, descendants: frozen.descendants },
        'Page moved',
      );
      if (result?.status === 'Applied') close();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <RecordDialog
      client={client}
      title="Move page"
      subtitle="Keep the whole branch together"
      className="task-dialog"
      close={() => {
        if (!busy) close();
      }}
    >
      <form className="task-form" onSubmit={(e) => void submit(e)}>
        <fieldset disabled={blocked}>
          <label>
            Project
            <select
              value={projectId}
              aria-label="Project"
              onChange={(e) => {
                setProjectId(e.target.value);
                setParentId('');
              }}
            >
              {projects.map((p) => (
                <option key={p.recordId} value={p.recordId}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Inside page
            <select aria-label="Inside page" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Project overview</option>
              {pages.map((p) => (
                <option key={p.recordId} value={p.recordId}>
                  {pagePath(state.projects.pages, p.recordId)
                    .map((p) => p.title)
                    .join(' / ')}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <p className="fine">
          The page and its {frozen.descendants.length} nested pages keep their content, links and photos.
        </p>
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={blocked}>
            Move page
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
