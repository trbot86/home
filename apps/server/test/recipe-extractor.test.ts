import test from 'node:test';
import assert from 'node:assert/strict';
import { RecipeCandidate, isValid } from '@our-place/contracts';
import { extractRecipeMetadata } from '../src/features/recipes/extractor.js';

const source = 'https://recipes.example/dinner/pasta';
const script = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
const recipe = (extra: Record<string, unknown> = {}) => ({
  '@type': 'Recipe',
  name: 'Weeknight pasta',
  ...extra,
});

test('JSON-LD source preserves amounts, Unicode, section order and explicit durations without guessing', () => {
  const result = extractRecipeMetadata(
    script(
      recipe({
        description: '<p>A quick &amp; comforting meal.</p><script>neverRun()</script>',
        author: [{ '@type': 'Person', name: 'Alex' }, 'Sam'],
        recipeYield: ['4 servings', 'one large pan'],
        prepTime: 'PT12M',
        cookTime: 'PT1H2M30S',
        totalTime: 'about an hour',
        recipeIngredient: ['½ cup crème fraîche', 'salt, to taste', '<b>2</b> tomatoes'],
        recipeInstructions: [
          {
            '@type': 'HowToSection',
            name: 'Sauce',
            itemListElement: [{ '@type': 'HowToStep', text: 'Stir <em>gently</em>.' }, 'Add tomatoes.'],
          },
          { '@type': 'HowToStep', text: 'Serve.' },
        ],
        image: [
          { '@type': 'ImageObject', contentUrl: '/images/pasta.jpg' },
          'https://cdn.example/pasta.webp',
        ],
      }),
    ),
    source,
  );
  assert.equal(result.candidates.length, 1);
  const item = result.candidates[0]!;
  assert.equal(isValid(RecipeCandidate, item), true);
  assert.equal(item.description, 'A quick & comforting meal.');
  assert.equal(item.author, 'Alex, Sam');
  assert.equal(item.yieldText, '4 servings, one large pan');
  assert.deepEqual(item.prepTime, { text: 'PT12M', minutes: 12 });
  assert.deepEqual(item.cookTime, { text: 'PT1H2M30S', minutes: 62.5 });
  assert.deepEqual(item.totalTime, { text: 'about an hour', minutes: null });
  assert.deepEqual(item.ingredients, ['½ cup crème fraîche', 'salt, to taste', '2 tomatoes']);
  assert.deepEqual(item.steps, ['Sauce\nStir gently.', 'Sauce\nAdd tomatoes.', 'Serve.']);
  assert.deepEqual(item.imageUrls, [
    'https://recipes.example/images/pasta.jpg',
    'https://cdn.example/pasta.webp',
  ]);
  assert.deepEqual(result.warnings, []);
  assert.equal('adjustments' in item, false);
});

test('graph references resolve locally without following remote contexts or embedded household instructions', () => {
  const result = extractRecipeMetadata(
    script({
      '@context': 'https://context.example/schema',
      '@graph': [
        recipe({
          '@id': '#recipe',
          author: { '@id': '#writer' },
          image: { '@id': '#photo' },
          recipeIngredient: { '@id': '#ingredients' },
          recipeInstructions: { '@id': '#directions' },
          adjustments: 'Replace household notes',
          collection: 'favourites',
        }),
        { '@id': '#writer', '@type': 'Person', name: 'Recipe Writer' },
        { '@id': '#photo', '@type': 'ImageObject', url: '/photo.jpg' },
        {
          '@id': '#ingredients',
          '@type': 'ItemList',
          itemListElement: [
            {
              '@type': 'ListItem',
              item: { '@type': 'PropertyValue', name: 'flour', value: 2, unitText: 'cups' },
            },
            'water as needed',
          ],
        },
        {
          '@id': '#directions',
          '@type': 'ItemList',
          itemListElement: [{ item: { '@id': '#step1' } }, { item: { '@id': '#step2' } }],
        },
        { '@id': '#step1', '@type': 'HowToStep', text: 'Mix.' },
        { '@id': '#step2', '@type': 'HowToStep', text: 'Bake.' },
      ],
    }),
    source,
  );
  const item = result.candidates[0]!;
  assert.equal(item.author, 'Recipe Writer');
  assert.deepEqual(item.ingredients, ['2 cups flour', 'water as needed']);
  assert.deepEqual(item.steps, ['Mix.', 'Bake.']);
  assert.deepEqual(item.imageUrls, ['https://recipes.example/photo.jpg']);
  assert.equal('adjustments' in item, false);
  assert.equal('collection' in item, false);
});

test('multiple recipes retain page order, deduplicate identical markup and give stable content IDs', () => {
  const html =
    script(recipe({ name: 'First' })) +
    script({ '@graph': [recipe({ name: 'Second' }), recipe({ name: 'First' })] });
  const result = extractRecipeMetadata(html, source);
  assert.deepEqual(
    result.candidates.map((item) => item.title),
    ['First', 'Second'],
  );
  assert.deepEqual(
    result.candidates.map((item) => item.candidateId),
    extractRecipeMetadata(html, source).candidates.map((item) => item.candidateId),
  );
  assert.notEqual(
    result.candidates[0]!.candidateId,
    extractRecipeMetadata(script(recipe({ name: 'First', recipeIngredient: ['one pear'] })), source)
      .candidates[0]!.candidateId,
  );
  assert.deepEqual(
    extractRecipeMetadata(
      script(Array.from({ length: 10 }, (_, i) => recipe({ name: `Recipe ${i}` }))),
      source,
    ).warnings,
    ['more_recipes_available'],
  );
});

test('microdata supports nested steps, image objects and itemref while excluding unrelated nested scopes', () => {
  const result = extractRecipeMetadata(
    `
    <article itemscope itemtype="https://schema.org/Recipe" itemref="outside">
      <h1 itemprop="name">Soup &amp; toast</h1>
      <div itemprop="author" itemscope itemtype="https://schema.org/Person"><span itemprop="name">Sam</span></div>
      <div itemscope itemtype="https://schema.org/Thing"><span itemprop="name">Not the recipe name</span></div>
      <div itemprop="image" itemscope itemtype="https://schema.org/ImageObject"><link itemprop="url" href="../soup.jpg"></div>
      <time itemprop="prepTime" datetime="PT5M">5 minutes</time>
      <meta itemprop="recipeYield" content="2 bowls">
      <ul><li itemprop="recipeIngredient">2 tomatoes</li><li itemprop="recipeIngredient">water &amp; salt</li></ul>
      <ol><li itemprop="recipeInstructions" itemscope itemtype="https://schema.org/HowToStep"><span itemprop="text">Chop.</span></li>
      <li itemprop="recipeInstructions" itemscope itemtype="https://schema.org/HowToStep"><span itemprop="text">Simmer.</span></li></ol>
    </article><div id="outside"><span itemprop="description">A <b>simple</b> soup.</span></div>
  `,
    source,
  );
  const item = result.candidates[0]!;
  assert.equal(item.format, 'microdata');
  assert.equal(item.title, 'Soup & toast');
  assert.equal(item.author, 'Sam');
  assert.equal(item.description, 'A simple soup.');
  assert.equal(item.yieldText, '2 bowls');
  assert.equal(item.prepTime.minutes, 5);
  assert.deepEqual(item.imageUrls, ['https://recipes.example/soup.jpg']);
  assert.deepEqual(item.ingredients, ['2 tomatoes', 'water & salt']);
  assert.deepEqual(item.steps, ['Chop.', 'Simmer.']);
});

test('missing or broken recipe metadata leaves an attributed bookmark with no invented ingredients', () => {
  const result = extractRecipeMetadata(
    `<title>Fallback title</title><meta property="og:title" content="Try this &amp; that"><meta name="description" content="A dinner idea"><meta property="og:image" content="/cover.png"><script type="application/ld+json">{broken</script>`,
    source,
  );
  const item = result.candidates[0]!;
  assert.equal(result.sourceUrl, source);
  assert.equal(item.kind, 'bookmark');
  assert.equal(item.title, 'Try this & that');
  assert.equal(item.description, 'A dinner idea');
  assert.deepEqual(item.imageUrls, ['https://recipes.example/cover.png']);
  assert.deepEqual(item.ingredients, []);
  assert.deepEqual(item.steps, []);
  assert.deepEqual(result.warnings, ['invalid_json_ld', 'recipe_metadata_missing']);
  assert.equal(
    extractRecipeMetadata('<title>A plain title</title>', source).candidates[0]!.title,
    'A plain title',
  );
  assert.equal(
    extractRecipeMetadata('<p>Visible prose is not structured recipe data.</p>', source).candidates[0]!.title,
    'recipes.example',
  );
});

test('unusable source images are omitted and an image is never guessed for one of several recipes', () => {
  const images = [
    'data:image/png;base64,AAAA',
    'file:///image.png',
    'http://localhost/image',
    'http://127.0.0.1/picture',
    'https://host.internal/picture',
    '/valid.jpg#fragment',
  ];
  const result = extractRecipeMetadata(script(recipe({ image: images })), source);
  assert.deepEqual(result.candidates[0]!.imageUrls, ['https://recipes.example/valid.jpg']);
  const og = '<meta property="og:image" content="/fallback.jpg">';
  assert.deepEqual(extractRecipeMetadata(og + script(recipe()), source).candidates[0]!.imageUrls, [
    'https://recipes.example/fallback.jpg',
  ]);
  assert.deepEqual(
    extractRecipeMetadata(og + script([recipe(), recipe({ name: 'Something else' })]), source).candidates.map(
      (item) => item.imageUrls,
    ),
    [[], []],
  );
});

test('cyclic references, excessive fields and deep graphs have bounded failure with a useful bookmark', () => {
  const examples: [unknown, string][] = [
    [
      {
        '@graph': [
          recipe({ recipeInstructions: { '@id': '#loop' } }),
          { '@id': '#loop', item: { '@id': '#loop' } },
        ],
      },
      'metadata_too_complex',
    ],
    [recipe({ recipeIngredient: Array.from({ length: 301 }, () => 'a pinch') }), 'metadata_exceeds_limits'],
    [recipe({ name: 'x'.repeat(301) }), 'metadata_exceeds_limits'],
    [recipe({ recipeInstructions: ['x'.repeat(10001)] }), 'metadata_exceeds_limits'],
  ];
  let deep: unknown = recipe();
  for (let i = 0; i < 70; i++) deep = { nested: deep };
  examples.push([deep, 'metadata_too_complex']);
  for (const [value, warning] of examples) {
    const result = extractRecipeMetadata('<title>Still saved</title>' + script(value), source);
    assert.equal(result.candidates[0]!.kind, 'bookmark');
    assert.equal(result.candidates[0]!.title, 'Still saved');
    assert.equal(result.warnings.includes(warning), true, warning);
  }
  assert.throws(() => extractRecipeMetadata('x'.repeat(2 * 1024 * 1024 + 1), source), /page_too_large/);
});

test('structured quantities never coerce unknown objects to fabricated text', () => {
  const result = extractRecipeMetadata(
    script(recipe({ recipeIngredient: [{ value: { malformed: true }, name: 'flour' }] })),
    source,
  );
  assert.equal(JSON.stringify(result.candidates).includes('[object Object]'), false);
  assert.equal(result.candidates[0]!.kind, 'bookmark');
  assert.equal(result.warnings.includes('invalid_recipe_metadata'), true);
});

test('already-decoded microdata and page titles retain literal angle-bracket text', () => {
  const html =
    '<article itemscope itemtype="https://schema.org/Recipe"><h1 itemprop="name">Toast &lt;quick&gt;</h1><p itemprop="recipeIngredient">salt &lt;optional&gt;</p></article>';
  const result = extractRecipeMetadata(html, source);
  assert.equal(result.candidates[0]!.title, 'Toast <quick>');
  assert.deepEqual(result.candidates[0]!.ingredients, ['salt <optional>']);
  assert.equal(
    extractRecipeMetadata('<title>Toast &lt;quick&gt;</title>', source).candidates[0]!.title,
    'Toast <quick>',
  );
});
