/* Champ the bot — picks a move using ONLY the engine's public API.
 * No rule logic lives here: the bot chooses among legalMoves(state).
 *
 * Heuristic:
 *  - Prefer dumping the suit it holds the most of (majority suit).
 *  - Save 8s for when it's stuck (only play an 8 if nothing else is legal).
 *  - When it plays an 8, declare its longest remaining suit.
 *  - Otherwise draw / pass as the engine allows.
 */

import { legalMoves, rankOf, suitOf, SUITS } from './engine.js';

function suitCounts(hand) {
  const counts = { S: 0, H: 0, D: 0, C: 0 };
  for (const card of hand) {
    if (rankOf(card) !== '8') counts[suitOf(card)]++;
  }
  return counts;
}

function longestSuit(counts) {
  let best = SUITS[0];
  for (const suit of SUITS) {
    if (counts[suit] > counts[best]) best = suit;
  }
  return best;
}

export function chooseMove(state) {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];

  const hand = state.hands[state.currentPlayer];
  const counts = suitCounts(hand);

  const normalPlays = moves.filter((m) => m.type === 'play' && rankOf(m.card) !== '8');
  if (normalPlays.length > 0) {
    // Dump from the majority suit; among those, shed the highest rank first
    // (later ranks in RANKS order ≈ harder to get rid of).
    let best = normalPlays[0];
    let bestScore = -1;
    for (const move of normalPlays) {
      const score = counts[suitOf(move.card)] * 100 + cardWeight(move.card);
      if (score > bestScore) { bestScore = score; best = move; }
    }
    return best;
  }

  // Only 8s are playable: play one and declare the longest remaining suit.
  const eightPlays = moves.filter((m) => m.type === 'play');
  if (eightPlays.length > 0) {
    const card = eightPlays[0].card;
    const remaining = suitCounts(hand.filter((c) => c !== card));
    const declare = longestSuit(remaining);
    return eightPlays.find((m) => m.card === card && m.declare === declare) || eightPlays[0];
  }

  return moves[0]; // draw or pass
}

function cardWeight(card) {
  // A rough "hard to play later" weight: face cards first.
  const order = 'A23456789TJQK';
  return order.indexOf(rankOf(card));
}
