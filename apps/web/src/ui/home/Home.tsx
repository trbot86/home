import { useNavigationState } from '../NavigationHistory.js';
import { useRef, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { CommandKind, HomeRecord, TaskDefinition } from '@our-place/contracts';
import { HomeEditor } from './HomeEditor.js';
import { HomeHistory } from './HomeHistory.js';
import { Icon } from '../Icon.js';
import { dateWithYear as date } from '../format.js';
import { LinkedText } from '../LinkedText.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { AttachmentDialog, type AttachmentSaved } from '../AttachmentDialog.js';
import { TaskEditor } from '../tasks/TaskEditor.js';
import type { TaskTemplate } from '../tasks/task-template.js';
import { MaintenanceIdeas } from './MaintenanceIdeas.js';
import { maintenanceTaskTemplate } from './maintenance-ideas.js';
import { CompletionDialog } from '../tasks/CompletionDialog.js';
import { TaskHistory } from '../tasks/TaskHistory.js';
import { displayDate, priorityNames, taskRecords } from '../tasks/shared.js';
import '../tasks/tasks.css';
import './home.css';

type Editor = { mode: 'asset' | 'service'; recordId?: string };
type TaskEditing = {
  mode: 'create' | 'definition' | 'occurrence';
  taskId?: string;
  occurrenceId?: string;
  template?: TaskTemplate;
};
export function Home({
  client,
  state,
  run,
  onError,
  onPhotosSaved,
  initialRecordId,
}: {
  client: ClientPlatform;
  state: ClientState;
  run: RunRecordCommand;
  onError: (error: unknown) => void;
  onPhotosSaved: AttachmentSaved;
  initialRecordId?: string | null;
}) {
  const initialService = state.home.serviceRecords.find((r) => r.recordId === initialRecordId);
  const initialAsset = state.home.assets.find(
    (r) => r.recordId === (initialService?.assetId ?? initialRecordId),
  );
  const [view, setView] = useNavigationState(`Home.${initialRecordId ?? ''}.view`, 'active'),
    [search, setSearch] = useState(''),
    [scope, setScope] = useState('all');
  const [selected, setSelected] = useNavigationState<string | null>(
      `Home.${initialRecordId ?? ''}.selected`,
      initialAsset?.recordId ?? null,
    ),
    [limit, setLimit] = useState(20),
    [serviceLimit, setServiceLimit] = useState(20);
  const [showRemoved, setShowRemoved] = useNavigationState(
      `Home.${initialRecordId ?? ''}.showRemoved`,
      false,
    ),
    [editor, setEditor] = useNavigationState<Editor | null>(`Home.${initialRecordId ?? ''}.editor`, null);
  const [historyId, setHistoryId] = useNavigationState<string | null>(
      `Home.${initialRecordId ?? ''}.historyId`,
      initialService?.recordId ?? null,
    ),
    [photosId, setPhotosId] = useNavigationState<string | null>(
      `Home.${initialRecordId ?? ''}.photosId`,
      null,
    );
  const [taskEditor, setTaskEditor] = useNavigationState<TaskEditing | null>(
      `Home.${initialRecordId ?? ''}.taskEditor`,
      null,
    ),
    [completionId, setCompletionId] = useNavigationState<string | null>(
      `Home.${initialRecordId ?? ''}.completionId`,
      null,
    ),
    [taskHistoryId, setTaskHistoryId] = useNavigationState<string | null>(
      `Home.${initialRecordId ?? ''}.taskHistoryId`,
      null,
    );
  const [working, setWorking] = useState<string[]>([]),
    locks = useRef(new Set<string>());
  const [showIdeas, setShowIdeas] = useNavigationState(`Home.${initialRecordId ?? ''}.showIdeas`, false);
  const session = state.session!,
    snapshot = state.home,
    records: HomeRecord[] = [...snapshot.assets, ...snapshot.serviceRecords];
  const asset = snapshot.assets.find((item) => item.recordId === selected);
  const visible = snapshot.assets
    .filter(
      (item) =>
        (view === 'deleted'
          ? item.deletedAt !== null
          : item.deletedAt === null && item.archived === (view === 'archived')) &&
        (scope === 'all' || item.scopeId === scope) &&
        `${item.name} ${item.model} ${item.location} ${item.notes}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const serviceRows = snapshot.serviceRecords
    .filter((item) => item.assetId === selected && (showRemoved || item.deletedAt === null))
    .sort((a, b) => b.occurredAt - a.occurredAt || b.recordId.localeCompare(a.recordId));
  const linkedTasks = state.tasks.definitions.filter(
    (task) => task.maintenance?.assetId === selected && task.deletedAt === null,
  );
  const editingAsset =
    editor?.mode === 'asset' ? snapshot.assets.find((item) => item.recordId === editor.recordId) : asset;
  const editingService = snapshot.serviceRecords.find((item) => item.recordId === editor?.recordId);
  const history = records.find((record) => record.recordId === historyId),
    photos = records.find((record) => record.recordId === photosId);
  const editingTask = state.tasks.definitions.find((task) => task.recordId === taskEditor?.taskId);
  const editingOccurrence = state.tasks.occurrences.find(
    (item) => item.recordId === taskEditor?.occurrenceId,
  );
  const completion = state.tasks.occurrences.find((item) => item.recordId === completionId),
    completionTask = state.tasks.definitions.find((task) => task.recordId === completion?.taskId);
  const taskHistory = taskRecords(state.tasks).find((record) => record.recordId === taskHistoryId);
  const disabled = (...ids: string[]) =>
    !state.online || ids.some((id) => state.pendingEdits.includes(id) || working.includes(id));
  const choose = (id: string) => {
    setSelected(id);
    setServiceLimit(20);
    setShowRemoved(false);
  };
  async function action(record: HomeRecord, kind: CommandKind, args: unknown, label: string) {
    if (disabled(record.recordId) || locks.current.has(record.recordId)) return;
    locks.current.add(record.recordId);
    setWorking([...locks.current]);
    try {
      const outcome = await run(record, kind, args, label);
      if (outcome?.status === 'Applied' && record.kind === 'home_asset') {
        if (kind === 'SetHomeAssetArchived') setView(record.archived ? 'active' : 'archived');
        else if (kind === 'DeleteHomeAsset') setView('deleted');
        else if (kind === 'RestoreHomeAsset') setView(record.archived ? 'archived' : 'active');
      }
    } finally {
      locks.current.delete(record.recordId);
      setWorking([...locks.current]);
    }
  }
  const taskRow = (task: TaskDefinition) => {
    const occurrence = state.tasks.occurrences.find(
      (item) => item.taskId === task.recordId && item.state === 'open' && item.deletedAt === null,
    );
    const last = state.tasks.completions
      .filter(
        (item) =>
          item.deletedAt === null &&
          state.tasks.occurrences.some((o) => o.recordId === item.occurrenceId && o.taskId === task.recordId),
      )
      .sort((a, b) => b.completedAt - a.completedAt)[0];
    return (
      <article className="home-maintenance-task" key={task.recordId}>
        <strong>{task.title}</strong>
        {occurrence && (
          <p className="fine">
            {priorityNames[occurrence.priority]}
            {occurrence.targetDate ? ` · Target ${displayDate(occurrence.targetDate)}` : ''}
            {occurrence.deadlineDate ? ` · Deadline ${displayDate(occurrence.deadlineDate)}` : ''}
          </p>
        )}
        {last && (
          <p className="fine">
            Last done {date(last.completedAt)} by {last.performerName}
          </p>
        )}
        {task.maintenance?.reference && (
          <p className="home-notes">
            <LinkedText client={client} text={task.maintenance.reference} />
          </p>
        )}
        <div className="task-actions">
          {occurrence && (
            <>
              <button
                disabled={disabled(task.recordId, occurrence.recordId)}
                onClick={() => setCompletionId(occurrence.recordId)}
              >
                Record completion
              </button>
              <button
                disabled={disabled(occurrence.recordId)}
                onClick={() =>
                  setTaskEditor({
                    mode: 'occurrence',
                    taskId: task.recordId,
                    occurrenceId: occurrence.recordId,
                  })
                }
              >
                Plan
              </button>
            </>
          )}
          <button
            disabled={disabled(task.recordId)}
            onClick={() => setTaskEditor({ mode: 'definition', taskId: task.recordId })}
          >
            Edit task
          </button>
          <button onClick={() => setTaskHistoryId(task.recordId)}>Task history</button>
        </div>
      </article>
    );
  };
  return (
    <section className="home-section">
      {!state.online && (
        <p className="notice">Saved household details are available offline. Connect to make changes.</p>
      )}
      <div className="collection-toolbar">
        <div className="task-views">
          {[
            ['active', 'In use'],
            ['archived', 'Archived'],
            ['deleted', 'Removed'],
          ].map(([id, title]) => (
            <button
              key={id}
              aria-pressed={view === id}
              onClick={() => {
                setView(id!);
                setLimit(20);
              }}
            >
              {title}
            </button>
          ))}
        </div>
        <button className="primary" disabled={!state.online} onClick={() => setEditor({ mode: 'asset' })}>
          <Icon name="plus" size={18} />
          Add asset
        </button>
      </div>
      <div className="task-filters">
        <select
          aria-label="Asset visibility"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="all">Shared + mine</option>
          {session.scopes.map((item) => (
            <option key={item.scopeId} value={item.scopeId}>
              {item.kind === 'shared' ? 'Shared' : 'Just me'}
            </option>
          ))}
        </select>
        <label className="search">
          <Icon name="search" size={16} />
          <input
            aria-label="Search assets"
            placeholder="Find an appliance, room or system…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      <div className="home-layout">
        <div className="home-asset-list">
          {visible.slice(0, limit).map((item) => (
            <button
              className="home-asset-card"
              aria-pressed={selected === item.recordId}
              key={item.recordId}
              onClick={() => choose(item.recordId)}
            >
              <Icon name="home" size={24} />
              <span>
                <strong>{item.name}</strong>
                <span>{item.location || item.model || 'Details, photos & service history'}</span>
                {session.scopes.find((scope) => scope.scopeId === item.scopeId)?.kind === 'private' && (
                  <small>Just me</small>
                )}
              </span>
            </button>
          ))}
          {!visible.length && (
            <div className="home-empty">
              <Icon name="home" size={36} />
              <h3>{view === 'active' ? 'Know your home a little better.' : 'Nothing here yet.'}</h3>
              <p className="fine">
                {search
                  ? 'Try another search.'
                  : 'Keep model numbers, receipts and service history together.'}
              </p>
            </div>
          )}
          {visible.length > limit && (
            <button className="load-more" onClick={() => setLimit((n) => n + 20)}>
              Show more assets
            </button>
          )}
        </div>
        {asset ? (
          <div className="home-detail">
            <div className="home-detail-heading">
              <div>
                <p className="eyebrow">
                  {asset.deletedAt ? 'Removed asset' : asset.archived ? 'Archived asset' : 'At home'}
                </p>
                <h2>{asset.name}</h2>
              </div>
              <button aria-label="Close asset" onClick={() => setSelected(null)}>
                <Icon name="close" />
              </button>
            </div>
            <dl className="home-specs">
              {[
                ['Model', asset.model],
                ['Serial number', asset.serial],
                ['Location', asset.location],
                ['Acquired', asset.acquiredDate],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
            {asset.notes && (
              <p className="home-notes">
                <LinkedText client={client} text={asset.notes} />
              </p>
            )}
            <AttachmentGallery client={client} attachments={asset.attachments} />
            <div className="task-actions">
              {asset.deletedAt === null ? (
                <>
                  <button
                    disabled={disabled(asset.recordId)}
                    onClick={() => setEditor({ mode: 'asset', recordId: asset.recordId })}
                  >
                    Edit asset
                  </button>
                  <button onClick={() => setPhotosId(asset.recordId)}>Photos & receipts</button>
                  <button
                    disabled={disabled(asset.recordId)}
                    onClick={() => {
                      void action(
                        asset,
                        'SetHomeAssetArchived',
                        {
                          recordId: asset.recordId,
                          expectedRevision: asset.revision,
                          archived: !asset.archived,
                        },
                        asset.archived ? 'Asset returned to use' : 'Asset archived',
                      );
                    }}
                  >
                    {asset.archived ? 'Return to use' : 'Archive'}
                  </button>
                  <button
                    disabled={
                      disabled(asset.recordId) ||
                      linkedTasks.length > 0 ||
                      snapshot.serviceRecords.some(
                        (item) => item.assetId === asset.recordId && item.deletedAt === null,
                      )
                    }
                    title="An asset with maintenance tasks or service records can be archived."
                    onClick={() => {
                      void action(
                        asset,
                        'DeleteHomeAsset',
                        { recordId: asset.recordId, expectedRevision: asset.revision },
                        'Asset removed',
                      );
                    }}
                  >
                    Remove asset
                  </button>
                </>
              ) : (
                <button
                  disabled={disabled(asset.recordId)}
                  onClick={() => {
                    void action(
                      asset,
                      'RestoreHomeAsset',
                      { recordId: asset.recordId, expectedRevision: asset.revision },
                      'Asset restored',
                    );
                  }}
                >
                  Restore asset
                </button>
              )}
              <button onClick={() => setHistoryId(asset.recordId)}>Asset history</button>
            </div>
            <section className="home-subsection">
              <div className="section-heading">
                <h3>Maintenance tasks</h3>
                <div className="task-actions">
                  <button
                    disabled={asset.archived || asset.deletedAt !== null}
                    onClick={() => setShowIdeas(true)}
                  >
                    Browse maintenance ideas
                  </button>
                  <button
                    disabled={disabled(asset.recordId) || asset.archived || asset.deletedAt !== null}
                    onClick={() => setTaskEditor({ mode: 'create' })}
                  >
                    Add maintenance task
                  </button>
                </div>
              </div>
              {!linkedTasks.length && (
                <p className="fine">Link a task to record each completion here automatically.</p>
              )}
              {linkedTasks.map(taskRow)}
            </section>
            <section className="home-subsection">
              <div className="section-heading">
                <h3>Service log</h3>
                <button
                  disabled={disabled(asset.recordId) || asset.deletedAt !== null}
                  onClick={() => setEditor({ mode: 'service' })}
                >
                  Record past service
                </button>
              </div>
              <label className="home-removed">
                <input
                  type="checkbox"
                  checked={showRemoved}
                  onChange={(event) => setShowRemoved(event.target.checked)}
                />
                Include removed entries
              </label>
              {!serviceRows.length && (
                <p className="fine">Repairs, appointments, little fixes—keep the details here.</p>
              )}
              {serviceRows.slice(0, serviceLimit).map((item) => {
                const completed = state.tasks.completions.find((row) => row.recordId === item.completionId);
                return (
                  <article className="home-service-card" key={item.recordId}>
                    <div className="home-service-heading">
                      <strong>{date(item.occurredAt)}</strong>
                      {item.costAmount !== null && (
                        <span>
                          {item.currency} {item.costAmount}
                        </span>
                      )}
                    </div>
                    <p className="fine">
                      {completed ? `Task completed by ${completed.performerName}` : 'Past service'}
                      {item.deletedAt ? ' · removed' : ''}
                    </p>
                    <p className="home-notes">
                      <LinkedText client={client} text={item.notes || 'No service notes yet.'} />
                    </p>
                    <AttachmentGallery client={client} attachments={item.attachments} />
                    {!!completed?.attachments?.length && (
                      <>
                        <p className="fine">Completion photos</p>
                        <AttachmentGallery client={client} attachments={completed.attachments} />
                      </>
                    )}
                    <div className="task-actions">
                      {item.deletedAt === null && (
                        <>
                          <button
                            disabled={disabled(item.recordId)}
                            onClick={() => setEditor({ mode: 'service', recordId: item.recordId })}
                          >
                            Edit service
                          </button>
                          <button onClick={() => setPhotosId(item.recordId)}>Photos & receipts</button>
                        </>
                      )}
                      {!item.completionId && (
                        <button
                          disabled={disabled(item.recordId)}
                          onClick={() => {
                            void action(
                              item,
                              item.deletedAt ? 'RestoreMaintenanceRecord' : 'DeleteMaintenanceRecord',
                              { recordId: item.recordId, expectedRevision: item.revision },
                              item.deletedAt ? 'Service entry restored' : 'Service entry removed',
                            );
                          }}
                        >
                          {item.deletedAt ? 'Restore service' : 'Remove service'}
                        </button>
                      )}
                      <button onClick={() => setHistoryId(item.recordId)}>Service history</button>
                    </div>
                  </article>
                );
              })}
              {serviceRows.length > serviceLimit && (
                <button className="load-more" onClick={() => setServiceLimit((n) => n + 20)}>
                  Show more service entries
                </button>
              )}
            </section>
          </div>
        ) : (
          <div className="home-detail home-welcome">
            <Icon name="home" size={52} />
            <h2>The details, all in one place.</h2>
            <p>Choose an appliance, room or system to see its photos, upcoming care and service history.</p>
          </div>
        )}
      </div>
      {editor && (editor.mode === 'asset' || asset) && (
        <HomeEditor
          key={`${editor.mode}:${editor.recordId ?? 'new'}`}
          client={client}
          state={state}
          mode={editor.mode}
          {...(editingAsset ? { asset: editingAsset } : {})}
          {...(editingService ? { service: editingService } : {})}
          run={run}
          close={() => setEditor(null)}
          onSaved={(id) => {
            choose(id);
            if (editor.mode === 'asset' && !editor.recordId) {
              setView('active');
              setScope('all');
              setSearch('');
            }
          }}
          onError={onError}
        />
      )}
      {history && (
        <HomeHistory
          client={client}
          state={state}
          record={history}
          run={run}
          close={() => setHistoryId(null)}
          onError={onError}
        />
      )}
      {photos && (
        <AttachmentDialog
          client={client}
          target={photos}
          title={photos.kind === 'home_asset' ? photos.name : 'Service photos & receipts'}
          online={state.online}
          serverEpoch={session.serverEpoch}
          pending={state.pendingEdits.includes(photos.recordId)}
          close={() => setPhotosId(null)}
          onSaved={onPhotosSaved}
        />
      )}
      {taskEditor && asset && (
        <TaskEditor
          key={`${taskEditor.mode}:${taskEditor.taskId ?? 'new'}:${taskEditor.template?.id ?? ''}`}
          client={client}
          state={state}
          mode={taskEditor.mode}
          asset={asset}
          {...(taskEditor.template ? { template: taskEditor.template } : {})}
          {...(editingTask ? { task: editingTask } : {})}
          {...(editingOccurrence ? { occurrence: editingOccurrence } : {})}
          run={run}
          close={() => setTaskEditor(null)}
          onSaved={() => {}}
          onError={onError}
        />
      )}
      {showIdeas && asset && (
        <MaintenanceIdeas
          client={client}
          asset={asset}
          tasks={linkedTasks}
          online={state.online}
          close={() => setShowIdeas(false)}
          choose={(idea) => {
            setShowIdeas(false);
            setTaskEditor({ mode: 'create', template: maintenanceTaskTemplate(idea) });
          }}
        />
      )}
      {completion && completionTask && (
        <CompletionDialog
          key={completion.recordId}
          client={client}
          state={state}
          task={completionTask}
          occurrence={completion}
          run={run}
          close={() => setCompletionId(null)}
          onError={onError}
        />
      )}
      {taskHistory && (
        <TaskHistory
          client={client}
          state={state}
          record={taskHistory}
          run={run}
          close={() => setTaskHistoryId(null)}
          onRecord={setTaskHistoryId}
          onError={onError}
        />
      )}
    </section>
  );
}
