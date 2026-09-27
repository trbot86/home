import type { PageBlock } from '@our-place/contracts';
/** A local draft may contain unfinished URLs and unchosen references. */
export function readEditorBlocks(text: string): PageBlock[] {
  const value: unknown = JSON.parse(text);
  const fields: Record<string, string[]> = {
    text: ['text'],
    web_link: ['url', 'title', 'notes'],
    record_link: ['recordId', 'caption'],
    attachment: ['attachmentId'],
  };
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    value.some(
      (block) =>
        !block ||
        typeof block !== 'object' ||
        typeof block.blockId !== 'string' ||
        !block.blockId ||
        typeof block.kind !== 'string' ||
        !Object.hasOwn(fields, block.kind) ||
        fields[block.kind]!.some((key) => typeof block[key] !== 'string'),
    )
  )
    throw new Error('Invalid saved page form');
  return value as PageBlock[];
}
