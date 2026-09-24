# JackiOh review — 2026-09-23 — 081f5c9 (polish/integration)

Scope: Part B (implementation audit) of the polish pass: `git diff main...HEAD`, where `main` is
`cd780db` (57 commits; 699 files, +129,738 / −3,937). Every check from B0 to B8 that the pass could
affect was run. Checks the pass does not touch were not repeated (see "Not verified").
Verdict: **FAIL**
BLOCKER ids: **B-1**

## Conditions of this run

- Several QA agents were working in this worktree at the same time. I edited no source file. Files
  other agents left untracked (`e2e/cypress/e2e/zz-qa-landing-auth.cy.ts`) are not part of the
  branch and were excluded: specs ran from an explicit `--spec` list, and the greps used `git grep`.
  The load average ran between 4 and 33 during the audit.
- The clients were built into my own directories under the session scratchpad, a dev-mode build
  (`vite build --mode development`) and a production build, never `apps/web/dist`. I served them
  with `vite preview` on port 5563, ran the E2E server (`E2E=1`) on port 8863 and the component dev
  server on port 5565, and kept Cypress output under `e2e/artifacts/part-b-final/`. I stopped every
  server afterwards.
- In the first Chrome run, specs 01 to 12 passed. Specs 13 to 16 then failed with
  `connect ECONNREFUSED ::1:5563` because both of my servers received SIGTERM at about 22:40 from
  outside the run (the server log ends with `Command failed with exit code 143`). I restarted the
  servers and reran specs 13 to 16, which passed 44 of 44. The failure was the environment, not
  the code.
- An earlier Part B pass on this branch, at `5bb2282`, left notes in
  `e2e/artifacts/part-b-audit/notes.md`. I used them for leads only. Unless a row says otherwise,
  every result below comes from my own run at `081f5c9`. Since `5bb2282` the branch has changed
  only `apps/web`, `e2e`, docs and two lines of SPEC §10.1.
- My working notes are in `e2e/artifacts/part-b-final/notes.md` (git-ignored).

## Findings

| ID | Severity | Location (file:line or SPEC §) | Expected (SPEC §) | Observed | Evidence |
| --- | --- | --- | --- | --- | --- |
| B-1 | BLOCKER | `packages/cards/test/turn-clock-and-legality.test.ts:278`; `apps/server/src/match/actor.ts:183`; `apps/web/src/practice/protocol.ts` (`PracticeSnapshot.legal`); SPEC.md:979 (R177, last sentences) | §9.1 (SPEC.md:502): "Hidden: library order, opponent hand, face-down traps". REVIEW B1.6: "Zero leaks." | `legalActions(state, p1)` can name one of p2's face-down traps by the instance id that p1 saw while the card was public. The repro: #72 Reminisce returns #41 Sheepish from p2's graveyard, p2 sets it again, and on p1's turn `legalActions(state, "p1")` (p1 holds #36 Magic Jammed) still contains an action naming that trap's id. Clients receive the same array: online, the match actor sends `legalActions(state, player)` with every view, and practice sends `snapshot.legal` to the page. So a client can read the face-down card. The pass found this gap, pinned it with `it.fails` and recorded it in SPEC as "a known limit, not a ruling". It did not close it. Its design note (`docs/polish/4-edge-cases.md:1451-1459`) says the gap predates the branch and that "The PR should open a tracked issue for it". | `pnpm test` reports `2 expected fail`; one is this `it.fails("R177 known limit: legalActions never names a face-down trap by an id its viewer saw while the card was public")`. `gh issue list --state all` lists only #1 (closed), so no issue tracks the gap. My own probe found no other channel (row B1.6 below). |
| B-2 | MAJOR | `packages/ai/src/gate.ts:37,44,109-114`; SPEC.md:610 (§9.9, Quality gates) | `docs/polish/reference.md:128-131` asks for gates, as tests, of ≥ 95% against random, ≥ 70% against greedy and ≥ 80% for Hard against Easy. §9.9 says: "Until the user accepts this rule, the brief's counts stand as the target". | The gate tests assert `gateNeeded`, which caps each count at the brief's share but lowers it to the 5% false-alarm count of the measured rate (`measuredRate` 0.945 / 0.68 / 0.913). That lowers the random and greedy counts to 17/20 and 10/20 in the smoke run and 91/100 and 28/50 in the full run. No test asserts the brief's gate against greedy, and the AI misses it: 12 of 20 in the smoke run (the brief's share is 14) and 33 of 50 in the full run, where the brief's share is 35. The AI does meet the brief in the other two matchups. SPEC marks the lower rule "Proposed, pending the user's acceptance", so for now the acceptance item is neither tested nor met. | `pnpm test` log: `[gate ai-vs-greedy] 12 wins and 1 turn-cap draws of 20; 10 wins needed`. `pnpm ai:gate` log: `[gate ai-vs-greedy] 33 wins and 3 turn-cap draws of 50; 28 wins needed`, `[gate ai-vs-random] 98 wins and 2 turn-cap draws of 100; 91 wins needed`, `[gate hard-vs-easy] 45 wins and 3 turn-cap draws of 50; 40 wins needed`. |
| B-3 | MINOR | SPEC.md:610 (§9.9, Quality gates, last sentence) | The spec should match the measured behaviour | SPEC says: "this AI does not reach them on the frozen series against random or greedy". On the frozen series (`seedSeries: "gate:v2"`) the AI does reach the brief's share against random. | `[gate ai-vs-random] 20 wins and 0 turn-cap draws of 20` (brief: 19); `pnpm ai:gate`: `[gate ai-vs-random] 98 wins and 2 turn-cap draws of 100` (brief: 95 of 100). |
| B-4 | MINOR | `packages/engine/test/lint-ban.test.ts:20-58` | CLAUDE.md rule 4 now names `packages/ai` as pure, and "ESLint enforces this". BUILD M1-T2 has the ban proved on a fixture. | The config does cover the AI package (`eslint.config.js:7-8`), but the lint-ban test only checks engine and cards paths. No test fails if `packages/ai` drops out of `PURE_PACKAGES`. | `grep -rn "ESLint\|eslint\|Math.random" packages/ai/test packages/ai/src` returns 0 hits. A manual `ESLint.lintText` run with `filePath: packages/ai/src/fixture.ts` reports `no-restricted-properties` (Math.random, Date.now), `no-restricted-globals` (setTimeout) and `no-restricted-syntax` (async), so the ban itself holds today. |
| B-5 | MINOR | `packages/engine/src/config.ts:44-49`; `packages/engine/src/reduce.ts:184-208` | CLAUDE.md rule 9 and BUILD §2 list the rules numbers. R79: `timeout` "ends the turn only when that is the active player" | The new `TIMEOUT_ANSWER_CAP = 500` appears in neither BUILD §2 nor SPEC. Its doc comment says the cap bounds prompts answered "before it ends the turn". The loop does something else: after the 500th answer it falls through to `return null` without calling `endTurn`, so a timeout that hits the cap leaves the turn running. No Core card can reach the cap. | `grep -n TIMEOUT_ANSWER_CAP BUILD.md SPEC.md` returns 0 hits. In `reduce.ts:184-208`, `endTurn(sink)` is reached only when no prompt is pending. |
| B-6 | MINOR | `apps/web/src/game/modeText.ts:20-25`; `apps/web/src/game/Prompt.tsx:351` | §8 #24 (SPEC.md:394), Radiant: "Uses X+1" | The mode picker describes #24's options as "Deal X damage to a target", "Heal a target by twice X" and "Gain half of X". It calls `modeText(source, option)` without the radiant flag, so a Radiant Efficiency Dividend shows X where the card resolves X+1 (`024-efficiency-dividend.ts`, `amountX(ctx, bonus)`). This is presentation only; the rules are not affected. | `MODE_TEXT["core-024"]` has one entry per option and no radiant variant. |
| B-7 | MINOR | `packages/ai/test/gate-perf.test.ts:78,91` | The brief's §3 "Budgets": "Budgets are node-based, so tests are deterministic, with a wall-clock safety cap in the browser" | `pnpm test`, and CI's `ai-gate` job through `pnpm ai:gate`, assert wall-clock time: `ms < AI_GATE.maxDecisionMs` (1500 ms). The result depends on how busy the machine is, not on the code. | In `pnpm ai:gate`, run beside the Electron e2e suite (load 5–10), `a decision on the wide-hard board stays within the node budget and under 1500 ms` failed at 5523 ms. Rerun alone at load 4, the same file passed 3/3. The smoke version passed inside `pnpm test`. The earlier pass on this branch recorded three smoke failures, at 2163, 2753 and 3462 ms under load 100–200 (`e2e/artifacts/part-b-audit/notes.md`). |

## Coverage of checks

| Check | Result | Evidence |
| --- | --- | --- |
| B0 `pnpm install` | pass | `--frozen-lockfile`: "Already up to date", exit 0 |
| B0 `pnpm lint` | pass | exit 0, 6 s |
| B0 `pnpm typecheck` | pass | exit 0; `gen-registry: unchanged src/scripts/_generated.ts (109 script files)` |
| B0 `pnpm test` | pass | exit 0, 299 s: 355 files, 6644 passed, 2 expected fail (B-1's `it.fails` and the older `effects-delay.test.ts:370` GAP R76), 9 todo. The 9 todos are the same ones `main` has. |
| B0 `pnpm test:coverage` | pass | exit 0, 63 s: 217 files, 2988 passed; lines 97.79% (5763/5893), statements 94.13% (floor 90%) |
| B0 `pnpm test:e2e` | pass (in two runs, see Conditions) | Chrome: specs 01–12 passed 36/36 in run 1, and specs 13–16 passed 44/44 in run 2 against restarted servers, so all 16 specs and 80 tests passed. Electron, all 16 in one run: exit 0, 80/80, 7 min 52 s. Component specs on Chrome: exit 0, 9 specs, 168/168. |
| B0 extras | pass | `validate:catalog` OK (100 + 9; 35/37/16/7/5). `missing-tests` exit 0 (4 NOTE lines). `rulings:coverage`: "218 rows, R1–R226, named by a test: 218". `pnpm fuzz` exit 0. `test:sql` exit 0 ("ALL LIFECYCLE CHECKS RAN", 0 FAIL/UNEXPECTED). `test:db` exit 0 (3 files, 80 tests). `gen:voice --check`: "ok, 152 files, 1605283 bytes". `pnpm ai:gate`: exit 1, 425 s. The three win gates passed; the full perf gate failed while the Electron run shared the machine (see B-7). Rerun alone, `JACKIOH_AI_GATE=full vitest run --project ai gate-perf` passed 3/3. |
| B1.1 Reducer purity | pass | The grep over `packages/{engine,cards,ai}/src` returns 4 hits, all comments (`effects/coins.ts:9`, `effects/index.ts:161`, `cards/src/query.ts:52`, `083-transmogulate.ts:40`). `eslint.config.js:7-8` adds `packages/ai` to both pure lists. The missing test is B-4. |
| B1.2 Seeded RNG | pass | `reduce.ts:284,295,304,306` threads `rngCursor`. R223 adds a second stream, `createRng(seed + ":instance-ids" [+ nextId])` (`state.ts:502,541`), which the SPEC sanctions. It is deterministic because `seed` and `nextId` are both in state. The fuzz replays every seed to the same hash. |
| B1.3 Prompts are state | pass | The grep over engine and AI `src` finds comments only. The AI's `shouldStop` is a budget callback passed to `decide`, never into `reduce`. |
| B1.4 Nonce dedupe | pass | The pass changed only the `timeout` answer loop in `reduce.ts`, not the nonce history. `reduce.test.ts:59` ("dedupes a repeated nonce: same state, no duplicate events") is green. |
| B1.5 Illegal actions / no client rules | pass | Besides `engine/config`, only `game/engine.real.ts` and `practice/core.ts` import `@jackioh/engine`, `@jackioh/ai` or `@jackioh/cards`. `isLegal` (`Card.tsx:41`) and `glow.ts` read `Highlight` only. `drag/targets.ts` reads `data-*` from the DOM. `conditionActive` is computed by the engine (`condition.ts`), not the client. |
| B1.6 Hidden information | **fail (B-1)** | Apart from B-1, I ran a probe (`scratchpad/leakprobe2.mts`) over 100 random-policy games with disjoint decks: 9,688 states, 1,820 of them with a p2 face-down card. It searched all of `viewFor(p1)`, events and log included, for any defId from p2's hand, library or face-down backrow that had never been public and that p1 never held. 30 raw hits came from 2 cases, both benign: a card p2 played in view and that was then fused (#85) or transformed in the same action, whose copies sat in p2's library. That leaves 0 leaks. The practice worker sends view, legal, `aiToAct` and error only; `debug` (raw state) is refused unless `env.dev` (`practice/core.ts:266`). A production build contains 0 occurrences of `__jackioh*`. The AI's R185 invariance tests are green (`observe.test.ts:158-368`). `conditionActive` is asked only for the viewer's own cards (`condition.ts:32-36`). |
| B1.7 Effects only | pass | The grep over `packages/cards/src` finds one comment (`076-field-of-dreams.ts:40`). The 27 changed card scripts return `Effect[]` or declare `staticFlags` (#38, #64, #79). |
| B2 §2.1 / §2.3 / §2.4 under a handicap | pass | `mana.ts:9` computes `min(turnsStarted + manaBonus, manaCap) + permMod`, floored at 0 (R181). `setup.ts:31` adds `extraOpeningCards` (R182). `turn.ts:310` draws `DRAWS_PER_TURN + extraDrawsPerTurn` (R183). `AI_DIFFICULTY` (`config.ts`) matches §9.9's table, BUILD §2 and the brief. Tests: 9 named R181, 8 named R182, 11 named R183 and 14 named R184, mostly in `handicap.test.ts`, plus `fuzz-handicap` over 1000 seeds with 0 failed. |
| B2 §2.2 / §2.5 | pass | R211, R216 and R224–R226 each have their named tests, and all are green. The server has no `handicap` path (`git grep handicap apps/server/src` returns 0 hits), so online play is unchanged. |
| B2 §2.6 Deckbuilding | pass | `createGame` still requires `DECK_SIZE` unless a seat carries a handicap (R184). Folding the Hard log without its handicaps throws `p1: deck must hold exactly 20 cards (§2.6 L2), got 30`. |
| B2 §3 / §4.1 control change (R171) | pass | `combat.ts:92 enterNewSide` resets `summonedTurn` and exertion. It is called on every `controlChanged` path: `effects/steal.ts:74`, `effects/swap.ts:181` and `subsystems/rotation.ts:201`. 34 tests are named R171, including a fast-check property test. Fuzz invariants I1–I5: 0 violations over seeds 1–1000. |
| B2 §4.4, §4.5, §5, §6, §7 | pass | Cross-card suites `combat-windows`, `deaths-and-reborn`, `re-entry`, `trigger-stays` and `paused-sequences` are green. `catalog.test.ts` is green. R14's amended radiant #52, which bounces outbound cards only, agrees with §8 #52 and BUILD M4-T4. |
| B3.1 missing-tests | pass | exit 0; the 4 NOTE lines are tokens covered by the tests of the cards that make them |
| B3.2 Test file count | pass (stale literal) | The REVIEW grep counts 140 files (110 on `main`), because 30 cross-card suites were added. There are 106 per-card files, the same as `main`. `missing-tests` is the authoritative check. |
| B3.3 Must-pass clauses | not re-walked | The pass changed 24 per-card test files, and all of them are green. No `it.todo` was added: all 9 predate the pass. |
| B3.4 Deep reads | pass | Read against §8: #24, #38, #52, #64, #71, #79 and the five `conditionMet` hooks (#10, #53, #68, #71, #93), which match R195's list and read only public counts. #79 moved from a Cry to `staticFlags.echoGrant`, per R209 and §8 #79. #64 is a static flag that the engine reads against `turnLog.costsPaid` (R213). #38 is a static flag that the engine reads against the cards played earlier in the turn (§8 #38, R119). |
| B3.5 Subsystems | pass | `packages/engine/test/{fuse,rotation,scorer,aiPolicy,heroPower,comboIndex,callToChaos,lethal}.test.ts` all exist and are green in `pnpm test`. I did not re-read the M3-T7 acceptance cases (see Not verified). |
| B4 Rulings | pass | `rulings:coverage`: 218 rows, R1–R226 (unused numbers: 189, 197–199, 205–208), every row named by a test, no orphan citations. The "decide" constants R1, R2, R4, R5, R14, R26 and R39 are unchanged in `config.ts`. The only R-ids that docs cite outside §11 are unused range bounds. |
| B5 Animations / client | pass (with B-6) | `ANIMATIONS` (`animations.ts:156`) and `SOUND_CUES` (`audio/cues.ts:137`) are mapped types over `GameEventType`, so the compiler enforces both totals. `events.ts` gains fields only, no new types. `Prompt.test.tsx` covers all 10 prompt kinds. `durationFor` zeroes every duration under reduced motion, and `animations.test.ts` is green. Production build: 0 `__jackioh*`. Dev-mode build: `__jackioh` 6 times, `__jackiohAudio` 3, `__jackiohPractice` 3, `__jackiohE` 1. Audio is 1.8 MB, within the 3 MB budget. |
| B6 Server | pass | `test:sql` and `test:db` are green. Tests cover R190's right-hand `X-Forwarded-For` (45 tests, `client-address.test.ts`), R191's shared normalization (70 tests; the server's `crypto.ts:10` and the client's `CodeField.tsx:62` both import from `@jackioh/shared`) and R192's rate-limit feedback, which keeps R145's exact bytes for code-dependent refusals (`redeem-feedback.test.ts:369`). The login return target is allow-listed (`net/return-to.ts`), so there is no open redirect. `render.yaml` sets `TRUSTED_PROXY_HOPS: "1"`. |
| B7 End-to-end | pass | There are 16 gated specs plus `99-online-smoke` (skipped unless enabled). `git grep "cy.wait([0-9]" -- e2e` returns 0 tracked hits. Diffs to the older specs (01, 02, 07) follow UI changes and weaken no assertion. Results are in the B0 row. |
| B8 Determinism | pass | `pnpm fuzz`: "seeds 1..1000: 1000 passed, 0 failed; 0 throw(s), 0 over the 15000-action bound or stalled, 0 replay mismatch(es), 0 invariant violation(s)". `fuzz-handicap`: 1000 seeds, 0 failed. I folded three recorded logs in two fresh processes, and both gave the same results: `01-hotseat-full-game` gave `aca6b485` (50 actions, 0 errors, p1 hero-death); `13-practice` gave `94ec900d`, the same with or without its handicaps, since Easy equals a human (R180); `13-practice-hard` gave `09094528`. |

## Not verified

- **The edge-case hunt stopped before it ran dry.** `docs/polish/4-edge-cases.md` ("Hunt status")
  says the user halted it after round 8, and every lens was still finding bugs (28 confirmed in
  round 8). No sick unit has attacked since the R171 slice, and the fuzz invariants I1–I5 hold. Any
  other engine edge cases that remain were not in the scope of this audit.
- **Must-pass clauses (B3.3).** I did not walk BUILD M4-T4 card by card. I checked only that no
  test the pass touched was skipped, and that every todo and expected failure predates the pass.
- **Findings that predate the pass and that it did not touch** were not scored: the 9 `it.todo`
  (#81, #83, #96 ×5, T-Bread, T-Sheep) and the `effects-delay.test.ts:370` GAP R76 `it.fails`.
- **The 99 online smoke spec** needs real accounts and a deployed stack.
- **Real devices.** I did not check phone layouts on a device. The component specs measure them
  in Chrome at 390×844, 844×390, 768×1024 and 1280×720.
- **The shadow-ban sweep (`pnpm ai:sweep`, R186)** was not rerun; `shadowBan.test.ts` is
  green.
- **BUILD M3-T7's acceptance cases for the subsystems (B3.5)** were not re-read one by one. I
  checked only that each test file exists and is green.

## Resolved (integration fix stage)

Fixed in the commit that follows `827dd6d` on `polish/integration`, with the gate rerun on it
(below). B-2 is the one finding still open.

- **B-1 (BLOCKER): fixed, new ruling R227.** A Trap or Field Trap that goes face-down (played,
  cast or recruited) now takes a fresh instance id as it is placed (`zones.freshFaceDownId`, called
  from `playSteps.placeCard` and `summon.summonExisting`), so no id a player saw while the card was
  public ever names it in its zone. The action protocol, the server and the e2e specs are unchanged.
  The `cardPlayed` and `summoned` that set it carry the old id as `formerId`: `viewFor` follows it,
  so the events that named the old id are judged by the card's zone exactly as before (R97), and
  strips it from any viewer who may not read the card; the setter's client uses it to find the hand
  card it animates from. The `it.fails` at `turn-clock-and-legality.test.ts:278` is now
  `it("R227 …")` and passes; `hidden-information.test.ts` adds three R227 tests (both seats, and
  the old events reading openly once the trap is public), `effects-summon.test.ts` two for the
  Recruit path, and the web's `animations.test.ts` and `stage.test.tsx` one each. SPEC R177's
  "known limit" sentences, R223's last sentence and §10.5 step 4 now point at R227;
  `docs/polish/4-edge-cases.md` says it is closed, so no tracked issue is needed.
- **B-2 (MAJOR): open, the user's decision.** Rerun on this commit, the AI still misses the
  brief's 70% against greedy on the frozen series: 33 of 50 (35 asked) and 12 of 20 (14 asked).
  Nothing an agent may do closes it: tuning on `gate:v2` would spend the frozen series, and
  lowering the floors is the sign-off SPEC §9.9 reserves for the user. `docs/polish/3-ai.md`
  records the levers already measured (a four-times search, perfect information, weights tuned by
  self-play, a reply that plays the sampled hand, last-turn kills), none of which moved the rate
  past noise. The `gateNeeded` rule stays marked "Proposed, pending the user's acceptance".
- **B-3: fixed.** SPEC §9.9 now says the AI reaches the brief against random (97 of 100 full, 19
  of 20 smoke on this commit) and as Hard against Easy (45 of 50, 17 of 20), and falls short only
  against greedy.
- **B-4: fixed.** `lint-ban.test.ts` has `it("applies the same ban under packages/ai")`, which
  lints a fixture path under `packages/ai/src` and expects the import, `Math.random`, `Date.now`,
  timer and `async` bans.
- **B-5: fixed (the comment, BUILD §2 and R79).** The loop's behaviour stays: after 500 answers
  with a prompt still open, the timeout stops with the turn running, and the next expiry carries
  on. It cannot end a turn under an open prompt. `config.ts` now says so, BUILD §2 lists
  `TIMEOUT_ANSWER_CAP`, and R79 names the cap.
- **B-6: fixed.** `modeText(defId, option, radiant)` reads `RADIANT_MODE_TEXT`, so a Radiant #24
  says "Deal X+1 damage", "Heal a target by twice X+1" and "Gain half of X+1". `Prompt.tsx` passes
  the played card's face, and `Prompt.test.tsx` covers both faces.
- **B-7: fixed.** `gate-perf.test.ts` reads the clock against a yardstick: each run of a decision
  is timed right after a fixed piece of engine work (`AI_GATE.calibrationGames` random-policy
  games), and the smallest ratio, times the yardstick's time on the development machine
  (`AI_GATE.calibrationRefMs`, 72 ms), must stay under `maxDecisionMs`. The node budget is still
  asserted exactly. Under 24 busy loops on 10 cores (load average 20) the file took 58 s and
  passed; the raw clock had failed at 1,520 ms. SPEC §9.9 ("Budgets") and B42 say so.

### The gate on the fix

`pnpm lint`, `pnpm typecheck`, `pnpm validate:catalog`, `missing-tests`, `pnpm rulings:coverage`
(219 rows, R1–R227) and `pnpm test` (356 files: 6,659 passed, 1 expected fail, the older GAP R76,
and the same 9 todos) pass. So do `pnpm fuzz` (seeds 1–1000: 0 throws, 0 replay mismatches, 0
invariant violations; fuzz-handicap 0 failed), `pnpm test:coverage` (lines 97.8%, statements
94.16%), `pnpm test:sql`, `pnpm test:db` (80 tests) and `pnpm ai:gate` (exit 0 under the proposed
counts; greedy as above).

E2E on Chrome against a `build:e2e` client and the `E2E=1` server: 15 of the 16 specs passed in
one run; spec 12 failed because it tracked a trap by the id it had in hand, which R227 now
replaces as the trap is set. The spec reads the id from the trap's zone after the play instead,
and passed on its own rerun. The component specs on Chrome: 9 specs, 168 of 168. Electron was not
rerun.
