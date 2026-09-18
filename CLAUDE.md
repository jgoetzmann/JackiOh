# JackiOh — project instructions for Claude Code

JackiOh is a 1v1 card game: Hearthstone-style mana, combat and keywords on Yu-Gi-Oh-style lanes with a hidden trap backrow. Three documents drive all work:

- `SPEC.md` — the master game specification. The only source of rules, cards and engine design. Section references (§) everywhere point here.
- `BUILD.md` — the work order: repo layout, constants, milestones M1–M8 with tasks, files and acceptance criteria, the per-card must-pass table, animations, e2e specs, definition of done.
- `REVIEW.md` — the audit procedure: Part A checks SPEC.md against the source design notes; Part B checks the code against SPEC.md and BUILD.md.

## Rules of engagement

1. Read SPEC.md fully before the first task and re-read the relevant section before each task. Never implement a rule from memory of Hearthstone or Yu-Gi-Oh when SPEC.md states it.
2. Work BUILD.md in order. A task is done when its acceptance items are green tests. Do not open the next milestone until the current gate passes.
3. Rulings live in SPEC §11. If you need a decision the spec does not make, follow Hearthstone semantics, append a new R-row to SPEC §11 in the same PR, and name the test after it (`it("R58 …")`).
4. `packages/engine` and `packages/cards` are pure: no `Math.random`, no `Date`, no I/O, no promises inside `reduce`. Every random draw goes through `rng` in state; every player choice is a `PendingChoice` in state.
5. Card scripts return `Effect[]` from `packages/engine/src/effects`. Never mutate state in a card file.
6. Every card has one script file and one test file covering base and radiant behaviour per the BUILD M4-T4 table.
7. The client sends intent and renders `viewFor`; it never enforces rules and never sees hidden information.
8. Before claiming a milestone is done, run the paste-in prompt at the end of REVIEW.md as a separate session and attach the report.

## Commands

```
pnpm install
pnpm lint          # includes the Math.random / Date ban in engine and cards
pnpm typecheck
pnpm test          # vitest: engine, cards, validator, server
pnpm test:e2e      # cypress against apps/web in E2E mode
pnpm fuzz          # 1,000-seed random-policy games with replay hashing
```
