export type TextPart = { text: string; href?: string };

/** Plain text stays plain text; only explicit web addresses become links. */
export function textLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const matches = text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi);
  let end = 0;
  for (const match of matches) {
    let label = match[0];
    // Sentence punctuation and unmatched closing brackets belong to the note.
    while (label) {
      const last = label.at(-1)!;
      if (/[.,!?;:]/.test(last)) {
        label = label.slice(0, -1);
        continue;
      }
      const opening = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[last];
      if (opening && label.split(last).length > label.split(opening).length) {
        label = label.slice(0, -1);
        continue;
      }
      break;
    }
    let url: URL;
    try {
      url = new URL(/^www\./i.test(label) ? `https://${label}` : label);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
      continue;
    if (match.index > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ text: label, href: url.href });
    end = match.index + label.length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}
