import { useState, type ReactNode } from 'react';
import type { ClientPlatform } from '@our-place/client';
import { textLinks } from './text-links.js';

export function LinkedText({ client, text }: { client: ClientPlatform; text: string }) {
  return (
    <>
      {textLinks(text).map((part, index) =>
        part.href ? (
          <WebLink client={client} href={part.href} key={index}>
            {part.text}
          </WebLink>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

export function WebLink({
  client,
  href,
  children,
}: {
  client: ClientPlatform;
  href: string;
  children: ReactNode;
}) {
  const [error, setError] = useState('');
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return <>{children}</>;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return <>{children}</>;
  return (
    <>
      <a
        className="text-link"
        href={url.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.stopPropagation();
          if (client.openExternalUrl) {
            event.preventDefault();
            setError('');
            void client
              .openExternalUrl(url.href)
              .catch(() => setError('Could not open this link. You can copy the address.'));
          }
        }}
      >
        {children}
      </a>
      {error && (
        <span className="link-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
