/* CRAZY EIGHTS — UI only. All rules live in engine.js; the bot lives in
 * bot.js. This file renders state, handles taps, paces the bot with
 * timers, and saves/restores the game (the whole game state is one
 * JSON-serializable object, so localStorage resume is a stringify away). */

import {
  createInitialState, legalMoves, applyMove, getStatus,
  rankOf, suitOf, topCard,
} from './engine.js';
import { chooseMove } from './bot.js';

const SAVE_KEY = 'crazy-eights-save-v1';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is Champ

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 }; // alternate colors in the fan
const RANK_CHAR = { T: '10' };
const RANK_SORT = 'A23456789TJQK';

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), handoff: $('handoff'), game: $('game'), gameover: $('gameover') };

let G = null;            // { mode: 'bot' | 'pass', state }
let pendingEight = null; // card string waiting on a suit declaration
let handRevealed = true; // pass & play: false until the handoff button is tapped
let botTimer = null;

/* ---------------------------------------------------------------- helpers */

const newSeed = () => (Math.random() * 2 ** 31) | 0;
const isRed = (card) => suitOf(card) === 'H' || suitOf(card) === 'D';
const rankChar = (card) => RANK_CHAR[rankOf(card)] || rankOf(card);
const suitSpan = (suit) =>
  `<span class="${suit === 'H' || suit === 'D' ? 'red' : ''}">${SUIT_CHAR[suit]}</span>`;

function playerName(p) {
  if (G.mode === 'bot') return p === BOT ? 'Champ' : 'You';
  return 'Player ' + (p + 1);
}

function humanTurn() {
  return G && getStatus(G.state).status === 'active' &&
    !(G.mode === 'bot' && G.state.currentPlayer === BOT);
}

function show(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle('hidden', key !== name);
}

function save() {
  try {
    if (G && getStatus(G.state).status === 'active') {
      localStorage.setItem(SAVE_KEY, JSON.stringify(G));
    } else {
      localStorage.removeItem(SAVE_KEY);
    }
  } catch (e) { /* private mode etc. — play on without saving */ }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved?.state?.version === 1 && getStatus(saved.state).status === 'active') return saved;
  } catch (e) { /* corrupted save — ignore it */ }
  return null;
}

/* ---------------------------------------------------------------- cards */

function cardEl(card) {
  const el = document.createElement('div');
  el.className = 'card ' + (isRed(card) ? 'red' : 'black');
  el.dataset.card = card;
  const r = rankChar(card);
  const s = SUIT_CHAR[suitOf(card)];
  const pip = rankOf(card) === '8'
    ? `<span class="eight-wild">8</span>`
    : s;
  el.innerHTML =
    `<div class="corner">${r}<br>${s}</div>` +
    `<div class="pip">${pip}</div>` +
    `<div class="corner flip">${r}<br>${s}</div>`;
  return el;
}

/* Stable pseudo-random tilt for a card in the discard pile (pure function
 * of the card string, so re-renders don't make the pile twitch). */
function cardTilt(card) {
  let h = 0;
  for (const ch of card) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 17) - 8);
}

function sortedHand(hand) {
  return hand.slice().sort((a, b) =>
    (SUIT_ORDER[suitOf(a)] - SUIT_ORDER[suitOf(b)]) ||
    (RANK_SORT.indexOf(rankOf(a)) - RANK_SORT.indexOf(rankOf(b))));
}

/* ---------------------------------------------------------------- render */

function render(fx = {}) {
  const state = G.state;
  const moves = legalMoves(state);
  const playable = new Set(moves.filter((m) => m.type === 'play').map((m) => m.card));
  const canDrawNow = moves.some((m) => m.type === 'draw');
  const mustPass = moves.length === 1 && moves[0].type === 'pass';
  const myTurn = humanTurn();

  // opponents bar
  const opps = $('opponents');
  opps.innerHTML = '';
  for (let p = 0; p < state.numPlayers; p++) {
    if (G.mode === 'bot' && p !== BOT) continue; // your own hand is on the table
    const chip = document.createElement('div');
    chip.className = 'opp' + (state.currentPlayer === p ? ' active' : '');
    chip.innerHTML =
      `<span>${G.mode === 'bot' ? '🐉 Champ' : 'P' + (p + 1)}</span>` +
      `<span class="opp-count">${state.hands[p].length}</span>`;
    opps.appendChild(chip);
  }

  // stock
  const stock = $('stock');
  stock.classList.toggle('drawable', myTurn && canDrawNow);
  stock.classList.toggle('empty', state.stock.length === 0 && state.discard.length <= 1);
  $('stockCount').textContent = state.stock.length + ' LEFT';
  if (fx.stockBump) {
    stock.classList.remove('bump'); void stock.offsetWidth; stock.classList.add('bump');
  }

  // discard + suit badge — show a couple of earlier plays peeking out
  // underneath so it reads as a real pile
  const discard = $('discard');
  discard.innerHTML = '';
  for (const under of state.discard.slice(-3, -1)) {
    const el = cardEl(under);
    el.classList.add('under');
    el.style.transform = `rotate(${cardTilt(under)}deg)`;
    discard.appendChild(el);
  }
  const top = cardEl(topCard(state));
  if (fx.slap) top.classList.add('slap');
  discard.appendChild(top);
  const badge = $('suitBadge');
  badge.textContent = SUIT_CHAR[state.currentSuit];
  badge.className = state.currentSuit === 'H' || state.currentSuit === 'D' ? 'red' : 'black';
  if (fx.suitPulse) { void badge.offsetWidth; badge.classList.add('pulse'); }

  // pass button
  $('passTurnBtn').classList.toggle('hidden', !(myTurn && mustPass));

  // hand — in bot mode always the human's; in pass mode the current player's
  const handOwner = G.mode === 'bot' ? 0 : state.currentPlayer;
  $('handLabel').textContent = G.mode === 'bot'
    ? 'your hand'
    : playerName(handOwner) + "'s hand";
  const handEl = $('hand');
  handEl.innerHTML = '';
  if (handRevealed) {
    const cards = sortedHand(state.hands[handOwner]);
    const lastDrawn = (state.lastAction?.type === 'draw' && state.lastAction.player === handOwner)
      ? state.hands[handOwner][state.hands[handOwner].length - 1] : null;
    // fan the hand: small rotation per card around a low pivot, with the
    // ends of the arc dipping slightly — like cards held in a hand
    const n = cards.length;
    const mid = (n - 1) / 2;
    const spread = Math.min(4.5, 36 / Math.max(n, 1)); // degrees between cards
    cards.forEach((card, i) => {
      const el = cardEl(card);
      el.style.setProperty('--rot', ((i - mid) * spread).toFixed(2) + 'deg');
      el.style.setProperty('--arc', Math.min(18, Math.pow(Math.abs(i - mid), 1.7) * 1.5).toFixed(1) + 'px');
      if (myTurn && playable.has(card)) el.classList.add('playable');
      if (fx.dealAll) { el.classList.add('deal-in'); el.style.animationDelay = (i * 45) + 'ms'; }
      else if (card === lastDrawn && fx.drew) el.classList.add('deal-in');
      el.addEventListener('click', () => onCardTap(card, el));
      handEl.appendChild(el);
    });
  }

  renderMessage(moves, myTurn, mustPass, canDrawNow);
}

function renderMessage(moves, myTurn, mustPass, canDrawNow) {
  const state = G.state;
  const last = state.lastAction;
  let lines = [];

  if (last) {
    const who = playerName(last.player);
    if (last.type === 'play') {
      if (last.declare) {
        lines.push(`${who} threw a wild 8 — suit is now ${suitSpan(last.declare)} ${SUIT_NAME[last.declare]}!`);
      } else {
        lines.push(`${who} played ${rankChar(last.card)}${suitSpan(last.card[1])}.`);
      }
    } else if (last.type === 'draw') {
      if (last.reshuffled) lines.push('Shuffled the pile back into the stock — Vermont thrift.');
      if (G.mode === 'bot' && last.player === BOT) lines.push('Champ digs into the pile…');
    } else if (last.type === 'pass') {
      lines.push(`${who} passed. It happens to the best of us.`);
    }
  }

  if (getStatus(state).status !== 'active') { $('msg').innerHTML = lines.join(' '); return; }

  if (myTurn) {
    const rank = rankChar(topCard(state));
    if (mustPass) {
      lines.push('Nothing doing — pass it along.');
    } else if (!moves.some((m) => m.type === 'play')) {
      const left = 3 - state.drawnThisTurn;
      lines.push(`No match? Tap the pile to draw (${left} draw${left === 1 ? '' : 's'} left).`);
    } else {
      lines.push(`${G.mode === 'pass' ? playerName(state.currentPlayer) + ': m' : 'M'}atch ${suitSpan(state.currentSuit)} or ${rank} — or go wild with an 8.`);
    }
  } else if (lines.length === 0) {
    lines.push('Champ is thinking…');
  }
  $('msg').innerHTML = lines.join(' ');
}

function flashSuitBanner(suit) {
  const banner = $('suitBanner');
  banner.innerHTML = `SUIT IS NOW <span class="big-suit ${suit === 'H' || suit === 'D' ? 'red' : ''}">${SUIT_CHAR[suit]}</span> ${SUIT_NAME[suit].toUpperCase()}`;
  banner.classList.remove('hidden');
  // restart the animation
  banner.style.animation = 'none'; void banner.offsetWidth; banner.style.animation = '';
  clearTimeout(flashSuitBanner.t);
  flashSuitBanner.t = setTimeout(() => banner.classList.add('hidden'), 1550);
}

/* ---------------------------------------------------------------- moves */

function doMove(move) {
  const mover = G.state.currentPlayer;
  G.state = applyMove(G.state, move);
  save();

  // Pass & play: the instant the turn changes hands, stop showing cards —
  // otherwise the next player's hand flashes on screen before the handoff.
  if (G.mode === 'pass' && G.state.currentPlayer !== mover) handRevealed = false;

  const fx = {};
  if (move.type === 'play') {
    fx.slap = true;
    fx.suitPulse = true;
    if (move.declare) flashSuitBanner(move.declare);
  } else if (move.type === 'draw') {
    fx.stockBump = true;
    fx.drew = true;
  }
  render(fx);

  const status = getStatus(G.state);
  if (status.status !== 'active') {
    setTimeout(() => showGameOver(status), move.type === 'play' ? 900 : 500);
    return;
  }

  const next = G.state.currentPlayer;
  if (next !== mover) {
    if (G.mode === 'bot' && next === BOT) {
      botTimer = setTimeout(botStep, 850);
    } else if (G.mode === 'pass') {
      setTimeout(() => showHandoff(next), move.type === 'play' ? 750 : 400);
    }
  }
}

function onCardTap(card, el) {
  if (!humanTurn()) return;
  const playable = legalMoves(G.state).some((m) => m.type === 'play' && m.card === card);
  if (!playable) {
    el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope');
    return;
  }
  if (rankOf(card) === '8') {
    pendingEight = card;
    $('suitPicker').classList.remove('hidden');
    return;
  }
  doMove({ type: 'play', card });
}

$('stock').addEventListener('click', () => {
  if (!humanTurn()) return;
  const moves = legalMoves(G.state);
  if (moves.some((m) => m.type === 'draw')) { doMove({ type: 'draw' }); return; }
  if (moves.some((m) => m.type === 'play')) {
    $('msg').innerHTML = "You've got a playable card — no drawing when you can play!";
  } else {
    $('msg').innerHTML = "That's your three draws — pass it along.";
  }
});

$('passTurnBtn').addEventListener('click', () => {
  if (!humanTurn()) return;
  if (legalMoves(G.state).some((m) => m.type === 'pass')) doMove({ type: 'pass' });
});

document.querySelectorAll('.suit-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!pendingEight) return;
    const move = { type: 'play', card: pendingEight, declare: btn.dataset.suit };
    pendingEight = null;
    $('suitPicker').classList.add('hidden');
    doMove(move);
  });
});

$('suitPicker').addEventListener('click', (e) => {
  if (e.target === $('suitPicker')) { // tap outside cancels
    pendingEight = null;
    $('suitPicker').classList.add('hidden');
  }
});

/* ---------------------------------------------------------------- bot */

function botStep() {
  if (!G || G.mode !== 'bot') return;
  if (getStatus(G.state).status !== 'active' || G.state.currentPlayer !== BOT) return;
  doMove(chooseMove(G.state));
  // doMove re-arms botTimer only on turn change; a bot draw keeps the turn:
  if (getStatus(G.state).status === 'active' && G.state.currentPlayer === BOT) {
    botTimer = setTimeout(botStep, 700);
  }
}

/* ---------------------------------------------------------------- flow */

function startGame(mode, numPlayers) {
  clearTimeout(botTimer);
  G = { mode, state: createInitialState({ numPlayers, seed: newSeed() }) };
  save();
  if (mode === 'pass') {
    showHandoff(G.state.currentPlayer);
  } else {
    handRevealed = true;
    show('game');
    render({ dealAll: true });
  }
}

function showHandoff(player) {
  handRevealed = false;
  $('handoffTitle').textContent = 'Pass the phone to ' + playerName(player);
  show('handoff');
}

$('handoffBtn').addEventListener('click', () => {
  handRevealed = true;
  show('game');
  render({ dealAll: true });
});

const WIN_LINES = [
  'Sweeter than fresh syrup on snow.',
  'Cleaned the table faster than a creemee melts in July.',
  'That hand deserves a spot at the farmers market.',
  'Smoother than a fresh line at Bolton Valley.',
];

function showGameOver(status) {
  clearTimeout(botTimer);
  save(); // clears the save — game's done
  const title = $('go-title');
  const line = $('go-line');
  const pick = WIN_LINES[(Math.random() * WIN_LINES.length) | 0];

  if (status.status === 'blocked') {
    title.textContent = 'GRIDLOCK!';
    const names = status.winners.map(playerName).join(' & ');
    line.textContent = status.winners.length === 1
      ? `Nobody could move — like Shelburne Road at 5pm. Fewest cards takes it: ${names} wins!`
      : `Nobody could move, and ${names} tie for fewest cards. Split the maple candy.`;
  } else if (G.mode === 'bot' && status.winner === BOT) {
    title.textContent = 'CHAMP TAKES IT';
    line.textContent = 'The lake monster out-carded you this time. Demand a rematch — Champ has nowhere to be.';
  } else if (G.mode === 'bot') {
    title.textContent = 'YOU WIN! 🍁';
    line.textContent = pick + ' Champ tips his fins to you.';
  } else {
    title.textContent = playerName(status.winner).toUpperCase() + ' WINS! 🍁';
    line.textContent = pick;
  }
  show('gameover');
}

/* ---------------------------------------------------------------- menu */

$('botBtn').addEventListener('click', () => startGame('bot', 2));
$('passBtn').addEventListener('click', () => $('countRow').classList.toggle('hidden'));
document.querySelectorAll('.count-btn').forEach((btn) => {
  btn.addEventListener('click', () => startGame('pass', +btn.dataset.n));
});

$('resumeBtn').addEventListener('click', () => {
  const saved = loadSave();
  if (!saved) { $('resumeBtn').classList.add('hidden'); return; }
  G = saved;
  if (G.mode === 'pass') {
    showHandoff(G.state.currentPlayer);
  } else {
    handRevealed = true;
    show('game');
    render({ dealAll: true });
    if (G.state.currentPlayer === BOT) botTimer = setTimeout(botStep, 850);
  }
});

function goMenu() {
  clearTimeout(botTimer);
  pendingEight = null;
  $('suitPicker').classList.add('hidden');
  $('resumeBtn').classList.toggle('hidden', !loadSave());
  show('menu');
}

$('homeBtn').addEventListener('click', goMenu);
$('menuBtn').addEventListener('click', goMenu);
$('againBtn').addEventListener('click', () => {
  startGame(G.mode, G.state.numPlayers);
});

/* ---------------------------------------------------------------- boot */

goMenu();
