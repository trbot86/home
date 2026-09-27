import { useEffect, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import { Icon } from './Icon.js';

export function Photo({ client, id }: { client: ClientPlatform; id: string }) {
  const [url, setUrl] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let current = true;
    setMissing(false);
    void client
      .photoUrl(id)
      .then((value) => {
        if (current) setUrl(value);
      })
      .catch(() => setMissing(true));
    return () => {
      current = false;
    };
  }, [client, id]);
  return missing ? (
    <div className="photo-missing">
      <Icon name="photo" />
      <span>Photo unavailable</span>
    </div>
  ) : (
    <img
      className="photo"
      src={url || undefined}
      alt="Attached household photo"
      loading="lazy"
      onError={() => setMissing(true)}
    />
  );
}
