import { useNavigationState } from './NavigationHistory.js';
import type { ClientPlatform } from '@our-place/client';
import type { Attachment } from '@our-place/contracts';
import { Photo } from './Photo.js';
import { RecordDialog } from './RecordDialog.js';
import { LinkedText } from './LinkedText.js';
import './attachments.css';

export function AttachmentGallery({
  client,
  attachments,
  navigationKey = '',
}: {
  client: ClientPlatform;
  attachments: Attachment[];
  navigationKey?: string;
}) {
  const [selectedId, setSelected] = useNavigationState<string | null>(
    `photos.${navigationKey}.${attachments.map((a) => a.attachmentId).join(',')}`,
    null,
  );
  const selected = attachments.find((a) => a.attachmentId === selectedId);
  if (!attachments.length) return null;
  return (
    <>
      <div className="attachment-gallery">
        {attachments.map((photo, index) => (
          <figure key={photo.attachmentId}>
            <button
              type="button"
              aria-label={`View photo ${index + 1}${photo.caption ? `: ${photo.caption}` : ''}`}
              onClick={() => setSelected(photo.attachmentId)}
            >
              <Photo client={client} id={photo.mediaId} descriptor={photo} />
            </button>
            {photo.caption && (
              <figcaption>
                <LinkedText client={client} text={photo.caption} />
              </figcaption>
            )}
          </figure>
        ))}
      </div>
      {selected && (
        <RecordDialog
          client={client}
          title="Photo"
          subtitle={selected.caption || 'A closer look'}
          className="photo-viewer"
          close={() => setSelected(null)}
        >
          <Photo client={client} id={selected.mediaId} descriptor={selected} />
        </RecordDialog>
      )}
    </>
  );
}
