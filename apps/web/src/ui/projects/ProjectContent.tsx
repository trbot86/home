import type { ClientPlatform } from '@our-place/client';
import type { ProjectPage } from '@our-place/contracts';
import type { RecordReference } from '../RecordReferences.js';
import { LinkedText, WebLink } from '../LinkedText.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { Icon } from '../Icon.js';

export function ReferenceCard({
  reference,
  caption,
  onOpen,
}: {
  reference: RecordReference | undefined;
  caption?: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="project-reference">
      <button
        disabled={!reference || reference.deletedAt !== null}
        onClick={() => reference && onOpen(reference.recordId)}
      >
        <span className="eyebrow">
          {reference?.label ?? 'App reference'}
          {reference?.deletedAt != null ? ' · Removed' : ''}
        </span>
        <strong>{reference?.title ?? 'Reference unavailable'}</strong>
        <Icon name="arrow" size={16} />
      </button>
      {caption && <p>{caption}</p>}
    </div>
  );
}
export function ProjectContent({
  client,
  page,
  references,
  onOpen,
}: {
  client: ClientPlatform;
  page: ProjectPage;
  references: Map<string, RecordReference>;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="project-content">
      {page.blocks.map((block) => (
        <article className={`project-block project-block-${block.kind}`} key={block.blockId}>
          {block.kind === 'text' ? (
            <p>
              <LinkedText client={client} text={block.text} />
            </p>
          ) : block.kind === 'web_link' ? (
            <>
              <span className="eyebrow">Web reference</span>
              <h3>
                <WebLink client={client} href={block.url}>
                  {block.title || new URL(block.url).hostname}
                </WebLink>
              </h3>
              <p>
                <LinkedText client={client} text={block.notes} />
              </p>
              <small>{new URL(block.url).hostname}</small>
            </>
          ) : block.kind === 'record_link' ? (
            <ReferenceCard
              reference={references.get(block.recordId)}
              caption={block.caption}
              onOpen={onOpen}
            />
          ) : (
            <AttachmentGallery
              client={client}
              attachments={page.attachments.filter((a) => a.attachmentId === block.attachmentId)}
            />
          )}
        </article>
      ))}
    </div>
  );
}
