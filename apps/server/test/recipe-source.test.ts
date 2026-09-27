import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePublicHtml } from '../src/infrastructure/html-text.js';
import { PublicFetchError, type PublicFetchResult } from '../src/infrastructure/public-web.js';
import { RecipeSourceReader } from '../src/features/recipes/source-reader.js';

const page = (bytes: Buffer, contentType = 'text/html'): PublicFetchResult => ({
  url: 'https://recipes.example/page',
  bytes,
  contentType,
  mediaType: contentType.split(';')[0]!,
});

test('HTML encoding declarations preserve accented text and fractions in source metadata', () => {
  const fragment = '<title>Crème &amp; café</title><p>½ cup</p>';
  assert.equal(decodePublicHtml(page(Buffer.from(fragment))).html, fragment);
  const declared = `<meta charset="windows-1252">${fragment}`;
  assert.equal(decodePublicHtml(page(Buffer.from(declared, 'latin1'))).html, declared);
  assert.equal(
    decodePublicHtml(page(Buffer.from(fragment, 'latin1'), 'text/html; charset="iso-8859-1"')).html,
    fragment,
  );
  const pragma = `<meta content="text/html; charset=windows-1252" http-equiv="content-type">${fragment}`;
  assert.equal(decodePublicHtml(page(Buffer.from(pragma, 'latin1'))).html, pragma);
});

test('BOM wins over headers, headers win over meta, comments are ignored and XML declarations are supported', () => {
  const html = '<meta charset="windows-1252"><title>Crème</title>';
  assert.equal(
    decodePublicHtml(
      page(
        Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(html)]),
        'text/html; charset=windows-1252',
      ),
    ).html,
    html,
  );
  assert.equal(decodePublicHtml(page(Buffer.from(html), 'text/html; charset=utf-8')).html, html);
  const commented = '<!-- <meta charset="windows-1252"> --><title>Crème</title>';
  assert.equal(decodePublicHtml(page(Buffer.from(commented))).html, commented);
  const xml = '<?xml version="1.0" encoding="iso-8859-1"?><html><title>Crème</title></html>';
  assert.equal(decodePublicHtml(page(Buffer.from(xml, 'latin1'), 'application/xhtml+xml')).html, xml);
  const utf16 = '<title>Crème</title>';
  assert.equal(
    decodePublicHtml(page(Buffer.concat([Buffer.from([255, 254]), Buffer.from(utf16, 'utf16le')]))).html,
    utf16,
  );
});

test('invalid text encoding leaves a diagnosable failure instead of corrupting recipe amounts', () => {
  assert.throws(
    () => decodePublicHtml(page(Buffer.from([60, 112, 62, 195, 40]))),
    (error: unknown) => error instanceof PublicFetchError && error.code === 'invalid_text_encoding',
  );
  assert.throws(() => decodePublicHtml(page(Buffer.alloc(2 * 1024 * 1024 + 1))), /response_too_large/);
  assert.throws(
    () => decodePublicHtml(page(Buffer.from('{}'), 'application/json')),
    /unsupported_content_type/,
  );
});

test('source reader uses the final redirected URL, retains provenance and produces only a reviewable result', async () => {
  const response = page(
    Buffer.from(
      '<meta charset="windows-1252"><script type="application/ld+json">{"@type":"Recipe","name":"Crème soup","recipeIngredient":["½ cup milk"],"image":"photo.jpg"}</script>',
      'latin1',
    ),
  );
  response.url = 'https://recipes.example/final/recipe';
  const cancellation = new AbortController().signal;
  const reader = new RecipeSourceReader({
    async get(url, kind, signal) {
      assert.equal(url, 'https://recipes.example/short');
      assert.equal(kind, 'html');
      assert.equal(signal, cancellation);
      return response;
    },
  });
  const result = await reader.read('https://recipes.example/short', cancellation);
  assert.equal(result.extraction.sourceUrl, response.url);
  assert.equal(result.extraction.candidates[0]!.title, 'Crème soup');
  assert.deepEqual(result.extraction.candidates[0]!.ingredients, ['½ cup milk']);
  assert.deepEqual(result.extraction.candidates[0]!.imageUrls, ['https://recipes.example/final/photo.jpg']);
  assert.equal(result.page.encoding, 'windows-1252');
  assert.equal(result.page.byteLength, response.bytes.length);
  assert.match(result.page.sha256, /^[a-f0-9]{64}$/);
  assert.equal('html' in result, false);
});
