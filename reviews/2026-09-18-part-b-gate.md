# JackiOh review — 2026-09-18 — 3c46a8a

Scope: Part B (implementation audit; gate requested for M1–M8, the whole build to date)
Verdict: **FAIL**

BLOCKER ids: B-1, B-2, B-3, B-4, B-5, B-6, B-7

## Conditions of this run

REVIEW B0 says "run everything from a clean checkout". That was not possible: roughly a dozen
agents were editing this tree while the audit ran. `git status --porcelain` showed 20 modified
files against HEAD `3c46a8a`, and `SPEC.md`, `BUILD.md` and several source files changed *during*
the audit. Every finding below was re-observed between 03:45 and 03:55 on 2026-09-18 against the
working tree, and every test result was reproduced at least twice. Three findings carried in from
the earlier pass were **withdrawn** because the tree fixed them mid-audit (see "Withdrawn during
this run"), and two red results were traced to an agent's in-flight edit and are recorded as
conditions rather than scored as defects.

## Milestone verdicts

| Milestone | Can it be called done? | Why |
| --- | --- | --- |
| M1 | **No** — the earlier PASS (`reviews/2026-09-17-m1.md`) does not hold | M1-T1 requires `GameState` "exactly as §10.1"; `declaredAttack` is absent (B-1). Everything else in M1 checks out: purity greps clean, replay and fuzz green. |
| M2 | **No** (was already FAIL-MAJOR) | §4.2 step 4's trap window does not exist (B-1); §4.5 step 3 Death hooks are not resumable (B-7). |
| M3 | **No** (was already FAIL) | Two §11 rulings are unimplemented inside a describe labelled "(M3 gate)": R133 (B-5) and R136 (B-6). M3-T5's Lunar Eclipse acceptance is red (B-4). |
| M4 | **No** | The M4-T3 gate script `missing-tests.ts` exits 1 (B-3); the cards project is red with 10 failures across 7 files (B-9); #88's six must-pass clauses are all `it.todo` (B-10). The M4 fuzz gate itself is genuinely green. |
| M5 | **Yes on the evidence I have** | `vitest run --project web` is 14 files / 308 tests green, including `animations.test.ts`. The two animation findings from the earlier pass were fixed during this audit. One MINOR (B-17) and one MINOR (B-20) remain, neither gate-blocking. Reduced-motion and the production `__jackioh` grep were not re-verified (see Not verified). |
| M6 | **No** | The server never registers the card catalog, so no real match can start (B-2). M6-T1's constant-time acceptance test does not exist (B-11). |
| M7 | **No** | §9.8's per-account API rate limit is not implemented (B-12). |
| M8 | **No** | `POST /api/rooms` discards the seed specs 05 and 06 send, so two of twelve specs run unseeded (B-13), against BUILD M8's "Every spec sets a seed" and SPEC §11 R143. I did not run the suite headless myself (see Not verified). |

## Findings

| ID | Severity | Location (file:line or SPEC §) | Expected (SPEC §) | Observed | Evidence |
| --- | --- | --- | --- | --- | --- |
| B-1 | BLOCKER | `packages/engine/src/state.ts` (GameState), `packages/engine/src/combat.ts:308-323` | §10.1 field `declaredAttack: DeclaredAttack \| null`; §4.2 step 4 opens a trap window between declaration and damage; §6.3 "Cancel an attack"; R44 | The field does not exist and `declareAttack` resolves combat on the next line, so the window never opens, `cancelAttack` is permanently inert and #96 My Pawn's trap body is `run: () => []` | `grep -c declaredAttack packages/engine/src/state.ts` → `0`, against `SPEC.md:601`. `combat.ts:312-320` pushes `attackDeclared` then calls `resolveCombat` with no trap dispatch. `effects/combat.ts:150` is a comment headed "ENGINE GAP". `effects-combat.test.ts:349` is `it.fails`; run reports "10 passed \| 1 expected fail". `096-my-pawn.ts:118` is `run: () => [],` and its five must-pass clauses are `it.todo` at test lines 191/197/202/208/213. |
| B-2 | BLOCKER | `apps/server/src/match/registry.ts:71`, `apps/server/src/match/engine.real.ts` | §9.2 puts the catalog and card scripts behind the match actor; BUILD M6-T4 "two WebSocket clients complete a scripted game" | `createGame({ seed, decks })` is called with no catalog and nothing in `apps/server` calls `registerAll()`, so `registeredCatalog()` is `{}` and every match throws on the deck's first card | `grep -rn registerAll apps/server/src` → no hits (`apps/web/src/game/engine.real.ts:26` does call it). `state.ts:315-319`: `createGame` validates against `registeredCatalog()` and throws `"core-001" is not in the catalog (§9.4 L6)`. Server tests miss it because they inject `apps/server/test/fakes/engine.ts`. |
| B-3 | BLOCKER | `packages/cards/test/` (no `051-kys-private-tutor.test.ts`) | BUILD M4-T3 acceptance: the missing-test script "prints nothing"; CLAUDE.md rule 6, one test file per card | The gate script names #51 and exits 1; no test anywhere exercises the card | `pnpm exec tsx packages/cards/scripts/missing-tests.ts` → `core-051  KY's Private Tutor  ->  test/051-kys-private-tutor.test.ts`, `EXIT=1`. Test-file count is 108, not REVIEW B3.2's 109. The script itself is complete (13 KB, registered in `_generated.ts`), so none of BUILD M4-T4 row 51's clauses is covered. |
| B-4 | BLOCKER | `packages/cards/src/scripts/035-lunar-eclipse.ts:56`; `packages/engine/src/playSteps.ts:258` | SPEC §8 row 35 "the next Spell you play this turn costs 1 less", Engine cell "consumed on use or at cleanup"; BUILD M3-T5 and M4-T4 row 35 | The discount carries `expiry: { until: "thisTurn" }`, the only consumer skips anything that is not `{ until: "used" }`, and `oncePerTurn` is read by no source file — so every Spell that turn is cheaper | `035-lunar-eclipse.ts:54-56`: `oncePerTurn: true,` … `expiry: { until: "thisTurn", turn: ctx.state.turn }`. `playSteps.ts:258`: `if (mod.kind !== "costDiscount" \|\| mod.expiry.until !== "used") continue;`. `grep -rn oncePerTurn packages/engine/src packages/cards/src` → only the type at `state.ts:72` and the card's own comments. Test fails on three runs: "only the NEXT Spell is cheaper, not every Spell this turn — p1 should have 2 mana but has 3 of 4". |
| B-5 | BLOCKER | `packages/engine/src/subsystems/comboIndex.ts:83-88` | SPEC §11 R133: "the pool is the set of cards played, not the list of plays" | `playedCardsThisTurn` flatMaps `turnLog.playedIds` with no de-duplication, and its only consumer (`stepE`, line 166) feeds that list straight to `ctx.rng.pick` | `vitest run --project engine packages/engine/test/rulings-c.test.ts` → `× R133 …` `AssertionError: expected [ 'c41', 'c42', 'c41' ] to deeply equal [ 'c41', 'c42' ]` at `test/rulings-c.test.ts:2047`, reproduced twice, inside the describe "SPEC §11 R131–R136 … (M3 gate)". Reachable in play: only `counter` (`effects/move.ts:313`) ever removes an id, so a bounce-and-replay double-counts. |
| B-6 | BLOCKER | `packages/engine/src/script.ts` (EffectContext), manifesting at `packages/engine/src/effects/combat.ts:84-88` | SPEC §11 R136: a card reads only its own script's events; "The context therefore records where the script's events begin" | There is no per-script window at all: `freshlySummoned` scans `ctx.events`, the sink list for the whole action | `combat.ts:84-88` is `new Set(ctx.events.flatMap(…))`; the doc comment at 79-83 says so outright ("reported, not faked here"). Grep for any window field (`eventStart`/`eventsSince`/`windowStart`) across `packages/engine/src` → no hits. `rulings-c.test.ts:2131` fails on three runs with `expected [ { type: 'attackDeclared', … } ] to deeply equal []`. |
| B-7 | BLOCKER | `packages/engine/src/stateCheck.ts:137`; same pattern at `packages/engine/src/resolve.ts:155` | SPEC §9.3: a choice made by a triggered effect "sets `state.pending` and returns"; §4.5 step 3; R113 (a sequence is never dropped in silence) | §4.5 step 3's Death hooks and a cast's Cry run through the non-resumable `resolve.runHook`, so a hook that opens a prompt has the rest of its effect list applied over the open prompt, nothing is parked on `state.work`, and a second dying unit's prompt is silently discarded | `stateCheck.ts:137` `runHook(sink, …, "death")` inside the `for (const unit of dying)` loop; `grep -n "paused\|pending\|work" packages/engine/src/stateCheck.ts` → no matches. `runHook` → `applyEffects` is a bare effect loop, unlike `prompts.applyResumable`. The play pipeline and queued triggers already use `runHookResumable` (`playSteps.ts:298/439/563`, `triggers.ts:462`); only these two paths do not. `work.ts:4` names "the Death hooks of §4.5 step 3" as a sequence that must be resumable. Executed probe: two prompting Death hooks gave `marks: ["ask","tail-ran","ask","tail-ran"] / work owed: []` with one prompt opened. **Caveat:** no Core card's Death hook prompts today (#3, #22, #81, #86 use `summon`/`fillBoard`/`setRadiant`/`stealAll`), so the Death half is latent; the identical `runHook` at `resolve.ts:155` is a cast's Cry, which is reachable through Call to Chaos and cast-on-draw. |
| B-8 | MAJOR | `packages/cards/test/088-twisting-nether.test.ts:45,80,94,133,160,174` | BUILD M4-T4 row 88 (every permanent destroyed, Indestructibles survive, radiant enemy-only mode); REVIEW B3.3 | All six must-pass clauses are `it.todo`, each ending "blocked on `destroyAll`" — a blocker that no longer holds. The card has zero executing behaviour tests | `grep -c it.todo` → 7. `088-twisting-nether.ts:29` imports `destroyAll` and line 60 calls it; `effects/destroy.ts:44` defines it and `effects/index.ts:59` re-exports it, and #2, #17, #43 test the same verb green. |
| B-9 | MAJOR | `packages/cards/test/` | BUILD M4-T4: "a wave is done when every card in it passes its tests" | The cards project is red: 10 failures across 7 files, stable over two full runs | `./node_modules/.bin/vitest run --project cards` → `Test Files 7 failed \| 103 passed (110)`, `Tests 10 failed \| 1330 passed \| 1 expected fail \| 15 todo (1356)`. Failing: `031` (R67/R78 returned copy costs 2), `035` (B-4), `050` ×2 (R76 steal after death), `051-1` (§2.4 empty library / token counts as played), `056` (§4.1 Rush), `078` ×3 (R62 hand exile, R65 X-cost ×2), `079` (R30). `035` has its own finding; `078`'s R65 pair fail with "Adaptive UI needs 1 target for that choice", a fixture error; the rest I did not root-cause individually. |
| B-10 | MAJOR | `apps/server/test/api/codes.test.ts:413-440` | BUILD M6-T1 acceptance: "timing test shows the three failure responses within 5 ms of each other over 50 samples"; SPEC §9.4, R107 | The constant-time floor is implemented (`padTo`, `REDEMPTION_RESPONSE_FLOOR_MS`) and the identical-*body* test exists, but no vitest test measures elapsed time | `grep -rn "5 ms\|toBeLessThan\|duration\|elapsed" apps/server/test/api/codes.test.ts` → no hits; the §9.4 test asserts only `new Set(statuses).size` and `new Set(bodies).size`. Three files forward-reference the missing test: `test/fakes/deps.ts:259`, `e2e/…/10-invite-gate.cy.ts:70`, `packages/engine/test/rulings.test.ts` ("M6-T1's 5 ms timing test proves it at the server level"). `10-invite-gate.cy.ts` does time responses, but at 3 samples and a 100 ms bound, 20× looser. |
| B-11 | MAJOR | `apps/server/src/api/deps.ts:62`; `apps/server/src/api/http.ts` | SPEC §9.8 "Per-match rate limit in the actor, per-account rate limit at the API"; R109 "300 requests per minute per account" | The per-match half is implemented and tested; the per-account half is not. `floodLimits` is exported and consumed by nothing, and `createRouter` has a `rate_limited: 429` mapping but no counter, window or 429 path | `grep -rn floodLimits apps/server/src apps/server/test` → exactly one hit, its own declaration at `deps.ts:62`. `API_REQUESTS_PER_MINUTE` is defined, re-exported, copied into `floodLimits`, asserted as a value in `rulings.test.ts`, and never enforced. |
| B-12 | MAJOR | `apps/server/src/match/rooms.ts:166` | SPEC §11 R143: in end-to-end mode "the room and queue endpoints accept an optional seed and use it verbatim … and outside that mode the field is rejected"; BUILD M8 "Every spec sets a seed" | `POST /api/rooms` reads only `deckIndex` from the body and mints its own seed, so specs 05 and 06 run unseeded; neither half of R143 is implemented for rooms | `grep -n seed apps/server/src/match/rooms.ts` → one line, `166: seed: deps.ids.seed(),`. `e2e/…/05-reconnect.cy.ts:305` and `06-room-code.cy.ts:226` both post `body: { deckIndex: 0, seed }`. `apps/server/src/api/queue.ts` implements both halves of R143 (`seedOverrideOf`, `takeSeedForPair`); rooms implements neither. |
| B-13 | MINOR | `SPEC.md` §11 R155 (uncommitted); `packages/engine/test/rulings.test.ts` | BUILD line 10 and line 548, M3 gate line 269: one `it("R<n> …")` per §11 row; CLAUDE.md rule 3 ("append a new R-row … and name the test after it") | R155 was appended to SPEC.md in the working tree with no test, so the index-completeness test is red | REVIEW B4's grep yields 154 distinct ids; `comm` against the 155 §11 rows prints only `155`. `vitest run --project engine packages/engine/test/rulings.test.ts` → `1 failed \| 155 passed`, the diff showing only `- 155`. **Scored MINOR, not MAJOR, because it is not a standing gap:** at HEAD `3c46a8a` ("all 154 rulings indexed") the index is complete, and `git show HEAD:SPEC.md \| grep -c "^\| R"` → 154 against 155 in the worktree. The earlier pass reported R137–R152 missing; that was closed during this audit. |
| B-14 | MINOR | `packages/engine/src/config.ts:27-35` | BUILD §1: rows marked "decide" "live behind named constants … so a designer can flip them in one line"; BUILD M3-T2 "`CRY_ON_PLAY_ONLY` makes `summon` never fire `cry`" | Four of the seven decide constants are dead exports: `CRY_ON_PLAY_ONLY`, `ROTATION_RING`, `GENN_GREED_EXILES`, `FIENDER_STATS_MODE`. The rules they name are hard-coded; the behaviour itself is correct | Grep outside `config.ts` across `packages/engine/src`, `packages/cards/src`, `apps`: 0, 0, 1, 1 hits, and the two are prose comments (`094-genns-greed.ts:8`, `092-felinor-fiender.ts:20`). The other three are genuinely wired (`LANE_RESTRICTED_ATTACKS` at `combat.ts:158`, `TURN_CAP_PLAYER_TURNS` at `turn.ts:404`, `HAND_CAP` at `draw.ts:52`). |
| B-15 | MINOR | `packages/engine/src/effects/` | REVIEW B2 §6 row: "`ls packages/engine/src/effects` lists every verb"; BUILD M3-T1 "one per §6.3 row that changes state" | 29 grouped files, not one per verb. `exile`, `bounce`, `discard`, `counter`, `recruit`, `discover`, `lock`, `plague`, `sacrifice`, `vanilla`, `switchPosition`, `fillBoard`, `grantKeyword`, `setCostMod`, `setCostOverride`, `gainMana`, `nextTurnMana` have no file of their own. Layout only — every verb is an exported factory | `ls packages/engine/src/effects` → `addToHand buff choose coins combat cost counters damage delay destroy draw fuse heal index library loseHealth mana memory move playerMods position radiant rotate shuffleInto steal summon swap targets transform`. Cheapest correct fix is amending BUILD M3-T1 and REVIEW B2 rather than a 36-file refactor. |
| B-16 | MINOR | `packages/cards/src/scripts/033-unstable-clone-machine.ts:23,46`; `041-sheepish.ts:61`; `096-my-pawn.ts:31` | CLAUDE.md rule 3; REVIEW §0 ("MINOR = wording, numbering, cross-reference") | Three scripts cite "proposed R82" / "proposed R91" for rulings that §11 has since assigned to R119, R120 and R121; R82 is "Automatic turn end" and R91 is "Switching to the position a unit already holds" | The comments are verbatim as cited. The rulings exist and are tested under the right ids (`033-…test.ts:109` names R119, `041-sheepish.test.ts` names R120, `096-my-pawn.test.ts` names R121) — only the prose points at the wrong row. |
| B-17 | MINOR | `apps/web/src/game/decks.ts:16-23,107-108` | SPEC §2.6 L2/L3; BUILD M6-T3's shared-validator requirement | The dev hotseat deck builder re-declares `DECK_SIZE = 20` and `MAX_COPIES = 1` and checks deck size itself, on a stated rationale — "`packages/engine` does not compile yet … Drop these the day `@jackioh/engine` typechecks" — that is no longer true | `./node_modules/.bin/tsc -p packages/engine/tsconfig.json --noEmit` → `EXIT=0`, 0 lines. `apps/web` already imports `@jackioh/validator` in the sibling `game/deckbuilder/loadout.ts`, which re-exports the real constants. Risk is silent divergence only: `createGame`/`validateDeck` remain the authority. |
| B-18 | MINOR | `apps/server/tsconfig.json:10-18` | BUILD §5 Definition of done: `pnpm typecheck` green over the tree | `src/match/engine.real.ts` — the only file in `apps/server` that imports `@jackioh/engine` — is excluded from the only tsconfig that covers `apps/server`, on a stated condition that has fired | The exclusion's own comment: "Delete this entry … the day `pnpm exec tsc -p packages/engine/tsconfig.json` is green", and that command exits 0 with no output. The root `tsconfig.json` includes only `packages/*`, so nothing else compiles the file. `apps/web/tsconfig.json` already dropped the identical exclusion. |
| B-19 | MINOR | `apps/server/test/sql/01_schema_invariants.sql:88` | SPEC §9.1 trust model; §9.4; BUILD M6-T2 | CHECK 12 issues `set local role authenticated;` outside a transaction block, so Postgres ignores it: the check runs as superuser with RLS bypassed, prints 2 profile rows, and has no `raise`, so it passes vacuously | Observed in a throwaway Postgres 16: `WARNING:  SET LOCAL can only be used in transaction blocks`, then `own_profile_rows` → `2`. RLS itself is fine — `02_rls_as_client.sql` wraps the same probes in a transaction and reports `profiles_visible 1`, plus five `OK: … refused` lines. Harness defect, not a schema defect; the suite is not part of `pnpm test` (`run.sh:5`). |
| B-20 | MINOR | `e2e/cypress/e2e/07-my-pawn-ai.cy.ts:43`, `08-turn-cap-draw.cy.ts:30`, `11-radiant.cy.ts:32`, `12-rotation-and-swaps.cy.ts:42` | REVIEW §0: a claim is not evidence | Four spec headers state as current fact that the client registers no catalog, that `/dev/hotseat` rejects every fixture deck with "(§9.4 L6)", and that `window.__jackioh` is never exposed, so "Every hotseat spec fails in `cy.seedGame`". All three are false, and a reviewer reading them would wrongly write off real failures | `apps/web/src/game/engine.real.ts:16,26` imports and calls `registerAll()`. `node e2e/scripts/check-fixtures.mjs` → "28 deck fixture(s) OK". `packages/engine/src/index.ts` exports all 27 modules the companion note in `routes/dev/hotseat.tsx:10-12` calls missing, `viewFor` included. |
| B-21 | MINOR | `packages/engine/test/fixtures/harness.ts:85,88-95` | SPEC §11 R84: "The skipped set is a named constant (`AI_SKIPPED_ACTIONS`), and the engine's own random-game harness and fuzz runs use the same one" | The harness that `hotseat.smoke.test.ts` and `replay.test.ts` run through hard-codes the three skipped action types and re-implements the §10.7 policy inline, instead of importing from `subsystems/aiPolicy` | `harness.ts:85`: `(action) => action.type !== "concede" && action.type !== "offerDraw" && action.type !== "answerDraw",`; its import list pulls only `AI_END_TURN_PROBABILITY, DECK_SIZE`. `packages/cards/test/fuzz.test.ts` calls `subsystems.chooseAction`. No behavioural divergence today — the two copies consume identical rng sequences — but the replay-parity gate measures a second, unversioned copy of the policy. |

### One-line fixes

- **B-1** Add `declaredAttack` to `GameState`, set it in `declareAttack`, run `traps.fireTrapsFor` before `resolveCombat`, and clear it after; `cancelAttack` and #96 then work unchanged.
- **B-2** Call `registerAll()` from `@jackioh/cards` inside `apps/server/src/match/engine.real.ts` (it registers the scripts too; passing `deps.catalog.defs` alone would not).
- **B-3** Write `packages/cards/test/051-kys-private-tutor.test.ts` covering BUILD M4-T4 row 51.
- **B-4** Give the discount an expiry shape that means "consumed on use or at cleanup" — either widen `consumeUsedDiscounts`' predicate at `playSteps.ts:258` to include `oncePerTurn`, or add the tag and make `expireModifiers` take it at cleanup.
- **B-5** De-duplicate by instance id in `playedCardsThisTurn`.
- **B-6** Record the sink's length on `EffectContext` when a script starts and slice from it in `freshlySummoned`.
- **B-7** Make `stateCheck`'s death loop a resumable sequence — park the remaining dying units on `state.work` and call `runHookResumable` — and do the same for `castCard`'s Cry at `resolve.ts:155`.
- **B-8** Delete the six `it.todo`s and write the assertions; the verb they name has landed.
- **B-10** Add the 50-sample timing test; `codeDeps()` already runs real timers with `redeemConstantMs: 20`.
- **B-11** Consume `floodLimits` in a per-account counter in `createRouter` and return the 429 the mapping already declares.
- **B-12** Have `rooms.ts` read an optional `seed` under `deps.e2e` and reject it otherwise, as `queue.ts` already does.

## Coverage of checks

| Check | Result | Evidence |
| --- | --- | --- |
| B0 `pnpm lint` | **fail (not scored)** | `./node_modules/.bin/eslint .` → `EXIT=1`, 1 error: `apps/web/src/game/Prompt.tsx:264 no-constant-binary-expression`. The line reads `const inHand = false && isHandPick(need, view); // TEMP EXPERIMENT` and the file's mtime was 03:47, one minute before the run — an agent's live scratch edit, not a defect of the build. Recorded, not filed. |
| B0 `pnpm typecheck` (root, the only one covering tests) | pass | `./node_modules/.bin/tsc -p tsconfig.json --noEmit` → `EXIT=0`, 0 lines of output. `tsc -p packages/engine/tsconfig.json` also exits 0. |
| B0 `pnpm test` | **fail** | engine `4 failed \| 1058 passed \| 2 expected fail`; cards `10 failed \| 1330 passed \| 1 expected fail \| 15 todo`; web `308 passed`; server `149 passed`; validator+shared `27 passed`. |
| B0 `pnpm test:coverage` | not run | see Not verified |
| B0 `pnpm test:e2e` | not run | see Not verified |
| B1.1 Reducer purity | pass | `grep -rn "Math.random\|Date.now\|new Date\|fetch(\|from \"fs\|setTimeout" packages/engine/src packages/cards/src` → 4 hits, all prose comments naming the ban. |
| B1.2 Seeded RNG | pass | `pnpm fuzz` → "seeds 1..1000: 1000 passed, 0 failed / 0 throw(s), 0 over the 15000-action bound or stalled, 0 replay mismatch(es)". |
| B1.3 Prompts are state | **fail** | B-7: two hook paths apply effects over an open prompt and park nothing on `state.work`. |
| B1.4 Nonce dedupe | pass (not re-run in isolation) | Covered by the green engine suite; no failure in that area. |
| B1.5 Illegal actions / no client rule logic | pass | `grep -rn "canAttack\|isLegal" apps/web/src` finds only `Card.tsx`'s `isLegal(highlight, testId)` highlight helper and its callers; no legality computation. |
| B1.6 Hidden information | pass (as far as run) | `viewFor.ts:332` redacts `trapFired` to `HIDDEN_ID` for the non-controller; engine view tests green. The M6-T4 protocol test was not exercised against a live socket. |
| B1.7 Effects only | pass | `grep -rn "state.players\|\.hand\.push\|\.graveyard\.push" packages/cards/src` → 2 hits, both comments asserting the grep is clean. |
| B2 §2.1–§2.6, §3 | pass | Engine suites for setup, turn loop, mana, draw, end and zones are green (67 engine files, 1058 passing). |
| B2 §4.1–§4.2 | **fail** | B-1: step 4's trap window does not exist. Cards-side §4.1 Rush is red (`056-jilliax`, B-9). |
| B2 §4.4 Pipeline | pass at engine level | Ten ordered step tests green; one cards-level Lifesteal/Rush case red under B-9. |
| B2 §4.5 State check | **fail** | B-7. |
| B2 §5 Catalog, §5.2 Radiant | pass | `catalog.test.ts` and the radiant tests green. |
| B2 §6 Keywords | **fail on the literal check** | B-15: the effects directory is grouped, not one file per verb. Behaviour complete. |
| B2 §6.2 Triggers | partial | Ordering and trap tests green; B-14 records that `CRY_ON_PLAY_ONLY` is never read. |
| B2 §7 Tokens | pass | Token tests green; the three card-defined tokens are covered inside their generators' files. |
| B3.1 missing-tests prints nothing | **fail** | B-3, `EXIT=1`. |
| B3.2 109 test files | **fail** | `ls packages/cards/test/*.test.ts \| grep -v catalog \| grep -v _harness \| wc -l` → 108. |
| B3.3 must-pass clauses as distinct `it()` | **fail** | B-8 (#88, six clauses `it.todo`), plus #96's five `it.todo` rows under B-1. |
| B3.4 implementation vs §8 row | **fail** | B-4 (#35). |
| B3.5 Subsystems | partial | Each named subsystem has a test file; `comboIndex` fails its own ruling (B-5). |
| B4 every §11 row has a named test | **fail (marginal)** | B-13: 154 of 155; complete at HEAD, one uncommitted row short in the worktree. |
| B4 "decide" rows are named constants | partial | All seven exist in `config.ts` with the spec's values; four are read by nothing (B-14). |
| B4 inverse (rulings in comments) | **fail** | B-16: three scripts cite superseded ids. |
| B5.1 animations | pass | `vitest run --project web` → 14 files / 308 tests green, `animations.test.ts` included; `toHaveLength(41)` matches the 41 `GAME_EVENT_TYPES`, and `@keyframes jk-card-resolved` is present in `animations.css`. Both were red at the start of this audit. |
| B5.2 prompt kinds | pass | `Prompt.test.tsx` 23/23; six kinds assert a submitted `answer`, the other four assert the exact `play` body per SPEC §10.6 and R81. |
| B5.3 client enforces no rules | pass, one MINOR | B1.5 clean; B-17 records duplicated §2.6 constants in the dev hotseat builder. |
| B6 invite redemption | **fail** | B-10 (timing test absent). Body-identity, the 250 ms floor and the step tests exist and pass. |
| B6 collection / validator | pass | Server suite 149/149; `apps/web` and `apps/server` both import `@jackioh/validator`; `loadout_card_unique` is enforced in migration `0003_loadouts.sql`. |
| B6 match actor | **fail** | B-2 (no catalog registered), B-12 (rooms discards the seed). |
| B6 abuse surface | **fail** | B-11 (per-account limit absent). |
| B7 twelve specs exist, no `cy.wait(n)` | pass | All twelve files present under `e2e/cypress/e2e/`; `grep -rn "cy.wait([0-9]" e2e/` → 0. |
| B7 specs pass headless | not verified | see Not verified. |
| B8 determinism and fuzz | pass | 1,000 seeds, 0 throws, 0 mismatches, 0 over the cap. One MINOR: B-21, the harness does not share `AI_SKIPPED_ACTIONS`. |

## Withdrawn during this run

Reported by the earlier pass, re-checked here, and **not** findings any more — the tree fixed them
while the audit was running. Recorded so the next reviewer does not chase them:

- **§11 R137–R152 have no named test.** Closed by commit `3c46a8a` ("all 154 rulings indexed").
  Only the uncommitted R155 remains (B-13).
- **`animations.test.ts` asserts 40 rows against 41 event types.** Now `toHaveLength(41)` at
  `animations.test.ts:215`; the web project is green.
- **`animations.css` has no `@keyframes jk-card-resolved`.** Now present (2 occurrences).

## Not verified

- **A clean checkout.** REVIEW B0 requires one. The tree carried 20 modified files and changed
  during the audit; `SPEC.md` and `BUILD.md` are both dirty. Everything above is the working tree
  at 03:45–03:55, not a reproducible build of `3c46a8a`. Re-run this audit on a quiet tree before
  acting on the MINOR findings in particular.
- **`pnpm test:e2e`.** Not run: the suite needs a dev server and a server fixture, and other agents
  were running Cypress concurrently (`e2e/artifacts/screenshots/11-radiant.cy.ts/` gained two
  failure PNGs at 03:48 and 03:49 while I worked). I can therefore neither confirm nor deny BUILD
  M8's "All twelve specs green in CI", and I did not attempt the two-browser requirement.
- **`pnpm test:coverage`.** Not run; BUILD §4's 90% line floor for engine and cards is unverified.
- **`R154 carries the trap's row and lane on trapFired`** is red on two runs
  (`rulings-c.test.ts:2204`, "no trapFired in view") and I deliberately did **not** file it. The
  implementation is correct — `traps.ts:222-230` emits `row` and `lane`, and the test's own
  `Object.keys` assertions on them pass — and the failure is in the second half, which reads
  `viewFor(state, …).events`; `viewFor.ts:417` builds those from `state.applied`, which the
  fixture never commits because it drives `fireTrapsFor` into a bare sink. Test file mtime 03:17,
  `traps.ts` 03:19. That reads as a fixture an agent is still writing, not a defect — but it is red
  right now inside an "(M3 gate)" describe, so someone must finish it.
- **The lint error** at `Prompt.tsx:264` (`// TEMP EXPERIMENT`) is likewise an in-flight edit. If it
  is still there at the next gate it is a BLOCKER on its own under REVIEW B0.
- **Root causes of six of the ten cards failures** (#31, #50 ×2, #51.1, #56, #78 ×3, #79). I
  confirmed they reproduce but did not trace each to a file; three prior skeptics concluded #79's
  is a test-arithmetic error rather than an engine defect, and I did not re-derive that.
- **B1.4 nonce dedupe and B1.6's M6-T4 protocol test** were not exercised in isolation against a
  live socket; I inferred them from green suites, which REVIEW §0 permits only as a named passing
  test, so treat them as unproven.
- **Hotseat `window.__jackioh` absent from a production build** (B5) and **reduced-motion drains a
  full game synchronously** were not checked; no production bundle was built.
