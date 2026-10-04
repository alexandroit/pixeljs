// Online: two players through portal.multiplayer. The portal finds the other player,
// shows its own waiting and room screens (with the invite code of a private room) and
// relays the games' messages; the game decides what they mean.
//
// The host's game is the referee (host-authoritative):
//   - the room's seed decides who starts, so both games build the same first state;
//   - the guest sends its move to the host: { t: 'move', move };
//   - the host checks it against legalMoves(), applies it and sends everyone the new
//     state: { t: 'state', state }. The host's own moves take the same path;
//   - at the end the host reports the result. A private room then returns to its
//     lobby, where the host can start a rematch; quick-match players search again.
import { applyMove, createState, legalMoves, parse, result, serialize } from '../rules.js';

const MODE = 'versus'; // a mode id of the "multiplayer" section of pixeljs.json
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Listens to the portal's room events from the start, because a player who opens an
 * invite link joins a room without going through the game's menu. `onRoom` is called
 * when a room or a match appears, so the game can show this mode.
 */
export function createOnline(portal, onRoom) {
  const online = portal.multiplayer;
  let screen = 'choose'; // choose | waiting | room | playing | over
  let note = '';
  let room = null; // the room as the portal last described it
  let match = null; // { slots, state, reported }: slots[side] is that side's room slot
  let sent = false; // the guest's move is on its way to the host
  let ready = false;

  const isHost = () => room !== null && room.host === room.me;
  const name = (slot) => {
    if (slot === room?.me) return 'YOU';
    const player = room?.players.find((p) => p.slot === slot);
    return String(player?.handle ?? 'OPPONENT')
      .toUpperCase()
      .slice(0, 11);
  };
  const enough = () => room !== null && room.players.length >= room.min;

  function fail(reason) {
    screen = 'choose';
    note =
      reason === 'guest' ? 'SIGN IN TO PLAY ONLINE' : `NOT POSSIBLE NOW: ${reason.toUpperCase()}`;
  }

  async function find() {
    screen = 'waiting';
    note = 'LOOKING FOR A PLAYER...';
    const answer = await online.find({ mode: MODE });
    if (!answer.ok) fail(answer.reason);
  }

  async function host() {
    screen = 'waiting';
    note = 'OPENING A PRIVATE ROOM...';
    const answer = await online.host({ mode: MODE });
    if (!answer.ok) return fail(answer.reason);
    room = answer.room ?? room;
    if (screen === 'waiting') enter();
  }

  async function start() {
    const answer = await online.start();
    if (!answer.ok) note = `NOT POSSIBLE NOW: ${answer.reason.toUpperCase()}`;
  }

  function leave() {
    if (room || screen === 'waiting') online.leave();
    room = null;
    match = null;
    screen = 'choose';
    note = '';
  }

  function finishIfOver() {
    const outcome = result(match.state);
    if (!outcome.over) return;
    screen = 'over';
    ready = false;
    if (isHost() && !match.reported) {
      // Draws give both slots equal placement instead of inventing a winner.
      match.reported = true;
      const [first, second] = match.slots;
      void online.result(outcome.winner === 1 ? [second, first] : [first, second], {
        draw: outcome.draw === true,
      });
    }
  }

  /** The referee: the host applies only legal moves of the side to play. */
  function apply(move) {
    const legal = legalMoves(match.state).find((candidate) => same(candidate, move));
    if (legal === undefined) return;
    match.state = applyMove(match.state, legal);
    online.send({ t: 'state', state: serialize(match.state) });
    finishIfOver();
  }

  /** The room's lobby replaces the menu or the waiting screen. */
  function enter() {
    screen = 'room';
    note = '';
  }

  online.on('room', (next) => {
    room = next; // also names a new host when the host leaves
    if (screen === 'choose' || screen === 'waiting') enter();
    onRoom();
  });
  online.on('start', (next) => {
    room = next;
    // Sides by slot order, so both games agree; the seed decides who starts.
    const slots = next.players.map((player) => player.slot).sort((a, b) => a - b);
    match = { slots, state: createState(next.seed), reported: false };
    sent = false;
    note = '';
    screen = 'playing';
    onRoom();
  });
  online.on('message', ({ from, data }) => {
    if (screen !== 'playing' || !data || typeof data !== 'object') return;
    if (isHost()) {
      if (data.t === 'move' && from === match.slots[match.state.turn]) apply(data.move);
    } else if (data.t === 'state' && from === room.host) {
      const state = parse(data.state);
      if (!state) return;
      match.state = state;
      sent = false;
      finishIfOver();
    }
  });
  online.on('left', ({ slot }) => {
    if (screen === 'playing' && match.slots.includes(slot)) {
      screen = 'over';
      note = 'YOUR OPPONENT LEFT';
    }
  });
  online.on('end', () => {
    room = null;
    match = null;
    screen = 'choose';
    note = 'THE ROOM CLOSED';
  });

  // An invite link: the portal joins the room once the game is ready.
  if (portal.launch.mode === 'online' && portal.launch.room) {
    screen = 'waiting';
    note = `JOINING ROOM ${portal.launch.room}...`;
  }

  return {
    get state() {
      return screen === 'playing' || screen === 'over' ? match.state : null;
    },
    get labels() {
      return match ? match.slots.map(name) : ['', ''];
    },
    canPlay: () => screen === 'playing' && !sent && match.slots[match.state.turn] === room.me,
    play(move) {
      if (isHost()) return apply(move);
      sent = true;
      online.send({ t: 'move', move }, { to: room.host });
    },
    update() {},
    status() {
      if (screen === 'playing') {
        if (sent) return 'SENDING YOUR MOVE...';
        const slot = match.slots[match.state.turn];
        return slot === room.me ? 'YOUR TURN' : `${name(slot)} IS PLAYING...`;
      }
      if (note) return `${note}. ENTER: BACK`;
      const outcome = result(match.state);
      const mine = match.slots.indexOf(room.me);
      const end = outcome.draw ? 'A DRAW!' : outcome.winner === mine ? 'YOU WIN!' : 'YOU LOSE!';
      if (!room.private) return `${end} ENTER: FIND ANOTHER PLAYER`;
      if (!isHost()) return `${end} ${ready ? 'READY: WAITING FOR THE HOST' : 'ENTER: READY'}`;
      return `${end} ${enough() && room.state === 'lobby' ? 'ENTER: REMATCH' : 'WAITING...'}`;
    },
    next() {
      if (screen === 'room' && isHost() && enough()) void start();
      if (screen !== 'over') return;
      if (note) leave();
      else if (!room.private) {
        leave();
        void find();
      } else if (!isHost()) {
        online.ready(true); // shown in the portal's room screen
        ready = true;
      } else if (enough() && room.state === 'lobby') void start();
    },
    close: leave,
    /** Opens the online screens from the game's menu. */
    open() {
      if (!room && screen !== 'waiting') {
        screen = 'choose';
        note = '';
      }
      return this;
    },
    /** The screens without a board: `{ title, lines, choices? }`, or null. */
    panel() {
      if (screen === 'choose')
        return {
          title: 'PLAY ONLINE',
          lines: [note],
          choices: [
            { label: 'QUICK MATCH', run: find },
            { label: 'PRIVATE ROOM', run: host },
          ],
        };
      if (screen === 'waiting') return { title: 'PLAY ONLINE', lines: [note, '', 'ESC: CANCEL'] };
      if (screen !== 'room') return null;
      const players = room.players.map((player) => name(player.slot));
      let prompt = 'WAITING FOR THE HOST TO START';
      if (isHost()) prompt = enough() ? 'ENTER: START THE MATCH' : 'WAITING FOR A PLAYER TO JOIN';
      return {
        title: room.private ? `ROOM ${room.code}` : 'MATCH FOUND',
        lines: [...players, '', note || prompt, 'ESC: LEAVE'],
      };
    },
  };
}
