# {{PROJECT_NAME}}

A 2D pixel game created with [PixelJS](https://pixeljs.com).

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm run dev
   ```

3. Build for production:
   ```bash
   npm run build
   ```

## What's inside

`src/main.js` is a small platformer to take apart: a hero sprite made with `createImage`, one-way platforms, triangle spikes, spinning coins drawn as ellipses, a flag that appears once every coin is collected, and a score drawn with `graphics.text`. Arrow keys, WASD and gamepads (d-pad, left stick, A to jump) all work.

Every sound is synthesized: a jump that slides up, coin and victory jingles, and a two-track music loop made with `audio.createMusic`. Browsers start audio only after a user gesture, so it begins with your first key press or tap; the button mutes it.

The [PixelJS API reference](https://github.com/alexandroit/pixeljs/blob/main/docs/api.md) lists everything else: tilemaps, fonts, asset manifests, screenshots and GIF recording.
