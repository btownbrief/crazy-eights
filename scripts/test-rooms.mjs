// Online-rooms wiring test: drives the real vendored client (js/rooms.js)
// against the local shim (scripts/rooms-shim.mjs) as simulated phones,
// then plays full 2- and 3-phone games through the real Crazy Eights engine.
// No network or Supabase is involved.
//
//   node scripts/test-rooms.mjs

import { createRooms } from './rooms-shim.mjs';
import { createInitialState, legalMoves, applyMove, getStatus } from '../js/engine.js';

const GAME = 'crazy-eights';

/* ------------------------------------------------ multi-phone environment */

const stores = new Map();
let current = 'A';
globalThis.localStorage = {
  getItem: (key) => (stores.get(current).has(key) ? stores.get(current).get(key) : null),
  setItem: (key, value) => stores.get(current).set(key, String(value)),
  removeItem: (key) => stores.get(current).delete(key),
};
function device(id) {
  if (!stores.has(id)) stores.set(id, new Map());
  current = id;
}
for (const id of ['A', 'B', 'C', 'D']) device(id);
device('A');

let passed = 0;
function t(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok — ${label}`);
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    t(false, `${label} (no error thrown)`);
  } catch (err) {
    t(err && err.code === code, `${label} (got ${err && err.code})`);
  }
}

let randomState = 0x8badf00d;
function randomChoice(items) {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return items[randomState % items.length];
}

async function syncPhones(phones) {
  for (const phone of phones) {
    device(phone.device);
    await phone.match._fetch();
  }
  const truth = JSON.stringify(phones[0].match.state);
  return phones.every((phone) => JSON.stringify(phone.match.state) === truth);
}

async function playSyncedGame(phones, cap = 400) {
  let moves = 0;
  let synced = await syncPhones(phones);
  while (getStatus(phones[0].match.state).status === 'active' && moves < cap) {
    const state = phones[0].match.state;
    const mover = phones.find((phone) => phone.match.seat === state.currentPlayer);
    if (!mover) throw new Error(`No phone for engine player ${state.currentPlayer}`);
    device(mover.device);
    await mover.match._fetch();
    const move = randomChoice(legalMoves(mover.match.state));
    const next = applyMove(mover.match.state, move);
    await mover.match.push(next, { over: getStatus(next).status !== 'active' });
    moves++;
    synced = await syncPhones(phones);
    if (!synced) break;
  }
  return {
    moves,
    synced,
    finished: getStatus(phones[0].match.state).status !== 'active',
  };
}

// The workspace sandbox forbids listening on localhost, so route fetch calls
// directly into the canonical shim's RPC table. This exercises the same room
// referee without opening a socket.
const shim = createRooms();
let backendReady = true;
globalThis.BTOWN_ROOMS_URL = 'http://rooms.test';
globalThis.fetch = async (url, options = {}) => {
  if (!backendReady) return new Response('{}', { status: 404 });
  const method = options.method || 'GET';
  const match = String(url).match(/\/rest\/v1\/rpc\/(\w+)$/);
  if (method !== 'POST' || !match || !shim.rpcs[match[1]]) {
    return new Response(JSON.stringify({ message: 'not a room rpc' }), { status: 404 });
  }
  try {
    const body = shim.rpcs[match[1]](JSON.parse(options.body || '{}')) ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ message: err.message }), {
      status: err.rpc ? 400 : 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
const { OnlineMatch, savedSession, RoomsError } = await import('../js/rooms.js');

/* ------------------------------------------------------- generic checks */

device('A');
const host = await OnlineMatch.create({
  game: GAME,
  name: 'Maple A',
  state: createInitialState({ numPlayers: 2, seed: 101 }),
  seats: 2,
});
t(/^[A-Z2-9]{4}$/.test(host.code) && host.seat === 0 && host.status === 'waiting',
  'host creates room in engine seat 0');
t(savedSession(GAME)?.roomId === host.roomId, 'host session saved');

device('B');
await expectCode(OnlineMatch.join({ game: GAME, code: 'ZZZZ', name: 'X' }),
  'not_found', 'bad code rejected');
await expectCode(OnlineMatch.join({ game: 'four-in-a-rowboat', code: host.code, name: 'X' }),
  'wrong_game', 'wrong game rejected');
const guest = await OnlineMatch.join({
  game: GAME,
  code: ` ${host.code.toLowerCase()} `,
  name: 'Maple B',
});
t(guest.seat === 1 && guest.status === 'playing',
  'last seat joins with sloppy code and starts the game');
t(guest.opponents().length === 1 && guest.opponents()[0].name === 'Maple A',
  'guest sees host name');

device('A');
await host._fetch();
t(host.status === 'playing' && host.opponents()[0].name === 'Maple B',
  'host poll sees the filled table');

let stateA = applyMove(host.state, randomChoice(legalMoves(host.state)));
await host.push(stateA);
t(host.version === 1, 'host pushes a legal engine move at version 1');

device('B');
await guest._fetch();
t(JSON.stringify(guest.state) === JSON.stringify(stateA),
  'guest poll receives the complete seeded state');
const stateB = applyMove(guest.state, randomChoice(legalMoves(guest.state)));
await guest.push(stateB);
t(guest.version === 2, 'guest pushes the next legal engine move');

device('A');
const staleState = applyMove(stateA, randomChoice(legalMoves(stateA)));
await expectCode(host.push(staleState), 'version_conflict', 'stale push rejected');
t(host.version === 2 && JSON.stringify(host.state) === JSON.stringify(guest.state),
  'conflict refetches the server truth');
t(new RoomsError('offline').code === 'offline', 'rooms failures carry stable codes');

const twoPhone = await playSyncedGame([
  { device: 'A', match: host },
  { device: 'B', match: guest },
]);
t(twoPhone.synced, 'two phones stay JSON-identical after every move');
t(twoPhone.finished || twoPhone.moves === 400,
  twoPhone.finished
    ? `two-phone game reaches engine game-over in ${twoPhone.moves} more moves`
    : 'two-phone game remains synced at the 400-move safety cap');
t(host.status === (twoPhone.finished ? 'over' : 'playing'),
  'room status matches the engine status');

if (!twoPhone.finished) {
  // The prompt permits a clean cap for a theoretically long recycling game.
  // Mark this room over by leaving before the generic rematch checks continue.
  device('A');
  await host.leave();
} else {
  device('B');
  const rematchVersion = guest.version;
  await guest.push(createInitialState({ numPlayers: 2, seed: 202 }), {});
  t(guest.status === 'playing' && guest.version === rematchVersion + 1,
    'either phone can deal a rematch');

  device('A');
  const resumed = await OnlineMatch.resume({ game: GAME });
  t(resumed.roomId === host.roomId && resumed.seat === 0 && resumed.status === 'playing',
    'resume reattaches to the same engine seat');
  await resumed.leave();
  t(savedSession(GAME) === null, 'leave clears the local room session');

  device('B');
  await guest._fetch();
  t(guest.status === 'over' && guest.opponents()[0].left === true,
    'remaining phone sees that a player left');
}

// A two-seat room rejects a third phone after the last seat starts it.
device('A');
const fullHost = await OnlineMatch.create({
  game: GAME,
  name: 'A',
  state: createInitialState({ numPlayers: 2, seed: 303 }),
  seats: 2,
});
device('B');
await OnlineMatch.join({ game: GAME, code: fullHost.code, name: 'B' });
device('C');
await expectCode(OnlineMatch.join({ game: GAME, code: fullHost.code, name: 'C' }),
  'room_started', 'extra phone is turned away after the table fills');

/* ------------------------------------------------------- three-phone game */

device('A');
const host3 = await OnlineMatch.create({
  game: GAME,
  name: 'North',
  state: createInitialState({ numPlayers: 3, seed: 404 }),
  seats: 3,
});
device('B');
const guest3b = await OnlineMatch.join({ game: GAME, code: host3.code, name: 'Center' });
t(guest3b.seat === 1 && guest3b.status === 'waiting',
  'three-phone room keeps waiting after seat 1 joins');
device('C');
const guest3c = await OnlineMatch.join({ game: GAME, code: host3.code, name: 'South' });
t(guest3c.seat === 2 && guest3c.status === 'playing',
  'three-phone room starts only when seat 2 fills the table');

const threePhone = await playSyncedGame([
  { device: 'A', match: host3 },
  { device: 'B', match: guest3b },
  { device: 'C', match: guest3c },
]);
t(threePhone.synced, 'all three phones stay JSON-identical after every move');
t(threePhone.finished || threePhone.moves === 400,
  threePhone.finished
    ? `three-phone game reaches engine game-over in ${threePhone.moves} moves`
    : 'three-phone game remains synced at the 400-move safety cap');
t(host3.state.numPlayers === 3 &&
    host3.state.hands.length === 3 &&
    host3.state.currentPlayer >= 0 &&
    host3.state.currentPlayer < 3,
  'three-phone state preserves engine seat mapping');

device('D');
await expectCode(OnlineMatch.join({ game: GAME, code: host3.code, name: 'Too Late' }),
  'room_started', 'fourth phone cannot enter the started three-seat room');

// Backend absent → clean not_ready error.
backendReady = false;
const fresh = await import('../js/rooms.js?not-ready');
device('D');
await expectCode(
  fresh.OnlineMatch.create({ game: GAME, name: 'A', state: {} }),
  'not_ready',
  'missing backend reads as not_ready',
);

console.log(`\nALL ROOMS TESTS PASSED (${passed} checks)`);
process.exit(0);
