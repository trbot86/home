import { useEffect, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { Attachment } from '@our-place/contracts';
import { Icon } from './Icon.js';

export function Photo({
  client,
  id,
  descriptor,
}: {
  client: ClientPlatform;
  id: string;
  descriptor?: Attachment;
}) {
  const [url, setUrl] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let current = true;
    setMissing(false);
    setUrl('');
    void client
      .photoUrl(id, descriptor)
      .then((value) => {
        if (current) setUrl(value);
      })
      .catch(() => {
        if (current) setMissing(true);
      });
    return () => {
      current = false;
    };
  }, [client, id, descriptor?.digest]);
  return missing ? (
    <div className="photo-missing">
      <Icon name="photo" />
      <span>Photo unavailable</span>
    </div>
  ) : (
    <img
      className="photo"
      src={url || undefined}
      alt={descriptor?.caption || 'Attached household photo'}
      loading="lazy"
      onError={() => setMissing(true)}
    />
  );
}
