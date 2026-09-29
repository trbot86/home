import { createElement, useMemo, type ReactNode } from 'react';
import type { ClientPlatform } from '@our-place/client';
import { LinkedText, WebLink } from '../LinkedText.js';

/** Parse into inert template content; rebuild only formatting, never provider attributes. */
export function CalendarDescription({ client, text }: { client: ClientPlatform; text: string }) {
  const content = useMemo(() => {
    const template = document.createElement('template');
    template.innerHTML = text;
    const allowed = new Set(['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre']);
    const blocked = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'img', 'video', 'audio', 'template']);
    const render = (node: Node, key: number, depth = 0): ReactNode => {
      if (depth > 40) return null;
      if (node.nodeType === Node.TEXT_NODE) return <LinkedText key={key} client={client} text={node.textContent ?? ''} />;
      if (!(node instanceof Element)) return null;
      const tag = node.tagName.toLowerCase();
      if (blocked.has(tag)) return null;
      const children = Array.from(node.childNodes, (child, index) => render(child, index, depth + 1));
      if (tag === 'a') return <WebLink key={key} client={client} href={node.getAttribute('href') ?? ''}>{node.textContent}</WebLink>;
      if (allowed.has(tag)) return createElement(tag, { key }, ...(tag === 'br' ? [] : children));
      return children;
    };
    return Array.from(template.content.childNodes, (node, index) => render(node, index));
  }, [client, text]);
  return <div className="agenda-description">{content}</div>;
}
