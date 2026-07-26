/* Engine test — plain Node, no framework. Run: node scripts/test-engine.mjs
 * Exercises the pure engine only; nothing here touches the DOM. */

import {
  createInitialState, legalMoves, applyMove, getStatus,
  rankOf, suitOf, topCard, SUITS,
} from '../js/engine.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.error('FAIL  ' + name); }
}

/* Helper: build a hand-crafted mid-game state (JSON-serializable, like the
 * real thing) so we can test exact rules without hunting for a seed. */
function fixture(overrides = {}) {
  const base = createInitialState({ numPlayers: 2, seed: 42 });
  return { ...base, ...overrides };
}

/* ---------------------------------------------------------- determinism */
{
  const a = createInitialState({ numPlayers: 3, seed: 12345 });
  const b = createInitialState({ numPlayers: 3, seed: 12345 });
  const c = createInitialState({ numPlayers: 3, seed: 54321 });
  assert(JSON.stringify(a) === JSON.stringify(b), 'same seed -> identical deal');
  assert(JSON.stringify(a) !== JSON.stringify(c), 'different seed -> different deal');
  assert(a.hands.length === 3 && a.hands.every((h) => h.length === 5), '3 players get 5 cards each');
  const two = createInitialState({ numPlayers: 2, seed: 7 });
  assert(two.hands.every((h) => h.length === 7), '2 players get 7 cards each');
  assert(rankOf(topCard(two)) !== '8', 'starter card is never an 8');
  const all = [...two.stock, ...two.discard, ...two.hands.flat()];
  assert(all.length === 52 && new Set(all).size === 52, 'full 52-card deck accounted for');
}

/* ------------------------------------------------- rank / suit / 8 legality */
{
  const s = fixture({
    hands: [['QS', '7H', '8D', '4C'], ['2C', '3C', '5C', '6C']],
    stock: ['9D', 'TD', 'JD'],
    discard: ['QH'],
    currentSuit: 'H',
    currentPlayer: 0,
    drawnThisTurn: 0,
  });
  const moves = legalMoves(s);
  const cards = moves.filter((m) => m.type === 'play').map((m) => m.card);
  assert(cards.includes('QS'), 'rank match is legal (QS on QH)');
  assert(cards.includes('7H'), 'suit match is legal (7H on hearts)');
  assert(cards.includes('8D'), '8 is legal any time');
  assert(!cards.includes('4C'), 'non-matching card is not legal');
  assert(moves.filter((m) => m.card === '8D').length === 4, 'an 8 offers all four suit declarations');
  assert(!moves.some((m) => m.type === 'draw'), 'cannot draw while holding a playable card');

  const after = applyMove(s, { type: 'play', card: 'QS' });
  assert(topCard(after) === 'QS' && after.currentSuit === 'S', 'playing QS makes spades the suit to match');
  assert(after.currentPlayer === 1, 'turn advances after a play');
  assert(s.hands[0].length === 4 && topCard(s) === 'QH', 'applyMove did not mutate the old state');
}

/* --------------------------------------------- declared suit after an 8 */
{
  const s = fixture({
    hands: [['8D', '4C'], ['2C', '3S', '5H', 'KD']],
    stock: ['9D', 'TD', 'JD', '6S', '7S'],
    discard: ['QH'],
    currentSuit: 'H',
    currentPlayer: 0,
  });
  const after = applyMove(s, { type: 'play', card: '8D', declare: 'S' });
  assert(after.currentSuit === 'S', '8 sets the declared suit');
  const oppMoves = legalMoves(after).filter((m) => m.type === 'play');
  const oppCards = oppMoves.map((m) => m.card);
  assert(oppCards.includes('3S'), 'declared suit is playable after an 8');
  assert(!oppCards.includes('5H'), "the 8's own printed suit no longer matters (hearts blocked)");
  assert(!oppCards.includes('KD'), "diamonds (the 8's face suit) is NOT playable after declaring spades");
}

/* --------------------------------------- draw-up-to-3-then-pass flow */
{
  let s = fixture({
    hands: [['4C', '5C'], ['2H', '3H']],
    stock: ['9D', 'TC', 'JD', '6C', '7C'], // draws come off the END: 7C, 6C, JD
    discard: ['QH'],
    currentSuit: 'H',
    currentPlayer: 0,
    drawnThisTurn: 0,
  });
  assert(legalMoves(s).every((m) => m.type === 'draw'), 'stuck player must draw');
  s = applyMove(s, { type: 'draw' });   // draws 7C — still stuck
  assert(s.hands[0].length === 3 && s.currentPlayer === 0, 'draw keeps the turn');
  s = applyMove(s, { type: 'draw' });   // draws 6C — still stuck
  s = applyMove(s, { type: 'draw' });   // draws JD — still stuck, 3rd draw
  assert(s.drawnThisTurn === 3, 'three draws counted');
  const after3 = legalMoves(s);
  assert(after3.length === 1 && after3[0].type === 'pass', 'after 3 draws with no play, only pass is legal');
  s = applyMove(s, { type: 'pass' });
  assert(s.currentPlayer === 1 && s.drawnThisTurn === 0, 'pass hands the turn on and resets the draw count');
}

/* Drawing a playable card stops the draw run */
{
  let s = fixture({
    hands: [['4C', '5C'], ['2H', '3H']],
    stock: ['9D', 'TC', '9H'], // first draw = 9H, a heart — playable
    discard: ['QH'],
    currentSuit: 'H',
    currentPlayer: 0,
  });
  s = applyMove(s, { type: 'draw' });
  const moves = legalMoves(s);
  assert(moves.some((m) => m.card === '9H'), 'drawn playable card is offered');
  assert(!moves.some((m) => m.type === 'draw'), 'no more drawing once you can play');
}

/* ------------------------------------------------------ stock reshuffle */
{
  let s = fixture({
    hands: [['4C', '5C'], ['2H', '3H']],
    stock: [],
    discard: ['9S', 'TS', 'JS', 'QH'], // empty stock, meaty discard
    currentSuit: 'H',
    currentPlayer: 0,
  });
  s = applyMove(s, { type: 'draw' });
  assert(s.hands[0].length === 3, 'draw succeeded off an empty stock via reshuffle');
  assert(s.discard.length === 1 && s.discard[0] === 'QH', 'reshuffle keeps the top discard');
  assert(s.stock.length === 2, 'rest of the discard became the new stock (3 - 1 drawn = 2)');
  assert(s.lastAction.reshuffled === true, 'reshuffle is flagged for the UI');
  const total = [...s.stock, ...s.discard, ...s.hands.flat()];
  assert(total.length === 8 && new Set(total).size === 8, 'no cards created or lost in the reshuffle');
}

/* Truly dead position: empty stock, bare discard -> pass, and a fully
 * blocked round ends with fewest-cards-wins instead of hanging. */
{
  let s = fixture({
    hands: [['4C', '5C'], ['2H']],
    stock: [],
    discard: ['QD'],
    currentSuit: 'D',
    currentPlayer: 0,
  });
  const only = legalMoves(s);
  assert(only.length === 1 && only[0].type === 'pass', 'nothing to draw at all -> pass immediately');
  s = applyMove(s, { type: 'pass' });
  s = applyMove(s, { type: 'pass' }); // player 1 also stuck (2H on QD, diamonds)
  const st = getStatus(s);
  assert(st.status === 'blocked' && st.winner === 1, 'blocked round: fewest cards wins');
}

/* --------------------------------------------------------- win detection */
{
  const s = fixture({
    hands: [['QS'], ['2C', '3C']],
    stock: ['9D'],
    discard: ['QH'],
    currentSuit: 'H',
    currentPlayer: 0,
  });
  const after = applyMove(s, { type: 'play', card: 'QS' });
  const st = getStatus(after);
  assert(st.status === 'won' && st.winner === 0, 'emptying your hand wins the round');
  assert(legalMoves(after).length === 0, 'no legal moves once the round is over');
}

/* -------------------------------------------- serialization round-trip */
{
  let s = createInitialState({ numPlayers: 2, seed: 999 });
  // Play a few forced moves, snapshotting through JSON each time.
  for (let i = 0; i < 20 && getStatus(s).status === 'active'; i++) {
    s = JSON.parse(JSON.stringify(s));
    s = applyMove(s, legalMoves(s)[0]);
  }
  const thawed = JSON.parse(JSON.stringify(s));
  assert(JSON.stringify(legalMoves(thawed)) === JSON.stringify(legalMoves(s)),
    'game survives stringify/parse mid-run with identical legal moves');
}

/* ------------------------------------- full-game soak: engine + fairness */
{
  const { chooseMove } = await import('../js/bot.js');
  let finished = 0;
  for (let seed = 1; seed <= 200; seed++) {
    for (const numPlayers of [2, 3, 4]) {
      let s = createInitialState({ numPlayers, seed });
      let guard = 0;
      while (getStatus(s).status === 'active' && guard++ < 2000) {
        s = applyMove(s, chooseMove(s));
      }
      const st = getStatus(s);
      if (st.status !== 'active') finished++;
      // invariant: 52 cards, no dupes, always
      const all = [...s.stock, ...s.discard, ...s.hands.flat()];
      if (all.length !== 52 || new Set(all).size !== 52) {
        failed++;
        console.error(`FAIL  card conservation broke (seed ${seed}, ${numPlayers}p)`);
      }
    }
  }
  assert(finished === 600, `600/600 bot-vs-bot games finish (got ${finished})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
