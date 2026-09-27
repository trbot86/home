import type { ClientPlatform } from '@our-place/client';
import type { EntryCategory } from '@our-place/contracts';
import { Icon } from './Icon.js';
export function CaptureMedia({
  client,
  draftId,
  category,
  busy,
  addPhotos,
  onError,
}: {
  client: ClientPlatform;
  draftId: string;
  category: EntryCategory;
  busy: boolean;
  addPhotos: (files: File[]) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  return (
    <>
      {client.acquirePhoto ? (
        <>
          <button
            className="file-button"
            type="button"
            disabled={busy}
            onClick={() => {
              void client.acquirePhoto!(draftId, 'gallery').catch(onError);
            }}
          >
            <Icon name="photo" />
            <span>Gallery</span>
          </button>
          <button
            className="file-button"
            type="button"
            disabled={busy}
            onClick={() => {
              void client.acquirePhoto!(draftId, 'camera').catch(onError);
            }}
          >
            Camera
          </button>
        </>
      ) : (
        <label className="file-button">
          <Icon name="photo" />
          <span>Add photos</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            disabled={busy}
            onChange={(event) => {
              void addPhotos(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </label>
      )}
      {client.dictate && (
        <button
          className="file-button"
          type="button"
          disabled={busy}
          onClick={() => {
            void client.dictate!(category).catch(onError);
          }}
        >
          Dictate
        </button>
      )}
    </>
  );
}
