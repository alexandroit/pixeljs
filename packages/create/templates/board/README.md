# {{PROJECT_NAME}}

A board game for two players created with [PixelJS](https://pixeljs.com) and ready for the PixelJS portal, with three ways to play: against the computer, two players on one device, and online. The rules are tic-tac-toe, a placeholder for your own game: chess, checkers, dominoes or any other turn-based game for two.

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

Outside the portal, the menu offers solo and local play. Online play works once the game is published on [pixeljs.com](https://pixeljs.com), where players are signed in.

## What's inside

| File                  | What it does                                                                            |
| --------------------- | --------------------------------------------------------------------------------------- |
| `public/pixeljs.json` | The manifest: three play modes, two players on one device and the `multiplayer` section |
| `src/main.js`         | Connects to the portal, starts the engine, picks the mode and runs the menu             |
| `src/rules.js`        | The rules of the game, behind six functions                                             |
| `src/board.js`        | Draws the board and turns keys, taps and gamepad buttons into moves                     |
| `src/modes/solo.js`   | You against the computer, which only uses the rules' functions                          |
| `src/modes/local.js`  | Two players taking turns on one device                                                  |
| `src/modes/online.js` | Online play through `portal.multiplayer`, with the host's game as referee               |

## Replace the rules

Only `src/rules.js` and `src/board.js`, which draws the board, know that the game is tic-tac-toe. Keep the names and meanings of the rules' functions, and the three modes keep working:

- `createState(seed)`: the first state. The seed decides who starts, so online players agree.
- `legalMoves(state)`: the moves the side to play may make, and none once the game is over.
- `applyMove(state, move)`: a new state after a legal move.
- `result(state)`: `{ over: false }`, `{ over: true, winner }` (side 0 or 1) or `{ over: true, draw: true }`.
- `serialize(state)` and `parse(text)`: the state in online messages. `parse` returns `null` for anything that is not a valid state.

States are plain data and moves are any JSON value: a cell here, `{ from, to }` in chess.

## How the mode is chosen

On PixelJS, the portal shows a button for each of the `play_modes` in `pixeljs.json` and tells the game the player's choice (`portal.launch.mode`); the game starts in that mode. Outside the portal, the game's own menu offers solo and local play. Escape always returns to the menu.

## Online play

The portal finds the other player (quick match) or opens a private room with an invite code and link, and shows its own waiting and room screens. The host's game is the referee: the guest sends `{ t: 'move', move }` to the host, which checks it with `legalMoves()`, applies it and sends `{ t: 'state', state }` to both games. The room's seed decides who starts. After a game, the host reports the result (a draw gives both players equal first place); in a private room the host can then start a rematch. When a player leaves or the room closes, the game says so.

To try it, publish the game in the studio and open its preview in two browser tabs: create a private room in one and join it from the other with the code.

## Publish on PixelJS

1. Build the game with `npm run build`.
2. Zip the contents of `dist/`, so that `index.html` and `pixeljs.json` are at the root of the archive:

   ```bash
   cd dist && zip -r ../game.zip . && cd ..
   ```

3. In the PixelJS studio, create your game, upload the archive and open the preview. It runs in test mode, with a bridge inspector that lists every message between the game and the portal.
4. Submit the version for review.

The [multiplayer tutorial](https://pixeljs.com/developers/tutorial/multiplayer) explains online play step by step, the [single-player tutorial](https://pixeljs.com/developers/tutorial/single-player) covers publishing, and the [developer guide](https://pixeljs.com/developers) documents `pixeljs.json` and the portal.
