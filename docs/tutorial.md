# Tutorial: your first PixelJS game

This tutorial builds _Star Catcher_, a small game in which you move a basket to catch falling stars, in about 120 lines of JavaScript. Along the way it covers the pieces every PixelJS game uses: the engine and its loop, drawing, input, sound and music, asset files, screenshots and shipping. The [API reference](api.md) has every detail.

You need Node.js 20.19 or later (the starter uses Vite) and a browser.

## 1. Create the project

```sh
npm create @pixeljs@latest star-catcher -- --template javascript
cd star-catcher
npm install
npm run dev
```

The starter opens a small platformer. You will replace its `src/main.js`. In `index.html`, keep the `<canvas>` and delete the `<div class="controls">` block: this game starts its sound with the first key press instead of a button. (`--template typescript`, the default, gives the same project in strict TypeScript.)

## 2. An engine and its loop

Replace `src/main.js` with:

```js
import { createEngine } from '@pixeljs/core';

const canvas = document.querySelector('canvas');
const engine = await createEngine({ canvas, width: 160, height: 120 });

function update(dt) {
  // Game logic: called at a fixed 60 Hz, so dt is 1/60 s.
}

function draw() {
  const g = engine.graphics;
  g.clear(1);
  g.text(8, 8, 'HELLO, PIXELJS', 7);
}

engine.start({ update, draw });
```

`createEngine` loads the WebAssembly core and resolves to an engine with a 160 × 120 indexed framebuffer. The default palette has 16 colors, numbered 0–15; drawing always uses these numbers. `update` runs at a fixed rate however fast the display is, and `draw` runs once per displayed frame. Drawing is only allowed inside `draw`, and the whole frame is validated and rasterized in C when `draw` returns.

The canvas shows the framebuffer at whatever size CSS gives it, with sharp pixels. Make it four times bigger in `src/style.css`:

```css
canvas {
  width: 640px;
  height: 480px;
}
```

Alternatively, `createEngine({ scaling: 'integer' })` sizes the canvas itself to the largest whole multiple that fits its parent element; the parent then needs a size of its own.

## 3. Draw the game

Add the game state and replace `draw`:

```js
const basket = { x: 72, y: 104, width: 16 };
let stars = [];
let score = 0;
let lives = 3;
let time = 0;

const SKY = [
  [12, 30],
  [40, 18],
  [75, 44],
  [110, 25],
  [140, 60],
  [25, 70],
  [95, 80],
];

function draw() {
  const g = engine.graphics;
  g.clear(1);
  for (const [x, y] of SKY) g.pixel(x, y, 3);
  for (const star of stars) {
    const x = Math.round(star.x);
    const y = Math.round(star.y);
    g.triangleFill(x, y - 4, x - 3, y + 2, x + 3, y + 2, 7);
    g.triangleFill(x, y + 4, x - 3, y - 2, x + 3, y - 2, 7);
  }
  g.rect(Math.round(basket.x), basket.y, basket.width, 6, 6);
  g.rect(Math.round(basket.x) + 1, basket.y + 6, basket.width - 2, 2, 15);
  g.text(4, 4, `SCORE ${score}`, 4);
  g.text(100, 4, `LIVES ${lives}`, 5);
}
```

Coordinates are whole pixels: round positions that you move with fractional speeds. Two filled triangles make each star, and the built-in font is 8 × 8 pixels per character. Other shapes include `line`, `rectb` (an outline), `circle`, `circleFill`, `ellipse`, `ellipseFill`, `triangle` and flood `fill`.

## 4. Move and catch

Replace `update`:

```js
function update(dt) {
  time += dt;
  if (lives === 0) {
    if (engine.input.wasPressed('Enter') || engine.input.wasButtonPressed('Start')) restart();
    return;
  }
  const input = engine.input;
  let direction = input.axis('leftX'); // A gamepad's left stick, -1 to 1.
  if (input.isDown('ArrowLeft') || input.isDown('KeyA') || input.isButtonDown('Left'))
    direction = -1;
  if (input.isDown('ArrowRight') || input.isDown('KeyD') || input.isButtonDown('Right'))
    direction = 1;
  // Touch or mouse: follow the pointer while it is down.
  if (input.pointer.down) direction = Math.sign(input.pointer.x - (basket.x + basket.width / 2));
  basket.x = Math.max(0, Math.min(160 - basket.width, basket.x + direction * 90 * dt));

  if (Math.random() < dt * (1 + time / 30)) stars.push({ x: 8 + Math.random() * 144, y: -4 });
  for (const star of stars) star.y += (30 + time) * dt;
  const caught = stars.filter(
    (star) =>
      star.y >= basket.y - 2 &&
      star.y <= basket.y + 6 &&
      star.x >= basket.x - 2 &&
      star.x <= basket.x + basket.width + 2,
  );
  const missed = stars.filter((star) => star.y > 124);
  score += caught.length * 10;
  lives = Math.max(0, lives - missed.length);
  stars = stars.filter((star) => !caught.includes(star) && !missed.includes(star));
}

function restart() {
  stars = [];
  score = 0;
  lives = 3;
  time = 0;
}
```

`engine.input` is a snapshot taken once per update tick: `isDown` tells whether a key is held, `wasPressed` whether it went down since the previous tick, so a press is seen exactly once. Keys use `KeyboardEvent.code` names. Gamepads use the standard layout (`'A'`, `'Start'`, `'Left'`, …) and `axis` values are dead-zoned. `input.pointer` follows the mouse or the first finger in game pixels, including letterboxed layouts.

Show a message when the game is over, at the end of `draw`:

```js
if (lives === 0) {
  g.rect(0, 46, 160, 30, 0);
  for (const [line, y] of [
    ['GAME OVER', 52],
    ['PRESS ENTER', 64],
  ])
    g.text((160 - engine.measureText(line).width) >> 1, y, line, 5);
}
```

`measureText` returns the size `text` would draw, here to center each line.

## 5. Sound and music

Every sound is synthesized by the engine's four-voice synthesizer, so there are no audio files to load. Describe the sounds once, outside the callbacks:

```js
const catchSound = engine.audio.createSound({
  waveform: 'triangle',
  bpm: 300,
  notes: [
    { step: 0, pitch: 'E5' },
    { step: 1, pitch: 'B5', length: 2, effect: 'fadeout' },
  ],
});
const missSound = engine.audio.createSound({
  waveform: 'square',
  frequency: 220,
  effect: 'slide',
  slideTo: 110,
  duration: 0.2,
  volume: 0.4,
});
const tune = engine.audio.createMusic({
  bpm: 120,
  length: 16,
  tracks: [
    {
      voice: 3,
      waveform: 'sine',
      volume: 0.3,
      notes: ['C4', 'E4', 'G4', 'E4'].map((pitch, index) => ({
        step: index * 4,
        pitch,
        length: 3,
      })),
    },
  ],
});
engine.audio.playMusic(tune); // Starts once audio is unlocked.

// Browsers start audio only from a user gesture.
addEventListener('keydown', () => void engine.audio.unlock().catch(() => {}), { once: true });
addEventListener('pointerdown', () => void engine.audio.unlock().catch(() => {}), { once: true });
```

Then play them in `update`, where `caught` and `missed` are known:

```js
if (caught.length) engine.audio.play(catchSound, 0);
if (missed.length) engine.audio.play(missSound, 1);
```

A sound is a single note (`frequency`, `duration`, an optional `effect`) or a short jingle of `notes` at a tempo. Pitches are note names such as `'C4'` or `'F#5'`, or MIDI numbers. Music plays up to four tracks on the audio clock, independently of the frame rate; this piece uses voice 3 and the effects use voices 0 and 1, so an effect never cuts the music. Until `unlock()` succeeds, `play` drops notes silently; the game never waits for audio.

## 6. Pictures and other files

Drawing everything with shapes goes a long way, but most games use images. Create a folder `public/assets/` and put a PNG there, for example a 16 × 8 `basket.png` drawn in any editor. Colors are mapped to the nearest palette color when the image loads. Then list it in `public/assets/assets.json`:

```json
{
  "format": "pixeljs-assets",
  "version": 1,
  "images": { "basket": { "src": "basket.png", "transparentIndex": 0 } }
}
```

Load it before starting the game, and draw it instead of the two rectangles:

```js
const assets = await engine.loadAssets('assets/assets.json');
const basketImage = assets.image('basket');
// In draw():
g.sprite(basketImage, Math.round(basket.x), basket.y);
```

A manifest can also list tilemaps, bitmap fonts, sounds, music and JSON data. Everything loads together, or nothing does: if one file fails, the others are released and `loadAssets` rejects with the failing entry's error. [PixelJS Studio](../apps/editor/README.md), the editor, exports sprites, tile maps, sounds and music in exactly this layout.

## 7. Screenshots

`engine.capture()` encodes the last displayed frame as a PNG. Save one with a key press:

```js
addEventListener('keydown', async (event) => {
  if (event.code !== 'KeyP') return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await engine.capture({ scale: 4 }));
  link.download = 'star-catcher.png';
  link.click();
});
```

`engine.startRecording()` and `engine.stopRecording()` record the frames in between as a looping GIF in the same way.

## 8. Ship it

```sh
npm run build
```

`dist/` now holds static files: your page, the bundled game and the engine's `.wasm` files. Upload them to any static host. Three requirements:

- Serve `.wasm` files as `application/wasm`; most hosts already do.
- Serve the page over HTTPS (or `localhost`): browsers only offer audio worklets in secure contexts.
- If your site sends a Content-Security-Policy, it needs `script-src 'self' 'wasm-unsafe-eval'`. Nothing else is required: the engine never uses `eval`, inline scripts or remote code.

Before the page closes, `engine.dispose()` releases the engine, its audio and its listeners; a page that is simply closed needs nothing.

## Where next

- Read the complete [API reference](api.md): palettes, tilemaps, fonts, cameras and clipping, sprite rotation and scaling, color remapping, pausing, errors and limits.
- Study the [Pac-Man example](../examples/javascript), which loads its maze tiles, sprites, font, sounds and music from one manifest.
- Open [PixelJS Studio](https://pixeljs.com/editor/) to draw sprites and maps and compose music for your game.
- [Publish on PixelJS](portal.md): put your game on pixeljs.com with levels, leaderboards, achievements, cloud saves and online play.
