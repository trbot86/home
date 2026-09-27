import { createHash } from 'node:crypto';
import { parse, parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { RecipeCandidate, isValid, type RecipeExtraction } from '@our-place/contracts';
import { publicWebUrl } from '../../infrastructure/public-web.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? [...value] : [value];
const attr = (node: Tree.Element, name: string) => node.attrs.find((item) => item.name === name)?.value;
const localType = (value: unknown, type: string) =>
  array(value).some((item) => typeof item === 'string' && item.split(/[\/#:]/).at(-1) === type);
class ExtractionLimit extends Error {}

function nodes(root: Tree.Node): Tree.Element[] {
  const result: Tree.Element[] = [],
    pending: Tree.Node[] = [root];
  let seen = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++seen > 150000) throw new ExtractionLimit('page_too_complex');
    if ('tagName' in node) result.push(node);
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
  }
  return result;
}
function nodeText(root: Tree.Node, budget?: { nodes: number }): string {
  const parts: string[] = [],
    pending: (Tree.Node | string)[] = [root];
  let count = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++count > 150000) throw new ExtractionLimit('metadata_too_complex');
    if (budget && ++budget.nodes > 30000) throw new ExtractionLimit('metadata_too_complex');
    if (typeof node === 'string') {
      parts.push(node);
      continue;
    }
    if ('value' in node) parts.push(node.value);
    else if ('childNodes' in node) {
      if ('tagName' in node && ['script', 'style', 'iframe', 'template'].includes(node.tagName)) continue;
      const block =
        'tagName' in node && ['p', 'div', 'li', 'br', 'h1', 'h2', 'h3', 'section'].includes(node.tagName);
      if (block) {
        parts.push('\n');
        pending.push('\n');
      }
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
    }
  }
  return parts
    .join('')
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const source = String(value);
  if (source.length > limit * 4 + 2000) throw new ExtractionLimit('metadata_exceeds_limits');
  const result = nodeText(parseFragment(source, { scriptingEnabled: false }));
  if (result.length > limit) throw new ExtractionLimit('metadata_exceeds_limits');
  return result;
}
type TextReader = typeof text;
// DOM text and attributes have already been decoded. Parsing them as HTML again loses literal text.
const plainText: TextReader = (value, limit) => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const result = String(value)
    .replace(/[\t \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
  if (result.length > limit) throw new ExtractionLimit('metadata_exceeds_limits');
  return result;
};
function quantity(value: JsonObject, readText: TextReader, limit: number): string {
  const parts = [value.value, value.unitText ?? value.unitCode, value.name ?? value.text].filter(
    (item) => item !== undefined && item !== null,
  );
  if (parts.some((item) => typeof item !== 'string' && typeof item !== 'number'))
    throw new Error('invalid_quantity');
  return readText(parts.join(' '), limit);
}
function duration(value: unknown, readText: TextReader = text): RecipeCandidate['prepTime'] {
  const original = readText(value, 80);
  const match =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      original,
    );
  const minutes =
    match && match.slice(1).some(Boolean)
      ? Number(match[1] ?? 0) * 1440 +
        Number(match[2] ?? 0) * 60 +
        Number(match[3] ?? 0) +
        Number(match[4] ?? 0) / 60
      : null;
  return { text: original, minutes: minutes !== null && minutes <= 5256000 ? minutes : null };
}
function imageUrls(value: unknown, base: string, dereference: (value: unknown) => unknown): string[] {
  const result = new Set<string>(),
    pending = array(value);
  let count = 0;
  while (pending.length && count++ < 100) {
    const item = dereference(pending.shift());
    if (typeof item === 'string') {
      try {
        result.add(publicWebUrl(item, base).href);
      } catch {
        /* Keep a useful card when a source image is unsuitable. */
      }
    } else if (object(item)) pending.unshift(...array(item.contentUrl ?? item.url ?? item.thumbnailUrl));
  }
  return [...result].slice(0, 12);
}
function referenceMap(
  roots: unknown[],
  base: string,
): { objects: JsonObject[]; dereference: (value: unknown) => unknown } {
  const objects: JsonObject[] = [],
    byId = new Map<string, JsonObject>();
  const pending = [...roots].reverse().map((value) => ({ value, depth: 0 }));
  const key = (id: string) => {
    try {
      return new URL(id, base).href;
    } catch {
      return id;
    }
  };
  let count = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++count > 30000 || depth > 64) throw new ExtractionLimit('metadata_too_complex');
    if (object(value)) {
      objects.push(value);
      if (typeof value['@id'] === 'string' && Object.keys(value).length > 1)
        byId.set(key(value['@id']), value);
      for (const item of Object.values(value).reverse())
        if (typeof item === 'object' && item !== null) pending.push({ value: item, depth: depth + 1 });
    } else if (Array.isArray(value))
      for (let i = value.length - 1; i >= 0; i--) pending.push({ value: value[i], depth: depth + 1 });
  }
  return {
    objects,
    dereference: (value) =>
      object(value) && typeof value['@id'] === 'string' ? (byId.get(key(value['@id'])) ?? value) : value,
  };
}
function instructions(
  value: unknown,
  dereference: (value: unknown) => unknown,
  readText: TextReader,
): string[] {
  const steps: string[] = [],
    pending = array(value)
      .reverse()
      .map((value) => ({ value, depth: 0, section: '' }));
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!,
      entry = dereference(item.value);
    if (++count > 2000 || item.depth > 16) throw new ExtractionLimit('metadata_too_complex');
    if (Array.isArray(entry)) {
      for (let i = entry.length - 1; i >= 0; i--)
        pending.push({ ...item, value: entry[i], depth: item.depth + 1 });
    } else if (object(entry)) {
      const children = entry.itemListElement ?? entry.steps ?? entry.item;
      if (children !== undefined) {
        const section = localType(entry['@type'], 'HowToSection') ? readText(entry.name, 300) : item.section;
        pending.push({ value: children, depth: item.depth + 1, section });
      } else {
        const body = readText(entry.text ?? entry.description ?? entry.name, 10000);
        if (body) steps.push(item.section ? `${item.section}\n${body}` : body);
      }
    } else {
      const body = readText(entry, 10000);
      if (body) steps.push(item.section ? `${item.section}\n${body}` : body);
    }
    if (steps.length > 200) throw new ExtractionLimit('metadata_exceeds_limits');
  }
  return steps;
}
function ingredients(
  value: unknown,
  dereference: (value: unknown) => unknown,
  readText: TextReader,
): string[] {
  const result: string[] = [],
    pending = array(value);
  let count = 0;
  while (pending.length) {
    const item = dereference(pending.shift());
    if (++count > 2000) throw new ExtractionLimit('metadata_too_complex');
    if (Array.isArray(item)) pending.unshift(...item);
    else if (object(item) && item.itemListElement !== undefined)
      pending.unshift(...array(item.itemListElement));
    else if (object(item) && item.item !== undefined) pending.unshift(item.item);
    else {
      const line = object(item) ? quantity(item, readText, 2000) : readText(item, 2000);
      if (line) result.push(line);
    }
    if (result.length > 300) throw new ExtractionLimit('metadata_exceeds_limits');
  }
  return result;
}
function microdata(
  root: Tree.Element,
  byId: Map<string, Tree.Element>,
  base: string,
  budget: { nodes: number },
  depth = 0,
): JsonObject {
  if (depth > 16) throw new ExtractionLimit('metadata_too_complex');
  const result: JsonObject = { '@type': (attr(root, 'itemtype') ?? '').split(/\s+/) };
  if (attr(root, 'itemid')) result['@id'] = attr(root, 'itemid');
  const pending: Tree.Node[] = [...root.childNodes];
  for (const id of (attr(root, 'itemref') ?? '').split(/\s+/)) if (byId.has(id)) pending.push(byId.get(id)!);
  const visited = new Set<Tree.Node>([root]);
  while (pending.length) {
    const node = pending.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (++budget.nodes > 30000) throw new ExtractionLimit('metadata_too_complex');
    if (!('tagName' in node)) continue;
    const properties = (attr(node, 'itemprop') ?? '').split(/\s+/).filter(Boolean);
    const scoped = attr(node, 'itemscope') !== undefined;
    if (properties.length) {
      let value: unknown;
      if (scoped) value = microdata(node, byId, base, budget, depth + 1);
      else {
        const uri = attr(node, 'src') ?? attr(node, 'href');
        value =
          attr(node, 'content') ??
          attr(node, 'datetime') ??
          (uri ? new URL(uri, base).href : nodeText(node, budget));
      }
      for (const property of properties) {
        if (['__proto__', 'prototype', 'constructor'].includes(property)) continue;
        result[property] = result[property] === undefined ? value : [...array(result[property]), value];
      }
    }
    if (!scoped) pending.unshift(...node.childNodes);
  }
  return result;
}
function finish(value: Omit<RecipeCandidate, 'candidateId'>): RecipeCandidate {
  const candidate = {
    ...value,
    candidateId: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  };
  if (!isValid(RecipeCandidate, candidate) || JSON.stringify(candidate).length > 150000)
    throw new ExtractionLimit('metadata_exceeds_limits');
  return candidate;
}

/** Pure extraction. No HTTP, database writes, scripts, remote contexts or household information. */
export function extractRecipeMetadata(html: string, source: string): RecipeExtraction {
  const sourceUrl = publicWebUrl(source).href;
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw new ExtractionLimit('page_too_large');
  const elements = nodes(parse(html, { scriptingEnabled: false }));
  const byId = new Map(elements.filter((node) => attr(node, 'id')).map((node) => [attr(node, 'id')!, node]));
  const meta = new Map<string, string>();
  for (const element of elements.filter((node) => node.tagName === 'meta')) {
    const name = attr(element, 'property') ?? attr(element, 'name'),
      content = attr(element, 'content');
    if (name && content && !meta.has(name.toLowerCase())) meta.set(name.toLowerCase(), content);
  }
  const warnings = new Set<string>(),
    roots: unknown[] = [];
  for (const script of elements.filter(
    (node) =>
      node.tagName === 'script' &&
      attr(node, 'type')?.split(';')[0]?.trim().toLowerCase() === 'application/ld+json',
  )) {
    try {
      roots.push(JSON.parse(script.childNodes.map((node) => ('value' in node ? node.value : '')).join('')));
    } catch {
      warnings.add('invalid_json_ld');
    }
  }
  let graph: ReturnType<typeof referenceMap>;
  try {
    graph = referenceMap(roots, sourceUrl);
  } catch (error) {
    warnings.add(error instanceof Error ? error.message : 'invalid_metadata');
    graph = referenceMap([], sourceUrl);
  }
  const structured = graph.objects.filter((value) => localType(value['@type'], 'Recipe'));
  const sources: { value: JsonObject; format: RecipeCandidate['format'] }[] = structured
    .slice(0, 64)
    .map((value) => ({ value, format: 'json-ld' }));
  if (structured.length > 64) warnings.add('more_recipes_available');
  const microdataBudget = { nodes: 0 };
  for (const element of elements.filter(
    (node) =>
      attr(node, 'itemscope') !== undefined &&
      (attr(node, 'itemtype') ?? '').split(/\s+/).some((type) => localType(type, 'Recipe')),
  )) {
    if (sources.length >= 64 || microdataBudget.nodes > 30000) {
      warnings.add('metadata_too_complex');
      break;
    }
    try {
      sources.push({ value: microdata(element, byId, sourceUrl, microdataBudget), format: 'microdata' });
    } catch {
      warnings.add('invalid_microdata');
    }
  }
  const candidates: RecipeCandidate[] = [],
    fingerprints = new Set<string>();
  for (const { value, format } of sources) {
    if (candidates.length >= 8) {
      warnings.add('more_recipes_available');
      break;
    }
    try {
      const dereference = format === 'json-ld' ? graph.dereference : (item: unknown) => item;
      const readText = format === 'json-ld' ? text : plainText;
      const author = array(value.author)
        .map((item) => {
          const author = dereference(item);
          return readText(object(author) ? author.name : author, 500);
        })
        .filter(Boolean)
        .join(', ');
      const yieldText = array(value.recipeYield ?? value.yield)
        .map((item) => (object(item) ? quantity(item, readText, 300) : readText(item, 300)))
        .filter(Boolean)
        .join(', ');
      const candidate = finish({
        kind: 'recipe',
        format,
        title: readText(value.name, 300),
        description: readText(value.description, 10000),
        author,
        yieldText,
        prepTime: duration(value.prepTime, readText),
        cookTime: duration(value.cookTime, readText),
        totalTime: duration(value.totalTime, readText),
        ingredients: ingredients(value.recipeIngredient ?? value.ingredients, dereference, readText),
        steps: instructions(value.recipeInstructions ?? value.steps, dereference, readText),
        imageUrls: imageUrls(
          value.image ?? (sources.length === 1 ? meta.get('og:image') : undefined),
          sourceUrl,
          dereference,
        ),
      });
      const fingerprint = JSON.stringify({ ...candidate, candidateId: undefined, format: undefined });
      if (!fingerprints.has(fingerprint)) {
        fingerprints.add(fingerprint);
        candidates.push(candidate);
      }
    } catch (error) {
      warnings.add(error instanceof ExtractionLimit ? error.message : 'invalid_recipe_metadata');
    }
  }
  if (!candidates.length) {
    warnings.add('recipe_metadata_missing');
    const safeText = (value: unknown, max: number) => {
      try {
        return plainText(value, max);
      } catch {
        warnings.add('metadata_exceeds_limits');
        return '';
      }
    };
    const title = elements.find((node) => node.tagName === 'title');
    candidates.push(
      finish({
        kind: 'bookmark',
        format: 'page-metadata',
        title:
          safeText(meta.get('og:title'), 300) ||
          safeText(title ? nodeText(title) : '', 300) ||
          new URL(sourceUrl).hostname,
        description: safeText(meta.get('og:description') ?? meta.get('description'), 10000),
        author: '',
        yieldText: '',
        prepTime: duration(''),
        cookTime: duration(''),
        totalTime: duration(''),
        ingredients: [],
        steps: [],
        imageUrls: imageUrls(meta.get('og:image'), sourceUrl, (value) => value),
      }),
    );
  }
  return { extractorVersion: 1, sourceUrl, candidates, warnings: [...warnings] };
}
