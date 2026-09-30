# JavaScript example

Pac-Man is the playable demo shared by the product site's home page. `main.js` creates the engine, loads `assets/assets.json` with `engine.loadAssets()` and starts the game; `game.js` draws the maze tilemap, sprites and HUD text and plays the sounds and music from that bundle; `pacman-model.js` holds the deterministic maze, movement, pellets, ghost behavior, scoring and level state; `controls.js` supplies direction buttons, swipes and the first-gesture audio start. The TypeScript example uses these same modules.

The files in `assets/` are an ordinary asset manifest: PNG sprite sheets and maze tiles, a tilemap, a `pixeljs-font` HUD font, `pixeljs-sound` effects and jingles, and two `pixeljs-music` loops (the siren and the frightened-ghost loop). `node tools/generate-pacman-assets.mjs` writes them all, and `npm run verify` checks that they match the generator. Replace them to reskin the game, or open them in the [editor](../../apps/editor).

Install `@pixeljs/core` from npm in your project (`npm install @pixeljs/core`), then serve this directory with a module-aware development server or bundler such as Vite, so that the `assets/` files are served next to the page.

For a plain HTTP server, first use the repository's site build: Vite resolves the package import and emits the runtime, game and real WASM artifact. Source files in this directory intentionally preserve the real package import for normal npm consumers. Do not open the source HTML with `file://` or expect a browser to resolve a bare npm name unaided.

The board renders on load and waits for the first direction. Use arrows/WASD, a gamepad's d-pad or left stick, swipe on the maze, or press the direction buttons; sound starts with the first key press or tap, and Mute silences it. Screenshot saves the current frame as a PNG through `engine.capture()`. Clear all pellets to advance; power pellets make the ghosts edible for a limited time. The Pause button resumes the same state, Restart starts a new game, and the page disposes its engine instance on `pagehide`.

The maze, sprites, font, sounds and music were made for this demo and contain no material from the original arcade game. Pac-Man is a trademark of Bandai Namco Entertainment Inc.; this example is an unofficial tribute.
