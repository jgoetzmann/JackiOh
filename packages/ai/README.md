# @jackioh/ai

The computer opponent of practice games (SPEC §9.9). It plays one seat of an ordinary engine game:
it reads a state, returns one `ActionBody`, and the caller reduces it. The design and every
signature below are in `docs/polish/3-ai.md`; this file is the contract other packages rely on.

## Purity

`src/` is pure and seeded, exactly like `packages/engine` and `packages/cards` (CLAUDE.md rule 4),
and ESLint enforces it: no `Math.random`, no `Date`, no timers, `performance`, `process`, `fetch`,
`crypto` or `node:*` imports, and no async code. Every random draw comes from an `Rng` the caller
passes in. The clock only ever arrives as a callback (`AiOptions.shouldStop`, `sweepCard`'s `now`).
Nothing in `src/` recurses.

`src/` never imports `@jackioh/cards`. Callers register the catalog and the card scripts first:
`scripts/` and the web worker call `registerAll()` from `@jackioh/cards`, and so does the `ai` test
project, once, in its setup file (`test/setup.ts`).

Every AI number lives in `src/config.ts` (CLAUDE.md rule 9). The deck-building, match, gate and
sweep numbers live in their own modules' constants (`AI_DECK`, `AI_MATCH`, `AI_GATE`, `AI_SWEEP`).

## `decide` reads only `redact`

`decide(state, seat, options)` is the one entry point. It reads the true `GameState` only through
`aiToAct` and `redact` (R185). `redact` blanks everything the seat may not know: the opponent's hand
and library, the backrow cards it cannot read, the cards in its own library that came from the
opponent's deck, the order of its own library, the seed and the event history. Every simulation runs
on a `determinize`d copy, whose hidden cards are resampled from Core cards the opponent has not shown
and whose seed is the AI's own. So two states that differ only in hidden cards give the same
decision under the same rng, and no simulation can foresee a real draw or a real coin flip.

The AI never concedes and never offers a draw, and it declines every draw offer at once (R188).

The difficulty tiers change the AI seat's resources only (`AI_DIFFICULTY` in the engine's
`config.ts`, R180). Nothing in this package reads a difficulty or a handicap to decide what to do.

## Search and the opponent's reply

`decide` runs an exact lethal solver, then a turn-level beam search on one determinization. Its
best lines are scored one turn deeper, after the opponent's reply (`src/reply.ts`): on the
determinization the opponent plays any card the line itself put in its hand (a Pocket Chaos handed
over, units a Flood bounced), otherwise trades or swings at the face by static trade value, and
ends its turn; the line is scored at the start of the AI's next turn. The opponent never plays a
card it held unseen, because those are samples. The best first actions are scored the same way on
the other determinizations, and the best mean is played. Only that first action is played; the AI
re-plans after it.

## Budgets

A decision's cost is counted in nodes: one node is one `reduce` call the AI makes, in any
determinization, the reply's included. `AI_BUDGET` is what the browser plays with, and
`AI_GATE_BUDGET`, the budget of the quality gates and the sweep, is the same budget, so that both
measure the AI that ships. Because budgets count nodes rather than time, the same state, seed and
budget always give the same `Decision`. The browser adds a wall-clock safety cap through
`shouldStop`, which ends the search early and answers with the best line found. The timing gate
(`test/gate-perf.test.ts`) holds one decision at `AI_BUDGET` under `AI_GATE.maxDecisionMs`.

## Decks and the shadow ban

`buildAiDeck(rng, size, options)` deals `size` distinct non-token Core ids by weighted sampling
without replacement (`AI_DECK`): a mana curve that shifts toward expensive cards as the seat's
`manaCap` rises, a floor on units, an optional tag theme, and a penalty for cards the seat could
never cast. It leaves out `SHADOW_BAN_IDS` unless `banned` says otherwise (`banned: []` for a human's
random deck).

`src/shadowBan.ts` (R186) lists the cards the AI never deals to itself, each with a reason that
starts with the sweep flags that put it there. It is decided by the sweep, never by hand:

```
pnpm ai:sweep                      # every non-token Core card; prints flagged rows, writes nothing
pnpm ai:sweep core-011 core-020    # only these ids
```

For each card, `sweepCard` plays `AI_SWEEP.seedsPerCard` games of an Easy AI whose deck includes the
card against the greedy baseline, and flags:

- `error`: a throw, a refused AI action or a fallback decision.
- `timeout`: a decision slower than `AI_SWEEP.decisionMs`, or a game still running at
  `AI_SWEEP.maxActions`.
- `neverPlayed`: the card sat affordable in hand on at least `AI_SWEEP.minAffordableTurns` turns and
  was never played.
- `selfHarm`: over at least `AI_SWEEP.minHarmPlays` plays, its plays lowered the AI's own
  evaluation by more than `AI_SWEEP.selfHarmDelta` on average.

Copy the printed entries into `SHADOW_BAN` and the printed header line into the file's header. A
later engine or AI change can make the ban stale, so rerun the sweep after one. `timeout` is the one
wall-clock flag: sweep a card it flags again, alone, before banning it, because parallel sweeps on a
busy machine slow every decision down. The unbanned pool
must keep at least `AI_DECK.minPool` cards, so that a 30-card Hard deck can always be built.

## Matches and the quality gates

`playMatch(config, hooks)` plays one whole game between two controllers (`ai`, `greedy` or `random`)
and returns its log, its hash and its bookkeeping: refused actions, throws, fallbacks, decisions and
nodes. It is deterministic: controllers draw from `${seed}:ctl:<seat>` and nonces are `m<n>`, so
`fold({ seed, decks, handicaps, log })` reproduces `record.hash`. `playAiTurn` plays one AI turn out
(nonces `t<n>`), which is what the puzzles use.

The baselines are `randomAction`, SPEC §10.7's random policy, and `greedyAction`, which looks one
action ahead on one determinization.

The gates (`runGate(matchup, seeds)`, `AI_GATE`) are three matchups whose subject alternates seats,
with every game folded back to its hash:

| Matchup | Subject | Opponent | Floor | Full seeds |
|---|---|---|---|---|
| `ai-vs-random` | the AI on Easy | random policy on Easy | 95% | 100 |
| `ai-vs-greedy` | the AI on Easy | greedy baseline on Easy | 70% | 50 |
| `hard-vs-easy` | the AI on Hard | the AI on Easy | 80% | 50 |

`gate-perf.test.ts` is the fourth gate file: every decision of the first ai-vs-greedy gate game (six
under `pnpm ai:gate`), decided again at `AI_BUDGET`, must stay within the node budget and take under
`AI_GATE.maxDecisionMs` (the fastest of `AI_GATE.perfRepeats` runs counts).

```
pnpm vitest run --project ai    # every AI test, gates at AI_GATE.smokeSeeds per matchup
pnpm ai:gate                    # the three gate files at their full seed counts (CI job ai-gate)
```

A failing gate names its losing seeds. `gameConfig(matchup, n)` rebuilds game `n` exactly, so a
tuner can replay it with `playMatch`. Tuning changes the weights in `src/config.ts`, never the
floors or the seed counts. If the full gate outgrows its CI job, shrink `AI_GATE_BUDGET` (it is
the browser's `AI_BUDGET` today) and say so, since the gates then measure a smaller search than the
one that ships.

Two tuning aids live in `scripts/` and write no file: `bench.ts <matchup> <from> <to> [gate|full]`
plays a range of gate games and prints one JSON line each (win, result, turns, nodes, the slowest
decision, whether the log replays), and `trace.ts <matchup> <n> [gate|full]` prints one game turn by
turn. Both take `OVERRIDE_<CONFIG>='{…}'` to try weights without editing `src/config.ts`, and
`BAN=id,id` to try a different shadow ban.
