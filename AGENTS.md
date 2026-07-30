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

## Online play (the rooms layer)

`js/rooms.js` is the fleet's vendored online-multiplayer client; its canonical
copy lives in `four-in-a-rowboat`, and this repo must copy it verbatim. It
talks to the shared Supabase rooms backend
(`btownbrief.github.io/supabase/rooms-2026-07-30.sql`): a room is a 4-letter
code plus the entire engine state as opaque JSON plus a version number. After
your move, push the new state with the version you last saw; everyone else
polls. All rules stay in `engine.js` — `rooms.js` knows nothing about any
game. Seat index is engine player index, and the host is seat/player 0. If the
backend SQL is not installed yet, clients get a clean `not_ready` error and
the UI says online play is not switched on.

`scripts/rooms-shim.mjs` is the verbatim canonical local stand-in from
`four-in-a-rowboat`, so the room client and engine are testable offline.
`scripts/test-rooms.mjs` drives the real client, shim referee, and engine
through synchronized two- and three-phone games.

## Before you finish

Run `node scripts/test-engine.mjs` — plain Node, no framework, must pass.
If you touched `rooms.js`, `main.js`'s online section, or the shim, also run
`node scripts/test-rooms.mjs`.
If you touched the engine, add assertions for the new behavior. If you
touched the UI, load the game at a phone-sized viewport and play a hand
(vs Champ AND pass-and-play), or clearly say you couldn't and what you
inspected instead. Say what you verified.
