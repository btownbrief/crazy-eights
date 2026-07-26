# CRAZY EIGHTS 🍁🃏

Crazy Eights on **the Burlington deck** — green-mountain felt, maple card
backs, and eights are wild. Play a hand against **Champ** the lake monster,
or pass the phone around the table with 2–4 players. Part of
[Btown Games](https://play.btownbrief.com), the browser arcade of the
[BTown Brief](https://www.btownbrief.com).

**Play it live:** https://play.btownbrief.com/crazy-eights/

## House rules

- 2 players get 7 cards each; 3–4 players get 5 each. One starter card is
  flipped (never an 8 — it gets shuffled back).
- On your turn, play a card matching the top discard's **rank or suit**.
- **Eights are wild**: play one any time and call the suit everyone must
  match next.
- Can't play? Draw from the stock — up to **3 draws**, then pass.
- Stock runs out? The discard pile (minus its top card) is shuffled into a
  new stock.
- First empty hand wins the round. Single rounds only — no cumulative
  scoring (yet).
- If nobody can move at all, the round is blocked and fewest cards wins,
  so a game can never hang.

## How it works

Plain static site — no build step. `index.html` + `style.css` + ES modules in `js/`:

| file | what it does |
| --- | --- |
| `js/engine.js` | **all** the rules, as pure functions over one JSON-serializable state object (seeded RNG lives in the state — same seed, same deal) |
| `js/bot.js` | Champ's brain — picks among the engine's legal moves (dumps its majority suit, saves 8s for when it's stuck, declares its longest suit) |
| `js/main.js` | UI only: screens, taps, animations, bot pacing, pass-the-phone handoffs, localStorage resume |
| `img/church-street-autumn.jpg` | Church Street under the fall maples (from the where-in-btown photo collection) — dimmed backdrop on the menu and round-over screens |

The engine/UI split is deliberate: online multiplayer later just means
syncing the engine's state object between phones. Rule logic anywhere
outside `engine.js` breaks that plan — see `AGENTS.md`.

Every push to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.

## Testing

```bash
node scripts/test-engine.mjs
```

Plain Node, no framework. Covers legality (rank/suit/8), the
draw-up-to-3-then-pass flow, declared suits after an 8, stock reshuffle,
win/blocked detection, deterministic deals per seed, serialization
round-trips, and a 600-game bot-vs-bot soak.
