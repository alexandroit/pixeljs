# PixelJS Studio

PixelJS Studio is the browser authoring tool for PixelJS games: a sprite and palette editor, a tile map editor, a sound editor, a music editor and a web-asset exporter. It is a separate application. It uses only the public `@pixeljs/core` API (`createEngine`, `createImage`, `createTilemap`, `graphics.*`, `audio.*`), and nothing from it is part of the runtime a game downloads.

Everything runs locally in the browser: files are opened with the file picker and saved as downloads. Nothing is uploaded.

## Running it

After `npm run build` (the engine must be built first):

```sh
npx vite apps/editor          # development server
npx vite build apps/editor    # static build in apps/editor/dist
```

`npm run build:site` also publishes it under `editor/` of the site build.

## Layout

| Tab              | Purpose                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| Sprite & Palette | Sprites of 1–256 × 1–256 pixels, the project palette, PNG import and single exports |
| Tilemap          | Maps of up to 256 × 256 cells built from a sprite used as a tileset                 |
| Sound            | Sound effects: single notes, and jingles of up to 64 notes                          |
| Music            | Pieces of up to four tracks of up to 512 notes each                                 |
| Export           | Every web asset of the project, each with its own download button                   |

The header holds **Undo**, **Redo** and the project file actions (**New**, **Open…**, **Save**). The footer shows status messages, the pixel or cell under the cursor, and the history size.

## Sprite and palette editor

Choose a sprite in the **Sprites** list. **New** adds a sprite of the current size, **Duplicate** copies the current one, **Delete** removes it (a sprite used as a map's tileset cannot be deleted). Change the name, the size (**Resize** crops or extends from the top-left corner) and the **Transparent color** of the selected sprite. A project holds at most 64 sprites.

### Tools

| Tool             | Key     | Effect                                                                                      |
| ---------------- | ------- | ------------------------------------------------------------------------------------------- |
| Pen              | P       | Paints the current color; a drag paints every pixel it crosses                              |
| Eraser           | E       | Paints the sprite's transparent color (color 0 when the sprite has none)                    |
| Fill             | F       | Fills the 4-connected area of the clicked color (diagonal neighbors are not connected)      |
| Line             | L       | Draws from press to release, pixel for pixel identical to the engine's `graphics.line`      |
| Rectangle        | R       | One-pixel outline spanning the two corners                                                  |
| Filled rectangle | Shift+R | Filled rectangle spanning the two corners                                                   |
| Eyedropper       | I       | Makes the clicked pixel's color current. Alt+click does the same with any tool              |
| Select           | S       | Drag to select a rectangle; drag inside the selection to move its pixels; a click deselects |

Every stroke, fill, shape or selection operation is one undo step.

### Selection, clipboard and flips

- **Copy** (Ctrl+C) copies the selected pixels into the editor's own clipboard (not the system clipboard). It survives switching sprites.
- **Cut** (Ctrl+X) copies, then fills the selection with the background color (the transparent color, or 0).
- **Paste** (Ctrl+V) writes the clipboard with its top-left corner at the selection's top-left corner or, with nothing selected, where it was copied from (the sprite's corner if that is outside this sprite). Every pixel is written, transparent ones included. The pasted area becomes the selection.
- **Move**: drag inside the selection, press Alt+arrow on the canvas, or use the arrow buttons. The block is lifted into a separate buffer, its old area takes the background color, then the block is written at the new place.
- **Overlap**: paste and move always read from a separate copy, so a block pasted or moved over its own area lands exactly as copied, never smeared.
- **Edges**: pixels pasted or moved past the sprite's edge are cut off, and the selection shrinks to what remains.
- **Clear** (Delete or Backspace) fills the selection with the background color. **Select all** is Ctrl+A; **Deselect** is Escape.
- **Flip H** (H) and **Flip V** (V) mirror the selection, or the whole sprite when nothing is selected.

Drawing tools are not limited to the selection.

### View

**Zoom** offers 1× to 32× (+ and − step through it); the first time a sprite is shown it is fitted to the view. **Grid** (G) shows pixel lines from 4× zoom and stronger lines every 8 pixels. Large sprites scroll; the canvas only ever covers the visible area.

### Keyboard editing

Tab to the canvas (it is framed when focused; the frame never covers pixels). Arrow keys move a yellow cursor, Space or Enter applies the tool at the cursor. Line, rectangle and select take two presses: the first sets the start corner, the second the end. Escape cancels a pending start corner.

### Palette

A project has one palette of 1–256 opaque colors, shared by all sprites; the default is the engine's own 16 colors. Click a swatch (or use the arrow keys inside the swatch group) to choose the drawing color; [ and ] step through colors.

- **Color (hex)**: type `#rrggbb` and press Enter or **Set**, or use the color picker, to change the selected color.
- **Number of colors**: grows the palette with new distinct colors, or shrinks it. Shrinking is refused while any sprite still uses a color that would be removed.
- A warning lists repeated colors: a PNG stores colors, not indices, so pixels of the higher index of a repeated color load back as the lower one. JSON images keep indices exactly.

### Live preview

A running PixelJS engine created with the project palette draws the sprite at 1:1 and tiled 2 × 2 (to show seams). Changes are uploaded as new images between frames. **Preview background** selects the color shown behind transparent pixels.

### PNG import

**Import PNG…** accepts static PNG files of at most 16 MiB and 1024 × 1024 pixels; the header is checked before the browser decodes anything. A review dialog then shows the source, the result and the changes before anything is added:

- **Region**: sprites are at most 256 × 256, so a larger image is imported one region at a time.
- **Transparent color**: pixels with alpha below 128 become this color. With **None**, alpha is ignored.
- **Mapping**: every other pixel takes the palette color with the smallest squared RGB distance, the lowest index on ties, never the transparent color (unless the palette has one color). This is the same rule, and gives the same indices, as `engine.loadImage`.
- **Changes**: the dialog counts pixels kept exactly and pixels changed (recolored to a different color, or with an alpha that was neither 0 nor 255), and can tint changed pixels magenta.

**Add as new sprite** creates a sprite named after the file; **Replace current sprite** replaces the current sprite's size, pixels and transparent color (one undo step). The PNG file itself is never modified.

### Single exports

**Export PNG** downloads the sprite as an 8-bit indexed PNG: the palette in `PLTE`, and the transparent color, if any, as the only transparent `tRNS` entry. **Export JSON** downloads the JSON image read by `engine.loadImage`:

```json
{ "width": 16, "height": 16, "transparentIndex": 0, "pixels": [0, 0, 7, 7] }
```

(`pixels` lists `width × height` palette indices, row by row; `transparentIndex` is omitted when the sprite has none.)

## Tile map editor

A map uses one sprite as its **tileset**, cut into tiles of **Tile width** × **Tile height** (1–256 pixels). Tiles are numbered left to right, top to bottom, counting whole tiles only: pixels beyond the last whole tile column or row are unused. ID 65535 (`EMPTY_TILE`) is an empty cell.

- **Maps**: **New**, **Duplicate**, **Delete**, name, and **Columns** × **Rows** (1–256 each; **Resize** keeps the top-left cells and adds empty ones). A project holds at most 64 maps and 1,048,576 cells in total.
- **Tileset** changes are refused if a placed tile would no longer exist. A tileset sprite cannot be resized if that would change its whole tiles per row (which would renumber placed tiles) or drop placed tiles.
- **Tiles**: click a tile in the picker, use the arrow keys on it, or type a **Selected tile ID**. [ and ] step through tiles.

| Tool      | Key | Effect                                                              |
| --------- | --- | ------------------------------------------------------------------- |
| Place     | P   | Places the selected tile; a drag places along the path              |
| Erase     | E   | Empties cells                                                       |
| Fill rect | R   | Fills the rectangle between two cells with the selected tile        |
| Pick      | I   | Selects the tile of the clicked cell. Alt+click works with any tool |

Zoom (1× to 16×), grid (G) and keyboard editing work as in the sprite editor; the cursor moves by cells.

The **live preview** is a running engine drawing the map with `createTilemap` and `graphics.tilemap` through a 256 × 144 camera placed at the view's scroll position; the dashed frame in the view shows that area. Map and tileset changes are published between frames. **Map JSON** and **Tileset PNG** download the map and its tileset.

## Sound editor

A project holds up to 64 named sounds, played through the same engine code a game uses: `createSound` validates them and the AudioWorklet synthesizer plays them. **Type** chooses what a sound is:

- **Single note**: waveform (square, triangle, sine or noise), frequency (above 0 and up to 24,000 Hz), gate duration (above 0 and up to 60 s) and an effect: **slide** glides to **Slide to** (Hz) over the note, **vibrato** wobbles by half a semitone at 6 Hz, **fadeout** fades to silence.
- **Notes (a jingle)**: up to 64 notes on a piano roll, played on one voice at **Beats per minute** (20–400) with **Steps per beat** (1–16). Switching a single note to notes starts with one C5 note.

The **Instrument** fields apply to the whole sound: waveform, volume (0–1), attack, decay and release (0–10 s) and sustain (0–1). Every committed field is one undo step; a value outside the engine's range is refused, named in the status line, and the field restored.

**Play** (P) unlocks audio from your click the first time, then plays the sound; **Stop** (Escape) silences every sound and the music. The line below shows the audio state the engine reports.

## Music editor

A project holds up to 16 named pieces. A piece has a tempo (**Beats per minute**, **Steps per beat**), a **Length** of 1–4,096 steps, **Loop**, and one to four **tracks**. Each track plays on its own voice (0–3, never shared) with its own instrument and holds up to 512 notes that start before the end of the piece. **Add track** takes the first free voice; a piece keeps at least one track and cannot be shortened below the start of its last note.

**Mute** and **Solo** only shape the preview: they are never saved or exported. Changing them while music plays restarts it with the new mix.

**Play** (P) sends the piece to the engine with `playMusic`; the synthesizer sequences it on the audio clock. The cyan playhead and the step shown under the buttons are **approximate**: they are computed from page time since Play at the piece's tempo, and ignore output latency and the device's start-up delay. A piece that does not loop stops by itself when the synthesizer reports its end; **Stop** (Escape) ends it at any time.

## Piano roll

Sounds with notes and music tracks share the piano roll: steps run left to right and MIDI pitches 0–127 bottom to top, one cell per step and pitch, with octave names at each C. A voice plays one note at a time, so notes of one sound or track never overlap in time. In music, the other tracks' notes show in blue and the end of the piece is marked in red.

- **Draw** (D): click an empty cell to add a note and drag right to lengthen it; new notes take the length used last. Drag a note to move it (step and pitch), or drag the right half of its last cell to resize it. Clicking a step that another note already plays selects that note instead.
- **Erase** (E): click or drag over notes to remove them.
- **Keyboard**: arrow keys move the cursor (Page Up and Page Down by an octave, Home and End to the first and last step); Space or Enter selects the note at the cursor or adds one; Alt+arrow keys move the selected note by a step or a semitone; Shift+Left and Shift+Right shorten or lengthen it; Delete removes it; Escape deselects.
- **Selected note**: step, length (1–4,096 steps), pitch (a name such as `C4`, `F#3` or `Bb5`, or a MIDI number), volume (0–1), waveform (the instrument's, or another one for this note) and effect (**slide** glides to the next note of the sound or track over the note, **vibrato**, **fadeout**). Each change is one undo step; changes that would overlap another note are refused.
- **Grid lines every** 6 or 8 steps (G toggles) and **Cell size** change only the view: the notes, the tempo and the saved data stay the same.

## History

Undo (Ctrl+Z or Cmd+Z) and redo (Ctrl+Shift+Z, Cmd+Shift+Z or Ctrl+Y) cover every change to the project: pixels, tiles, palette, sprite and map settings, sounds, music, tracks and notes, additions and deletions. The history is shared by all editors; undoing selects the sprite, map, sound or piece it changed. Entries store deltas (positions with old and new values, or the changed fields and note lists, whose unchanged notes are shared rather than copied) instead of whole snapshots, except resizes and imports, which keep the old and new image. The history keeps at most 256 steps and 16 MiB and drops the oldest steps first. Selection, clipboard, zoom and the chosen tool are not part of it.

## Project files

**Save** (Ctrl+S) downloads the project; **Open…** (Ctrl+O) loads one; **New** starts over with the default palette. New and Open ask for confirmation in a bar below the header when there are unsaved changes.

An opened file is validated completely before it replaces anything: on any problem the editor names the first invalid field and the open project, and its history, stay unchanged. Files above 16 MiB are refused before they are read. Unknown fields, unknown formats and newer versions are rejected.

Format, version 1 (`*.pixeljs.json`):

```json
{
  "format": "pixeljs-project",
  "version": 1,
  "palette": ["#0d111c", "#242c42"],
  "sprites": [
    {
      "name": "hero",
      "width": 4,
      "height": 2,
      "transparentIndex": 0,
      "pixels": ["00010100", "01000001"]
    }
  ],
  "maps": [
    {
      "name": "level1",
      "tileset": "hero",
      "tileWidth": 2,
      "tileHeight": 2,
      "cols": 3,
      "rows": 1,
      "tiles": ["00000001ffff"]
    }
  ],
  "sounds": [
    {
      "name": "coin",
      "waveform": "square",
      "frequency": 988,
      "volume": 0.5,
      "attack": 0.005,
      "decay": 0.01,
      "sustain": 0.7,
      "release": 0.05,
      "duration": 0.08,
      "effect": "slide",
      "slideTo": 1319
    }
  ],
  "music": [
    {
      "name": "theme",
      "bpm": 120,
      "stepsPerBeat": 4,
      "length": 16,
      "loop": true,
      "tracks": [
        {
          "voice": 0,
          "waveform": "triangle",
          "volume": 0.6,
          "attack": 0.005,
          "decay": 0.01,
          "sustain": 0.7,
          "release": 0.05,
          "notes": [
            { "step": 0, "length": 2, "pitch": "C4", "volume": 1 },
            { "step": 4, "length": 1, "pitch": "E4", "volume": 1, "effect": "vibrato" }
          ]
        }
      ]
    }
  ]
}
```

- `palette`: 1–256 colors as `#rrggbb`.
- `sprites`: at most 64. `pixels` holds `height` strings of `width × 2` hex digits (one palette index per pixel, `00`–`ff`, below the palette size). `transparentIndex` is optional.
- `maps`: at most 64, and 1,048,576 cells in total. `tileset` names a sprite of the project; the tile size must fit it. `tiles` holds `rows` strings of `cols × 4` hex digits, one tile ID per cell (`ffff` is empty); IDs must exist in the tileset.
- Names (sprites and maps separately): 1–32 letters, digits, `-` or `_`, starting with a letter or digit, unique ignoring case, and not a reserved name (such as `constructor` or `con`). They become file names and manifest keys.
- `sounds`: at most 64, each a `name` plus exactly the engine's `SoundOptions`. A single note has `waveform`, `frequency`, `volume`, `attack`, `decay`, `sustain`, `release`, `duration`, `effect` and, for the slide effect only, `slideTo`. A sound with notes has the instrument fields, `bpm`, `stepsPerBeat` and 1–64 `notes`; it may not carry `frequency`, `duration`, `effect` or `slideTo`, and a single note may not carry `bpm` or `stepsPerBeat`.
- `music`: at most 16, each a `name` plus exactly the engine's `MusicOptions`: `bpm` (20–400), `stepsPerBeat` (1–16), `length` (1–4,096 steps), `loop` and 1–4 `tracks` of `voice` (0–3, distinct), the instrument fields and up to 512 `notes` starting before `length`. A file without `music` opens with none.
- Notes: `step`, `length` (1–4,096), `pitch` (MIDI 0–127 or a name from `C-1` to `G9`), `volume` (0–1), and optionally `waveform` and `effect`. Fields left out take the engine's defaults; the editor then writes every field, so the files it saves are complete and ordered as above.
- The ranges are the engine's own; the editor tests load exported files with the engine's loaders to show the formats agree.

## Exporting web assets

The **Export** tab lists every file of the project with its own download button. Browsers save downloads by file name only, so place them in this layout next to your game:

```text
assets.json
palette.json
images/<sprite>.png
maps/<map>.json
sounds/<sound>.json
music/<piece>.json
```

`assets.json`, format `pixeljs-assets` version 1, lists every image and tile map:

```json
{
  "format": "pixeljs-assets",
  "version": 1,
  "images": {
    "hero": { "src": "images/hero.png", "transparentIndex": 0 },
    "tiles": { "src": "images/tiles.png" }
  },
  "tilemaps": { "level1": { "src": "maps/level1.json", "tileset": "tiles" } },
  "sounds": { "coin": { "src": "sounds/coin.json" } },
  "music": { "theme": { "src": "music/theme.json" } }
}
```

- `images/<sprite>.png`: the indexed PNG described above.
- `maps/<map>.json`: `{ "cols", "rows", "tileWidth", "tileHeight", "tiles" }` with `cols × rows` tile IDs, the JSON read by `engine.loadTilemap`.
- `sounds/<sound>.json`: `{ "format": "pixeljs-sound", "version": 1, … }` with the sound's `SoundOptions`, read by `engine.audio.loadSound`.
- `music/<piece>.json`: `{ "format": "pixeljs-music", "version": 1, … }` with the piece's `MusicOptions`, read by `engine.audio.loadMusic`. Notes are written one per line, so even four full tracks stay well below the loader's 256 KiB limit.
- `palette.json`: the flat opaque RGBA array (`[r, g, b, 255, …]`) accepted by `createEngine({ palette })`. A game must create its engine with the project palette, because PNG colors are mapped to that palette when loaded.

A game loads everything the manifest lists with one call, all or nothing:

```js
import { createEngine } from '@pixeljs/core';

const palette = await (await fetch('palette.json')).json();
const engine = await createEngine({ canvas, palette });
const assets = await engine.loadAssets('assets.json');
const level1 = assets.tilemap('level1');
const coin = assets.sound('coin');
engine.audio.playMusic(assets.music('theme')); // Starts once audio.unlock() runs from a click.
engine.audio.play(coin);
```

Each file can also be loaded on its own with `engine.loadImage`, `engine.loadTilemap`, `engine.audio.loadSound` and `engine.audio.loadMusic`.

The Export tab shows this code for the open project, and warns when repeated palette colors would make a PNG load with different indices. There is no ZIP or cartridge format.

## Limits

| Item                | Limit                                          |
| ------------------- | ---------------------------------------------- |
| Palette             | 1–256 opaque colors                            |
| Sprite size         | 1–256 × 1–256 pixels                           |
| Sprites per project | 64                                             |
| Map size            | 1–256 × 1–256 cells                            |
| Maps per project    | 64, and 1,048,576 cells in total               |
| Tile size           | 1–256 × 1–256 pixels, whole tiles only         |
| Sounds per project  | 64, each up to 64 notes                        |
| Music per project   | 16, each 1–4 tracks of up to 512 notes         |
| Tempo and length    | 20–400 BPM, 1–16 steps per beat, 1–4,096 steps |
| Project file        | 16 MiB                                         |
| PNG import          | 16 MiB, 1024 × 1024 pixels, static PNG         |
| Undo history        | 256 steps and 16 MiB                           |
| Zoom                | 1×–32× (sprites), 1×–16× (maps)                |

## Keyboard

Shortcuts never fire while a text field, number field or list has focus, and keys the editor does not use are left alone.

| Keys                                    | Action                                                                |
| --------------------------------------- | --------------------------------------------------------------------- |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y    | Undo, redo                                                            |
| Ctrl/Cmd+S, Ctrl/Cmd+O                  | Save, open                                                            |
| Arrow keys, Home, End on the tab list   | Switch editor tabs                                                    |
| P E F L R Shift+R I S                   | Sprite tools                                                          |
| P E R I                                 | Map tools                                                             |
| D, E (sound and music)                  | Draw or erase notes                                                   |
| P, Escape (sound and music)             | Play; stop (every sound in the Sound tab, the music in the Music tab) |
| G (sound and music)                     | Grid lines every 6 or 8 steps                                         |
| G, + and −                              | Grid, zoom                                                            |
| [ and ]                                 | Previous or next color (sprites) or tile (maps)                       |
| H, V                                    | Flip horizontally, vertically                                         |
| Ctrl/Cmd+C, X, V, A                     | Copy, cut, paste, select all                                          |
| Delete or Backspace, Escape             | Clear selection, deselect or cancel                                   |
| Arrow keys, Space or Enter (on canvas)  | Move the cursor, apply the tool                                       |
| Alt+arrow keys (on the sprite canvas)   | Move the selected pixels by one                                       |
| Alt+arrow keys, Shift+Left/Right (roll) | Move or resize the selected note                                      |
| Page Up, Page Down, Delete (roll)       | Cursor up or down an octave, delete the note                          |

## Not included

- No autosave: save the project file to keep your work.
- Playhead positions are approximate (page time since Play, not the audio clock).
- One project at a time; no layers, animation frames or palette import/export other than through project files.
- The clipboard is internal to the editor.
- A 256 × 256 tileset of 1 × 1 tiles has 65,536 tiles, but ID 65535 is `EMPTY_TILE`, so its last tile cannot be placed.
