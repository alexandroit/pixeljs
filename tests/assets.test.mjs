import test from 'node:test';
import assert from 'node:assert/strict';
import { PixelJSError } from '../packages/core/dist/api/errors.js';
import { parseStrictJson } from '../packages/core/dist/internal/assets/json.js';
import {
  decodeBase64,
  parseFontFile,
  textSize,
} from '../packages/core/dist/internal/assets/font-format.js';
import {
  ASSET_KINDS,
  MANIFEST_LIMITS,
  parseManifest,
} from '../packages/core/dist/internal/assets/manifest.js';
import { loadBundle } from '../packages/core/dist/internal/assets/bundle.js';

const code = (expected) => (error) => error instanceof PixelJSError && error.code === expected;
const bytes = (text) => new TextEncoder().encode(text);
const strict = (text) => parseStrictJson(bytes(text), 'Test JSON');

test('strict JSON accepts what JSON.parse accepts and nothing else', () => {
  const valid = [
    '0',
    '-0',
    '1.5e3',
    '-12.25E-2',
    '1e400',
    'true',
    'false',
    'null',
    '""',
    '"\\u00e9\\ud83d\\ude00 \\" \\\\ \\/ \\b\\f\\n\\r\\t"',
    '"\\ud800"',
    ' \t\r\n[ 1 , [ ] , { } , "x" ] ',
    '{"a":{"b":[1,{"c":null}]},"d":"é"}',
    '"\u2028"',
  ];
  for (const text of valid) assert.deepEqual(strict(text), JSON.parse(text), text);
  const invalid = [
    '',
    ' ',
    '01',
    '1.',
    '.5',
    '+1',
    '-',
    '1e',
    '0x10',
    'NaN',
    'Infinity',
    'tru',
    'nul',
    '"abc',
    '"\t"',
    '"\\x"',
    '"\\u12"',
    '[1,]',
    '[,1]',
    '{"a":1,}',
    '{a:1}',
    "{'a':1}",
    '{"a" 1}',
    '[1 2]',
    '{} {}',
    '[1]]',
    '\u00a0 1',
  ];
  for (const text of invalid) {
    assert.throws(() => JSON.parse(text), undefined, text);
    assert.throws(() => strict(text), code('ASSET_DATA'), text);
  }
  assert.throws(
    () => parseStrictJson(Uint8Array.of(0x22, 0xff, 0x22), 'Bytes'),
    code('ASSET_DATA'),
  );
});

test('strict JSON rejects duplicate keys and deep nesting, and never touches prototypes', () => {
  assert.throws(() => strict('{"a":1,"a":2}'), /duplicate key "a"/);
  assert.throws(() => strict('{"x":{"a":1,"b":2,"a":3}}'), code('ASSET_DATA'));
  assert.deepEqual(strict('{"a":1,"b":{"a":2}}'), { a: 1, b: { a: 2 } });
  assert.throws(() => strict('['.repeat(17) + ']'.repeat(17)), /nesting deeper than 16/);
  assert.equal(strict('['.repeat(16) + ']'.repeat(16)).length, 1);
  const parsed = strict(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
  );
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ['__proto__', 'constructor']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

/** A 2-glyph 8 × 3 font: 'A' is a diagonal, 'B' a full top row. */
const glyphRows = [
  ['#.......', '.#......', '..#.....'],
  ['########', '........', '.......#'],
];
const glyphBytes = [0x80, 0x40, 0x20, 0xff, 0x00, 0x01];

function font(overrides = {}) {
  return {
    format: 'pixeljs-font',
    version: 1,
    glyphWidth: 8,
    glyphHeight: 3,
    firstChar: 65,
    charCount: 2,
    bitmap: Buffer.from(glyphBytes).toString('base64'),
    ...overrides,
  };
}

test('font files in both encodings produce identical createFont options', () => {
  const fromBitmap = parseFontFile(font({ fallbackChar: 66 }));
  const { bitmap: _, ...withoutBitmap } = font({ fallbackChar: 66 });
  const fromGlyphs = parseFontFile({ ...withoutBitmap, glyphs: glyphRows });
  assert.deepEqual(fromBitmap, fromGlyphs);
  assert.deepEqual(fromBitmap, {
    glyphWidth: 8,
    glyphHeight: 3,
    firstChar: 65,
    charCount: 2,
    fallbackChar: 66,
    bitmap: Uint8Array.from(glyphBytes),
  });
  // Rows narrower than a byte and wider than one byte.
  const narrow = parseFontFile({
    format: 'pixeljs-font',
    version: 1,
    glyphWidth: 3,
    glyphHeight: 2,
    charCount: 1,
    glyphs: [['#.#', '.##']],
  });
  assert.deepEqual([...narrow.bitmap], [0xa0, 0x60]);
  assert.equal(narrow.firstChar, 32, 'firstChar defaults to 32');
  assert.equal('fallbackChar' in narrow, false);
  const wide = parseFontFile({
    format: 'pixeljs-font',
    version: 1,
    glyphWidth: 10,
    glyphHeight: 1,
    charCount: 1,
    glyphs: [['#........#']],
  });
  assert.deepEqual([...wide.bitmap], [0x80, 0x40]);
  const defaults = parseFontFile({
    format: 'pixeljs-font',
    version: 1,
    glyphWidth: 1,
    glyphHeight: 1,
    bitmap: Buffer.alloc(96).toString('base64'),
  });
  assert.equal(defaults.charCount, 96);
});

test('font file errors are ASSET_DATA and newer versions say so', () => {
  const { bitmap: _, ...noBitmap } = font();
  const cases = [
    [null, /JSON object/],
    [[], /JSON object/],
    [font({ extra: 1 }), /unknown key "extra"/],
    [font({ format: 'other' }), /format must be "pixeljs-font"/],
    [font({ version: 2 }), /version 2 is newer than this version of PixelJS supports \(1\)/],
    [font({ version: 0 }), /version must be 1/],
    [font({ version: '1' }), /version must be 1/],
    [font({ glyphWidth: 0 }), /glyphWidth must be an integer between 1 and 64/],
    [font({ glyphHeight: 65 }), /glyphHeight/],
    [font({ glyphWidth: 1.5 }), /glyphWidth/],
    [font({ firstChar: 65536 }), /firstChar/],
    [font({ firstChar: 65535, charCount: 2 }), /charCount must be an integer between 1 and 1/],
    [font({ charCount: 257 }), /charCount/],
    [font({ fallbackChar: 64 }), /fallbackChar must be an integer between 65 and 66/],
    [font({ bitmap: 'gEAg/wAB' + '=' }), /base64 of exactly/],
    [font({ bitmap: 'gEAg/wA!' }), /not valid base64/],
    [font({ bitmap: 'gEAg /wA' }), /not valid base64/],
    [font({ bitmap: 42 }), /base64 of exactly/],
    [{ ...font(), glyphs: glyphRows }, /exactly one of "bitmap" and "glyphs"/],
    [noBitmap, /exactly one of "bitmap" and "glyphs"/],
    [{ ...noBitmap, glyphs: [glyphRows[0]] }, /exactly charCount \(2\) glyphs/],
    [
      { ...noBitmap, glyphs: [glyphRows[0], glyphRows[1].slice(0, 2)] },
      /exactly glyphHeight \(3\) rows/,
    ],
    [
      { ...noBitmap, glyphs: [glyphRows[0], ['########', '.......', '.......#']] },
      /exactly glyphWidth/,
    ],
    [
      { ...noBitmap, glyphs: [glyphRows[0], ['########', '...x....', '.......#']] },
      /may only contain/,
    ],
    [{ ...noBitmap, glyphs: [glyphRows[0], [1, 2, 3]] }, /exactly glyphWidth/],
  ];
  for (const [value, message] of cases)
    assert.throws(
      () => parseFontFile(value),
      (error) => code('ASSET_DATA')(error) && message.test(error.message),
      String(message),
    );
});

test('base64 decoding is canonical and strict', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 64, 65, 66]) {
    const data = Buffer.from(Array.from({ length }, (_, index) => (index * 53 + 11) & 255));
    assert.deepEqual(decodeBase64(data.toString('base64')), new Uint8Array(data));
  }
  for (const text of [
    'A',
    'AB',
    'ABC',
    'A===',
    '=AAA',
    'AB=C',
    'QR==',
    'QUJ=',
    'AB\nC',
    'ABC-',
    'ABCé',
  ])
    assert.equal(decodeBase64(text), null, text);
});

test('textSize follows graphics.text layout', () => {
  assert.deepEqual(textSize('', 8, 8), { width: 0, height: 0 });
  assert.deepEqual(textSize('\r\r', 8, 8), { width: 0, height: 0 });
  assert.deepEqual(textSize('A', 8, 8), { width: 8, height: 8 });
  assert.deepEqual(textSize('HELLO', 5, 7), { width: 25, height: 7 });
  assert.deepEqual(textSize('AB\nCDE\r\nF', 6, 9), { width: 18, height: 27 });
  assert.deepEqual(textSize('A\n', 8, 8), { width: 8, height: 16 });
  assert.deepEqual(textSize('\n', 8, 8), { width: 0, height: 16 });
  // Surrogate pairs are two code units, as graphics.text draws them.
  assert.deepEqual(textSize('\ud83d\ude00', 4, 4), { width: 8, height: 4 });
});

const base = new URL('https://games.example/play/assets/manifest.json?v=3');

function manifest(sections = {}) {
  return { format: 'pixeljs-assets', version: 1, ...sections };
}

test('a valid manifest resolves every entry inside the manifest directory', () => {
  const parsed = parseManifest(
    manifest({
      tilemaps: { level: { src: 'maps/level-1.json', tileset: 'tiles' } },
      images: {
        tiles: { src: 'img/tiles.png', transparentIndex: 15 },
        'hero.v2': { src: 'img/hero sprite.png' },
      },
      fonts: { small: { src: 'fonts/small.json' } },
      sounds: { jump: { src: 'sfx/jump.json' } },
      data: { levels: { src: '...json' } },
    }),
    base,
    16,
  );
  assert.deepEqual(parsed.ids, {
    images: ['tiles', 'hero.v2'],
    tilemaps: ['level'],
    fonts: ['small'],
    sounds: ['jump'],
    music: [],
    data: ['levels'],
  });
  const byId = Object.fromEntries(parsed.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.level.url.href, 'https://games.example/play/assets/maps/level-1.json');
  assert.equal(byId['hero.v2'].url.href, 'https://games.example/play/assets/img/hero%20sprite.png');
  assert.equal(byId.levels.url.href, 'https://games.example/play/assets/...json');
  assert.equal(byId.tiles.transparentIndex, 15);
  assert.equal(byId.level.tileset, 'tiles');
  assert.ok(byId.level.phase > byId.tiles.phase, 'tilemaps load after images');
  assert.equal(parseManifest(manifest(), base, 16).entries.length, 0);
  // An object manifest resolves against the document base, here a directory.
  const object = parseManifest(
    manifest({ data: { a: { src: 'a.json' } } }),
    new URL('https://x.test/game/'),
    2,
  );
  assert.equal(object.entries[0].url.href, 'https://x.test/game/a.json');
});

test('manifest validation rejects malformed structure with ASSET_DATA', () => {
  const image = { src: 'a.png' };
  const cases = [
    [null, /JSON object/],
    [[], /JSON object/],
    [{ version: 1 }, /format must be "pixeljs-assets"/],
    [manifest({ format: 'pixeljs-font' }), /format must be/],
    [manifest({ version: 2 }), /version 2 is newer than this version of PixelJS supports \(1\)/],
    [manifest({ version: 0 }), /version must be 1/],
    [manifest({ version: '1' }), /version must be 1/],
    [manifest({ extra: {} }), /unknown key "extra"/],
    [manifest({ images: [] }), /"images" must be an object/],
    [manifest({ images: 'a.png' }), /"images" must be an object/],
    [manifest({ images: { a: 'a.png' } }), /images.a must be an object/],
    [manifest({ images: { a: {} } }), /images.a needs a "src"/],
    [manifest({ images: { a: { src: 'a.png', size: 2 } } }), /unknown key "size"/],
    [
      manifest({ fonts: { a: { src: 'a.json', transparentIndex: 1 } } }),
      /unknown key "transparentIndex"/,
    ],
    [manifest({ images: { a: { src: 'a.png', transparentIndex: 16 } } }), /between 0 and 15/],
    [manifest({ images: { a: { src: 'a.png', transparentIndex: -1 } } }), /between 0 and 15/],
    [manifest({ images: { a: { src: 'a.png', transparentIndex: '1' } } }), /between 0 and 15/],
    [manifest({ tilemaps: { m: { src: 'm.json' } } }), /tileset must be the id of an image/],
    [manifest({ tilemaps: { m: { src: 'm.json', tileset: 'nope' } } }), /missing image "nope"/],
    [
      manifest({ fonts: { f: image }, tilemaps: { m: { src: 'm.json', tileset: 'f' } } }),
      /missing image "f"/,
    ],
    [manifest({ images: { 'a b': image } }), /must match/],
    [manifest({ images: { 'a/b': image } }), /must match/],
    [manifest({ images: { '': image } }), /must match/],
    [manifest({ images: { ['x'.repeat(65)]: image } }), /must match/],
    [manifest({ images: { é: image } }), /must match/],
  ];
  for (const [value, message] of cases)
    assert.throws(
      () => parseManifest(value, base, 16),
      (error) => code('ASSET_DATA')(error) && message.test(error.message),
      String(message),
    );
  assert.equal(
    parseManifest(manifest({ images: { ['x'.repeat(64)]: image } }), base, 16).entries.length,
    1,
  );
});

test('only own properties count: inherited values are ignored', () => {
  const inherited = Object.create({ format: 'pixeljs-assets', version: 1 });
  assert.throws(() => parseManifest(inherited, base, 16), /format must be/);
  const entry = Object.create({ src: 'a.png' });
  assert.throws(() => parseManifest(manifest({ images: { a: entry } }), base, 16), /needs a "src"/);
  const map = Object.assign(Object.create({ tileset: 'a' }), { src: 'm.json' });
  assert.throws(
    () =>
      parseManifest(manifest({ images: { a: { src: 'a.png' } }, tilemaps: { m: map } }), base, 16),
    /tileset must be the id of an image/,
  );
  const fontData = Object.assign(Object.create({ format: 'pixeljs-font' }), {
    version: 1,
    glyphWidth: 1,
    glyphHeight: 1,
    charCount: 1,
    bitmap: 'AA==',
  });
  assert.throws(() => parseFontFile(fontData), /format must be "pixeljs-font"/);
});

test('ids follow JavaScript key order: integer-like ids first', () => {
  const parsed = parseManifest(
    strict(
      '{"format":"pixeljs-assets","version":1,"images":{"title":{"src":"t.png"},"2":{"src":"2.png"},"1":{"src":"1.png"}}}',
    ),
    base,
    16,
  );
  assert.deepEqual(parsed.ids.images, ['1', '2', 'title']);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.id),
    ['1', '2', 'title'],
  );
});

test('music is a manifest section; unknown sections are invalid data', () => {
  assert.equal(Object.hasOwn(ASSET_KINDS, 'music'), true);
  const parsed = parseManifest(
    manifest({ music: { theme: { src: 'music/theme.json' } } }),
    base,
    16,
  );
  assert.deepEqual(parsed.ids.music, ['theme']);
  assert.throws(
    () =>
      parseManifest(manifest({ music: { theme: { src: 'theme.json', loop: true } } }), base, 16),
    code('ASSET_DATA'),
  );
  assert.throws(
    () => parseManifest(manifest({ scripts: { main: { src: 'main.js' } } }), base, 16),
    /unknown key "scripts"/,
  );
});

test('manifest paths cannot escape the manifest directory', () => {
  const escapes = [
    '../secret.json',
    'a/../../secret.json',
    'a/..',
    './a.json',
    'a/./b.json',
    'a//b.json',
    'a/',
    '/abs.json',
    '//evil.example/x.json',
    'https://evil.example/x.json',
    'javascript:alert(1)',
    'data:application/json,{}',
    'C:\\x.json',
    'a\\..\\..\\x.json',
    '%2e%2e/x.json',
    '.%2E/x.json',
    'a%2fb.json',
    'x.json?token=1',
    'x.json#frag',
    ' ../x.json',
    '../x.json ',
    '.\t./x.json',
    'a\n/../../x.json',
    '\u0000x.json',
    '\u007fx.json',
    'x'.repeat(513),
    '',
    42,
    null,
  ];
  for (const src of escapes)
    assert.throws(
      () => parseManifest(manifest({ data: { d: { src } } }), base, 16),
      code('ASSET_DATA'),
      JSON.stringify(src),
    );
  for (const src of [
    'x'.repeat(512),
    'a b/c.json',
    'ünï/çødé.json',
    '.../x.json',
    'a..b/c',
    '~user.json',
  ])
    assert.ok(
      parseManifest(manifest({ data: { d: { src } } }), base, 16).entries[0].url.href.startsWith(
        'https://games.example/play/assets/',
      ),
      src,
    );
});

test('duplicate ids, prototype keys and entry counts are rejected', () => {
  const text = (body) => strict(`{"format":"pixeljs-assets","version":1,${body}}`);
  assert.throws(
    () => text('"images":{"a":{"src":"a.png"},"a":{"src":"b.png"}}'),
    /duplicate key "a"/,
  );
  assert.throws(() => text('"images":{},"images":{}'), /duplicate key "images"/);
  // The same id in different sections is allowed.
  assert.equal(
    parseManifest(text('"images":{"a":{"src":"a.png"}},"fonts":{"a":{"src":"a.json"}}'), base, 16)
      .entries.length,
    2,
  );
  for (const body of [
    '"__proto__":{}',
    '"images":{"__proto__":{"src":"a.png"}}',
    '"images":{"constructor":{"src":"a.png"}}',
    '"images":{"prototype":{"src":"a.png"}}',
    '"images":{"a":{"src":"a.png","__proto__":{"transparentIndex":1}}}',
  ])
    assert.throws(() => parseManifest(text(body), base, 16), /forbidden key/, body);
  assert.equal(Object.prototype.src, undefined);
  const many = (count) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`e${index}`, { src: `${index}.json` }]),
    );
  const limit = MANIFEST_LIMITS.entries;
  assert.equal(limit, 1024);
  assert.equal(
    parseManifest(manifest({ data: many(1000), fonts: many(24) }), base, 16).entries.length,
    limit,
  );
  assert.throws(
    () => parseManifest(manifest({ data: many(1000), fonts: many(25) }), base, 16),
    code('CAPACITY'),
  );
});

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Fake engine: loaders wait until the test settles them; releases are recorded. */
function fakeHost() {
  const lifetime = new AbortController();
  const host = {
    lifetime: lifetime.signal,
    dispose: () => lifetime.abort(),
    started: [],
    pending: new Map(),
    released: [],
    active: 0,
    peak: 0,
    idleError: null,
    release(value) {
      if (lifetime.signal.aborted) throw new PixelJSError('STATE', 'disposed');
      host.released.push(value.name);
    },
    check() {
      if (lifetime.signal.aborted) throw new PixelJSError('STATE', 'disposed');
    },
    idle() {
      if (host.idleError) throw host.idleError;
    },
    loaders: {},
  };
  for (const kind of Object.keys(ASSET_KINDS))
    host.loaders[kind] = (entry, signal, tileset) => {
      const name = `${kind}.${entry.id}`;
      const control = deferred();
      host.started.push({ name, tileset: tileset?.name, signal });
      host.pending.set(name, control);
      host.active++;
      host.peak = Math.max(host.peak, host.active);
      signal.addEventListener('abort', () =>
        control.reject(new PixelJSError('ABORTED', 'The operation was cancelled.')),
      );
      return control.promise.finally(() => host.active--);
    };
  host.finish = async (name, value = { name }) => {
    host.pending.get(name).resolve(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  host.failWith = async (name, error) => {
    host.pending.get(name).reject(error);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return host;
}

const sample = (sections) => parseManifest(manifest(sections), base, 16);
const range = (prefix, count, extra = {}) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `${prefix}${index}`,
      { src: `${prefix}${index}.x`, ...extra },
    ]),
  );

test('bundles load at most four entries at once, images and data first, maps after their tilesets', async () => {
  const host = fakeHost();
  const progress = [];
  const loading = loadBundle(
    sample({
      tilemaps: { map: { src: 'map.json', tileset: 'i5' } },
      fonts: range('f', 2),
      images: range('i', 6),
      data: range('d', 2),
    }),
    host,
    { onProgress: (loaded, total) => progress.push([loaded, total]) },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    host.started.map((item) => item.name),
    ['images.i0', 'images.i1', 'images.i2', 'images.i3'],
  );
  for (let index = 0; index < 4; index++) await host.finish(`images.i${index}`);
  assert.deepEqual(
    host.started.slice(4).map((item) => item.name),
    ['images.i4', 'images.i5', 'data.d0', 'data.d1'],
  );
  await host.finish('images.i4');
  await host.finish('data.d0');
  // The tilemap still waits for its tileset; fonts come next.
  assert.deepEqual(
    host.started.slice(8).map((item) => item.name),
    ['fonts.f0', 'fonts.f1'],
  );
  await host.finish('images.i5');
  assert.equal(host.started.at(-1).name, 'tilemaps.map');
  assert.equal(host.started.at(-1).tileset, 'images.i5');
  for (const name of ['data.d1', 'fonts.f0', 'fonts.f1', 'tilemaps.map']) await host.finish(name);
  const bundle = await loading;
  assert.equal(host.peak, 4);
  assert.deepEqual(
    progress,
    Array.from({ length: 11 }, (_, index) => [index + 1, 11]),
  );
  assert.equal(bundle.image('i3').name, 'images.i3');
  assert.equal(bundle.tilemap('map').name, 'tilemaps.map');
  assert.equal(bundle.font('f1').name, 'fonts.f1');
  assert.equal(bundle.data('d0').name, 'data.d0');
  assert.deepEqual(bundle.ids('images'), ['i0', 'i1', 'i2', 'i3', 'i4', 'i5']);
  assert.deepEqual(bundle.ids('sounds'), []);
  assert.deepEqual(bundle.ids('music'), []);
  assert.throws(() => bundle.ids('scripts'), code('ARGUMENT'));
  assert.throws(() => bundle.image('missing'), code('ARGUMENT'));
  assert.throws(() => bundle.image(3), code('ARGUMENT'));
  assert.throws(() => bundle.sound('i0'), code('ARGUMENT'));
  host.idleError = new PixelJSError('STATE', 'inside a callback');
  assert.throws(() => bundle.release(), code('STATE'));
  assert.deepEqual(host.released, []);
  host.idleError = null;
  bundle.release();
  assert.equal(host.released[0], 'tilemaps.map', 'tilemaps are released before their tilesets');
  assert.equal(host.released.length, 9, 'data entries own no resource');
  assert.ok(host.released.indexOf('fonts.f0') < host.released.indexOf('images.i0'));
  bundle.release();
  assert.equal(host.released.length, 9, 'release is idempotent');
  assert.throws(() => bundle.image('i0'), code('STATE'));
  assert.throws(() => bundle.ids('images'), code('STATE'));
});

test('bundle.release() is final even when one resource cannot be released', async () => {
  const host = fakeHost();
  const loading = loadBundle(sample({ images: range('i', 3), fonts: range('f', 1) }), host);
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const name of ['images.i0', 'images.i1', 'images.i2', 'fonts.f0']) await host.finish(name);
  const bundle = await loading;
  const inUse = new PixelJSError('RESOURCE_IN_USE', 'used by a tilemap outside the bundle');
  const release = host.release;
  host.release = (value) => {
    if (value.name === 'images.i1') throw inUse;
    release(value);
  };
  assert.throws(
    () => bundle.release(),
    (error) => error === inUse,
  );
  assert.deepEqual(host.released, ['fonts.f0', 'images.i0', 'images.i2']);
  assert.throws(() => bundle.image('i1'), code('STATE'));
  bundle.release();
  assert.equal(host.released.length, 3, 'nothing is retried');
});

test('a failed entry cancels the others and releases everything already created', async () => {
  const host = fakeHost();
  const loading = loadBundle(
    sample({
      images: range('i', 4),
      tilemaps: { map: { src: 'm.json', tileset: 'i0' } },
      data: range('d', 1),
    }),
    host,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.finish('images.i0');
  await host.finish('images.i1');
  assert.deepEqual(
    host.started.map((item) => item.name),
    ['images.i0', 'images.i1', 'images.i2', 'images.i3', 'data.d0', 'tilemaps.map'],
  );
  await host.finish('tilemaps.map');
  const original = new PixelJSError('ASSET_LOAD', 'Request failed (HTTP 404).');
  // images.i2 completes after the failure: it must be released as well.
  host.pending.get('data.d0').reject(original);
  host.pending.get('images.i2').resolve({ name: 'images.i2' });
  await assert.rejects(loading, (error) => {
    assert.equal(error.code, 'ASSET_LOAD');
    assert.equal(error.cause, original);
    assert.match(error.message, /data\.d0.*HTTP 404/);
    return true;
  });
  assert.ok(
    host.started.every((item) => item.signal.aborted),
    'every pending load was cancelled',
  );
  assert.deepEqual(host.released, ['tilemaps.map', 'images.i0', 'images.i1', 'images.i2']);
});

test('abort, disposal and a throwing progress callback roll back', async () => {
  // Aborting the caller's signal.
  let host = fakeHost();
  const controller = new AbortController();
  let loading = loadBundle(sample({ images: range('i', 2) }), host, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.finish('images.i0');
  controller.abort();
  await assert.rejects(loading, code('ABORTED'));
  assert.deepEqual(host.released, ['images.i0']);
  // An already aborted signal starts nothing.
  host = fakeHost();
  await assert.rejects(
    loadBundle(sample({ images: range('i', 2) }), host, { signal: AbortSignal.abort() }),
    code('ABORTED'),
  );
  assert.equal(host.started.length, 0);
  // Disposal: STATE, and the disposed engine is not asked to release anything.
  host = fakeHost();
  loading = loadBundle(sample({ images: range('i', 2) }), host);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.finish('images.i0');
  host.dispose();
  await assert.rejects(loading, code('STATE'));
  assert.deepEqual(host.released, []);
  // The progress callback's own error is the rejection.
  host = fakeHost();
  const thrown = new Error('progress failed');
  loading = loadBundle(sample({ images: range('i', 3) }), host, {
    onProgress: (loaded) => {
      if (loaded === 2) throw thrown;
    },
  });
  const rejected = assert.rejects(loading, (error) => error === thrown);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await host.finish('images.i0');
  await host.finish('images.i1');
  await rejected;
  assert.deepEqual([...host.released].sort(), ['images.i0', 'images.i1']);
  // An empty manifest resolves to an empty bundle.
  const empty = await loadBundle(sample({}), fakeHost());
  assert.deepEqual(empty.ids('data'), []);
});
