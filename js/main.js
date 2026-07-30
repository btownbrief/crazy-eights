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

let G = null;            // { mode: 'bot' | 'pass' | 'online', state }
let pendingEight = null; // card string waiting on a suit declaration
let handRevealed = true; // pass & play: false until the handoff button is tapped
let botTimer = null;
let online = null;       // { match, myPlayer } while seated in an online crew
let onlinePushing = false;
let pollErrors = 0;
let panelIntent = 'host';
let selectedSeats = 2;
let leaveTimer = null;

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
  return true;
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

  // The shared room carries every hand so each phone can replay the same
  // state, but the honest online UI renders only this phone's seat.
  const handOwner = G.mode === 'bot' ? 0
    : G.mode === 'online' ? online.myPlayer
      : state.currentPlayer;
  $('handLabel').textContent = G.mode === 'bot' || G.mode === 'online'
    ? 'your hand'
    : playerName(handOwner) + "'s hand";
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

  renderMessage(moves, myTurn, mustPass, canDrawNow);
}

function renderMessage(moves, myTurn, mustPass, canDrawNow) {
  const state = G.state;
  const last = state.lastAction;
  let lines = [];

  if (last) {
    const who = esc(playerName(last.player));
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
      lines.push(`${G.mode === 'pass' ? esc(playerName(state.currentPlayer)) + ': m' : 'M'}atch ${suitSpan(state.currentSuit)} or ${rank} — or go wild with an 8.`);
    }
  } else if (lines.length === 0) {
    lines.push(G.mode === 'online'
      ? `Waiting on ${esc(playerName(state.currentPlayer))}…`
      : 'Champ is thinking…');
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
  if (G.mode === 'online') onlinePushing = true;
  G.state = applyMove(G.state, move);
  save();
  const movedState = G.state;

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
  if (G.mode === 'online') pushOnline(movedState);

  const status = getStatus(G.state);
  if (status.status !== 'active') {
    setTimeout(() => {
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
  } catch {
    clearSession(GAME);
    refreshRejoin();
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
  online = { match, myPlayer: match.seat };
  onlinePushing = false;
  pollErrors = 0;
  G = { mode: 'online', state: match.state };
  handRevealed = true;
  pendingEight = null;
  $('suitPicker').classList.add('hidden');
  onlinePanel.classList.add('hidden');
  lobbyEl.classList.add('hidden');
  showOnlineTruth({ dealAll: true });
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

// Online diffs can include draws, reshuffles, wild declarations, conflict
// truth, or a fresh rematch. Repainting cold is deliberately safer than
// guessing at an animation from hidden opponent cards.
function showOnlineTruth(fx = {}) {
  const status = getStatus(G.state);
  if (status.status === 'active') {
    show('game');
    render(fx);
  } else {
    render();
    showGameOver(status);
  }
}

function onRemoteState(newState) {
  if (!online) return;
  G.state = newState;
  onlinePushing = false;
  pendingEight = null;
  $('suitPicker').classList.add('hidden');
  showOnlineTruth();
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
  $('go-title').textContent = 'CREW MEMBER LEFT';
  $('go-line').textContent = `${name || 'A player'} stepped away, so this hand is over.`;
  $('againBtn').classList.add('hidden');
  show('gameover');
}

function onPollError(err) {
  if (!online) return;
  if (err && err.code === 'not_found') {
    online.match.stop();
    clearSession(GAME);
    online = null;
    onlinePushing = false;
    show('menu');
    refreshRejoin();
    return;
  }
  pollErrors++;
  if (pollErrors >= 3 && getStatus(G.state).status === 'active') {
    $('msg').textContent = 'CHOPPY CONNECTION — HANG TIGHT…';
  }
}

async function pushOnline(nextState) {
  const match = online && online.match;
  if (!match) return;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await match.push(nextState, { over: getStatus(nextState).status !== 'active' });
      if (!online || online.match !== match) return;
      pollErrors = 0;
      onlinePushing = false;
      if (G.state === nextState && getStatus(G.state).status === 'active') render();
      return;
    } catch (err) {
      lastError = err;
      if (err && err.code === 'version_conflict') {
        if (!online || online.match !== match) return;
        G.state = match.state;
        onlinePushing = false;
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
  showOnlineTruth();
  onPollError(lastError);
}

async function onlineRematch() {
  if (!online || onlinePushing) return;
  const again = $('againBtn');
  again.disabled = true;
  onlinePushing = true;
  const fresh = createInitialState({
    numPlayers: G.state.numPlayers,
    seed: newSeed(),
  });
  G.state = fresh;
  show('game');
  render({ dealAll: true });
  await pushOnline(fresh);
  again.disabled = false;
}

/* ---------------------------------------------------------------- boot */

// the hand layout is measured at render time, so re-lay it on rotate/resize
window.addEventListener('resize', () => {
  if (G && !screens.game.classList.contains('hidden')) render();
});

goMenu();
