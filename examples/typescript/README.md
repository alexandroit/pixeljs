# TypeScript example

This is the typed equivalent of the standalone JavaScript consumer. Both use the same original `../javascript/game.js` game module and its `game.d.ts` controller declaration. The engine type is derived directly from the actual package factory, rather than duplicated.

Use a TypeScript-aware bundler or dev server (such as Vite) with `@pixeljs/core` installed from npm. Serve `index.html`; the server compiles `main.ts`, which loads the game's assets from `../javascript/assets/assets.json`. Root verification checks the typed consumer. A raw HTTP server cannot execute TypeScript source directly.

Source is intentionally shared with the site's playable demonstration. No separate, non-running code sample is maintained for the documentation panel.
