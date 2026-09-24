# JackiOh polish pass — reference

The brief for seven pieces of work that make JackiOh feel like Hearthstone. There is one branch, one
worktree and one PR per task, plus an integration branch that proves all seven merge together and
pass CI. The workers are coordinated by a workflow (the "master") that runs nested design, build,
test, review and fix agents for each task.

`SPEC.md` still holds every rule. This file decides what the SPEC doesn't cover yet, and splits the
repo between the tasks so seven branches can be built at once and still merge.

Written 2026-09-22 against `main` at `cd780db`.

---

## The seven tasks

The user's words, then the decisions made for them.

### 1. Animations and VFX — `polish/1-animations`

> Currently animations are NOT great. The cards shaking are fine … BUT WE WANT MORE ANIMATIONS + more
> advanced ones beyond just shaking a card. Fire animations, cards shaking or glowing. Think
> HEARTHSTONE.

- A board-wide effects layer: `apps/web/src/fx/`. A pooled, DPR-aware particle system on a
  `<canvas>` overlay (pointer-events none), plus DOM/CSS effects anchored to the `data-testid`
  rectangles the board already renders.
- Effects to include:
  - Fire, embers and burn-away.
  - Holy light and heal sparkles.
  - Arcane motes for traps and spells.
  - A poison cloud.
  - Smoke puffs for transform and fuse.
  - Impact flashes and screen shake scaled by damage.
  - Hearthstone-style damage and heal splats.
  - Spell projectiles with trails, from source to target.
  - Summon slam with a dust ring.
  - Legendary and Mythic entrances with light rays.
  - Radiant golden shimmer.
  - Divine Shield bubble and shatter.
  - Buff arrows.
  - Trap reveal flip with an arcane burst.
  - A "Your turn" banner.
  - Mana crystal fill.
  - Card draw flight.
  - Death crack and dissolve.
  - Victory and defeat sequences.
- The existing architecture stays: the `ANIMATIONS` total map over `GameEventType`, the event-queue
  runner and `data-animating`. Each row gains an optional `fx` descriptor.
- `prefers-reduced-motion` still drains the queue synchronously (`animations.test.ts`).
- 60 fps target on a mid phone, a particle cap, and pause while `document.hidden`.
- Settings the effects layer exposes (speed, intensity) live in `apps/web/src/fx/settings.ts`. Task 7's
  panel wires them in at integration.

### 2. Sound design — `polish/2-sound`

> More sound effects for cards. Voice lines on cry and death for cards.

- `apps/web/src/audio/` holds a WebAudio engine: created lazily and unlocked on the first user
  gesture (iOS included), with master, sfx and voice buses.
- **SFX are synthesized procedurally** at runtime (noise bursts, filtered sweeps, FM chimes), so
  there are no licensing questions and no asset weight. One recipe per sound: draw, play, summon,
  attack swing, impact scaled by damage, shield shatter, heal chime, buff rise, death crumble, burn
  crackle, trap sting, spell shimmer, mana fill, turn start, victory, defeat, and UI click and
  hover.
- Sounds are driven by the same event stream as animations and synced to the animation runner. Every
  `GameEventType` gets a sound or an explicit silence, as a total map (like `ANIMATIONS`).
- **Voice lines:** every Unit gets a *play* line (spoken when it is played, which is when its Cry
  fires) and a *death* line. Spells and traps get a short *cast* line. The lines are written in
  character from each card's name and text in `apps/web/src/audio/voice-lines.json`.
- The audio is **generated with macOS `say`** by `apps/web/scripts/gen-voice.mjs`: voice and rate
  chosen per card personality, mono AAC `.m4a` at about 32 kbps in
  `apps/web/public/audio/voice/<card-id>-<play|death|cast>.m4a`. Total budget is ≤ 3 MB. The script is
  idempotent and committed. At runtime, a missing file falls back to `speechSynthesis`.
- Settings (master, sfx and voice volume, mute, voice on or off) live in
  `apps/web/src/audio/settings.ts`, persisted to `localStorage` inside `try/catch`. The branch mounts
  a mute toggle in the game HUD, and task 7's panel mounts the full controls at integration.

### 3. AI opponent — `polish/3-ai`

> A well defined and capable AI … randomized decks … smart … able to execute complex ideas. Cards too
> complicated for it go on a shadow ban list. Three difficulties that don't change behaviour, only
> resources.

**Difficulty table** (AI seat only; the human always has SPEC's resources):

| | Easy | Medium | Hard |
|---|---|---|---|
| Deck size | 20 | 25 | 30 |
| Max mana | `min(turns, 4)` (as a human) | `min(turns + 1, 5)` | `min(turns + 1, 7)` |
| Opening hand | as a human | +1 card | +1 card |
| Draws per turn | 1 | 1 | 2 |
| Behaviour | identical | identical | identical |

- "+1 mana always" means one more crystal than a human has on every turn, up to the tier's cap.
  Persistent and temporary mana modifiers apply on top, exactly as for a human.
- Hard includes Medium's extra opening card; the brief lists Hard's differences from Medium.
- Hard's second draw is a separate draw with its own cast-on-draw chain (R58) and its own fatigue
  count.
- AI decks bypass the 20-card deckbuilding limit. They are still distinct, token-free Core cards.

**Engine** (`packages/engine`, pure):
- A per-player `handicap` in the game setup (`manaBonus`, `manaCap`, `extraOpeningCards`,
  `extraDrawsPerTurn`), defaulting to a human's values.
- It is part of what `replay.ts` folds, so a practice game replays exactly.
- The difficulty table is a named constant in `packages/engine/src/config.ts` (rule 9).
- Online matches are unchanged.

**AI** (new package `packages/ai`, pure and seeded; add it to ESLint's pure-package lists):
- **No cheating.** It decides from `viewFor(state, ai)` only. Where it simulates, it first
  *determinizes*: the opponent's hand, face-down backrow and library, and its own library order, are
  resampled from what that seat could legally know. A test proves two states that differ only in
  the opponent's hidden cards produce the same decision under the same rng.
- **Search.** Turn-level beam search over `legalActions` sequences with `reduce` on several
  determinizations, re-planning after every action. It includes an exact lethal solver (attack
  orderings, removing Taunt first, buffs before attacks) and prompt answering through the same
  search.
- **Evaluation.** Hero health, weighted non-linearly; armor; board stats and keywords through
  `unitView`; card advantage; mana efficiency; threat, meaning the enemy's damage next turn against
  our health; and the risk of face-down traps.
- **Budgets** are node-based, so tests are deterministic, with a wall-clock safety cap in the
  browser.
- **Decks.** `buildAiDeck(rng, size, options)` makes a curve-aware, tag-aware random deck of
  distinct non-token cards, minus the shadow-ban list.
- **Shadow ban.** `packages/ai/src/shadowBan.ts` holds one reason per card. It is decided by a sweep
  that forces each card into AI decks and flags errors, timeouts, never-played cards and
  self-harming play.
- **Quality gates**, as tests:
  - ≥ 95% wins against the random policy on Easy over 100 seeds.
  - ≥ 70% against a one-ply greedy baseline.
  - Hard beats Easy (the same AI) at least 80% of the time.
  - At least 12 hand-built puzzles pass: lethal through Taunt, buff then attack, spell for lethal,
    don't trade badly, play around a lethal threat, and use a prompt well.
  - No illegal action, and replay hashes match across the fuzz seeds.

**Web:**
- A `/practice` route that needs no account.
- Choose a difficulty and a deck: a saved deck when signed in, otherwise a random or preset one.
- The engine and the AI run in a **Web Worker** (`apps/web/src/practice/`), so the React tree only
  ever holds `viewFor(human)` (rule 7). There is an in-thread fallback for jsdom tests.
- AI turns are paced (a think indicator, and gaps so animations and voice lines play).
- Reuse `Game.tsx`, add Cypress spec `13-practice-vs-ai.cy.ts`, and document it in SPEC as a new
  **§9.9 Practice against the AI**.

### 4. Edge-case hunt — `polish/4-edge-cases`

> Niche edge cases when switching boards with opponent … units can attack the enemy when they should
> have summoning sickness. Test to find these.

- Known gap: `isSick` is `summonedTurn === state.turn`, and a control change never touches
  `summonedTurn`. So a unit that is stolen, swapped or rotated across the centre line can attack at
  once.
- **Ruling (Hearthstone semantics, first new row R171):** a unit whose controller changes has
  *entered its new controller's side* on that turn. It is summoning sick exactly like a unit summoned
  that turn, with Rush and Charge applying as usual, and its exertion is reset for its new
  controller. A unit that changes lanes on the same side is not re-entered.
  - Apply this to **every** path that changes control: steal, swap, rotation across sides, board
    swaps, "Miss" Mrow, Kpop Fanatic's delayed steal, and anything else found.
  - Also check: stealing back on the same turn, a stolen Reborn unit, forced attacks (which still
    ignore sickness, R53), and Rush or Charge granted or removed mid-turn.
- **Method:** loop-until-dry adversarial finders, each with its own lens:
  - control change
  - re-entry and zone moves
  - keywords granted or removed
  - Stack piles and dormancy
  - forced attacks
  - rotation and swap
  - prompts mid-sequence
  - turn boundaries and delayed effects
  - `legalActions` and `reduce` disagreeing
  - `viewFor` leaks

  Every finding becomes a failing test (the cards harness `scenario()`), then a fix, then a §11 row
  where a ruling is needed.
- Add fuzz-level invariants to the random games, such as "no attack ever comes from a sick unit
  without Rush or Charge (unit target) or Charge (hero target)", and fast-check properties.

### 5. Sign-in and landing page — `polish/5-sign-in`

> Make the sign in codes more thorough and run an adversarial check … improve the landing page ui.

- Harden the invite code end to end:
  - A segmented entry field: auto-uppercase, auto-advance, paste of any form (spaces, dashes, lower
    case), and live format feedback. The alphabet excludes 0, 1, O and I, so say so when one is
    typed.
  - Client and server normalization must agree, proved by one shared test table.
  - Clear rate-limit feedback.
  - R145's identical error for every code-dependent refusal is preserved on purpose, because the UI
    must not reveal whether a code exists.
- Harden sign-in and sign-up:
  - Validation and show-password.
  - Map Supabase errors to plain messages.
  - Resend the confirmation email.
  - A **forgot password / reset** flow, if it is missing.
  - No dead ends: every screen has a way out.
- Run an **adversarial panel**: security (enumeration, timing, brute force and rate-limit bypass,
  `X-Forwarded-For` spoofing, token handling, open redirects in confirmation and reset links, XSS),
  UX (confusing states, dead ends, trapped screens) and correctness (client/server mismatch,
  redemption races). Every confirmed finding gets a fix and a test.
- A new **landing page**: extract `Landing` from `main.tsx` into `apps/web/src/routes/landing.tsx`
  with its own CSS.
  - A Hearthstone-flavoured hero: an animated card fan, a strong title treatment and depth.
  - Clear CTAs: **Play vs AI** (to `/practice`, task 3), Play online, Build decks, and Sign in or
    Account.
  - A short "how it plays" strip.
  - Responsive down to 360 px.
- No fullsend here: this touches an auth boundary.

### 6. Cards and deck builder — `polish/6-cards`

> Cards are just squares and lack character … placeholder images for each … unique designs, tags,
> rarity shown, elaborate sorting, hover to view … a tall rectangle with art and the effect printed,
> like Hearthstone.

- A new card presentation module, `apps/web/src/cards/`:
  - `CardFace`: a tall card (about 5:7) with:
    - A cost gem.
    - An art window.
    - A name ribbon.
    - A type line.
    - Tag badges.
    - A rarity gem, with a frame that varies by rarity (Common, Rare, Epic, Legendary with an
      ornate crest, Mythic with an animated foil).
    - A rules-text box with keywords and `Cry:` / `Death:` in bold.
    - Attack (sword) and health (drop) for units.
    - Distinct frames for Spell, Field Spell, Trap and Field Trap.
    - A Radiant face in golden foil.
  - A compact **minion** form for the board: an oval portrait with attack and health.
- **Placeholder art, procedural and deterministic per card id:** layered SVG themed by tag and type,
  with two variants per card (base and radiant).
  - Real art drops in later at `apps/web/public/art/<card-id>.webp` and `<card-id>-radiant.webp`.
  - A manifest, `apps/web/src/cards/art/manifest.ts`, lists which ids have real art, so there is no
    404 storm.
- **Inspect:**
  - Hover (desktop, about 300 ms) shows an enlarged card.
  - Long-press (touch) opens an inspect sheet.
  - In the deck builder, a click opens a detail view with both faces side by side and a glossary of
    its keywords.
- **Deck builder:**
  - A grid of full cards.
  - Filters: cost (0–6+, X), type, tag, rarity, text search and owned.
  - Sort by cost, name, rarity, attack, health and type.
  - A deck sidebar with Hearthstone-style list tiles, a mana-curve histogram and a 20/20 count.
  - Tabs for the three decks, marking a card another deck already uses (loadout rule L4).
  - Every existing `data-testid` is kept.
- `Card.tsx` keeps every `data-testid` and `data-*` attribute that e2e and the animation table read.

### 7. Mobile, drag to play, settings, highlights — `polish/7-mobile-ux`

> Make sure the UI is great on mobile. Make everything drag, with an opt-out in settings that brings
> back the selection UI. Highlight valid targets in green, and a triggered condition in yellow.

- **Responsive board:**
  - Phone portrait (390×844) and landscape (844×390), tablet (768×1024) and desktop (1280×720).
  - Touch targets ≥ 44 px, safe-area insets, and no horizontal page scroll.
  - The hand as an overlapping fan with tap-to-lift.
  - Prompts as bottom sheets on phones.
  - The component spec's overflow checks stay green and gain the new viewports.
- **Drag to play**, with unified pointer events for mouse and touch:
  - Drag a hand card onto the board or a target to play it.
  - Drag a unit onto an enemy unit or hero to attack, with a Hearthstone targeting arrow from source
    to pointer and a reticle on valid targets.
  - Cancel with Esc, a right-click or a drop outside.
  - **Click-click keeps working in every mode** (the e2e specs click).
  - The setting "Drag to play" is on by default. Off means tap to select, then the selection UI
    (`Prompt.tsx` pickers).
- **Settings:** `apps/web/src/settings/` holds the store (`localStorage` in `try/catch`) and a panel
  opened from a gear in the game HUD and in the nav. It has sections for:
  - Gameplay: drag to play, confirm end turn, hover previews.
  - Visuals: effects speed and intensity, reduced motion.
  - Audio: task 2's controls.

  Tasks 1, 2 and 6 own their settings modules; this panel mounts them at integration.
- **Highlights:**
  - Green on playable hand cards, attack-ready units and every valid target while targeting,
    straight from `legalActions` / `Highlight.legal`.
  - Yellow when a card's **condition is met** (Hearthstone's combo glow). The engine decides it
    (rule 7): a new optional `Script` hook `conditionMet?: (ctx) => boolean`, surfaced by `viewFor` as
    `conditionActive` on the viewer's own hand cards (and units where the condition lives on the
    field).
  - Cards whose §8 text is conditional implement the hook, each with a test.
  - SPEC changes: §10.8 and §10.9, plus a §11 row.

---

## Who owns what

Every shared file has one owner per task. Anyone else touches it only by a minimal, additive edit (one
import and one mount line) and says so in their PR.

| Surface | Owner | Others |
|---|---|---|
| `packages/engine/src/combat.ts`, control-change paths in `effects/steal.ts`, `effects/swap.ts`, `subsystems/rotation.ts` | 4 | — |
| `packages/engine/src/{setup,turn,mana,draw}.ts`, `replay.ts`, handicap fields in `state.ts`, `config.ts` difficulty table | 3 | 4 may add control-change bookkeeping in `state.ts` |
| `packages/engine/src/script.ts`, `viewFor.ts` `conditionActive`, the conditional card scripts in `packages/cards` | 7 | — |
| `packages/ai/**` (new) | 3 | — |
| `packages/shared/src/view.ts` | 7 (`conditionActive`) | 3 (handicap fields in the view) |
| `packages/shared/src/events.ts` | nobody: **no new `GameEvent` types**. If one proves essential, the task adds its SPEC §10.3 entry, BUILD M5-T4 row and `ANIMATIONS` row, and flags it in its PR | — |
| `apps/server/src/api/{auth,codes}.ts`, `apps/web/src/routes/{login,invite}.tsx`, `apps/web/src/net/auth.ts` | 5 | — |
| `apps/web/src/main.tsx` | 5 (extracts `Landing`) | 3 (adds the `/practice` route line) |
| `apps/web/src/net/navigate.ts` `paths` | 3 (`practice`) | 5 (reset-password path; adds `practice: "/practice"` if it links there before 3 lands; the identical line merges) |
| `apps/web/src/cards/**` (new), `Card.tsx` internals, `game/deckbuilder/**`, `routes/decks.tsx` | 6 | 7 adds highlight or drag attributes on `Card.tsx`'s root only |
| `apps/web/src/fx/**` (new), `animations.ts`, `animations.css` | 1 | — |
| `apps/web/src/audio/**` (new), `apps/web/scripts/gen-voice.mjs`, `apps/web/public/audio/**` | 2 | — |
| `apps/web/src/settings/**` (new), `Board.tsx`, `Zone.tsx`, `Hand.tsx`, `board.css`, `prompt.css`, `Prompt.tsx` layout | 7 | — |
| `apps/web/src/practice/**` (new), `routes/practice.tsx` | 3 | — |
| `apps/web/src/game/Game.tsx` | shared: 1 mounts `<FxLayer/>`, 2 mounts the audio hook, 7 mounts the drag layer and settings gear, 3 reuses it. Each is a minimal additive edit | — |
| `apps/web/src/index.css` | keep global edits minimal; put styles in each task's own CSS file | — |
| `apps/web/package.json`, `pnpm-lock.yaml` | **no new runtime dependencies** without a written reason in the PR; pin exact versions | — |

### SPEC §11 numbers

These ranges avoid collisions; a range need not be used up. The rulings index in
`packages/engine/test/rulings.test.ts` must list the rows in ascending order, matching SPEC, so each
task inserts its rows in numeric position. Unused numbers leave harmless gaps: both the index test
and `rulings:coverage` compare sets in order, and neither requires the numbers to be contiguous.

| Task | Rows |
|---|---|
| 4 edge cases | R171–R179 |
| 3 AI | R180–R189 |
| 5 sign-in | R190–R194 |
| 7 highlights | R195–R199 |
| 1 animations | R200–R202 |
| 2 sound | R203–R205 |
| 6 cards | R206–R208 |
| overflow (any task that fills its range) | R209 and up, first come; the integration merge renumbers any collision |

### SPEC sections

| Task | Sections |
|---|---|
| 3 | new §9.9 Practice against the AI |
| 4 | §4.1 |
| 5 | §9.4 (invite UX notes) |
| 7 | §10.8, §10.9 |
| 1 | §10.10 (plus BUILD M5-T4's table) |
| 2 | new §10.11 Audio |
| 6 | none unless unavoidable |

---

## Worktrees, ports, commands

| Task | Worktree | Branch | Web port | Server port | Component port |
|---|---|---|---|---|---|
| 1 | `.claude/worktrees/polish-1-animations` | `polish/1-animations` | 5171 | 8781 | 5281 |
| 2 | `.claude/worktrees/polish-2-sound` | `polish/2-sound` | 5172 | 8782 | 5282 |
| 3 | `.claude/worktrees/polish-3-ai` | `polish/3-ai` | 5173 | 8783 | 5283 |
| 4 | `.claude/worktrees/polish-4-edge-cases` | `polish/4-edge-cases` | 5174 | 8784 | 5284 |
| 5 | `.claude/worktrees/polish-5-sign-in` | `polish/5-sign-in` | 5175 | 8785 | 5285 |
| 6 | `.claude/worktrees/polish-6-cards` | `polish/6-cards` | 5176 | 8786 | 5286 |
| 7 | `.claude/worktrees/polish-7-mobile-ux` | `polish/7-mobile-ux` | 5177 | 8787 | 5287 |
| integration | `.claude/worktrees/polish-integration` | `polish/integration` | 5173 | 8787 | 5273 |

- Worktree paths are relative to the repo root.
- Every command runs **inside the task's own worktree**. Never edit the main checkout.
- The machine has 10 cores and about 13 GB of free disk, and up to 8 agents share it:
  - Prefer targeted runs (`pnpm vitest run --project <p> <file>`).
  - Run the full `pnpm test` / `pnpm fuzz` at gates.
  - A test that times out under load gets rerun alone before it's called a failure.
- E2E from a worktree: `pnpm build:e2e`, then
  `pnpm --dir apps/web exec vite preview --port <web> --strictPort`, then
  `E2E_BASE_URL=http://localhost:<web> pnpm --dir e2e exec cypress run --spec …`. Networked specs also
  need `E2E=1 PORT=<server> pnpm --dir apps/server start`, with `--expose apiUrl=…,wsUrl=…` and
  `PUBLIC_ORIGINS`.
- Component specs from a worktree:
  `E2E_COMPONENT_PORT=<component> pnpm --dir e2e test:component`. Each branch's first commit makes
  the port overridable, and CI still uses 5273.
- Kill every server you start.

### The gate every branch passes before its PR

```
pnpm lint && pnpm typecheck && pnpm validate:catalog \
  && pnpm --filter @jackioh/cards missing-tests && pnpm rulings:coverage \
  && pnpm test && pnpm fuzz && pnpm test:coverage
```

Plus the e2e specs the change can affect, and `pnpm --dir e2e test:component` for any layout change.

---

## Conventions

- **Commits** follow the repo's style: a sentence subject that says what is now true, and a body
  that explains why.
  - **No `Co-Authored-By` trailer** (the user's standing preference).
  - A few meaningful commits per branch, not one per agent step.
- **PR titles:** `Polish N: <what it does>`.
  - The body has: summary; what changed, by area; SPEC rows and sections added; the gate commands
    and their results; screenshots or recordings where the harness can make them (paths under
    `e2e/artifacts/`); known limits; and merge notes (which other polish PRs it touches).
  - Every PR links this file.
- **Design notes** for each task are committed at `docs/polish/<n>-<slug>.md` (the design brief,
  its behaviours and its decisions), so a reviewer can read why before what.
- **Merge order** for the integration branch: 4 → 3 → 5 → 6 → 2 → 1 → 7 (engine first, then the web
  foundations the later tasks build on). `polish/integration` merges all seven, wires the
  cross-task seams (settings panel ↔ audio/fx/drag, landing CTA ↔ `/practice`, card faces in
  practice/hotseat/match), runs the full CI including e2e on Chrome, and gets its own PR. It can be
  merged instead of the seven if that's easier.

## How the work is orchestrated

1. **Design** (one agent per task, in parallel). Each reads its area, researches Hearthstone where
   the task is visual, and writes `docs/polish/<n>-<slug>.md`: goal, surface, numbered behaviours,
   out of scope, and slices with disjoint file ownership.
2. **Build.**
   - Greenfield modules (fx, audio, ai, cards, settings) use the fullsend pattern: slice builders
     that write blind, with no compiler; spec-testers writing tests from the behaviours at the same
     time; then reconcile, green and cull.
   - Edits to existing code use implement, then verify.
   - Task 4 is a find-and-fix loop. Task 5 is build, then an adversarial panel.
3. **Review.** Three independent reviewers per task, each with a different lens (spec and rules,
   quality and completeness against the brief, and one lens specific to the task: performance and
   mobile, security, or determinism). Confirmed findings get fixed, and the gate is rerun.
4. **PR.** Commit, push, open the PR.
5. **Integrate.** Merge all seven, wire the seams, run full CI and e2e, then visual QA on
   screenshots at four viewports, a completeness critic, and REVIEW.md's Part B prompt on the
   result.
