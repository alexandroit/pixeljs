# @pixeljs/create

Creates a ready-to-run [PixelJS](https://pixeljs.com) game project: a platformer in JavaScript or strict TypeScript, or a game ready for the PixelJS portal.

## Usage

```bash
# Asks which starter you want (TypeScript when the terminal is not interactive)
npm create @pixeljs@latest my-game

# Or choose the starter directly
npm create @pixeljs@latest my-game -- --template typescript
npm create @pixeljs@latest my-game -- --template javascript
npm create @pixeljs@latest my-game -- --template portal
npm create @pixeljs@latest my-game -- --template board

# Equivalent direct invocation
npx @pixeljs/create my-game --template typescript
```

Then:

```bash
cd my-game
npm install
npm run dev
```

`npm create @pixeljs` runs this package. Note that `npm create pixeljs` (without the `@`) would look for an unrelated unscoped package named `create-pixeljs`.

## Templates

| Template               | What you get                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript` (default) | A small, winnable platformer in strict TypeScript: a sprite hero, shapes, text, synthesized sounds and music, keyboard and gamepad input, and a production build |
| `javascript`           | The same platformer in JavaScript                                                                                                                                |
| `portal`               | A game for the PixelJS portal, in JavaScript: three levels with leaderboards, stars, two achievements and a cloud save                                           |
| `board`                | A board game for two players for the PixelJS portal, in JavaScript: against the computer, on one device and online, around a small rules interface (tic-tac-toe) |

The `portal` and `board` starters connect through `@pixeljs/core/portal` and include `public/pixeljs.json`, the manifest the portal reads. They run anywhere: outside the portal every portal call still answers. To publish one, run `npm run build`, zip the contents of `dist/` (with `index.html` and `pixeljs.json` at the root of the archive) and upload the archive in the PixelJS studio. The [developer guide](https://pixeljs.com/developers) and the tutorials for a [single-player](https://pixeljs.com/developers/tutorial/single-player) and a [multiplayer](https://pixeljs.com/developers/tutorial/multiplayer) game explain each step.

## Options

- `-t, --template <name>`: `typescript`, `javascript`, `portal` or `board`. Without it, an interactive terminal asks; otherwise the starter is `typescript`
- `-f, --force`: write into a non-empty directory, replacing files with the same names
- `-h, --help`: show help and the list of templates
- `-v, --version`: show the version

The destination must be empty unless `--force` is given. The tool never writes through symbolic links, runs no install scripts and makes no network requests; `npm install` in the new project is your own step. The starters use Vite and depend only on `@pixeljs/core` at runtime.

## License

MIT
