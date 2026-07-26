/* CRAZY EIGHTS engine — pure rules, no DOM, no timers, no Math.random.
 *
 * Every function here is a pure function over a plain JSON-serializable
 * state object. The shuffle uses a seeded RNG whose state lives INSIDE the
 * game state, so a game can be JSON.stringify'd, parsed, and resumed — and
 * two states built from the same seed are identical. Online multiplayer
 * later = syncing this exact object. Keep ALL rule logic in this file.
 *
 * Public API:
 *   createInitialState(options) -> state
 *   legalMoves(state)           -> array of move objects for the current player
 *   applyMove(state, move)      -> NEW state (never mutates)
 *   getStatus(state)            -> { status, winner, winners }
 *
 * Cards are 2-char strings: rank + suit, e.g. "8H", "TS" (T = ten).
 * Moves: { type:'play', card:'QS' }
 *        { type:'play', card:'8H', declare:'S' }  (8s must declare a suit)
 *        { type:'draw' }
 *        { type:'pass' }
 */

export const SUITS = ['S', 'H', 'D', 'C'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];

export const rankOf = (card) => card[0];
export const suitOf = (card) => card[1];
export const topCard = (state) => state.discard[state.discard.length - 1];

const MAX_DRAWS_PER_TURN = 3;

/* ---------------------------------------------------------------- RNG
 * mulberry32 — tiny, deterministic. The integer state is threaded through
 * and stored on the game state as `rng`. */

function rngNext(s) {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, s };
}

/* Fisher-Yates. Returns { deck, rng } — never touches the input array. */
function shuffle(cards, rngState) {
  const deck = cards.slice();
  let s = rngState;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = rngNext(s);
    s = r.s;
    const j = Math.floor(r.value * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return { deck, rng: s };
}

function freshDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(rank + suit);
  }
  return deck;
}

/* ---------------------------------------------------------------- setup */

export function createInitialState(options = {}) {
  const numPlayers = options.numPlayers ?? 2;
  if (!Number.isInteger(numPlayers) || numPlayers < 2 || numPlayers > 4) {
    throw new Error('numPlayers must be 2, 3, or 4');
  }
  const seed = (options.seed ?? 1) | 0;

  let { deck, rng } = shuffle(freshDeck(), seed);

  const handSize = numPlayers === 2 ? 7 : 5;
  const hands = [];
  for (let p = 0; p < numPlayers; p++) {
    hands.push(deck.slice(p * handSize, (p + 1) * handSize));
  }
  let stock = deck.slice(numPlayers * handSize);

  // Flip the starter. If it's an 8, shuffle it back into the stock and flip
  // again (house rule per the box: an 8 can't start the pile).
  let starter = stock[stock.length - 1];
  stock = stock.slice(0, -1);
  while (rankOf(starter) === '8') {
    const re = shuffle(stock.concat([starter]), rng);
    rng = re.rng;
    stock = re.deck;
    starter = stock[stock.length - 1];
    stock = stock.slice(0, -1);
  }

  return {
    version: 1,
    seed,
    rng,
    numPlayers,
    hands,
    stock,
    discard: [starter],
    currentSuit: suitOf(starter), // suit to match; overridden when an 8 declares
    currentPlayer: 0,
    drawnThisTurn: 0,
    passesInARow: 0,
    winner: null,
    blocked: false,
    lastAction: null, // { player, type, card?, declare?, reshuffled? } — for UI narration
  };
}

/* ---------------------------------------------------------------- rules */

function isPlayable(state, card) {
  if (rankOf(card) === '8') return true; // eights are wild, always
  return suitOf(card) === state.currentSuit || rankOf(card) === rankOf(topCard(state));
}

function handHasPlay(state, hand) {
  return hand.some((card) => isPlayable(state, card));
}

/* Can the current player physically draw a card? True if the stock has one,
 * or the discard pile (minus its top card) can be reshuffled into a stock. */
function canDraw(state) {
  return state.stock.length > 0 || state.discard.length > 1;
}

export function legalMoves(state) {
  if (getStatus(state).status !== 'active') return [];

  const hand = state.hands[state.currentPlayer];
  const moves = [];

  for (const card of hand) {
    if (!isPlayable(state, card)) continue;
    if (rankOf(card) === '8') {
      for (const suit of SUITS) moves.push({ type: 'play', card, declare: suit });
    } else {
      moves.push({ type: 'play', card });
    }
  }

  if (moves.length > 0) return moves; // you have a play: you must play

  if (state.drawnThisTurn < MAX_DRAWS_PER_TURN && canDraw(state)) {
    moves.push({ type: 'draw' });
  } else {
    moves.push({ type: 'pass' });
  }
  return moves;
}

/* ---------------------------------------------------------------- apply */

function sameMove(a, b) {
  return a.type === b.type && a.card === b.card && a.declare === b.declare;
}

export function applyMove(state, move) {
  const legal = legalMoves(state);
  if (!legal.some((m) => sameMove(m, move))) {
    throw new Error('Illegal move: ' + JSON.stringify(move));
  }

  if (move.type === 'play') return applyPlay(state, move);
  if (move.type === 'draw') return applyDraw(state);
  return applyPass(state);
}

function applyPlay(state, move) {
  const player = state.currentPlayer;
  const hand = state.hands[player];
  const idx = hand.indexOf(move.card);
  const newHand = hand.slice(0, idx).concat(hand.slice(idx + 1));
  const hands = state.hands.map((h, p) => (p === player ? newHand : h));
  const isEight = rankOf(move.card) === '8';

  return {
    ...state,
    hands,
    discard: state.discard.concat([move.card]),
    currentSuit: isEight ? move.declare : suitOf(move.card),
    winner: newHand.length === 0 ? player : null,
    currentPlayer: (player + 1) % state.numPlayers,
    drawnThisTurn: 0,
    passesInARow: 0,
    lastAction: { player, type: 'play', card: move.card, declare: isEight ? move.declare : undefined },
  };
}

function applyDraw(state) {
  const player = state.currentPlayer;
  let stock = state.stock;
  let discard = state.discard;
  let rng = state.rng;
  let reshuffled = false;

  if (stock.length === 0) {
    // Stock is out: shuffle the discard pile (keeping the top card) into a
    // new stock so the game keeps going.
    const top = discard[discard.length - 1];
    const re = shuffle(discard.slice(0, -1), rng);
    rng = re.rng;
    stock = re.deck;
    discard = [top];
    reshuffled = true;
  }

  const drawn = stock[stock.length - 1];
  const hands = state.hands.map((h, p) => (p === player ? h.concat([drawn]) : h));

  return {
    ...state,
    rng,
    hands,
    stock: stock.slice(0, -1),
    discard,
    drawnThisTurn: state.drawnThisTurn + 1,
    passesInARow: 0,
    lastAction: { player, type: 'draw', reshuffled },
  };
}

function applyPass(state) {
  const player = state.currentPlayer;
  const passesInARow = state.passesInARow + 1;
  return {
    ...state,
    currentPlayer: (player + 1) % state.numPlayers,
    drawnThisTurn: 0,
    passesInARow,
    // Everyone passed back-to-back with no card to draw: the round is
    // blocked. Fewest cards wins (see getStatus) so the game can't hang.
    blocked: passesInARow >= state.numPlayers,
    lastAction: { player, type: 'pass' },
  };
}

/* ---------------------------------------------------------------- status */

export function getStatus(state) {
  if (state.winner !== null) {
    return { status: 'won', winner: state.winner, winners: [state.winner] };
  }
  if (state.blocked) {
    const min = Math.min(...state.hands.map((h) => h.length));
    const winners = [];
    state.hands.forEach((h, p) => { if (h.length === min) winners.push(p); });
    return { status: 'blocked', winner: winners.length === 1 ? winners[0] : null, winners };
  }
  return { status: 'active', winner: null, winners: [] };
}
