import { useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { HomeAsset, TaskDefinition } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { WebLink } from '../LinkedText.js';
import { maintenanceIdeas, type MaintenanceIdea } from './maintenance-ideas.js';
export function MaintenanceIdeas({
  client,
  asset,
  tasks,
  online,
  close,
  choose,
}: {
  client: ClientPlatform;
  asset: HomeAsset;
  tasks: TaskDefinition[];
  online: boolean;
  close: () => void;
  choose: (idea: MaintenanceIdea) => void;
}) {
  const [category, setCategory] = useState('all'),
    [search, setSearch] = useState('');
  const ideas = maintenanceIdeas.filter(
    (idea) =>
      (category === 'all' || idea.category === category) &&
      `${idea.title} ${idea.instructions} ${idea.category}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <RecordDialog
      client={client}
      title="Maintenance ideas"
      subtitle={asset.name}
      close={close}
      className="maintenance-ideas-dialog"
    >
      <p className="fine">
        Choose an idea that fits this asset. You can edit its wording, dates and repetition before saving.
        Your model’s manual takes precedence.
      </p>
      <div className="maintenance-ideas-filters">
        <label>
          Find an idea
          <input
            aria-label="Find a maintenance idea"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label>
          Category
          <select
            aria-label="Maintenance idea category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">All categories</option>
            {[...new Set(maintenanceIdeas.map((idea) => idea.category))].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="maintenance-ideas-grid">
        {ideas.map((idea) => {
          const existing = tasks.some(
            (task) =>
              task.maintenance?.assetId === asset.recordId &&
              task.deletedAt === null &&
              task.title === idea.title,
          );
          return (
            <article className="maintenance-idea" key={idea.id}>
              <p className="eyebrow">{idea.category}</p>
              <h3>{idea.title}</h3>
              <p>{idea.instructions}</p>
              <p className="fine">{idea.timing}</p>
              <WebLink client={client} href={idea.source.url}>
                {idea.source.title}
              </WebLink>
              <button
                className="primary"
                disabled={!online || existing || asset.archived || asset.deletedAt !== null}
                onClick={() => choose(idea)}
              >
                {existing ? 'Task with this title already added' : 'Customize task'}
              </button>
            </article>
          );
        })}
      </div>
      {!ideas.length && (
        <p className="fine">No matching ideas. You can always add your own maintenance task.</p>
      )}
    </RecordDialog>
  );
}
