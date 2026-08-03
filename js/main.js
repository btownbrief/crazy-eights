/* CRAZY EIGHTS — UI only. All rules live in engine.js; the bot lives in
 * bot.js. This file renders state, handles taps, paces the bot with
 * timers, and saves/restores the game (the whole game state is one
 * JSON-serializable object, so localStorage resume is a stringify away). */

import {
  createInitialState, legalMoves, applyMove, getStatus,
  rankOf, suitOf, topCard,
} from './engine.js';
import { chooseMove } from './bot.js';
import { OnlineMatch, savedSession, clearSession, getName } from './rooms.js';
import { sound } from './audio.js';
import {
  lbEnabled, fetchTop, submitScore, renamePlayer, monthLabel,
  getName as lbGetName, playerId as lbPlayerId,
} from './leaderboard.js';

const SAVE_KEY = 'crazy-eights-save-v1';
const GAME = 'crazy-eights';
const BOT = 1; // in bot mode, player 0 is the human, player 1 is Champ

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 }; // alternate colors in the fan
const RANK_CHAR = { T: '10' };
const RANK_SORT = 'A23456789TJQK';

const $ = (id) => document.getElementById(id);
const screens = { menu: $('menu'), handoff: $('handoff'), game: $('game'), gameover: $('gameover') };
const onlinePanel = $('onlinePanel');
const opTitle = $('opTitle');
const opName = $('opName');
const opSeatsWrap = $('opSeatsWrap');
const opCodeWrap = $('opCodeWrap');
const opCode = $('opCode');
const opError = $('opError');
const lobbyEl = $('lobby');
const lobbyCode = $('lobbyCode');
const lobbyNames = $('lobbyNames');
const rejoinBtn = $('rejoinBtn');
const fxBanner = $('fxBanner');
const fxStatus = $('fxStatus');
const champEl = $('champ');
const champBubble = $('champBubble');

let G = null;            // { mode: 'bot' | 'pass' | 'online', state }
let pendingEight = null; // card string waiting on a suit declaration
let handRevealed = true; // pass & play: false until the handoff button is tapped
let botTimer = null;
let gameOverTimer = null;
let online = null;       // { match, myPlayer } while seated in an online crew
let onlinePushing = false;
let pollErrors = 0;
let panelIntent = 'host';
let selectedSeats = 2;
let leaveTimer = null;
let confirmedState = null;
let confirmedKey = '';
let effectRun = 0;
let effectTimers = [];
let resolutionKey = '';

/* ---------------------------------------------------------------- helpers */

const newSeed = () => (Math.random() * 2 ** 31) | 0;
const isRed = (card) => suitOf(card) === 'H' || suitOf(card) === 'D';
const rankChar = (card) => RANK_CHAR[rankOf(card)] || rankOf(card);
const suitSpan = (suit) =>
  `<span class="${suit === 'H' || suit === 'D' ? 'red' : ''}">${SUIT_CHAR[suit]}</span>`;
// Player names arrive from the network; escape them anywhere suit markup
// requires innerHTML. Everywhere else, insert them with textContent.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function playerName(p) {
  if (G.mode === 'bot') return p === BOT ? 'Champ' : 'You';
  if (G.mode === 'online') {
    if (p === online.myPlayer) return 'You';
    const seat = online.match.seats.find((s) => s.seat === p);
    return seat?.name || 'Player ' + (p + 1);
  }
  return 'Player ' + (p + 1);
}

function humanTurn() {
  if (!G || getStatus(G.state).status !== 'active') return false;
  if (G.mode === 'bot') return G.state.currentPlayer !== BOT;
  if (G.mode === 'online') {
    return !onlinePushing && online && online.match.status === 'playing' &&
      G.state.currentPlayer === online.myPlayer;
  }
  return handRevealed;
}

function show(name) {
  for (const key of Object.keys(screens)) screens[key].classList.toggle('hidden', key !== name);
}

function save() {
  try {
    if (G && G.mode !== 'online' && getStatus(G.state).status === 'active') {
      localStorage.setItem(SAVE_KEY, JSON.stringify(G));
    } else if (!G || G.mode !== 'online') {
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

/* ------------------------------------------------------- sound + effects */

function stateKey(state) {
  return state ? JSON.stringify(state) : '';
}

function setConfirmedStateCold(state) {
  confirmedState = state;
  confirmedKey = stateKey(state);
}

function later(fn, delay) {
  const run = effectRun;
  const timer = setTimeout(() => {
    effectTimers = effectTimers.filter((candidate) => candidate !== timer);
    if (run === effectRun) fn();
  }, delay);
  effectTimers.push(timer);
}

function clearPresentation() {
  effectRun++;
  effectTimers.forEach(clearTimeout);
  effectTimers = [];
  clearTimeout(flashSuitBanner.t);
  clearTimeout(flashBanner.t);
  flashSuitBanner.t = null;
  flashBanner.t = null;
  $('suitBanner').classList.add('hidden');
  fxBanner.className = 'hidden';
  fxBanner.textContent = '';
  fxStatus.textContent = '';
  $('msg').className = '';
  $('msg').textContent = '';
  document.querySelectorAll('.one-card').forEach((el) => el.classList.remove('one-card'));
  champEl.classList.add('hidden');
  screens.gameover.classList.remove('resolving');
  resetLbPanel();
}

function updateMuteButton() {
  $('mute').textContent = sound.muted ? '🔇' : '🔊';
  $('mute').setAttribute('aria-label', sound.muted ? 'Turn sound on' : 'Mute sound');
  $('mute').setAttribute('aria-pressed', String(sound.muted));
}

$('mute').addEventListener('click', () => {
  sound.toggleMuted();
  updateMuteButton();
});
document.addEventListener('pointerdown', sound.unlock, { once: true, capture: true });
document.addEventListener('keydown', sound.unlock, { once: true, capture: true });

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

/* Hand layout: every card must keep a thumb-sized strip (≥44px) tappable.
 * Small hands keep the classic overlapping fan; once one row can't give
 * every card 44px, the hand wraps into a flat rack of 2 (rarely 3) rows,
 * shrinking cards a touch only when even a rack row would overflow. */
const MIN_TAP = 44;     // minimum exposed tappable width per card
const MIN_CARD_W = 48;  // don't shrink cards into unreadability
const FAN_PAD = 18;     // #hand side padding — keep in sync with style.css
const RACK_PAD = 6;     // #hand.wrap side padding — keep in sync with style.css

function handLayout(handEl, n) {
  const total = handEl.clientWidth || window.innerWidth;
  // resolve the CSS card width (a clamp() in style.css) with a probe
  const probe = document.createElement('div');
  probe.className = 'card';
  probe.style.visibility = 'hidden';
  handEl.appendChild(probe);
  const baseW = probe.getBoundingClientRect().width || 64; // sub-pixel exact
  probe.remove();

  // one-row fan: classic overlap, widened to MIN_TAP where it was tighter
  const fanAvail = total - FAN_PAD * 2;
  const fanExposure = Math.max(MIN_TAP, baseW * 0.56);
  if (n <= 1 || (n - 1) * fanExposure + baseW <= fanAvail) {
    return { rows: 1, cardW: baseW, baseW, exposure: fanExposure };
  }

  // multi-row rack: flat cards, MIN_TAP strips, spread to fill the row
  const rackAvail = total - RACK_PAD * 2;
  const maxPerRow = Math.max(2, Math.floor((rackAvail - MIN_CARD_W) / MIN_TAP) + 1);
  const rows = Math.max(2, Math.ceil(n / maxPerRow));
  const perRow = Math.ceil(n / rows);
  const cardW = Math.max(MIN_CARD_W, Math.min(baseW, rackAvail - (perRow - 1) * MIN_TAP));
  const exposure = Math.min(cardW, (rackAvail - cardW) / Math.max(perRow - 1, 1));
  return { rows, cardW, baseW, exposure };
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
    if (G.mode === 'online' && p === online.myPlayer) continue;
    const chip = document.createElement('div');
    chip.className = 'opp' + (state.currentPlayer === p ? ' active' : '');
    chip.dataset.player = p;
    const name = document.createElement('span');
    name.textContent = G.mode === 'bot' ? '🐉 Champ' : playerName(p);
    const count = document.createElement('span');
    count.className = 'opp-count';
    count.textContent = state.hands[p].length;
    chip.append(name, count);
    opps.appendChild(chip);
  }

  // stock
  const stock = $('stock');
  stock.classList.toggle('drawable', myTurn && canDrawNow);
  stock.classList.toggle('empty', state.stock.length === 0 && state.discard.length <= 1);
  $('stockCount').textContent = state.stock.length + ' LEFT';
  stock.classList.remove('bump-1', 'bump-2', 'bump-3');
  if (fx.drawLevel) {
    void stock.offsetWidth;
    stock.classList.add(`bump-${Math.min(3, fx.drawLevel)}`);
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

  // The shared room carries every hand so each phone can replay the same
  // state, but the honest online UI renders only this phone's seat.
  const handOwner = G.mode === 'bot' ? 0
    : G.mode === 'online' ? online.myPlayer
      : state.currentPlayer;
  $('handLabel').textContent = G.mode === 'bot' || G.mode === 'online'
    ? 'your hand'
    : playerName(handOwner) + "'s hand";
  $('handLabel').dataset.player = handOwner;
  const handEl = $('hand');
  handEl.innerHTML = '';
  handEl.classList.remove('wrap');
  handEl.style.removeProperty('--card-w');
  handEl.style.removeProperty('--fan-ml');
  if (handRevealed) {
    const cards = sortedHand(state.hands[handOwner]);
    const lastDrawn = (state.lastAction?.type === 'draw' && state.lastAction.player === handOwner)
      ? state.hands[handOwner][state.hands[handOwner].length - 1] : null;
    // fan the hand: small rotation per card around a low pivot, with the
    // ends of the arc dipping slightly — like cards held in a hand.
    // Big hands drop the fan and wrap into a flat rack instead.
    const n = cards.length;
    const layout = handLayout(handEl, n);
    const rack = layout.rows > 1;
    if (layout.cardW !== layout.baseW) handEl.style.setProperty('--card-w', layout.cardW + 'px');
    handEl.style.setProperty('--fan-ml', (layout.exposure - layout.cardW).toFixed(2) + 'px');
    handEl.classList.toggle('wrap', rack);
    const perRow = Math.ceil(n / layout.rows);
    const mid = (n - 1) / 2;
    const spread = rack ? 0 : Math.min(4.5, 36 / Math.max(n, 1)); // degrees between cards
    cards.forEach((card, i) => {
      if (rack && i > 0 && i % perRow === 0) {
        const br = document.createElement('div');
        br.className = 'hand-break';
        handEl.appendChild(br);
      }
      const el = cardEl(card);
      el.style.setProperty('--rot', ((i - mid) * spread).toFixed(2) + 'deg');
      el.style.setProperty('--arc', rack ? '0px'
        : Math.min(18, Math.pow(Math.abs(i - mid), 1.7) * 1.5).toFixed(1) + 'px');
      if (myTurn && playable.has(card)) el.classList.add('playable');
      if (fx.dealAll) { el.classList.add('deal-in'); el.style.animationDelay = (i * 45) + 'ms'; }
      else if (card === lastDrawn && fx.drew) el.classList.add('deal-in');
      el.addEventListener('click', () => onCardTap(card, el));
      handEl.appendChild(el);
    });
  }

  renderRequirement(moves, myTurn, mustPass);
  if (fx.narrate) renderNarration();
}

function showNarration(html) {
  const msg = $('msg');
  msg.innerHTML = html;
  msg.classList.remove('fresh');
  void msg.offsetWidth;
  msg.classList.add('fresh');
  fxStatus.textContent = msg.textContent;
}

function renderNarration() {
  const state = G.state;
  const last = state.lastAction;
  if (!last) return;
  const who = esc(playerName(last.player));
  let text = '';

  if (last.type === 'play') {
    text = last.declare
      ? `${who} threw a wild 8 — ${suitSpan(last.declare)} ${SUIT_NAME[last.declare]} is live.`
      : `${who} played ${rankChar(last.card)}${suitSpan(last.card[1])}.`;
  } else if (last.type === 'draw') {
    text = last.reshuffled
      ? 'The discards became the stock again — Vermont thrift.'
      : `${who} drew from the pile.`;
  } else if (last.type === 'pass') {
    text = `${who} passed. It happens to the best of us.`;
  }
  if (text) showNarration(text);
}

function renderRequirement(moves, myTurn, mustPass) {
  const state = G.state;
  const requirement = $('requirement');
  if (G.mode === 'pass' && !handRevealed) {
    requirement.textContent = 'Hand hidden — pass the phone';
    return;
  }
  if (getStatus(state).status !== 'active') {
    requirement.textContent = 'Hand complete';
    return;
  }
  if (myTurn) {
    const rank = rankChar(topCard(state));
    if (mustPass) {
      requirement.textContent = 'Three draws down — pass it along';
    } else if (!moves.some((m) => m.type === 'play')) {
      const left = 3 - state.drawnThisTurn;
      const drawPrompts = {
        3: 'No match — tap the pile (3 tries)',
        2: 'Still hunting — 2 draws left',
        1: 'Last chance — one draw left',
      };
      requirement.textContent = drawPrompts[left];
    } else {
      const prefix = G.mode === 'pass' ? `${esc(playerName(state.currentPlayer))}: ` : '';
      requirement.innerHTML = `${prefix}match ${suitSpan(state.currentSuit)} or ${rank} · 8 is wild`;
    }
  } else {
    requirement.textContent = G.mode === 'online'
      ? `Waiting on ${playerName(state.currentPlayer)}…`
      : 'Champ is choosing…';
  }
}

function flashSuitBanner(suit, oneCard = false) {
  const banner = $('suitBanner');
  const prefix = oneCard ? '🍁 ONE CARD! · ' : '';
  banner.innerHTML = `${prefix}SUIT IS NOW <span class="big-suit ${suit === 'H' || suit === 'D' ? 'red' : ''}">${SUIT_CHAR[suit]}</span> ${SUIT_NAME[suit].toUpperCase()}`;
  banner.classList.remove('hidden');
  // restart the animation
  banner.style.animation = 'none'; void banner.offsetWidth; banner.style.animation = '';
  clearTimeout(flashSuitBanner.t);
  const run = effectRun;
  flashSuitBanner.t = setTimeout(() => {
    if (run === effectRun) banner.classList.add('hidden');
  }, 1550);
}

function flashBanner(text) {
  fxBanner.textContent = text;
  fxStatus.textContent = text;
  fxBanner.className = 'show';
  fxBanner.style.animation = 'none';
  void fxBanner.offsetWidth;
  fxBanner.style.animation = '';
  clearTimeout(flashBanner.t);
  const run = effectRun;
  flashBanner.t = setTimeout(() => {
    if (run === effectRun) fxBanner.className = 'hidden';
  }, 1350);
}

function pulseOneCard(player) {
  const chip = document.querySelector(`.opp[data-player="${player}"]`);
  const handOwner = G.mode === 'bot' ? 0
    : G.mode === 'online' ? online.myPlayer
      : G.state.currentPlayer;
  const target = chip || (player === handOwner ? $('handLabel') : null);
  if (!target) return;
  target.classList.remove('one-card');
  void target.offsetWidth;
  target.classList.add('one-card');
  later(() => target.classList.remove('one-card'), 1500);
}

function analyzeTransition(before, after, knownMove = null) {
  if (!before || !after) return null;
  if (getStatus(before).status !== 'active' &&
      getStatus(after).status === 'active' &&
      after.lastAction === null) {
    return { action: { type: 'deal' }, oneCardPlayers: [] };
  }
  const action = after.lastAction;
  if (!action || (knownMove && (
    knownMove.type !== action.type ||
    knownMove.card !== action.card ||
    knownMove.declare !== action.declare
  ))) return null;
  const player = action.player;
  if (!Number.isInteger(player) || !before.hands[player] || !after.hands[player]) return null;

  if (action.type === 'play') {
    if (!before.hands[player].includes(action.card) ||
        after.hands[player].length !== before.hands[player].length - 1 ||
        after.discard.length !== before.discard.length + 1) return null;
  } else if (action.type === 'draw') {
    if (after.hands[player].length !== before.hands[player].length + 1 ||
        after.drawnThisTurn !== before.drawnThisTurn + 1) return null;
  } else if (action.type === 'pass') {
    if (after.currentPlayer === before.currentPlayer) return null;
  } else {
    return null;
  }

  const oneCardPlayers = [];
  before.hands.forEach((hand, p) => {
    if (hand.length > 1 && after.hands[p].length === 1) oneCardPlayers.push(p);
  });
  return { action, oneCardPlayers };
}

function visualFxFor(transition) {
  if (!transition) return {};
  if (transition.action.type === 'play') return { slap: true, suitPulse: true, narrate: true };
  if (transition.action.type === 'draw') {
    return { drawLevel: G.state.drawnThisTurn, drew: true, narrate: true };
  }
  if (transition.action.type === 'pass') return { narrate: true };
  if (transition.action.type === 'deal') return { dealAll: true };
  return {};
}

function fireTransitionEffects(transition) {
  if (!transition) return;
  const { action, oneCardPlayers } = transition;
  const oneCard = oneCardPlayers.length > 0;
  if (action.type === 'play') {
    if (action.declare) {
      flashSuitBanner(action.declare, oneCard);
      sound.wild();
    } else {
      sound.slap();
    }
  } else if (action.type === 'draw') {
    sound.draw(G.state.drawnThisTurn);
  } else if (action.type === 'deal') {
    sound.deal();
  }

  if (oneCard) {
    oneCardPlayers.forEach(pulseOneCard);
    if (!action.declare) flashBanner('🍁 ONE CARD!');
    fxStatus.textContent = 'ONE CARD!';
    sound.oneCard();
  }
}

/* Accept one genuinely new transition. Cold starts and hydration instead use
 * setConfirmedStateCold(), so reconnect/rerender never replays effects. */
function acceptConfirmedState(next, knownMove = null) {
  const key = stateKey(next);
  if (key === confirmedKey) {
    render();
    return false;
  }
  const transition = analyzeTransition(confirmedState, next, knownMove);
  confirmedState = next;
  confirmedKey = key;
  const canPresent = !screens.game.classList.contains('hidden');
  render(canPresent ? visualFxFor(transition) : {});
  if (canPresent) fireTransitionEffects(transition);
  return true;
}

/* ---------------------------------------------------------------- moves */

function doMove(move) {
  const mover = G.state.currentPlayer;
  if (G.mode === 'online') onlinePushing = true;
  G.state = applyMove(G.state, move);
  save();
  const movedState = G.state;

  // Pass & play: the instant the turn changes hands, stop showing cards —
  // otherwise the next player's hand flashes on screen before the handoff.
  if (G.mode === 'pass' && G.state.currentPlayer !== mover) handRevealed = false;

  if (G.mode === 'online') {
    // The room is the referee: paint the optimistic state quietly, then
    // present its effects only after the push or a poll confirms it.
    render();
    pushOnline(movedState, move);
    return;
  }
  acceptConfirmedState(movedState, move);

  const status = getStatus(G.state);
  if (status.status !== 'active') {
    clearTimeout(gameOverTimer);
    const finalKey = stateKey(G.state);
    gameOverTimer = setTimeout(() => {
      if (!G || stateKey(G.state) !== finalKey) return;
      const current = getStatus(G.state);
      if (current.status !== 'active') showGameOver(current);
    }, move.type === 'play' ? 900 : 500);
    return;
  }

  const next = G.state.currentPlayer;
  if (next !== mover) {
    if (G.mode === 'bot' && next === BOT) {
      botTimer = setTimeout(botStep, 850);
    } else if (G.mode === 'pass') {
      later(() => showHandoff(next), move.type === 'play' ? 750 : 400);
    }
  }
}

function onCardTap(card, el) {
  if (!humanTurn()) return;
  const playable = legalMoves(G.state).some((m) => m.type === 'play' && m.card === card);
  if (!playable) {
    el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope');
    showNarration(`That card doesn't match ${suitSpan(G.state.currentSuit)} or ${rankChar(topCard(G.state))}.`);
    sound.nope();
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
    showNarration("You've got a playable card — no drawing when you can play!");
  } else {
    showNarration("That's your three draws — pass it along.");
  }
  sound.nope();
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
  clearTimeout(gameOverTimer);
  clearPresentation();
  resolutionKey = '';
  G = { mode, state: createInitialState({ numPlayers, seed: newSeed() }) };
  setConfirmedStateCold(G.state);
  save();
  sound.deal();
  if (mode === 'pass') {
    showHandoff(G.state.currentPlayer);
  } else {
    handRevealed = true;
    show('game');
    render({ dealAll: true });
  }
}

function showHandoff(player) {
  clearPresentation();
  handRevealed = false;
  $('handoffTitle').textContent = 'Pass the phone to ' + playerName(player);
  show('handoff');
}

$('handoffBtn').addEventListener('click', () => {
  handRevealed = true;
  show('game');
  render();
});

const WIN_LINES = [
  'Sweeter than fresh syrup on snow.',
  'Cleaned the table faster than a creemee melts in July.',
  'That hand deserves a spot at the farmers market.',
  'Smoother than a fresh line at Bolton Valley.',
];
const CHAMP_CONCEDES_CLOSE = [
  'One card from glory. Nice finish.',
  'Too close for dry scales!',
  'You slipped that one past me.',
];
const CHAMP_CONCEDES_BIG = [
  'That was sharp. Fins tipped.',
  'You cleaned the lake with me.',
  'A proper Burlington card shark!',
];
const CHAMP_WINS_CLOSE = [
  'By one whisker of a wave!',
  'Close one. I felt the splash.',
  'Nearly had me, neighbor.',
];
const CHAMP_WINS_BIG = [
  'Lake monster, table monster.',
  'The lake keeps its secrets.',
  'Back in for another hand?',
];
const CHAMP_TIES = [
  'Call it even over a creemee?',
  'A very Vermont traffic jam.',
];
const usedChampLines = new Set();

function pickFresh(lines) {
  let available = lines.filter((text) => !usedChampLines.has(text));
  if (available.length === 0) {
    lines.forEach((text) => usedChampLines.delete(text));
    available = lines;
  }
  const text = available[(Math.random() * available.length) | 0];
  usedChampLines.add(text);
  return text;
}

function localPlayerWon(status) {
  if (G.mode === 'bot') return status.winners.includes(0);
  if (G.mode === 'online') return status.winners.includes(online.myPlayer);
  return true;
}

function champReaction(status) {
  const humanWon = status.winners.includes(0);
  const champWon = status.winners.includes(BOT);
  if (humanWon && champWon) return pickFresh(CHAMP_TIES);
  const loser = humanWon ? BOT : 0;
  const close = G.state.hands[loser].length <= 2;
  if (humanWon) return pickFresh(close ? CHAMP_CONCEDES_CLOSE : CHAMP_CONCEDES_BIG);
  return pickFresh(close ? CHAMP_WINS_CLOSE : CHAMP_WINS_BIG);
}

function celebrateChamp(status) {
  champBubble.textContent = champReaction(status);
  champEl.classList.add('hidden');
  void champEl.offsetWidth;
  champEl.classList.remove('hidden');
}

function showGameOver(status, { celebrate = true } = {}) {
  const key = stateKey(G.state) + '|' + status.status;
  if (resolutionKey === key) return;
  resolutionKey = key;
  clearTimeout(botTimer);
  clearTimeout(gameOverTimer);
  clearPresentation();
  save(); // clears the save — game's done
  const title = $('go-title');
  const line = $('go-line');
  $('againBtn').classList.remove('hidden');
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
  } else if (G.mode === 'online') {
    title.textContent = status.winner === online.myPlayer
      ? 'YOU WIN! 🍁'
      : playerName(status.winner).toUpperCase() + ' WINS! 🍁';
    line.textContent = pick;
  } else {
    title.textContent = playerName(status.winner).toUpperCase() + ' WINS! 🍁';
    line.textContent = pick;
  }
  show('gameover');
  if (celebrate) {
    screens.gameover.classList.add('resolving');
    sound[localPlayerWon(status) ? 'win' : 'lose']();
    if (G.mode === 'bot') celebrateChamp(status);
  }
  if (G.mode === 'bot') {
    // Submit only a fresh human went-out win vs Champ. A blocked gridlock,
    // a loss, or a repaint of a finished hand shows the standings read-only.
    // The resolutionKey check above makes this exactly-once per hand.
    const humanWon = celebrate && status.status === 'won' && status.winner === 0;
    updateLeaderboard(humanWon ? botWinScore() : 0);
  }
  later(() => $('againBtn').focus(), 0);
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
  clearTimeout(gameOverTimer);
  clearPresentation();
  G = saved;
  resolutionKey = '';
  setConfirmedStateCold(G.state);
  if (G.mode === 'pass') {
    showHandoff(G.state.currentPlayer);
  } else {
    handRevealed = true;
    show('game');
    render();
    if (G.state.currentPlayer === BOT) botTimer = setTimeout(botStep, 850);
  }
});

function goMenu(source = null) {
  if (online) {
    if (!source || source.dataset.armed !== '1') {
      if (source) {
        source.dataset.armed = '1';
        source.dataset.oldText = source.textContent;
        source.textContent = 'LEAVE?';
        source.classList.add('leave-armed');
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(() => resetLeaveButton(source), 2500);
      }
      return;
    }
    const match = online.match;
    online = null;
    onlinePushing = false;
    match.leave(); // fire and forget: stops polling and clears this room session
    resetLeaveButton(source);
  }
  clearTimeout(botTimer);
  clearTimeout(gameOverTimer);
  clearPresentation();
  pendingEight = null;
  $('suitPicker').classList.add('hidden');
  $('resumeBtn').classList.toggle('hidden', !loadSave());
  show('menu');
  refreshRejoin();
}

$('homeBtn').addEventListener('click', () => goMenu($('homeBtn')));
$('menuBtn').addEventListener('click', () => goMenu($('menuBtn')));
$('againBtn').addEventListener('click', () => {
  if (G.mode === 'online') {
    onlineRematch();
  } else {
    startGame(G.mode, G.state.numPlayers);
  }
});

function resetLeaveButton(btn) {
  if (!btn) return;
  clearTimeout(leaveTimer);
  btn.dataset.armed = '';
  if (btn.dataset.oldText) btn.textContent = btn.dataset.oldText;
  btn.dataset.oldText = '';
  btn.classList.remove('leave-armed');
}

/* ------------------------------------------------------------- online play */
// The room ferries the complete deterministic engine state. Seat number is
// engine player number: host = player 0, and player 0 opens every fresh deal.

$('hostBtn').addEventListener('click', () => openPanel('host'));
$('joinBtn').addEventListener('click', () => openPanel('join'));
$('opCancel').addEventListener('click', closePanel);
$('opGo').addEventListener('click', onlineGo);
$('lobbyCancel').addEventListener('click', cancelLobby);
rejoinBtn.addEventListener('click', rejoinCrew);
opCode.addEventListener('input', () => {
  opCode.value = opCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
[opName, opCode].forEach((el) => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') onlineGo();
}));
document.querySelectorAll('.seat-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedSeats = +btn.dataset.seats;
    document.querySelectorAll('.seat-btn').forEach((choice) => {
      const selected = choice === btn;
      choice.classList.toggle('selected', selected);
      choice.setAttribute('aria-pressed', String(selected));
    });
  });
});

function openPanel(intent) {
  panelIntent = intent;
  opTitle.textContent = intent === 'host' ? 'START A CREW' : 'JOIN A CREW';
  $('opGo').textContent = intent === 'host' ? 'GET A CODE' : 'DEAL ME IN';
  opSeatsWrap.classList.toggle('hidden', intent !== 'host');
  opCodeWrap.classList.toggle('hidden', intent === 'host');
  opError.classList.add('hidden');
  opName.value = opName.value || getName();
  onlinePanel.classList.remove('hidden');
  (intent === 'join' && opName.value ? opCode : opName).focus();
}

function closePanel() {
  onlinePanel.classList.add('hidden');
}

const FRIENDLY_ERRORS = {
  not_found: 'No crew with that code — double-check it.',
  room_full: 'That table is already full.',
  room_started: 'That crew already started the hand.',
  not_ready: "Online play isn't switched on yet — check back soon!",
  offline: "Can't reach the table — are you online?",
};
function friendly(err) {
  if (err && err.code === 'wrong_game') {
    return `That code is for ${String(err.detail || 'another game').replace(/-/g, ' ')} — head there to use it.`;
  }
  return (err && FRIENDLY_ERRORS[err.code]) || 'Cards went sideways — please try again.';
}

async function onlineGo() {
  if ($('opGo').disabled) return; // Enter key can't double-submit
  const name = opName.value.trim();
  if (!name) {
    opError.textContent = 'Every card sharp needs a name.';
    opError.classList.remove('hidden');
    opName.focus();
    return;
  }

  const go = $('opGo');
  go.disabled = true;
  opError.classList.add('hidden');
  try {
    let match;
    if (panelIntent === 'host') {
      match = await OnlineMatch.create({
        game: GAME,
        name,
        seats: selectedSeats,
        state: createInitialState({ numPlayers: selectedSeats, seed: newSeed() }),
      });
    } else {
      const code = opCode.value.trim();
      if (code.length !== 4) {
        opError.textContent = 'The crew code is 4 characters.';
        opError.classList.remove('hidden');
        opCode.focus();
        return;
      }
      match = await OnlineMatch.join({ game: GAME, code, name });
    }
    closePanel();
    if (match.status === 'waiting') openLobby(match);
    else enterOnlineGame(match);
  } catch (err) {
    opError.textContent = friendly(err);
    opError.classList.remove('hidden');
  } finally {
    go.disabled = false;
  }
}

function renderLobby(match) {
  lobbyCode.textContent = match.code;
  lobbyNames.innerHTML = '';
  const total = match.state?.numPlayers || selectedSeats;
  for (let seat = 0; seat < total; seat++) {
    const joined = match.seats.find((s) => s.seat === seat);
    const item = document.createElement('li');
    item.textContent = joined
      ? `${joined.name} · Player ${seat + 1}`
      : `Waiting for Player ${seat + 1}…`;
    lobbyNames.appendChild(item);
  }
}

function openLobby(match) {
  if (lobbyEl._match && lobbyEl._match !== match) lobbyEl._match.stop();
  $('lobbyHint').textContent = 'The rest of the crew taps JOIN A CREW and types it in.';
  renderLobby(match);
  lobbyEl.classList.remove('hidden');
  lobbyEl._match = match;
  match.start({
    onStatus: (status) => {
      if (status === 'playing') {
        lobbyEl.classList.add('hidden');
        enterOnlineGame(match);
      } else if (status === 'over') {
        $('lobbyHint').textContent = 'Someone left the table. Call it off and make a new crew.';
      }
    },
    onPresence: () => renderLobby(match),
    onError: () => {}, // waiting-room hiccups resolve on the next poll
  });
}

function cancelLobby() {
  const match = lobbyEl._match;
  if (match) match.leave();
  lobbyEl._match = null;
  lobbyEl.classList.add('hidden');
  refreshRejoin();
}

async function rejoinCrew() {
  rejoinBtn.disabled = true;
  try {
    const match = await OnlineMatch.resume({ game: GAME });
    if (match.status === 'waiting') openLobby(match);
    else enterOnlineGame(match);
  } catch (err) {
    // Only a room that's truly gone forfeits the session — a flaky
    // connection must not delete the one path back to the game.
    if (err && (err.code === 'not_found' || err.code === 'not_seated' || err.code === 'room_started')) {
      clearSession(GAME);
      refreshRejoin();
    }
  } finally {
    rejoinBtn.disabled = false;
  }
}

function refreshRejoin() {
  const saved = savedSession(GAME);
  rejoinBtn.classList.toggle('hidden', !saved);
  if (saved) rejoinBtn.textContent = `↩ REJOIN YOUR CREW (${saved.code})`;
}

function enterOnlineGame(match) {
  clearTimeout(botTimer);
  clearTimeout(gameOverTimer);
  clearPresentation();
  resolutionKey = '';
  online = { match, myPlayer: match.seat };
  onlinePushing = false;
  pollErrors = 0;
  G = { mode: 'online', state: match.state };
  handRevealed = true;
  pendingEight = null;
  $('suitPicker').classList.add('hidden');
  onlinePanel.classList.add('hidden');
  lobbyEl.classList.add('hidden');
  setConfirmedStateCold(G.state);
  showOnlineTruth();
  match.start({
    onState: onRemoteState,
    onStatus: onRemoteStatus,
    onPresence: onRemotePresence,
    onError: onPollError,
  });
  if (match.status === 'over' && getStatus(G.state).status === 'active') {
    onRemoteStatus('over');
  }
}

// Conflict, reconnect, and rejoin truth repaints cold. Only ordinary new
// onState transitions pass through acceptConfirmedState() and earn effects.
function showOnlineTruth(fx = {}, { celebrate = false } = {}) {
  const status = getStatus(G.state);
  if (status.status === 'active') {
    show('game');
    render(fx);
  } else {
    render();
    showGameOver(status, { celebrate });
  }
}

function scheduleOnlineGameOver(status) {
  clearTimeout(gameOverTimer);
  const finalKey = stateKey(G.state);
  gameOverTimer = setTimeout(() => {
    if (!online || stateKey(G.state) !== finalKey) return;
    if (getStatus(G.state).status !== 'active') showGameOver(status);
  }, 700);
}

function onRemoteState(newState) {
  if (!online) return;
  const key = stateKey(newState);
  G.state = newState;
  onlinePushing = false;
  if (key === confirmedKey) {
    if (!screens.game.classList.contains('hidden')) render();
    return;
  }
  const isRematch = confirmedState && getStatus(confirmedState).status !== 'active' &&
    getStatus(newState).status === 'active' && newState.lastAction === null;
  if (isRematch) {
    clearPresentation();
    resolutionKey = '';
  }
  pendingEight = null;
  $('suitPicker').classList.add('hidden');
  show('game');
  acceptConfirmedState(newState);
  const status = getStatus(newState);
  if (status.status !== 'active') scheduleOnlineGameOver(status);
}

function onRemoteStatus(status) {
  if (!online) return;
  if (status !== 'over' || getStatus(G.state).status !== 'active') return;
  const departed = online.match.opponents().find((opp) => opp.left);
  if (departed) showOnlineDeparture(departed.name);
}

function onRemotePresence(opponents) {
  if (!online) return;
  pollErrors = 0;
  const departed = opponents.find((opp) => opp.left);
  if (departed && getStatus(G.state).status === 'active') {
    showOnlineDeparture(departed.name);
  }
}

function showOnlineDeparture(name) {
  clearTimeout(gameOverTimer);
  clearPresentation();
  $('go-title').textContent = 'CREW MEMBER LEFT';
  $('go-line').textContent = `${name || 'A player'} stepped away, so this hand is over.`;
  $('againBtn').classList.add('hidden');
  show('gameover');
  later(() => $('menuBtn').focus(), 0);
}

function onPollError(err) {
  if (!online) return;
  if (err && err.code === 'not_found') {
    online.match.stop();
    clearSession(GAME);
    online = null;
    onlinePushing = false;
    clearPresentation();
    show('menu');
    refreshRejoin();
    return;
  }
  pollErrors++;
  if (pollErrors >= 3 && getStatus(G.state).status === 'active') {
    showNarration('CHOPPY CONNECTION — HANG TIGHT…');
  }
}

async function pushOnline(nextState, knownMove = null) {
  const match = online && online.match;
  if (!match) return;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await match.push(nextState, { over: getStatus(nextState).status !== 'active' });
      if (!online || online.match !== match) return;
      pollErrors = 0;
      onlinePushing = false;
      if (G.state === nextState) {
        show('game');
        acceptConfirmedState(nextState, knownMove);
        const status = getStatus(nextState);
        if (status.status !== 'active') scheduleOnlineGameOver(status);
      }
      return;
    } catch (err) {
      lastError = err;
      if (err && err.code === 'version_conflict') {
        if (!online || online.match !== match) return;
        G.state = match.state;
        onlinePushing = false;
        setConfirmedStateCold(G.state);
        showOnlineTruth();
        return;
      }
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }
  if (!online || online.match !== match) return;
  // Neither publish landed. Roll back to the last server-confirmed state so
  // this phone cannot keep playing a private, unsynced version of the hand.
  G.state = match.state;
  onlinePushing = false;
  pollErrors = 3;
  setConfirmedStateCold(G.state);
  showOnlineTruth();
  onPollError(lastError);
}

async function onlineRematch() {
  if (!online || onlinePushing) return;
  const again = $('againBtn');
  again.disabled = true;
  onlinePushing = true;
  clearTimeout(gameOverTimer);
  clearPresentation();
  resolutionKey = '';
  const fresh = createInitialState({
    numPlayers: G.state.numPlayers,
    seed: newSeed(),
  });
  G.state = fresh;
  show('game');
  render();
  await pushOnline(fresh);
  again.disabled = false;
}

/* ------------------------------------------------------------- leaderboard */
// Monthly board for vs-Champ wins only. Score = cards Champ was still
// holding when you went out (a bigger stranded hand = a more crushing win),
// clamped to 1..999. There is only one bot, so no difficulty bonus.

const lbBox = $('lb');
const lbList = $('lbList');
const lbStatusEl = $('lbStatus');
const lbForm = $('lbForm');
const lbNameInput = $('lbNameInput');
const lbThisBtn = $('lbThisBtn');
const lbLastBtn = $('lbLastBtn');
const lbRenameBtn = $('lbRenameBtn');
let lbMonthOffset = 0;

if (lbEnabled()) {
  lbThisBtn.textContent = `🏆 ${monthLabel(0)}`;
  lbLastBtn.textContent = monthLabel(-1);
}

function resetLbPanel() {
  lbBox.classList.add('hidden');
  lbForm.classList.add('hidden');
  lbForm.dataset.pendingScore = '';
}

function botWinScore() {
  return Math.max(1, Math.min(999, G.state.hands[BOT].length));
}

function lbScoreLabel(s) {
  return `🃏 +${s} card${s === 1 ? '' : 's'}`;
}

// score > 0 submits a fresh win; score 0 just shows the standings read-only
async function updateLeaderboard(score) {
  if (!lbEnabled()) return;
  lbBox.classList.remove('hidden');
  if (score > 0 && !lbGetName()) {
    // first win with no saved name: hold the score until they pick one
    lbForm.classList.remove('hidden');
    lbRenameBtn.classList.add('hidden');
    lbStatusEl.textContent = 'Pick a name to join the monthly leaderboard!';
    lbList.innerHTML = '';
    lbForm.dataset.pendingScore = String(score);
    return;
  }
  if (score > 0) {
    try { await submitScore(score); } catch { /* offline — still show the board */ }
  }
  renderLbBoard();
}

async function renderLbBoard() {
  lbForm.classList.add('hidden');
  lbRenameBtn.classList.remove('hidden');
  lbStatusEl.textContent = 'Loading…';
  try {
    const rows = await fetchTop(lbMonthOffset);
    const me = lbPlayerId();
    lbList.innerHTML = '';
    rows.slice(0, 10).forEach((r, i) => {
      const li = document.createElement('li');
      if (r.player_id === me) li.className = 'me';
      const medal = ['🥇', '🥈', '🥉'][i];
      li.innerHTML = '<span class="rank"></span><span class="nm"></span><span class="sc"></span>';
      li.querySelector('.rank').textContent = medal || `${i + 1}.`;
      li.querySelector('.nm').textContent = r.name;
      li.querySelector('.sc').textContent = lbScoreLabel(r.score);
      lbList.appendChild(li);
    });
    const myRank = rows.findIndex((r) => r.player_id === me);
    lbStatusEl.textContent = rows.length === 0
      ? 'No scores yet this month — be the first!'
      : myRank >= 0 ? `You're #${myRank + 1} of ${rows.length} this month` : '';
  } catch {
    lbStatusEl.textContent = 'Leaderboard unavailable (offline?)';
  }
}

$('lbSaveBtn').addEventListener('click', async () => {
  const name = lbNameInput.value.trim();
  if (!name) { lbNameInput.focus(); return; }
  const pending = Number(lbForm.dataset.pendingScore || 0);
  lbForm.dataset.pendingScore = '';
  try {
    await renamePlayer(name); // saves locally + renames any existing rows
    if (pending > 0) await submitScore(pending);
  } catch { /* offline — the name is still saved locally */ }
  renderLbBoard();
});
lbNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('lbSaveBtn').click();
});
lbRenameBtn.addEventListener('click', () => {
  lbNameInput.value = lbGetName();
  lbForm.classList.remove('hidden');
  lbRenameBtn.classList.add('hidden');
  lbNameInput.focus();
});
lbThisBtn.addEventListener('click', () => {
  lbMonthOffset = 0;
  lbThisBtn.classList.add('sel');
  lbLastBtn.classList.remove('sel');
  renderLbBoard();
});
lbLastBtn.addEventListener('click', () => {
  lbMonthOffset = -1;
  lbLastBtn.classList.add('sel');
  lbThisBtn.classList.remove('sel');
  renderLbBoard();
});

/* ---------------------------------------------------------------- boot */

// the hand layout is measured at render time, so re-lay it on rotate/resize
window.addEventListener('resize', () => {
  if (G && !screens.game.classList.contains('hidden')) render();
});

updateMuteButton();
goMenu();

/* ------------------------------------------------- crew-link invites */
// Text a link instead of reading letters aloud: ?join=ABCD opens the join
// panel with the code filled in, then scrubs the URL so refreshes don't
// re-trigger it. Canonical pattern: four-in-a-rowboat (ROOMS-INTEGRATION §6).

$('inviteBtn').addEventListener('click', async () => {
  const code = ($('lobbyCode').textContent || '').trim();
  if (!code) return;
  const url = `${location.origin}${location.pathname}?join=${code}`;
  const text = `🃏 Deal you in? Eights are wild — tap to join my Crazy Eights game: ${url}`;
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
      await navigator.share({ text });
    } else {
      await navigator.clipboard.writeText(url);
      $('inviteBtn').textContent = '✓ LINK COPIED';
      setTimeout(() => { $('inviteBtn').textContent = '📲 SEND AN INVITE'; }, 1800);
    }
  } catch { /* share sheet closed */ }
});

(() => {
  const code = new URLSearchParams(location.search).get('join');
  if (!code || !/^[A-Za-z0-9]{4}$/.test(code)) return;
  history.replaceState(null, '', location.pathname);
  openPanel('join');
  $('opCode').value = code.toUpperCase();
})();
