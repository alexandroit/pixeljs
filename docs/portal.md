# Publish on PixelJS

[pixeljs.com](https://pixeljs.com) is also a game portal. A game published there gets levels, leaderboards, achievements, cloud saves and online play without any server of its own: it declares what it uses in a manifest, `pixeljs.json`, and talks to the portal through `@pixeljs/core/portal`. This page covers the engine's side. The [developer guide](https://pixeljs.com/developers) is the complete reference of the portal, and two tutorials build a [single-player game](https://pixeljs.com/developers/tutorial/single-player) and a [multiplayer game](https://pixeljs.com/developers/tutorial/multiplayer) step by step.

- [Start from a starter](#start-from-a-starter)
- [The manifest](#the-manifest)
- [Connect to the portal](#connect-to-the-portal)
- [Levels, runs and scores](#levels-runs-and-scores)
- [Achievements](#achievements)
- [Saves](#saves)
- [Play modes](#play-modes)
- [Online play](#online-play)
- [Build and upload](#build-and-upload)

## Start from a starter

```sh
npm create @pixeljs@latest my-game -- --template portal   # levels, leaderboards and saves
npm create @pixeljs@latest my-game -- --template board    # two players: solo, local and online
```

`portal` is a three-level platformer with leaderboards, stars, two achievements and a cloud save. `board` is a two-player board game, with tic-tac-toe as placeholder rules behind a small interface, playable against the computer, by two players on one device and online. Both include their `pixeljs.json` and run anywhere with `npm run dev`.

## The manifest

`pixeljs.json` sits at the root of the uploaded build; in a Vite project, put it in `public/`. The smallest manifest declares the version of the format, the youngest age the game suits and what it uses:

```json
{
  "manifest_version": 2,
  "min_age": 0,
  "capabilities": ["pause", "mute"]
}
```

- `manifest_version`: `2`.
- `min_age`: `0` (Everyone), `10` (Everyone 10+) or `13` (Teen); it becomes the game's age rating. `18` is accepted only for simulated casino games, and adult content is not accepted.
- `capabilities`: what the game uses, among `pause`, `mute`, `levels`, `scores`, `achievements`, `save`, `level-select` and `multiplayer`. The portal grants them once the game is reviewed.

The sections below add `levels`, `leaderboards`, `achievements`, `save`, `play_modes` and `multiplayer`. Optional fields such as `width`, `height`, `inputs` and `controls_md` describe the game on its page; the [developer guide](https://pixeljs.com/developers) lists every field and limit. Ids of levels, leaderboards and achievements are permanent once the game is published: add new ids instead of renaming old ones.

## Connect to the portal

```js
import { createEngine } from '@pixeljs/core';
import { attachEngine, connectPortal } from '@pixeljs/core/portal';

const portal = await connectPortal({ capabilities: ['pause', 'mute', 'levels', 'scores'] });
const engine = await createEngine({ canvas, width: 320, height: 180, scaling: 'integer' });
engine.start({ update, draw });
attachEngine(portal, engine);
portal.ready(); // the portal hides its loading screen
```

Inside the portal, `connectPortal()` resolves once the portal answers. Anywhere else (your own site, `npm run dev`, Node) it resolves at once with `portal.inPortal` false, and every call still answers: results are not recorded (`{ recorded: false, reason: 'not_in_portal' }`), saves stay in memory until the page closes and online play is unavailable. The same build therefore runs on any site.

`attachEngine(portal, engine)` lets the portal's pause, resume and mute buttons control the engine. Call it after `engine.start()`, which ends a pause. Held keys need no handling: the engine releases them when its window loses focus, when the page is hidden and on every pause and resume. Other events reach `portal.on()`: `select` when a player picks a level in the portal, `player` when they sign in, `visibility` and `viewport`.

`@pixeljs/core/portal` is a separate entry point: games that do not import it do not load it. The [API reference](api.md#portal) documents every function and type.

## Levels, runs and scores

A **run** is one attempt at one level. Start it when play starts, never on menus, and end it when the level ends:

```js
const run = await portal.levelStart('1-1');
// … the player plays …
const answer = await portal.levelEnd(run, {
  outcome: 'complete', // 'complete', 'fail' or 'quit'
  scores: { 'level-score': 4200, fastest: 51320 },
  timeMs: 51320,
  stars: 3,
});
if (answer.newBest?.['level-score']) showNewBest();
```

- One run at a time: starting a run ends the previous one as `"quit"`. End every run, also when the player leaves the level (`outcome: 'quit'`, never ranked).
- `timeMs` is game time, without pauses: count the engine's fixed updates (`updates × 1000 / 60`). It may never exceed the real time since `levelStart`.
- `scores` are whole numbers keyed by leaderboard id, within each board's `min` and `max`.
- An endless game calls `levelStart()` without a level when a game begins and `portal.gameOver({ scores })` when it ends.
- `portal.levels()` returns the player's progress per level (`completed`, `stars`, `best`) for your own level menu.

The portal stores the result, ranks it and shows its own message under the game, so a game needs no name entry or ranking table. The levels and leaderboards come from the manifest:

```json
{
  "capabilities": ["pause", "mute", "levels", "scores"],
  "levels": [
    { "id": "1-1", "name": "First Steps" },
    { "id": "1-2", "name": "Up We Go" }
  ],
  "leaderboards": [
    {
      "id": "level-score",
      "name": "Best score",
      "scope": "level",
      "sort": "desc",
      "type": "points",
      "min": 0,
      "max": 100000,
      "periods": ["all", "week"]
    },
    {
      "id": "total",
      "name": "Total score",
      "scope": "game",
      "source": "sum_levels",
      "of": "level-score",
      "sort": "desc",
      "type": "points",
      "periods": ["all", "week"],
      "default": true
    }
  ]
}
```

## Achievements

An achievement with a `rule` is unlocked by the portal from recorded results, which cannot be forged from the browser; prefer rules whenever one fits.

```json
{
  "id": "first-steps",
  "name": "First Steps",
  "description": "Complete the first level.",
  "points": 10,
  "rule": { "complete": "1-1" }
}
```

An achievement without a rule is unlocked by the game, during a run or within 10 seconds after it ends, with `await portal.unlock('untouched')`. Declare achievements under `"achievements"` and add the `achievements` capability.

## Saves

```js
const { data, rev } = await portal.load('progress'); // data: a string, or null
const progress = data ? JSON.parse(data) : {};
// … at a checkpoint or at the end of a level:
const saved = await portal.save('progress', JSON.stringify(progress), { rev });
if (!saved.ok && saved.reason === 'conflict') {
  // Another device saved first: load, merge and save again.
}
```

Declare the slots with `"save": { "slots": 1, "max_bytes": 4096, "schema": 1 }` and the `save` capability. Signed-in players find their saves on every device. Save at checkpoints rather than every frame: the portal accepts one save per slot every two seconds. Games on the portal run in a sandbox without browser storage, so saves are the way to keep anything.

## Play modes

A game playable in several ways lists them in the manifest:

```json
{
  "play_modes": ["solo", "local", "online"],
  "local_players": 2
}
```

`solo` is one player (against the computer, levels, endless games), `local` is `local_players` people sharing one device and `online` needs the `multiplayer` section below. The portal shows a button for each mode and tells the game the player's choice in `portal.launch`: `{ mode: 'solo' | 'local' | 'online', players?, room? }`, where `players` is the number of local players and `room` the code of the private room the player was invited to, which the portal joins once the game calls `portal.ready()`. Outside the portal `portal.launch` is `{ mode: 'solo' }`, so a game shows its own menu there.

## Online play

The portal finds the players, shows its own waiting and room screens (with the invite code and link of a private room) and relays the games' messages. Games never touch the network: only the portal page does.

```json
{
  "capabilities": ["pause", "mute", "multiplayer"],
  "multiplayer": {
    "min_players": 2,
    "max_players": 2,
    "modes": [{ "id": "versus", "name": "Versus" }],
    "quick_match": true,
    "private_rooms": true,
    "join_in_progress": false,
    "max_message_bytes": 1024,
    "max_messages_per_second": 10
  }
}
```

```js
import { createRandom } from '@pixeljs/core/portal';

const online = portal.multiplayer;
// Listen from the start: a player who opens an invite link joins a room directly.
online.on('room', (room) => showRoom(room)); // { code, host, me, players, state, … }
online.on('start', (match) => {
  const random = createRandom(match.seed); // the same numbers in every player's game
  startMatch(match.players, match.me, match.host, random);
});
online.on('message', ({ from, data }) => receive(from, data)); // check data before use
online.on('left', ({ slot }) => removePlayer(slot));
online.on('end', ({ reason }) => backToMenu());

if (online.available) await online.find({ mode: 'versus' }); // or online.host() for a private room
online.send({ t: 'move', move }, { to: host }); // to one slot (the host's), or to everyone
await online.result([winner, loser]); // the host reports the slots, best first
```

- **Slots** number the players of a room; `me` is this player's slot and `host` the host's. When the host leaves, the next player becomes host and every game receives a new `room` event.
- **The seed** of a match is the same for every player. `createRandom(seed)` uses only 32-bit integer arithmetic, so it gives the same numbers in every browser: use it for everything random in a match, such as who starts. It is not cryptographic.
- **Keep the games in step.** The portal relays messages and runs no game logic. In a turn-based game the host's game can be the referee, as in the `board` starter: the other player sends `{ t: 'move', move }` to the host, which checks the move against the rules, applies it and sends the new state to everyone. In a game where everyone plays the same world, games exchange only what the others need to see.
- **Stay within the limits** of the manifest: messages above `max_message_bytes` or beyond `max_messages_per_second` are dropped. Send small messages at a steady rate, and never free text: players must not be able to chat.
- After `result()`, a private room returns to its lobby, where the host can `start()` a rematch; quick-match players `find()` again.

## Build and upload

```sh
npm run build
cd dist && zip -r ../game.zip . && cd ..
```

The archive needs `index.html` and `pixeljs.json` at its root. Everything must load from the game's own files with relative URLs (the starters set Vite's `base: './'`), and the game may make no network requests and use no browser storage. In the PixelJS studio, create the game, upload the archive and open its preview: it runs in test mode, with a bridge inspector that lists every message between the game and the portal. Then submit the version for review. The [developer guide](https://pixeljs.com/developers) has the review checklist.
