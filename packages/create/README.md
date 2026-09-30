# @pixeljs/create

Creates a ready-to-run [PixelJS](https://pixeljs.com) game project for JavaScript or strict TypeScript.

## Usage

```bash
# TypeScript starter (default)
npm create @pixeljs@latest my-game

# JavaScript starter
npm create @pixeljs@latest my-game -- --template javascript

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

## Options

- `-t, --template <name>`: `typescript` (default) or `javascript`
- `-f, --force`: write into a non-empty directory, replacing files with the same names
- `-h, --help`: show help
- `-v, --version`: show the version

The destination must be empty unless `--force` is given. The tool never writes through symbolic links, runs no install scripts and makes no network requests; `npm install` in the new project is your own step. The starters use Vite and depend only on `@pixeljs/core` at runtime. Each is a small, winnable platformer with a sprite hero, shapes, text, synthesized sounds and music, keyboard and gamepad input, and a production build.

## License

MIT
