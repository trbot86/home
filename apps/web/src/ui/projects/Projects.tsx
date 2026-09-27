import { useEffect, useRef, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { CommandKind, ProjectRecord } from '@our-place/contracts';
import { AttachmentDialog, type AttachmentSaved } from '../AttachmentDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { LinkedText } from '../LinkedText.js';
import { RecordDialog } from '../RecordDialog.js';
import { recordReferences, linkableReferences, type RecordReference } from '../RecordReferences.js';
import { Photo } from '../Photo.js';
import { Icon } from '../Icon.js';
import { ProjectEditor } from './ProjectEditor.js';
import { ProjectContent, ReferenceCard } from './ProjectContent.js';
import { ProjectHistory } from './ProjectHistory.js';
import { ProjectRemoval } from './ProjectRemoval.js';
import { MovePage } from './MovePage.js';
import { pagePath, projectTarget } from './tree.js';
import '../tasks/tasks.css';
import './projects.css';

type Editor = { kind: 'project' | 'page'; recordId?: string; parentPageId?: string | null };
export function Projects({
  client,
  state,
  run,
  onError,
  onPhotosSaved,
  onOpenRecord,
}: {
  client: ClientPlatform;
  state: ClientState;
  run: RunRecordCommand;
  onError: (error: unknown) => void;
  onPhotosSaved: AttachmentSaved;
  onOpenRecord: (reference: RecordReference) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null),
    [view, setView] = useState('active'),
    [scope, setScope] = useState('all'),
    [search, setSearch] = useState(''),
    [limit, setLimit] = useState(24),
    [showRemoved, setShowRemoved] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null),
    [photosId, setPhotosId] = useState<string | null>(null),
    [historyId, setHistoryId] = useState<string | null>(null),
    [moveId, setMoveId] = useState<string | null>(null),
    [removal, setRemoval] = useState<{ record: ProjectRecord; restore: boolean } | null>(null),
    [pinning, setPinning] = useState(false),
    [pinSearch, setPinSearch] = useState('');
  const [working, setWorking] = useState(false),
    lock = useRef(false),
    detailRef = useRef<HTMLElement>(null);
  const snapshot = state.projects,
    records: ProjectRecord[] = [...snapshot.projects, ...snapshot.pages],
    page = snapshot.pages.find((p) => p.recordId === selected),
    project = snapshot.projects.find((p) => p.recordId === (page?.projectId ?? selected)),
    current = page ?? project;
  const references = recordReferences(state),
    referenceMap = new Map(references.map((r) => [r.recordId, r]));
  const savedView = state.views.find((v) => v.kind === 'project_next' && v.projectId === project?.recordId),
    pins = savedView?.pins ?? [];
  const blocked = working || !state.online || (!!current && state.pendingEdits.includes(current.recordId));
  const visible = snapshot.projects
    .filter(
      (p) =>
        (scope === 'all' || p.scopeId === scope) &&
        (view === 'removed'
          ? p.deletedAt !== null
          : p.deletedAt === null && p.archived === (view === 'archived')) &&
        `${p.title} ${p.description}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  const children = snapshot.pages
    .filter(
      (p) =>
        p.projectId === project?.recordId &&
        (showRemoved
          ? p.deletedAt !== null
          : p.deletedAt === null && p.parentPageId === (page?.recordId ?? null)),
    )
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  const history = records.find((r) => r.recordId === historyId),
    photos = records.find((r) => r.recordId === photosId),
    moving = snapshot.pages.find((p) => p.recordId === moveId),
    editing = records.find((r) => r.recordId === editor?.recordId);
  const choose = (id: string) => {
    setSelected(id);
    setShowRemoved(false);
  };
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [selected]);
  useEffect(
    () =>
      client.onBack?.(() => {
        if (editor || photosId || historyId || moveId || removal || pinning) return false;
        if (page) {
          choose(page.parentPageId ?? page.projectId);
          return true;
        }
        if (project) {
          setSelected(null);
          return true;
        }
        return false;
      }),
    [client, selected, page, project, editor, photosId, historyId, moveId, removal, pinning],
  );
  async function action(target: { recordId: string }, kind: CommandKind, args: unknown, label: string) {
    if (lock.current || !state.online || state.pendingEdits.includes(target.recordId)) return null;
    lock.current = true;
    setWorking(true);
    try {
      return await run(target, kind, args, label);
    } catch (error) {
      onError(error);
      return null;
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  function openReference(id: string) {
    const reference = referenceMap.get(id);
    if (!reference || reference.deletedAt !== null) return;
    if (reference.kind === 'project' || reference.kind === 'project_page') choose(id);
    else onOpenRecord(reference);
  }
  async function pin(id: string, pinned: boolean) {
    if (!project) return;
    const result = await action(
      project,
      'SetRecordPin',
      {
        recordId: id,
        scopeId: project.scopeId,
        viewKind: 'project_next',
        projectId: project.recordId,
        expectedViewRevision: savedView?.revision ?? 0,
        pinned,
      },
      pinned ? 'Pinned to next actions' : 'Pin removed',
    );
    if (result?.status === 'Applied') setPinning(false);
  }
  function order(index: number, offset: number) {
    if (!project || !savedView) return;
    const ids = pins.map((p) => p.recordId);
    [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
    void action(
      project,
      'SetViewPinOrder',
      { viewId: savedView.viewId, expectedViewRevision: savedView.revision, recordIds: ids },
      'Priorities reordered',
    );
  }
  return (
    <section className="projects-section" aria-label="Projects and pages">
      {!project && (
        <div className="section-heading">
          <div>
            <p className="eyebrow">Ideas with room to grow</p>
            <h2>Our projects</h2>
          </div>
          <button className="primary" onClick={() => setEditor({ kind: 'project' })}>
            <Icon name="plus" size={18} />
            New project
          </button>
        </div>
      )}
      {!state.online && (
        <p className="notice">
          Your saved projects are here. Reconnect to change them; unfinished editor text stays on this device.
        </p>
      )}
      {!project ? (
        <>
          <div className="project-filters">
            <label>
              Search projects
              <input
                type="search"
                value={search}
                placeholder="Find an idea or project"
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              Show
              <select aria-label="Project view" value={view} onChange={(e) => setView(e.target.value)}>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
                <option value="removed">Removed</option>
              </select>
            </label>
            <label>
              Visibility
              <select
                aria-label="Project visibility"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="all">Shared + mine</option>
                {state.session!.scopes.map((s) => (
                  <option key={s.scopeId} value={s.scopeId}>
                    {s.kind === 'shared' ? 'Shared' : 'Just me'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Cards
              <select
                aria-label="Projects per page"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              >
                {[...new Set([12, 24, 48, limit])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n}>{n}</option>
                  ))}
              </select>
            </label>
          </div>
          <div className="project-grid">
            {visible.slice(0, limit).map((p) => (
              <button className="project-card" key={p.recordId} onClick={() => choose(p.recordId)}>
                {p.attachments[0] ? (
                  <Photo client={client} id={p.attachments[0].mediaId} descriptor={p.attachments[0]} />
                ) : (
                  <div className="project-cover">
                    <Icon name="projects" size={40} />
                  </div>
                )}
                <div>
                  <span className="eyebrow">
                    {state.session!.scopes.find((s) => s.scopeId === p.scopeId)?.kind === 'shared'
                      ? 'Together'
                      : 'Just me'}{' '}
                    ·{' '}
                    {
                      snapshot.pages.filter(
                        (page) => page.projectId === p.recordId && page.deletedAt === null,
                      ).length
                    }{' '}
                    pages
                  </span>
                  <h3>{p.title}</h3>
                  <p>{p.description || 'A place for plans, photos and the details worth keeping.'}</p>
                </div>
              </button>
            ))}
          </div>
          {!visible.length && (
            <div className="project-empty">
              <Icon name="projects" size={36} />
              <h3>{search ? 'No matching projects' : 'Give an idea a home'}</h3>
              <p>Keep inspiration, notes and useful references together, with your next steps close by.</p>
            </div>
          )}
          {visible.length > limit && <button onClick={() => setLimit(limit + 24)}>Show more projects</button>}
        </>
      ) : (
        <article className="project-board" ref={detailRef}>
          <nav className="project-breadcrumbs" aria-label="Project breadcrumb">
            <button onClick={() => setSelected(null)}>All projects</button>
            <span>/</span>
            <button onClick={() => choose(project.recordId)}>{project.title}</button>
            {page &&
              pagePath(snapshot.pages, page.recordId).map((p) => (
                <span key={p.recordId}>
                  {' '}
                  /{' '}
                  <button
                    aria-current={p.recordId === page.recordId ? 'page' : undefined}
                    onClick={() => choose(p.recordId)}
                  >
                    {p.title}
                  </button>
                </span>
              ))}
          </nav>
          <div className="project-board-heading">
            <div>
              <p className="eyebrow">
                {page ? 'Project page' : project.archived ? 'Archived project' : 'Project overview'}
              </p>
              <h2>{current!.title}</h2>
            </div>
            <div className="project-actions">
              {current!.deletedAt === null ? (
                <>
                  <button
                    disabled={blocked}
                    onClick={() =>
                      setEditor({ kind: page ? 'page' : 'project', recordId: current!.recordId })
                    }
                  >
                    Edit
                  </button>
                  <button disabled={blocked} onClick={() => setPhotosId(current!.recordId)}>
                    Photos
                  </button>
                  {page ? (
                    <button disabled={blocked} onClick={() => setMoveId(page.recordId)}>
                      Move
                    </button>
                  ) : (
                    <button
                      disabled={blocked}
                      onClick={() =>
                        void action(
                          project,
                          'SetProjectArchived',
                          { ...projectTarget(project), archived: !project.archived },
                          project.archived ? 'Project reopened' : 'Project archived',
                        )
                      }
                    >
                      {project.archived ? 'Reopen' : 'Archive'}
                    </button>
                  )}
                  <button disabled={blocked} onClick={() => setRemoval({ record: current!, restore: false })}>
                    Remove
                  </button>
                </>
              ) : (
                <button
                  disabled={
                    blocked ||
                    (project.deletedAt !== null && !!page) ||
                    (!!page?.parentPageId &&
                      snapshot.pages.some((p) => p.recordId === page.parentPageId && p.deletedAt !== null))
                  }
                  onClick={() => setRemoval({ record: current!, restore: true })}
                >
                  Restore
                </button>
              )}
              <button onClick={() => setHistoryId(current!.recordId)}>History</button>
            </div>
          </div>
          {current!.deletedAt !== null && (
            <p className="notice">
              This {page ? 'page' : 'project'} is removed. Restore its project and parent pages first if
              needed.
            </p>
          )}
          {!page && (
            <>
              <p className="project-description">
                <LinkedText client={client} text={project.description} />
              </p>
              <AttachmentGallery client={client} attachments={project.attachments} />
              <section className="project-next" aria-label="Project next actions">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Keep these in sight</p>
                    <h3>Next actions</h3>
                  </div>
                  <button
                    disabled={blocked || project.deletedAt !== null}
                    onClick={() => {
                      setPinSearch('');
                      setPinning(true);
                    }}
                  >
                    Pin something
                  </button>
                </div>
                {!pins.length && (
                  <p className="fine">
                    Pin a task, a page or a useful reference. Put the most important one first.
                  </p>
                )}
                <ol>
                  {pins.map((pin, index) => (
                    <li key={pin.recordId}>
                      <ReferenceCard reference={referenceMap.get(pin.recordId)} onOpen={openReference} />
                      <div className="project-pin-actions">
                        <button
                          aria-label={`Move priority ${index + 1} up`}
                          disabled={blocked || project.deletedAt !== null || index === 0}
                          onClick={() => order(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          aria-label={`Move priority ${index + 1} down`}
                          disabled={blocked || project.deletedAt !== null || index === pins.length - 1}
                          onClick={() => order(index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          aria-label={`Unpin ${referenceMap.get(pin.recordId)?.title ?? 'unavailable reference'}`}
                          disabled={blocked || project.deletedAt !== null}
                          onClick={() => void pinAction(pin.recordId)}
                        >
                          Unpin
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
          {page && (
            <ProjectContent client={client} page={page} references={referenceMap} onOpen={openReference} />
          )}
          <section className="project-pages" aria-label="Nested pages">
            <div className="section-heading">
              <h3>{showRemoved ? 'Removed pages' : page ? 'Inside this page' : 'Pages & references'}</h3>
              <div className="project-actions">
                <button aria-pressed={showRemoved} onClick={() => setShowRemoved(!showRemoved)}>
                  {showRemoved ? 'Show active pages' : 'Removed pages'}
                </button>
                <button
                  disabled={blocked || current!.deletedAt !== null || project.deletedAt !== null}
                  onClick={() => setEditor({ kind: 'page', parentPageId: page?.recordId ?? null })}
                >
                  + New page
                </button>
              </div>
            </div>
            <div className="project-page-grid">
              {children.map((p) => (
                <button className="project-page-card" key={p.recordId} onClick={() => choose(p.recordId)}>
                  {p.attachments[0] && (
                    <Photo client={client} id={p.attachments[0].mediaId} descriptor={p.attachments[0]} />
                  )}
                  <div>
                    <span className="eyebrow">
                      {showRemoved ? 'Removed page' : `${p.blocks.length} blocks`}
                    </span>
                    <h4>{p.title}</h4>
                    {showRemoved && (
                      <small>
                        {pagePath(snapshot.pages, p.recordId)
                          .slice(0, -1)
                          .map((p) => p.title)
                          .join(' / ')}
                      </small>
                    )}
                  </div>
                  <Icon name="arrow" size={18} />
                </button>
              ))}
            </div>
            {!children.length && (
              <p className="fine">
                {showRemoved
                  ? 'No removed pages here.'
                  : 'Add a page for ideas, measurements, photos or useful links.'}
              </p>
            )}
          </section>
        </article>
      )}
      {editor && (
        <ProjectEditor
          key={`${editor.kind}:${editor.recordId ?? 'new'}:${editor.parentPageId ?? 'root'}`}
          client={client}
          state={state}
          {...(editing ? { record: editing } : {})}
          {...(editor.kind === 'page' && !editing && project
            ? { project, parentPageId: editor.parentPageId ?? null }
            : {})}
          run={run}
          close={() => setEditor(null)}
          onSaved={choose}
          onError={onError}
        />
      )}
      {photos && (
        <AttachmentDialog
          client={client}
          target={photos}
          title={photos.title}
          online={state.online}
          serverEpoch={state.session!.serverEpoch}
          pending={state.pendingEdits.includes(photos.recordId)}
          close={() => setPhotosId(null)}
          onSaved={onPhotosSaved}
        />
      )}
      {history && (
        <ProjectHistory
          client={client}
          state={state}
          record={history}
          run={run}
          close={() => setHistoryId(null)}
          onError={onError}
        />
      )}
      {moving && (
        <MovePage
          client={client}
          state={state}
          page={moving}
          run={run}
          close={() => setMoveId(null)}
          onError={onError}
        />
      )}
      {removal && (
        <ProjectRemoval
          client={client}
          state={state}
          record={removal.record}
          restore={removal.restore}
          run={run}
          close={() => setRemoval(null)}
          onDone={() => {
            setShowRemoved(false);
          }}
          onError={onError}
        />
      )}
      {pinning && project && (
        <RecordDialog
          client={client}
          title="Pin a next action"
          subtitle="Bring what matters to the front"
          className="task-dialog"
          close={() => {
            if (!working) setPinning(false);
          }}
        >
          <label>
            Find something to pin
            <input type="search" autoFocus value={pinSearch} onChange={(e) => setPinSearch(e.target.value)} />
          </label>
          <div className="project-picker">
            {linkableReferences(state, project.scopeId)
              .filter(
                (r) =>
                  r.recordId !== project.recordId &&
                  !pins.some((p) => p.recordId === r.recordId) &&
                  `${r.label} ${r.title}`.toLowerCase().includes(pinSearch.toLowerCase()),
              )
              .slice(0, 100)
              .map((r) => (
                <button key={r.recordId} disabled={blocked} onClick={() => void pin(r.recordId, true)}>
                  <span className="eyebrow">{r.label}</span>
                  <strong>{r.title}</strong>
                </button>
              ))}
          </div>
        </RecordDialog>
      )}
    </section>
  );
  function pinAction(id: string) {
    return pin(id, false);
  }
}
