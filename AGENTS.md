# Crazy Eights — agent instructions

Shared brain for any AI agent working in this repo (Codex, Claude Code, etc.).
Read `README.md` first for the rules and architecture — this file adds the
rules an agent needs. Stephen is non-technical — explain consequential
changes in plain language.

## What this is

Crazy Eights for Btown Games, Vermont-themed ("the Burlington deck").
Plain static site, **no build step**: `index.html` + `style.css` + ES modules
in `js/`. Deployed by GitHub Pages via `.github/workflows/deploy.yml` on push.
No backend, no accounts, no analytics.

## The one non-negotiable

**Every rule of the game lives in `js/engine.js` and nowhere else.** It's
pure functions over one JSON-serializable state object: `createInitialState`,
`legalMoves`, `applyMove` (returns a NEW state, never mutates), `getStatus`.
It imports nothing and never touches the DOM, timers, `Date`, or
`Math.random` — the shuffle runs on a seeded RNG whose state lives inside
the game state. A game must survive `JSON.stringify` → `JSON.parse` → resume.

Why: online multiplayer gets bolted on later by syncing that exact state
object between phones. Rule logic in `main.js` or `bot.js` silently breaks
that plan. `js/bot.js` may only call the engine's public API; `js/main.js`
is UI only.

## Before you finish

Run `node scripts/test-engine.mjs` — plain Node, no framework, must pass.
If you touched the engine, add assertions for the new behavior. If you
touched the UI, load the game at a phone-sized viewport and play a hand
(vs Champ AND pass-and-play), or clearly say you couldn't and what you
inspected instead. Say what you verified.
