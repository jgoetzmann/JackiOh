// SPEC §11, every row: the single index BUILD's M3 gate asks for and REVIEW's B4 check greps by
// name. One `it("R<n> …")` per §11 row, in ascending order: the same ids, in the same order, as
// SPEC §11's table, gaps included (`pnpm rulings:coverage` compares the two).
//
// Two kinds of test live here. A row whose ruling is a number asserts that number against
// `config.ts` — the seven "decide" rows (R1, R2, R4, R5, R14, R26, R39) among them, which B4
// requires to be named constants there. Every other row delegates: the comment above it names the
// file and the test that does the work with fixtures, and the body asserts that the named file
// still carries a test for the row, so the index goes red if a proof is renamed away or deleted.
// Rows whose subject is a card M4 has yet to build say so in the comment: the engine test proves
// the machinery, the card test will prove the card (BUILD M3 gate, M4-T4).
//
// R104 to R112 are server rulings, and B4 greps only this file and `packages/cards/test`, so their
// index rows stay here: they delegate to `apps/server`'s own evidence where there is some and
// assert the constant §11 fixes where there is not (R107, R108, R109 are `config.ts` values with no
// database behaviour, proved at the server level by BUILD M6-T1, M7-T1 and M7-T3).
//
// The index imports `config.ts` and nothing else from the engine on purpose: it must stay green
// while the modules it points at are edited, so a red test here always means a missing proof.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as config from "../src/config";

const titleCache = new Map<string, readonly string[]>();
const sourceCache = new Map<string, string>();

/**
 * One proof file's text. The path is resolved against this directory, so a sibling test file is a
 * bare name and a proof outside `packages/engine/test` is a relative path — `apps/server`'s SQL
 * evidence scripts and vitest files included. Nothing is imported: the index must not make
 * `packages/engine` depend on `apps/server`.
 */
function sourceOf(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  let source: string;
  try {
    source = readFileSync(new URL(file, import.meta.url), "utf8");
  } catch {
    source = ""; // A missing file reads as no proofs, so `provenIn` names the row it cannot find.
  }
  sourceCache.set(file, source);
  return source;
}

/** Every `R<n> …` test title in a sibling test file, read once. A title may name two rows. */
function rulingTitles(file: string): readonly string[] {
  const cached = titleCache.get(file);
  if (cached !== undefined) return cached;
  const titles = [...sourceOf(file).matchAll(/\bit\(\s*"(R\d+[^"]*)"/g)].map((match) => match[1] ?? "");
  titleCache.set(file, titles);
  return titles;
}

/**
 * Every *heading* an SQL evidence script announces a check with: `\echo '### … ###'` or
 * `\echo '=== … ==='`, as the text between the delimiters.
 *
 * Only a heading counts. `apps/server/test/sql/03_match_lifecycle.sql`'s own header states the
 * contract ("that heading form is the signal; a bare mention in prose is not"), and it exists
 * because that file *names* R107, R108 and R109 in a comment in order to record that it
 * deliberately does **not** prove them — they are `config.ts` values with no database behaviour.
 * A substring search over the file would therefore credit exactly the three rows it disclaims, so
 * neither comments nor the `-- …` prose `\echo`s between checks are read. `sqlHeadingsCredit`
 * below is the test that keeps this honest.
 */
function sqlHeadings(file: string): readonly string[] {
  return [...sourceOf(file).matchAll(/\\echo\s*'\s*(?:###|===)\s*([^']*?)\s*(?:###|===)?\s*'/g)].map(
    (match) => match[1] ?? "",
  );
}

/**
 * The headings of one SQL file that name this row. A heading names a row by writing the id where a
 * name goes — `### R104: …` or `=== CHECK 15 (R105): …` — so the id is followed by `:` or `)`.
 */
function sqlProofs(file: string, row: number): readonly string[] {
  const names = new RegExp(`\\bR${row}(?![0-9])\\s*[:)]`);
  return sqlHeadings(file).filter((heading) => names.test(heading));
}

/**
 * Every proof of this row in one file, in that file's own idiom for a test name:
 *   * a sibling engine test leads with the row (`it("R<n> …")`), which is this file's convention;
 *   * a vitest file elsewhere may also put it mid-title or at the end (`it("… (R112)")`), or name
 *     it on the `describe` that heads the group of tests proving it (`describe("R143 — …")`) — the
 *     same heading idea as the SQL scripts, one level up from the individual case;
 *   * an SQL evidence script announces it as a heading, per `sqlHeadings`.
 */
function proofsFor(file: string, row: number): readonly string[] {
  if (file.endsWith(".sql")) return sqlProofs(file, row);

  const leads = new RegExp(`^R${row}(?![0-9])`);
  const strict = rulingTitles(file).filter((title) => leads.test(title));
  if (strict.length > 0 || !file.includes("/")) return strict;

  const names = new RegExp(`\\bR${row}(?![0-9])`);
  return [...sourceOf(file).matchAll(/\b(?:it|describe)\(\s*"([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((title) => names.test(title));
}

/** The row is proved by a test named after it in each file listed. */
function provenIn(row: number, ...files: readonly string[]): void {
  for (const file of files) {
    expect(proofsFor(file, row), `${file} carries no test named after R${row}`).not.toEqual([]);
  }
}

/** `apps/server/src/config.ts`, whose constants R104 to R109 fix. */
const SERVER_CONFIG = "../../../apps/server/src/config.ts";
/** `apps/server`'s SQL evidence for the rulings its schema implements (BUILD M6-T1). */
const SERVER_SQL = "../../../apps/server/test/sql/03_match_lifecycle.sql";
/** The schema-invariant checks, which prove R105 a second way (BUILD M6-T1). */
const SERVER_SCHEMA_SQL = "../../../apps/server/test/sql/01_schema_invariants.sql";
/** The server modules R137 and R145 to R149 fix a number or a shape in (BUILD M7). */
const SERVER_ACTOR = "../../../apps/server/src/match/actor.ts";
const SERVER_CLOCK = "../../../apps/server/src/match/clock.ts";
const SERVER_WS = "../../../apps/server/src/match/wsServer.ts";
const SERVER_ROOMS = "../../../apps/server/src/match/rooms.ts";
const SERVER_CODES = "../../../apps/server/src/api/codes.ts";
const SERVER_RESULTS = "../../../apps/server/src/api/results.ts";
/** The end-to-end-mode server tests, which name R143 and R144 on their `describe`s. */
const SERVER_E2E_TEST = "../../../apps/server/test/api/e2e.test.ts";
/** The `apps/server` vitest files that prove R157 and R159 to R167 (BUILD M6, M7). */
const SERVER_RATE_LIMIT_TEST = "../../../apps/server/test/api/rate-limit.test.ts";
const SERVER_AUTH_TEST = "../../../apps/server/test/api/auth.test.ts";
const SERVER_CODES_TEST = "../../../apps/server/test/api/codes.test.ts";
const SERVER_CORS_TEST = "../../../apps/server/test/api/cors.test.ts";
const SERVER_CATALOG_TEST = "../../../apps/server/test/api/catalog.test.ts";
const SERVER_QUEUE_TEST = "../../../apps/server/test/api/queue.test.ts";
/** The ranked ladder's proofs (issue #49, SPEC §9.12, R603–R612). */
const SERVER_GLICKO_TEST = "../../../apps/server/test/ranked/glicko2.test.ts";
const SERVER_LADDER_TEST = "../../../apps/server/test/ranked/ladder.test.ts";
const SERVER_SEASON_TEST = "../../../apps/server/test/ranked/season.test.ts";
const SERVER_RANKED_TEST = "../../../apps/server/test/api/ranked.test.ts";
const SERVER_RANKED_RESULTS_TEST = "../../../apps/server/test/api/results.test.ts";
const SERVER_RANKED_SQL = "../../../apps/server/test/sql/12_ranked.sql";
const SERVER_RANKED_CONTRACT = "../../../apps/server/test/db/contract.ts";

/** R169's card-side proofs: the two §8 cards a missing badge list made invisible. */
const CARDS_CURVATURE_TEST = "../../cards/test/077-professor-curvature.test.ts";
const CARDS_FULLSEND_TEST = "../../cards/test/078-fullsend.test.ts";
/** R169's client-side proof: the animation table's targets, checked against a rendered DOM. */
const WEB_ANIMATION_TARGETS_TEST = "../../../apps/web/src/game/animation-targets.test.tsx";
/** R171's and R172's card-side proofs: the six control-change cards and the stolen Reborn bodies. */
const CARDS_CONTROL_CHANGE_TEST = "../../cards/test/control-change.test.ts";
/** R173 to R179's proofs: the polish-4 edge-case hunt, one file per topic (docs/polish/4-edge-cases.md). */
const CARDS_FORCED_ATTACKS_TEST = "../../cards/test/forced-attacks.test.ts";
const CARDS_RE_ENTRY_TEST = "../../cards/test/re-entry.test.ts";
const CARDS_COMBAT_WINDOWS_TEST = "../../cards/test/combat-windows.test.ts";
const CARDS_HIDDEN_INFORMATION_TEST = "../../cards/test/hidden-information.test.ts";
const CARDS_ECHO_AND_EXILE_TEST = "../../cards/test/echo-and-exile.test.ts";
const CARDS_FUSE_REGISTRY_TEST = "../../cards/test/fuse-registry.test.ts";
/** R346 to R354's card-side proofs: patch v0.1.1 (issue #27). */
const CARDS_TRUE_STRIKE_TEST = "../../cards/test/044-true-strike.test.ts";
const CARDS_GHOUL_TEST = "../../cards/test/t-ghoul.test.ts";
const CARDS_VANILLA_POSITIONS_TEST = "../../cards/test/vanilla-and-positions.test.ts";
const CARDS_ADAPTIVE_UI_TEST = "../../cards/test/074-adaptive-ui.test.ts";
const CARDS_DIVIDEND_TEST = "../../cards/test/024-efficiency-dividend.test.ts";
const CARDS_CN_TEST = "../../cards/test/090-cn-viral-injection.test.ts";
const CARDS_HEROIC_POWER_TEST = "../../cards/test/098-heroic-power.test.ts";
const CARDS_ZAO_GAO_TEST = "../../cards/test/080-zao-gao.test.ts";
/** R209 to R211's proofs: the hunt's second round (docs/polish/4-edge-cases.md). */
const CARDS_LASTING_EFFECTS_TEST = "../../cards/test/lasting-effects.test.ts";
const CARDS_PLAYS_AND_CASTS_TEST = "../../cards/test/plays-and-casts.test.ts";
const CARDS_PLAY_CHOICES_TEST = "../../cards/test/play-choices.test.ts";
/** R212 to R214's proofs, and the round's proofs of older rows: the hunt's third round. */
const CARDS_TRIGGER_STAYS_TEST = "../../cards/test/trigger-stays.test.ts";
const CARDS_RESOLVING_FACE_TEST = "../../cards/test/resolving-face.test.ts";
const CARDS_AFTER_RESOLUTION_TEST = "../../cards/test/after-resolution.test.ts";
const CARDS_STACKS_AND_REBORN_TEST = "../../cards/test/stacks-and-reborn.test.ts";
const CARDS_HAND_RETURNS_TEST = "../../cards/test/hand-returns.test.ts";
const CARDS_TRIBUTES_TEST = "../../cards/test/tributes.test.ts";
/** R215 and R216's proofs: the hunt's fourth round, past its three-round cap. */
const CARDS_GAME_OVER_TEST = "../../cards/test/game-over.test.ts";
/** R217 to R219's proofs: the hunt's fifth round. */
const CARDS_CALL_TO_ARMS_TEST = "../../cards/test/069-call-to-arms.test.ts";
const CARDS_CORPSE_EATER_TEST = "../../cards/test/089-corpse-eater.test.ts";
/** R220 to R223's proofs: the hunt's sixth round. */
const CARDS_TURN_CLOCK_TEST = "../../cards/test/turn-clock-and-legality.test.ts";
const CARDS_ZEPHYRS_TEST = "../../cards/test/097-zephyrs.test.ts";
/** R224's proofs: the hunt's seventh round. */
const CARDS_SETUP_TEST = "../../cards/test/setup-and-mulligan.test.ts";
/** R225 and R226's proofs: the hunt's eighth round, where it was halted. */
const CARDS_PAUSED_SEQUENCES_TEST = "../../cards/test/paused-sequences.test.ts";
/** R240 and R241's proofs: the hunt's ninth round, continued at the user's request. */
const CARDS_TURN_STAGES_TEST = "../../cards/test/turn-stages.test.ts";
/** R243's proof beside hidden-information.test.ts's, and R46's: the hunt's tenth round. */
const CARDS_VANILLA_AND_POSITIONS_TEST = "../../cards/test/vanilla-and-positions.test.ts";
/** R244 and R245's proofs: The Coin, dealt to the seat going second (§2.1, §7). */
const CARDS_COIN_TEST = "../../cards/test/t-coin.test.ts";
/** R247's proofs: the live-cards change — #82's options are numbers, and the client draws them so. */
const CARDS_KYS_TRIAL_TEST = "../../cards/test/082-kys-trial.test.ts";
const WEB_PROMPT_CARDS_TEST = "../../../apps/web/src/game/PromptCards.test.tsx";
/** R275 to R283's proofs: the Radiant pass (docs/radiant-audit.md) and what it brought the client. */
const CARDS_RADIANT_STANDARD_TEST = "../../cards/test/radiant-standard.test.ts";
const CARDS_CATALOG_TEST = "../../cards/test/catalog.test.ts";
const CARDS_REFERENCES_TEST = "../../cards/test/references.test.ts";
/** Patch v0.2.0's catalog proofs (R380–R382, R388, R432, R482). */
const CARDS_QUERY_TEST = "../../cards/test/query.test.ts";
const CARDS_PATCHES_TEST = "../../cards/test/patches.test.ts";
const CARDS_PARAMS_TEST = "../../cards/test/params.test.ts";
/** R481's SQL evidence: migration 0016's grant for a catalog that grows. */
const SERVER_CATALOG_GROWTH_SQL = "../../../apps/server/test/sql/09_catalog_growth.sql";
const CARDS_PREVIEW_TEST = "../../cards/test/preview.test.ts";
const CARDS_QUICKSTRIKER_TEST = "../../cards/test/038-quickstriker.test.ts";
const CARDS_KPOP_FANATIC_TEST = "../../cards/test/050-k-pop-fanatic.test.ts";
const CARDS_MY_PAWN_TEST = "../../cards/test/096-my-pawn.test.ts";
const WEB_RADIANT_DIFF_TEST = "../../../apps/web/src/cards/radiantDiff.test.ts";
const WEB_FILTERS_TEST = "../../../apps/web/src/game/deckbuilder/filters.test.ts";
const WEB_REFERENCES_TEST = "../../../apps/web/src/cards/references.test.tsx";
const WEB_COMPUTED_TEST = "../../../apps/web/src/cards/computed.test.tsx";
/** R278's schema half: migration 0010 lets the Jlockeed tag into `public.cards`. */
const SERVER_SEED_CATALOG_TEST = "../../../apps/server/test/db/seed-catalog.test.ts";
const SERVER_SEED_CATALOG_SPEC = "../../../apps/server/test/db/seed-catalog.spec.ts";
/** R185, R186 and R188's proofs in `packages/ai`, and R187's in the practice worker's core (§9.9). */
const AI_OBSERVE_TEST = "../../ai/test/observe.test.ts";
/** The match actor's and the clock's own tests, which prove the concurrent mulligan's server half. */
const SERVER_ACTOR_TEST = "../../../apps/server/test/match/actor.test.ts";
const SERVER_CLOCK_TEST = "../../../apps/server/test/match/clock.test.ts";
const SERVER_RECOVERY_TEST = "../../../apps/server/test/match/recovery.test.ts";
const AI_SHADOW_BAN_TEST = "../../ai/test/shadowBan.test.ts";
const AI_DECK_TEST = "../../ai/test/deck.test.ts";
const AI_DECIDE_TEST = "../../ai/test/decide.test.ts";
const WEB_PRACTICE_CORE_TEST = "../../../apps/web/src/practice/core.test.ts";
/** R203's and R204's proofs (SPEC §10.11): the client's sound cue table, and the director that plays it. */
const WEB_AUDIO_CUES_TEST = "../../../apps/web/src/audio/cues.test.ts";
const WEB_AUDIO_DIRECTOR_TEST = "../../../apps/web/src/audio/director.test.ts";
/** R631's proofs (SPEC §10.11): the music's priority stack, the game's music director and the player. */
const WEB_MUSIC_PLAN_TEST = "../../../apps/web/src/audio/musicPlan.test.ts";
const WEB_MUSIC_DIRECTOR_TEST = "../../../apps/web/src/audio/musicDirector.test.ts";
const WEB_MUSIC_PLAYER_TEST = "../../../apps/web/src/audio/music.test.ts";
/** R632's proof (SPEC §9.2): where the browser keeps a session. */
const WEB_SESSION_TEST = "../../../apps/web/src/net/session.test.ts";
/** R633 and R634's proofs (SPEC §9.1): the account's settings, the routes, both stores and the client sync. */
const SERVER_SETTINGS_API_TEST = "../../../apps/server/test/api/settings.test.ts";
const SERVER_SETTINGS_SQL = "../../../apps/server/test/sql/11_player_settings.sql";
const WEB_SETTINGS_SYNC_TEST = "../../../apps/web/src/settings/accountSync.test.tsx";
/** R639's proofs (SPEC §9.11, §10.10): the player statistics and the homescreen's rotation. */
const WEB_STATS_MODEL_TEST = "../../../apps/web/src/stats/model.test.ts";
const WEB_STATS_TRACK_TEST = "../../../apps/web/src/stats/track.test.ts";
const WEB_STATS_STORE_TEST = "../../../apps/web/src/stats/store.test.ts";
const WEB_STATS_HOOK_TEST = "../../../apps/web/src/stats/useGameStats.test.tsx";
const WEB_LANDING_FAN_TEST = "../../../apps/web/src/routes/landingFan.test.ts";
const WEB_LANDING_TEST = "../../../apps/web/src/routes/landing.test.tsx";
/** The effects layer's proofs (R200 to R202): the cue planner, the director, the layer and the runner. */
const WEB_FX_CUES_TEST = "../../../apps/web/src/fx/cues.test.ts";
const WEB_FX_DIRECTOR_TEST = "../../../apps/web/src/fx/director.test.ts";
const WEB_FX_LAYER_TEST = "../../../apps/web/src/fx/FxLayer.test.tsx";
const WEB_FX_STAGE_TEST = "../../../apps/web/src/fx/stage.test.tsx";
const WEB_FX_CSS_TEST = "../../../apps/web/src/fx/css.test.ts";
const WEB_FX_CANVAS_TEST = "../../../apps/web/src/fx/canvasFx.test.ts";
const WEB_FX_PARTICLES_TEST = "../../../apps/web/src/fx/particles.test.ts";
const WEB_ANIMATIONS_FX_TEST = "../../../apps/web/src/game/animations.fx.test.ts";
/** R250 to R264's proofs: saved decks and trios, deck codes, autosave, queue modes and the series. */
const VALIDATOR_DRAFTS_TEST = "../../validator/test/drafts.test.ts";
const SERVER_STORE_CONTRACT = "../../../apps/server/test/db/contract.ts";
const SERVER_DECKS_TEST = "../../../apps/server/test/api/decks.test.ts";
const SERVER_ROOMS_TEST = "../../../apps/server/test/match/rooms.test.ts";
const SERVER_ENGINE_REAL_TEST = "../../../apps/server/test/match/engine.real.test.ts";
const SERVER_SERIES_RULES_TEST = "../../../apps/server/test/api/series-rules.test.ts";
const SERVER_SERIES_TEST = "../../../apps/server/test/api/series.test.ts";
const SERVER_SERIES_RECOVERY_TEST = "../../../apps/server/test/match/series-recovery.test.ts";
const SERVER_DECKS_SQL = "../../../apps/server/test/sql/04_decks_and_series.sql";
const WEB_DECK_CODE_TEST = "../../../apps/web/src/game/deckbuilder/deckCode.test.ts";
const WEB_DECK_SYNC_TEST = "../../../apps/web/src/game/deckbuilder/sync.test.ts";
const WEB_WORKSHOP_TEST = "../../../apps/web/src/game/deckbuilder/DeckWorkshop.test.tsx";
const WEB_PLAY_TEST = "../../../apps/web/src/routes/play.test.tsx";
const WEB_SERIES_TEST = "../../../apps/web/src/routes/series.test.tsx";
/** R330 to R341's proofs beyond those above: Conquest and trio codes. */
const WEB_SERIES_BANNER_TEST = "../../../apps/web/src/routes/SeriesBanner.test.tsx";
const WEB_TRIO_CODE_TEST = "../../../apps/web/src/game/deckbuilder/trioCode.test.ts";

/** R345's proof on the client: the "End turn automatically" switch and what Game.tsx sends. */
const WEB_SETTINGS_TEST = "../../../apps/web/src/test/ux/settings.test.tsx";

/** R290 to R294's proofs: the tutorial (SPEC §9.10) — its handicap, lessons, coach and progress. */
const AI_TUTORIAL_TIER_TEST = "../../ai/test/tutorial-tier.test.ts";
const WEB_TUTORIAL_LESSONS_TEST = "../../../apps/web/src/tutorial/lessons.test.ts";
const WEB_TUTORIAL_COACH_TEST = "../../../apps/web/src/tutorial/coach.test.ts";
const WEB_TUTORIAL_PROGRESS_TEST = "../../../apps/web/src/tutorial/progress.test.ts";
const WEB_TUTORIAL_LESSON_TESTS = [
  "../../../apps/web/src/tutorial/scripts/basics.test.ts",
  "../../../apps/web/src/tutorial/scripts/spells.test.ts",
  "../../../apps/web/src/tutorial/scripts/traps.test.ts",
  "../../../apps/web/src/tutorial/scripts/advanced.test.ts",
] as const;
/** R310 to R314's proofs: the viewer's own library list (§10.8) and the tutorial without Skip step. */
const WEB_PILE_BROWSER_TEST = "../../../apps/web/src/game/PileBrowser.test.tsx";
const WEB_PRACTICE_TUTORIAL_TEST = "../../../apps/web/src/routes/practice-tutorial.test.tsx";
const CARD_TESTS_R311 = [
  "../../cards/test/033-unstable-clone-machine.test.ts",
  "../../cards/test/090-cn-viral-injection.test.ts",
  "../../cards/test/042-eugenics.test.ts",
] as const;
const CARD_TESTS_R312 = [
  "../../cards/test/087-pocket-chaos.test.ts",
  "../../cards/test/083-transmogulate.test.ts",
  "../../ai/test/observe.test.ts",
] as const;
/** R320 to R322's proofs: tutorial progress and the hidden path on the account (§9.10). */
const SERVER_TUTORIAL_API_TEST = "../../../apps/server/test/api/tutorial.test.ts";
const SERVER_TUTORIAL_SQL = "../../../apps/server/test/sql/05_tutorial_progress.sql";
const SERVER_RLS_SQL = "../../../apps/server/test/sql/02_rls_as_client.sql";
const WEB_TUTORIAL_ACCOUNT_SYNC_TEST = "../../../apps/web/src/tutorial/accountSync.test.ts";
const WEB_PRACTICE_ROUTE_TEST = "../../../apps/web/src/routes/practice.test.tsx";
const WEB_TUTORIAL_PATH_TEST = "../../../apps/web/src/tutorial/TutorialPath.test.tsx";
/** R323's proof of the verifier itself; the auth-flow, redirect and login proofs are R192–R194's own. */
const WEB_PKCE_TEST = "../../../apps/web/src/auth/pkce.test.ts";
/** R315 to R319's proofs: the overflow events, what each seat reads of them, and how the board and the speakers play them. */
const OVERFLOW_EVENTS_TEST = "overflow-events.test.ts";
/** Patch v0.1.1's card proofs, R360–R366 (issue #27). */
const CARDS_LAVA_GOLEM_TEST = "../../cards/test/055-lava-golem.test.ts";
const CARDS_MROW_TEST = "../../cards/test/086-miss-mrow.test.ts";
const CARDS_FIENDER_TEST = "../../cards/test/092-felinor-fiender.test.ts";
const CARDS_TRANSMOGULATE_TEST = "../../cards/test/083-transmogulate.test.ts";
const CARDS_CARD_TEXT_TEST = "../../cards/test/card-text.test.ts";
/** The Classic #1–#45 cards' own tests (patch v0.2.0, the cards-classic-a workstream). */
const CLASSIC_007_TEST = "../../cards/test/classic/007-infiniscepter.test.ts";
const CLASSIC_009_TEST = "../../cards/test/classic/009-income-tax.test.ts";
const CLASSIC_010_TEST = "../../cards/test/classic/010-exile.test.ts";
const CLASSIC_015_TEST = "../../cards/test/classic/015-nose-hunter.test.ts";
const CLASSIC_PLUS_040_TEST = "../../cards/test/classic-plus/040-appropriations.test.ts";
const CLASSIC_PLUS_042_TEST = "../../cards/test/classic-plus/042-kys-test.test.ts";
const CLASSIC_PLUS_043_TEST = "../../cards/test/classic-plus/043-ai-slop.test.ts";
const CLASSIC_PLUS_044_TEST = "../../cards/test/classic-plus/044-simplicity-audit.test.ts";
const CLASSIC_PLUS_045_TEST = "../../cards/test/classic-plus/045-complexity-audit.test.ts";
const CLASSIC_PLUS_062_TEST = "../../cards/test/classic-plus/062-kys-papaya.test.ts";
const CLASSIC_PLUS_064_TEST = "../../cards/test/classic-plus/064-mulch-muncher.test.ts";
const CLASSIC_PLUS_065_2_TEST = "../../cards/test/classic-plus/065-2-normal-grape.test.ts";
const CLASSIC_PLUS_065_3_TEST = "../../cards/test/classic-plus/065-3-large-grape.test.ts";
const CLASSIC_PLUS_070_TEST = "../../cards/test/classic-plus/070-chaos-machine.test.ts";
const CLASSIC_PLUS_060_TEST = "../../cards/test/classic-plus/060-doctors-orders.test.ts";
const CLASSIC_PLUS_073_TEST = "../../cards/test/classic-plus/073-call-to-chaos-classic-edition.test.ts";
const CLASSIC_PLUS_073_1_TEST = "../../cards/test/classic-plus/073-1-classic-golem.test.ts";
const CLASSIC_PLUS_047_TEST = "../../cards/test/classic-plus/047-joggs-box.test.ts";
const CLASSIC_PLUS_052_TEST = "../../cards/test/classic-plus/052-jlockheeds-permanent-defense-contract.test.ts";
const CLASSIC_PLUS_074_TEST = "../../cards/test/classic-plus/074-twice-forward-one-step-backwards.test.ts";
const CLASSIC_PLUS_T_AI_06_TEST = "../../cards/test/classic-plus/t-ai-06-datacenter-fire.test.ts";
const CLASSIC_PLUS_T_AI_03_TEST = "../../cards/test/classic-plus/t-ai-03-hallucination.test.ts";
const CLASSIC_018_TEST = "../../cards/test/classic/018-glitch-in-the-system.test.ts";
const CLASSIC_025_TEST = "../../cards/test/classic/025-lag-in-the-system.test.ts";
const CLASSIC_028_TEST = "../../cards/test/classic/028-second-wind.test.ts";
const CLASSIC_032_TEST = "../../cards/test/classic/032-felinor-feelings.test.ts";
const CLASSIC_033_TEST = "../../cards/test/classic/033-joro.test.ts";
const CLASSIC_038_TEST = "../../cards/test/classic/038-jackiestan-auctioneer.test.ts";
const CLASSIC_039_TEST = "../../cards/test/classic/039-outbreak.test.ts";
/** The Classic+ #1–#39 cards' own tests (patch v0.2.0, the cards-plus-c workstream). */
const PLUS = (file: string): string => `../../cards/test/classic-plus/${file}.test.ts`;
const PLUS_002_TEST = PLUS("002-groom-shroom");
const PLUS_007_TEST = PLUS("007-the-house");
const PLUS_008_TEST = PLUS("008-withering-storm");
const PLUS_009_TEST = PLUS("009-silence");
const PLUS_010_TEST = PLUS("010-new-wraps");
const PLUS_012_6_TEST = PLUS("012-6-frozen-wastes");
const PLUS_012_7_TEST = PLUS("012-7-legion-of-the-hungry");
const PLUS_012_8_TEST = PLUS("012-8-frostspatula");
const PLUS_014_TEST = PLUS("014-forever");
const PLUS_019_TEST = PLUS("019-league-of-losers");
const PLUS_019_2_TEST = PLUS("019-2-jungle-loser");
const PLUS_019_3_TEST = PLUS("019-3-mid-loser");
const PLUS_019_5_TEST = PLUS("019-5-bot-loser");
const PLUS_022_TEST = PLUS("022-blood-moon");
const PLUS_025_TEST = PLUS("025-soul-shot");
const PLUS_026_TEST = PLUS("026-tommy-tempo");
const PLUS_027_TEST = PLUS("027-zephrys-zealotism");
const PLUS_029_TEST = PLUS("029-portal-to-the-past");
const PLUS_030_TEST = PLUS("030-felinor-fuser");
const PLUS_031_TEST = PLUS("031-fusion-lab");
const PLUS_033_TEST = PLUS("033-ivory-tower");
const PLUS_035_TEST = PLUS("035-rollback");
const PLUS_037_TEST = PLUS("037-wardrum");
const SERVER_LAST_BOARDS_TEST = "../../../apps/server/test/match/last-boards.test.ts";
/** Classic #46–#90's card-side proofs (cards-classic-b). */
const CLASSIC_048_TEST = "../../cards/test/classic/048-hired-shrimp.test.ts";
const CLASSIC_050_TEST = "../../cards/test/classic/050-voidwalker.test.ts";
const CLASSIC_057_TEST = "../../cards/test/classic/057-echo.test.ts";
const CLASSIC_058_TEST = "../../cards/test/classic/058-common-resources.test.ts";
const CLASSIC_062_TEST = "../../cards/test/classic/062-living-bomb.test.ts";
const CLASSIC_063_TEST = "../../cards/test/classic/063-crop-dusting.test.ts";
const CLASSIC_066_TEST = "../../cards/test/classic/066-eu-striker.test.ts";
const CLASSIC_078_TEST = "../../cards/test/classic/078-mutate-spell.test.ts";
const CLASSIC_088_TEST = "../../cards/test/classic/088-siphon-squad.test.ts";
const CLASSIC_090_TEST = "../../cards/test/classic/090-in-too-deep.test.ts";
const WEB_OVERFLOW_TEST = "../../../apps/web/src/game/overflow.test.tsx";
const WEB_ANIMATIONS_WINDOW_TEST = "../../../apps/web/src/game/animations.window.test.ts";
/** The migrations R105, R110, R111 and R112 live in (BUILD M6-T2, M7-T2). */
const SERVER_INVITES_SQL = "../../../apps/server/src/db/migrations/0001_profiles_and_invites.sql";
const SERVER_COLLECTION_SQL = "../../../apps/server/src/db/migrations/0002_collection.sql";
const SERVER_MATCHES_SQL = "../../../apps/server/src/db/migrations/0004_matches.sql";
const SERVER_LOADOUTS_SQL = "../../../apps/server/src/db/migrations/0003_loadouts.sql";

/**
 * The literal an `export const NAME = …` declares in a server source file, as written. Read rather
 * than imported for the reason `sourceOf` gives; `null` when the file has no such constant, so a
 * renamed constant reads as a missing value instead of a silent pass.
 */
function serverConstant(file: string, name: string): string | null {
  const found = new RegExp(`^export const ${name} = ([^;]+);`, "m").exec(sourceOf(file));
  return found?.[1]?.trim() ?? null;
}

describe("SPEC §11 rulings, every row (BUILD M3 gate, REVIEW B4)", () => {
  // Proved by rulings-a.test.ts "R1 fires Cry only on a play from hand or a cast, never on a summon, Recruit
  // or Transform"; effects-summon.test.ts "R1 fires no Cry".
  it("R1 fires Cry only on a play from hand or a cast", () => {
    expect(config.CRY_ON_PLAY_ONLY).toBe(true);
    provenIn(1, "rulings-a.test.ts", "effects-summon.test.ts");
  });

  // Proved by rulings-a.test.ts "R2 counts the cap in player-turns: 60 turns, 30 each (R389), then the
  // game is a draw" — patch v0.2.0 doubled the cap (R389).
  it("R2 counts the turn cap in player-turns: 60, so 30 each (R389)", () => {
    expect(config.TURN_CAP_PLAYER_TURNS).toBe(60);
    expect(config.TURN_CAP_PLAYER_TURNS / 2).toBe(30);
    provenIn(2, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R3 makes the Nth draw from an empty library deal N damage to that hero";
  // config.test.ts "R3 fatigue deals N on the Nth empty draw".
  it("R3 deals N damage on the Nth draw from an empty library", () => {
    expect([1, 2, 3, 4].map(config.FATIGUE_DAMAGE)).toEqual([1, 2, 3, 4]);
    provenIn(3, "rulings-a.test.ts", "config.test.ts");
  });

  // Proved by rulings-a.test.ts "R4 caps the hand at 10 and burns an extra draw to the graveyard";
  // callToChaos.test.ts "R4 a full hand burns what the draw and the added cards cannot fit";
  // effects-cost.test.ts and the cards package's hand-returns.test.ts "R4 …" (a burned card keeps
  // its cost: #31's +1 and #37r's 1 less are the price of a return it never made).
  it("R4 caps the hand at 10 and burns the overflow to the graveyard", () => {
    expect(config.HAND_CAP).toBe(10);
    provenIn(4, "rulings-a.test.ts", "callToChaos.test.ts", "effects-cost.test.ts", CARDS_HAND_RETURNS_TEST);
  });

  // Proved by rulings-a.test.ts "R5 does not restrict attacks by lane: any unit may attack any enemy unit or
  // the hero"; combat-validation.test.ts "R5 lets a lane-1 unit attack an enemy in lane 5, since attacks
  // are not lane-restricted".
  it("R5 does not restrict attacks by lane", () => {
    expect(config.LANE_RESTRICTED_ATTACKS).toBe(false);
    provenIn(5, "rulings-a.test.ts", "combat-validation.test.ts");
  });

  // Proved by rulings-a.test.ts "R6 refuses an attack from Defense Position, and switching to Attack spends
  // the exertion"; combat-positions.test.ts "R6 a unit that switched position cannot attack that turn".
  it("R6 refuses an attack from Defense Position, and a switch spends the turn's exertion", () => {
    provenIn(6, "rulings-a.test.ts", "combat-positions.test.ts");
  });

  // Proved by rulings-a.test.ts "R7 refuses an attack declared by a 0-attack unit"; combat-validation.test.ts
  // "R7 refuses a unit with 0 attack", "R7 never lets Big D-fender (0 attack) be an attacker".
  it("R7 refuses an attack declared by a 0-attack unit", () => {
    provenIn(7, "rulings-a.test.ts", "combat-validation.test.ts");
  });

  // Proved by rulings-a.test.ts "R8 fires Death on both deaths of a Reborn unit"; statecheck.test.ts "R8,
  // R64: a Reborn unit reserves its zone, a Death-trigger summon lands elsewhere, and Death fires on both
  // deaths".
  it("R8 fires Death on both deaths of a Reborn unit", () => {
    provenIn(8, "rulings-a.test.ts", "statecheck.test.ts");
  });

  // Proved by rulings-a.test.ts "R9 draws the mulligan replacements before the returned cards are shuffled
  // back in"; setup.test.ts "R9: replacements are drawn before the returned cards are shuffled back".
  it("R9 draws the mulligan replacements before shuffling the returned cards back in", () => {
    expect(config.MULLIGAN_ORDER).toBe("draw-then-shuffle");
    provenIn(9, "rulings-a.test.ts", "setup.test.ts");
  });

  // Proved by rulings-a.test.ts "R10 gives the first player their turn-1 draw".
  it("R10 gives the first player their turn-1 draw", () => {
    provenIn(10, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R11 vanishes a unit token off the field while a spell token reaches the
  // graveyard"; effects-destroy.test.ts "R11 a destroyed unit token vanishes and reaches no graveyard",
  // "R11 a sacrificed unit token vanishes and enters no graveyard"; effects-move.test.ts "R11 an exiled
  // unit token vanishes and never enters the exile pile", "R11 a bounced unit token vanishes instead of
  // reaching a hand", and 2 more.
  it("R11 vanishes a unit token that leaves the field, while a spell token reaches the graveyard", () => {
    provenIn(11, "rulings-a.test.ts", "effects-destroy.test.ts", "effects-move.test.ts");
  });

  // Proved by rulings-a.test.ts "R12 keeps ownership off the field: a stolen unit dies to its owner's
  // graveyard"; effects-steal.test.ts "R12 keeps the owner, so a stolen unit that dies goes to its owner's
  // graveyard"; effects-move.test.ts "R12 a stolen unit is exiled to its owner's pile", "R12 a stolen unit
  // bounces to its owner's hand, not the controller's", and 1 more.
  it("R12 keeps hand, library, graveyard and exile with the owner, control only on the field", () => {
    provenIn(12, "rulings-a.test.ts", "effects-steal.test.ts", "effects-move.test.ts");
  });

  // Proved by rulings-a.test.ts "R13 keeps a card under a Stack off the field: it neither acts nor can be
  // targeted"; combat-validation.test.ts "R13 refuses an attack by a card dormant under a Stack (§3.2)",
  // "R13 refuses a dormant card under a Stack as a target too (§3.2)"; effects-radiant.test.ts "R13 offers
  // only the top of a Stack pile, never the dormant card beneath"; the cards package's
  // stacks-and-reborn.test.ts "R13 …" (§4.5's check never collects a dormant card).
  it("R13 keeps a card dormant under a Stack off the field", () => {
    provenIn(13, "rulings-a.test.ts", "combat-validation.test.ts", "effects-radiant.test.ts", CARDS_STACKS_AND_REBORN_TEST);
  });

  // M4 owns #52 Silly Silas itself; the rotation subsystem is the machinery its script calls.
  // Proved by rulings-a.test.ts "R14 rotates two independent rings, bounces a Locked destination and carries
  // damage and buffs"; rotation.test.ts "R14 rotates the unit ring one step right, so your lane 5 crosses
  // to the opponent's lane 5", "R14 rotates left as the mirror of right, so your lane 1 crosses to the
  // opponent's lane 1", and 5 more.
  it("R14 rotates two independent rings, bounces a Locked destination, and carries damage and buffs", () => {
    expect(config.ROTATION_RING).toBe("two-rings");
    provenIn(14, "rulings-a.test.ts", "rotation.test.ts");
  });

  // Proved by rulings-a.test.ts "R15 steals into the same lane when it is free, else the first free zone,
  // leaving the excess"; effects-steal.test.ts "R15 takes the same lane when it is free, and moves control
  // only", "R15 falls back to the first free zone when the same lane is taken or Locked", and 2 more.
  it("R15 steals into the same lane when it is free, else the first free zone, and leaves the excess", () => {
    provenIn(15, "rulings-a.test.ts", "effects-steal.test.ts");
  });

  // Proved by rulings-a.test.ts "R16 makes a discard the player's choice unless the card says random";
  // effects-move.test.ts "R16 a named card goes from the hand to the graveyard", "R16 the random form draws
  // its pick from the match rng", and 2 more.
  it("R16 makes a discard the player's choice unless the card says random", () => {
    provenIn(16, "rulings-a.test.ts", "effects-move.test.ts");
  });

  // M4 owns #41 Sheepish, #60, #33 and #85: their card tests prove the timing on the real scripts.
  // Proved by rulings-a.test.ts "R17 fires a trap on the play before the Cry, and an Immutable target still
  // consumes it".
  it("R17 fires Sheepish before the Cry and the other traps after the card resolves", () => {
    provenIn(17, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R18 makes a health loss skip Armor, the hero cap and the damage pipeline";
  // damage.test.ts "R18: lose health bypasses Armor, the hero cap and the damage event".
  it("R18 makes a health loss skip Armor, the hero cap and the damage pipeline", () => {
    provenIn(18, "rulings-a.test.ts", "damage.test.ts");
  });

  // Proved by rulings-a.test.ts "R19 lets a heal name any unit or hero on either side"; effects-heal.test.ts
  // "R19: heal X takes damage off a unit and never past its max health", "R19: heal X gives a hero health
  // with no cap, on either side (#5, #47)".
  it("R19 lets a heal name any unit or hero on either side", () => {
    provenIn(19, "rulings-a.test.ts", "effects-heal.test.ts");
  });

  // Proved by rulings-a.test.ts "R20 spends no exertion when an effect switches a position";
  // combat-positions.test.ts "R20 a unit switched by a spell keeps its exertion".
  it("R20 spends no exertion when an effect switches a position", () => {
    provenIn(20, "rulings-a.test.ts", "combat-positions.test.ts");
  });

  // Proved by rulings-a.test.ts "R21 draws random keywords from the thirteen-entry pool and never repeats one
  // on a unit"; effects-buff.test.ts "R21 draws from the pool, never repeats within one grant, and is
  // seeded", "R21 never grants a keyword the unit already has, from any source", and 1 more.
  it("R21 draws random keywords from the thirteen-entry pool and never repeats one on a unit", () => {
    expect(config.RANDOM_KEYWORD_POOL).toEqual([
      "Taunt",
      "Armor 1",
      "Rush",
      "Charge",
      "First Strike",
      "Poisonous",
      "Lifesteal",
      "Reborn",
      "Divine Shield",
      "Trample",
      "Cleave",
      "Pierce",
      "Windfury",
    ]);
    expect(new Set(config.RANDOM_KEYWORD_POOL).size).toBe(13);
    provenIn(21, "rulings-a.test.ts", "effects-buff.test.ts");
  });

  // Proved by rulings-a.test.ts "R22 swaps the base layer on the field, keeps damage and buffs, and re-fires
  // no Cry"; effects-radiant.test.ts "R22 swaps the base-stat layer at once, keeps damage and buffs, and
  // re-fires no Cry", "R22 applies a keyword the radiant face adds at once", and 1 more.
  it("R22 swaps the base layer on the field, keeps damage and buffs, and re-fires no Cry", () => {
    provenIn(22, "rulings-a.test.ts", "effects-radiant.test.ts");
  });

  // Proved by rulings-a.test.ts "R23 blocks Vanilla, Transform and Fuse-onto on an Immutable card while
  // Radiant still works"; effects-transform.test.ts "R23 refuses a Transform on an Immutable card, printed
  // or granted", "R23 refuses a Vanilla on an Immutable card, printed or granted".
  it("R23 blocks Vanilla, Transform and Fuse-onto on an Immutable card while Radiant still works", () => {
    provenIn(23, "rulings-a.test.ts", "effects-transform.test.ts");
  });

  // M4 owns #30 Archivist: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R24 reads costs per R65 for highest and lowest, and ties go to the card
  // nearest the top".
  it("R24 reads costs per R65 for highest and lowest, and breaks ties nearest the top", () => {
    provenIn(24, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R25 clamps the Fib index at Fib(11) = 89"; config.test.ts "R25 Fib index
  // clamps at 11 (89)".
  it("R25 clamps the Fib index at Fib(11) = 89", () => {
    expect(config.FIB).toHaveLength(12);
    expect([11, 12, 99].map(config.fib)).toEqual([89, 89, 89]);
    expect([0, 1, 2, 7].map(config.fib)).toEqual([0, 1, 1, 13]);
    provenIn(25, "rulings-a.test.ts", "config.test.ts");
  });

  // M4 owns #94 Genn's Greed: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R26 reads Genn's Greed as 'exile all odd-cost cards'".
  it("R26 reads Genn's Greed as “exile all odd-cost cards”", () => {
    expect(config.GENN_GREED_EXILES).toBe("odd");
    provenIn(26, "rulings-a.test.ts");
  });

  // M4 owns #93 Combo-Index; the subsystem test is the machinery its script calls.
  // Proved by comboIndex.test.ts "R27 runs every step from E up to the new grade, in order", "R27 the E→S
  // cascade runs each step in order once it reaches S", and 2 more.
  it("R27 runs Combo-Index E to the new grade in order, and makes grade S terminal", () => {
    provenIn(27, "comboIndex.test.ts");
  });

  // M4 owns #95 Call to Chaos; the subsystem test is the machinery its script calls.
  // Proved by callToChaos.test.ts "R28 the base form rolls exactly one of the ten effects, and all ten are
  // reachable", "R28 the radiant form rolls two effects: the recursion plus one of the other nine", and 4
  // more.
  it("R28 caps the Call to Chaos chain at 20 and pairs the recursion with one of the other nine", () => {
    expect(config.CALL_TO_CHAOS_CHAIN_CAP).toBe(20);
    provenIn(28, "callToChaos.test.ts");
  });

  // M4 owns #97 Zephyrs; the scorer subsystem is the machinery its script calls.
  // Proved by rulings-a.test.ts "R29 ranks every non-token Core card except #97 and offers the top three";
  // scorer.test.ts "R29 ranks every non-token Core definition except #97 itself", "R29 is deterministic:
  // the same state always produces the same order", and 6 more.
  it("R29 ranks every non-token Core card except #97 and offers the top three", () => {
    provenIn(29, "rulings-a.test.ts", "scorer.test.ts");
  });

  // M4 owns #79 Twinspell: its card test proves the lifetime on the real script.
  // Proved by rulings-a.test.ts "R30 keeps a Twinspell Echo until a Spell is played, then sends Twinspell to
  // the graveyard".
  it("R30 keeps a Twinspell Echo until a Spell is played, then sends Twinspell to the graveyard", () => {
    provenIn(30, "rulings-a.test.ts");
  });

  // M4 owns #76 Field of Dreams: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R31 sends a replaced hand to the graveyard, where Reminisce can still find
  // it".
  it("R31 sends a hand replaced by Field of Dreams to the graveyard", () => {
    provenIn(31, "rulings-a.test.ts");
  });

  // M4 owns #4 Lucky: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R32 leaves a coin-stat effect alone: Lucky has no defined best, so it
  // changes nothing".
  it("R32 leaves a coin-stat effect alone, since Lucky has no defined best", () => {
    provenIn(32, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R33 shows a face-down trap to its current controller only, and a fired Field
  // Trap to both"; effects-swap.test.ts "R33 a swapped face-down trap stays face-down and is readable by
  // its new controller only"; rotation.test.ts "R33 a face-down trap that crosses answers to its new
  // controller and stays face down".
  it("R33 shows a face-down trap to its current controller only, and a fired Field Trap to both", () => {
    provenIn(33, "rulings-a.test.ts", "effects-swap.test.ts", "rotation.test.ts");
  });

  // M4 owns #33 Unstable Clone Machine: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R34 copies token cards too: a unit-token card and a spell token both reach
  // the library".
  it("R34 copies token cards too, spell tokens and unit-token cards alike", () => {
    provenIn(34, "rulings-a.test.ts");
  });

  // M4 owns #83 Transmogulate and its pool: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R35 replaces a board card in place with its own type, and the replaced card
  // ceases to exist"; effects-transform.test.ts "R35 the replaced card ceases to exist: no graveyard, no
  // exile and no Death", "R35 replaces a hand card and keeps a library card at its index"; the cards
  // package's hidden-information.test.ts "R35 …" (an Immutable library card is replaced too).
  it("R35 replaces a board card in place with its own type, and the replaced card ceases to exist", () => {
    provenIn(35, "rulings-a.test.ts", "effects-transform.test.ts", CARDS_HIDDEN_INFORMATION_TEST);
  });

  // Proved by rulings-a.test.ts "R36 lets only the active player offer a draw, once a turn, and a decline
  // blocks 3 of their turns".
  it("R36 lets only the active player offer a draw, once a turn, and blocks a decliner for three turns", () => {
    expect(config.DRAW_OFFERS_PER_TURN).toBe(1);
    expect(config.DRAW_OFFER_BLOCK_TURNS).toBe(3);
    provenIn(36, "rulings-a.test.ts");
  });

  // M4 owns #18 and the token catalog row: the card test proves the name and cost.
  // Proved by rulings-a.test.ts "R37 gives the unnamed X/X token its stats through statsOverride, at cost 0".
  it("R37 names the unnamed X/X token Bread Token, cost 0, with no text", () => {
    provenIn(37, "rulings-a.test.ts");
  });

  // M4 owns #89 Corpse Eater: its card test proves the stat source on the real script.
  // Proved by rulings-a.test.ts "R38 feeds a hand trigger from a unit reaching a graveyard, and never from a
  // token".
  it("R38 feeds Corpse Eater the dying unit's current attack and max health", () => {
    provenIn(38, "rulings-a.test.ts");
  });

  // M4 owns #92 Felinor Fiender: its card test proves the stat mode on the real script.
  // Proved by rulings-a.test.ts "R39 gives Felinor Fiender printed plus the sum of your Felinors, never below
  // printed".
  it("R39 gives Felinor Fiender printed stats plus the sum of your Felinors, never below printed", () => {
    expect(config.FIENDER_STATS_MODE).toBe("printed-plus-sum");
    provenIn(39, "rulings-a.test.ts");
  });

  // M4 owns #21, #27 and #90.1: their card tests prove Combo counting on the real scripts.
  // Proved by rulings-a.test.ts "R40 counts a cast-on-draw cast as a card played this turn, at cost 0".
  it("R40 counts a cast-on-draw cast as a card played this turn, at cost 0", () => {
    provenIn(40, "rulings-a.test.ts");
  });

  // M4 owns #22 Carnivorous Cube: its card test proves the meal on the real script.
  // Proved by rulings-a.test.ts "R41 gives Carnivorous Cube a meal it never takes from itself, and a Death
  // that can do nothing".
  it("R41 never lets Carnivorous Cube eat itself, and makes it eat if able", () => {
    provenIn(41, "rulings-a.test.ts");
  });

  // M4 owns #32: its card test proves the trigger on the real script.
  // Proved by rulings-a.test.ts "R42 records the unit whose damage instance was lethal, Cleave hits
  // included".
  it("R42 reads “destroys a unit” as a death whose lethal damage instance came from this unit", () => {
    provenIn(42, "rulings-a.test.ts");
  });

  // M4 owns #98 Heroic Power: its card test proves the power list and the once-a-turn use.
  // Proved by rulings-b.test.ts "R43 stores Heroic Power's power on the instance, costs its X, uses it once a
  // turn and recruits a permanent"; setup.test.ts "R43: Heroic Power rolls its power during setup,
  // deterministically from the seed", "R43 rolls a power for a Heroic Power the mulligan returned to the
  // library"; mana.test.ts "R43 gives Heroic Power the cost of its power".
  it("R43 stores Heroic Power's rolled power on the instance and costs its X", () => {
    provenIn(43, "rulings-b.test.ts", "setup.test.ts", "mana.test.ts");
  });

  // M4 owns #96 My Pawn: its card test proves the cancel on the real trap script.
  // Proved by rulings-b.test.ts "R44 projects lethal after Armor, the cap and Trample excess, and the policy
  // draws from legalActions"; lethal.test.ts "R44 projects a plain hit on the hero as the attacker's
  // attack", "R44 subtracts the defending hero's Armor before the comparison (§4.4 step 2)", and 5 more;
  // aiPolicy.test.ts "R44 returns the same action sequence for the same state and seed", "R44 ends the turn
  // when nothing else is on offer, and takes no rng draw to decide it", and 5 more.
  it("R44 projects lethal after Armor, the Anti-oneshot cap and Trample excess, then cancels the attack", () => {
    expect(config.ANTI_ONESHOT_CAP).toEqual({ base: 5, radiant: 3 });
    provenIn(44, "rulings-b.test.ts", "lethal.test.ts", "aiPolicy.test.ts");
  });

  // Proved by rulings-b.test.ts "R45 keeps players as a map, so the seats and 'each opposing hero' are read
  // from it, not hard-coded".
  it("R45 keeps players as a map, so the seats and “each opposing hero” are read from it", () => {
    provenIn(45, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R46 turns a would-destroy Indestructible unit to Attack Position without
  // Taunt, and leaves a Field Spell alone"; statecheck.test.ts "R46: an Indestructible unit destroyed by an
  // effect is in Attack Position with no Taunt until end of turn", "R46 leaves an Indestructible Field
  // Spell where it is and drops the mark"; effects-destroy.test.ts "R46 an Indestructible unit ignores a
  // destroy mark and stays on the field".
  it("R46 turns a would-destroy Indestructible unit to Attack Position without Taunt", () => {
    provenIn(46, "rulings-b.test.ts", "statecheck.test.ts", "effects-destroy.test.ts");
  });

  // Proved by rulings-b.test.ts "R47 fizzles a lane-targeted summon into an occupied or Locked zone, and
  // holds a Reborn unit's zone"; statecheck.test.ts "R47: Reborn into a zone that was Locked meanwhile
  // fails silently", "R47 says so in the event stream when a Reborn return fizzles into a Locked zone";
  // effects-summon.test.ts "R47 a lane-named summon fizzles on an occupied or a Locked zone".
  it("R47 fizzles a lane-targeted summon into an occupied or Locked zone", () => {
    provenIn(47, "rulings-b.test.ts", "statecheck.test.ts", "effects-summon.test.ts");
  });

  // M4 owns #77 Professor Curvature: its card test proves the discount on the real script.
  // Proved by rulings-b.test.ts "R48 applies Professor Curvature to a card whose cost is 4 once the other
  // modifiers have landed"; mana.test.ts "R48 a next-turn discount does nothing on the turn it was
  // created"; turn.test.ts "R48 keeps a next-turn modifier through its own turn and drops it after the next
  // one".
  it("R48 applies Professor Curvature to a card whose current cost is 4 at play time", () => {
    provenIn(48, "rulings-b.test.ts", "mana.test.ts", "turn.test.ts");
  });

  // M4 owns #45 Deft Duelist: its card test proves the second exertion on the real script.
  // Proved by rulings-b.test.ts "R49 gives Deft Duelist two exertions, one attack and one switch, where a
  // plain unit has one"; combat-positions.test.ts "R49 Deft Duelist attacks and switches in one turn".
  it("R49 gives Deft Duelist two exertions: one attack and one switch a turn", () => {
    provenIn(49, "rulings-b.test.ts", "combat-positions.test.ts");
  });

  // M4 owns #72 Reminisce: its card test proves the Discover on the real script.
  // Proved by rulings-b.test.ts "R50 discovers from the actual graveyard, so a spell token sitting there is
  // eligible"; effects-choose.test.ts "R50 Discover from the graveyard offers the cards actually in your
  // own graveyard".
  it("R50 discovers from the actual graveyard, so a spell token sitting there is eligible", () => {
    provenIn(50, "rulings-b.test.ts", "effects-choose.test.ts");
  });

  // M4 owns #13: its card test proves the spread on the real script.
  // Proved by rulings-b.test.ts "R51 gives 'all enemies' one damage instance to every enemy unit and one to
  // the enemy hero".
  it("R51 gives “all enemies” one damage instance each, the enemy hero included", () => {
    provenIn(51, "rulings-b.test.ts");
  });

  // M4 owns #18 Bread and Butter: its card test proves the beneficiary on the real script.
  // Proved by rulings-b.test.ts "R52 gives the end-of-turn token to the trap's controller, whoever ended the
  // turn with mana".
  it("R52 gives the end-of-turn token to the trap's controller", () => {
    provenIn(52, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R53 forces an attack past the validator, spends no exertion, and stops once
  // the target is gone"; combat-resolution.test.ts "R53 Moths pulls a summoning-sick enemy into an attack
  // without spending its exertion", "R53 a forced attack ignores position, sickness and the Taunt rule",
  // and 3 more.
  it("R53 runs a forced attack past the validator, with no exertion and its own state check", () => {
    provenIn(53, "rulings-b.test.ts", "combat-resolution.test.ts");
  });

  // M4 owns #82 KY's Trial: its card test proves the roll on the real script.
  // Proved by rulings-b.test.ts "R54 never offers a token index or the generating card's own index in a
  // random pool".
  it("R54 rolls only 1–100, rerolls its own index and never a token index", () => {
    provenIn(54, "rulings-b.test.ts");
  });

  // M4 owns #100 Ceaseless Void: its card test proves the counters on the real script.
  // Proved by rulings-b.test.ts "R55 counts both players' draws, plays, destructions and exiles from the
  // start of the game".
  it("R55 counts both players' draws, plays, destructions and exiles from the start of the game", () => {
    provenIn(55, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R56 reports the cost actually paid after modifiers, which is what a cost
  // threshold reads".
  it("R56 reads a cost threshold off the cost actually paid after modifiers", () => {
    provenIn(56, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R57 makes a shuffled-in copy a fresh instance carrying the radiant flag, and
  // a field copy keep statsOverride".
  it("R57 keeps a field copy's flag, buffs and statsOverride, and makes a shuffled-in copy fresh", () => {
    provenIn(57, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R58 casts at most CAST_ON_DRAW_CHAIN_CAP cards in one draw, casts on a full
  // hand, and draws N times for 'draw N'"; draw.test.ts "R58 casts a cast-on-draw card even when the hand
  // is full"; callToChaos.test.ts "R58 draws the library it had when the effect started and gains 4 mana".
  it("R58 casts at most CAST_ON_DRAW_CHAIN_CAP cards per draw, even on a full hand", () => {
    expect(config.CAST_ON_DRAW_CHAIN_CAP).toBe(20);
    provenIn(58, "rulings-b.test.ts", "draw.test.ts", "callToChaos.test.ts");
  });

  // Proved by rulings-b.test.ts "R59 runs the state check after a whole effect, never between its hits, and
  // calls two dead heroes a draw"; statecheck.test.ts "R59: the check runs after a whole effect, not
  // between its hits", "R59: both heroes at 0 in one check is a draw, one hero at 0 is a loss";
  // endgame.test.ts "R59: one effect that leaves both heroes at 0 is a draw".
  it("R59 runs the state check after each whole effect, never between its hits, and calls two dead heroes a draw", () => {
    provenIn(59, "rulings-b.test.ts", "statecheck.test.ts", "endgame.test.ts");
  });

  // Proved by rulings-b.test.ts "R60 picks different cards among the non-Radiant ones, all of them when fewer
  // exist, and none when none are left"; effects-radiant.test.ts "R60 chooses only among non-Radiant
  // cards", "R60 changes no card and draws nothing when no non-Radiant card is left, though the hidden
  // hand is cued", and 1 more; comboIndex.test.ts "R60 grade D makes 2 different random hand cards cost
  // 1 less", "R60 grade B picks only among non-Radiant hand cards, and changes none when none are left,
  // though it cues the hand". The cues are R177's: a pick over a hidden zone is cued whatever it changed.
  it("R60 picks different cards, all of them when fewer exist, and changes none when none are left", () => {
    provenIn(60, "rulings-b.test.ts", "effects-radiant.test.ts", "comboIndex.test.ts");
  });

  // M4 owns #85 Unlicensed Experimentation: its card test proves the trigger on the real script.
  // Proved by rulings-b.test.ts "R61 emits cardPlayed only for a play or a cast, refuses an Immutable Fuse
  // target, and consumes a trap that does nothing".
  it("R61 fires Unlicensed Experimentation only on the opponent's played permanent, after its Cry", () => {
    provenIn(61, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R62 ends a turn as triggers, then the trap window on both sides, then
  // delayed effects, then cleanup"; turn.test.ts "R62 runs a turn in order: refresh, start triggers, draw,
  // then end of turn"; comboIndex.test.ts "R62 the rise is an ordinary end-of-turn trigger, so ending the
  // turn runs the cascade".
  it("R62 runs the turn in §11 order: triggers, then the end-of-turn trap window, then delayed effects, then cleanup", () => {
    provenIn(62, "rulings-b.test.ts", "turn.test.ts", "comboIndex.test.ts");
  });

  // Proved by rulings-b.test.ts "R63 tramples only the excess, cleaves past a stopped hit, ignores zero hits
  // and lifesteals the total once"; damage.test.ts "R63 gives Fed Fauci one Plague Token per damage
  // instance, and none for an instance Armor zeroed"; effects-damage.test.ts "R63 an amount of 0 or less is
  // not a damage instance at all".
  it("R63 tramples only the excess, cleaves past a stopped hit, and makes a zero hit no damage instance", () => {
    provenIn(63, "rulings-b.test.ts", "damage.test.ts", "effects-damage.test.ts");
  });

  // Proved by rulings-b.test.ts "R64 summons into the leftmost open zone, fills the board left to right, and
  // reserves a Reborn unit's zone"; effects-summon.test.ts "R64 takes the leftmost empty unlocked zone of
  // its row with no zone named", "R64 skips a Locked zone and one reserved for a Reborn unit", and 2 more.
  it("R64 summons into the leftmost open zone, fills left to right, and reserves a dying Reborn unit's zone", () => {
    provenIn(64, "rulings-b.test.ts", "effects-summon.test.ts");
  });

  // Proved by rulings-b.test.ts "R65 reads costOverride, then costMod, then the player's discounts, then
  // Curvature, floored at 0"; mana.test.ts "R65 prefers costOverride over the printed cost, then applies
  // costMod", "R65 applies a player discount, and only to the types it names", and 4 more;
  // effects-cost.test.ts "R65 adds to the instance's costMod and reports the new effective cost", "R65: the
  // cost the event reports is the effective one, with the player's discount included", and 4 more.
  it("R65 computes a cost as override, then costMod, then discounts, then Curvature, floored at 0", () => {
    provenIn(65, "rulings-b.test.ts", "mana.test.ts", "effects-cost.test.ts");
  });

  // M4 owns #94 Genn's Greed: its card test proves both halves on the real script.
  // Proved by rulings-b.test.ts "R66 reads Genn's Greed costs per R65 at resolution and exempts X-cost cards
  // from both halves".
  it("R66 reads Genn's Greed costs per R65 at resolution and exempts X-cost cards from both halves", () => {
    provenIn(66, "rulings-b.test.ts");
  });

  // M4 owns #31 KY's Math Equation: its card test proves the index on the real script.
  // Proved by rulings-b.test.ts "R67 takes KY's Math Equation's Fib index from printed cost plus costMod plus
  // 1, ignoring discounts".
  it("R67 takes KY's Math Equation's Fib index from printed cost plus costMod plus 1", () => {
    provenIn(67, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R68 orders triggers active side first, units by lane, then backrow, hand and
  // graveyard, delayed by creation"; turn.test.ts "R68 resolves two end-of-turn triggers on one side in
  // lane order"; statecheck.test.ts "R68: one effect kills six units in one check and fires six Death
  // triggers, active side first, then lane order"; the cards package's tributes.test.ts "R68 …" (a
  // Tribute's Deaths in lane order, whatever order the play lists them in).
  it("R68 orders triggers by side, then lane, then hand and graveyard, and delayed effects by creation", () => {
    provenIn(68, "rulings-b.test.ts", "turn.test.ts", "statecheck.test.ts", CARDS_TRIBUTES_TEST);
  });

  // Proved by rulings-b.test.ts "R69 collects an Indestructible unit whose max health falls to 0, and leaves
  // one merely at 0 health"; statecheck.test.ts "R69: an Indestructible unit at 0 max health dies and
  // counts as destroyed, one at 0 health with max health above 0 stays".
  it("R69 collects an Indestructible unit whose max health falls to 0, and leaves one merely at 0 health", () => {
    provenIn(69, "rulings-b.test.ts", "statecheck.test.ts");
  });

  // Proved by rulings-b.test.ts "R70 makes a cast free, counts it as a play, fires the card's Cry and sends a
  // Spell to the graveyard"; turn.test.ts "R70 a cast counts as a play and pays nothing";
  // callToChaos.test.ts "R70 casts a random Call to Chaos: free, counted as a play, and its script
  // resolves".
  it("R70 makes a cast free, counts it as a play and fires the card's Cry", () => {
    provenIn(70, "rulings-b.test.ts", "turn.test.ts", "callToChaos.test.ts");
  });

  // M4 owns #39 Recycling Initiative: its card test proves the copy set on the real script.
  // Proved by rulings-b.test.ts "R71 copies every other card played this turn at end of turn, including the
  // ones played after it".
  it("R71 copies every other card played this turn at end of turn, the later ones included", () => {
    provenIn(71, "rulings-b.test.ts");
  });

  // M4 owns #40 and #70: their card tests prove the counts on the real scripts.
  // Proved by rulings-b.test.ts "R72 keeps exile piles with their owners and lets a hero climb above the 30
  // that missing health counts from".
  it("R72 reads “cards in exile” as your own pile and counts missing health from 30", () => {
    expect(config.HERO_HEALTH).toBe(30);
    provenIn(72, "rulings-b.test.ts");
  });

  // M4 owns #87 Pocket Chaos: its card test proves the three swaps on the real script.
  // Proved by rulings-b.test.ts "R73 gives Pocket Chaos its three swaps: armor apart from health, locks with
  // the zone, a trap read by its controller, and owner-routed libraries"; effects-swap.test.ts "R73 swaps
  // hero health and leaves each hero's armor where it was", "R73 swaps board contents lane by lane in both
  // rows, with control moving and nothing resetting", and 3 more.
  it("R73 gives Pocket Chaos its three swaps: health apart from armor, board with locks, libraries with owners", () => {
    provenIn(73, "rulings-b.test.ts", "effects-swap.test.ts");
  });

  // Proved by rulings-b.test.ts "R74 models Radiant as a flag that never unsets, swaps the layer in place,
  // and rides copies and formless cards"; effects-radiant.test.ts "R74 sets the flag on a card whose
  // radiant form is the same as its base".
  it("R74 models Radiant as a flag that never unsets, with an in-place layer swap and no Cry", () => {
    provenIn(74, "rulings-b.test.ts", "effects-radiant.test.ts");
  });

  // M4's catalog.test.ts diffs the whole catalog against the §8 fixture.
  // Proved by rulings-b.test.ts "R75 keeps the §5.3 corrections in the catalog shape: a set and type on every
  // def, the Felinor tag, N.1 indexes and cost 6".
  it("R75 keeps the §5.3 catalog corrections in the catalog shape", () => {
    provenIn(75, "rulings-b.test.ts");
  });

  // M4 owns #50 K-Pop Fanatic: its card test proves the delay on the real script.
  // Proved by rulings-b.test.ts "R76 fires the delayed steal at your next start of turn even though the unit
  // died, and fizzles on a card already yours".
  it("R76 fires the delayed steal at your next start of turn even after the unit died", () => {
    provenIn(76, "rulings-b.test.ts");
  });

  // M4 owns #85 and #99; the fuse subsystem is the machinery their scripts call.
  // Proved by rulings-b.test.ts "R77 fuses the base forms, keeps the target's instance, sums buffs, and
  // crafts a free non-Radiant hand card", and by re-entry.test.ts "R77 …": the kept card's memory
  // is as it was but for the meal its Cube text remembered, moved to that text's place (R102).
  it("R77 fuses into a transient definition whose cost is capped at FUSE_COST_CAP", () => {
    expect(config.FUSE_COST_CAP).toBe(4);
    provenIn(77, "rulings-b.test.ts", CARDS_RE_ENTRY_TEST);
  });

  // Proved by rulings-b.test.ts "R78 resets an instance as it leaves the field while costMod, costOverride
  // and radiant persist"; statecheck.test.ts "R78: a Reborn unit returns reset, at 1 health without Reborn,
  // and its Cry does not fire", "R78 a Death trigger reads what the unit remembered before it left the
  // field"; effects-move.test.ts "R78 exile resets the instance but keeps costMod and radiant", "R78
  // returns a unit to its owner's hand and drops its damage, buffs and position".
  it("R78 resets an instance as it leaves the field, while costMod, costOverride and radiant persist", () => {
    provenIn(78, "rulings-b.test.ts", "statecheck.test.ts", "effects-move.test.ts");
  });

  // M7 owns apps/server/src/config.ts: the server test proves the clocks, the rating and the room codes.
  // Proved by rulings-b.test.ts "R79 answers only the timed-out player's prompt, loses on a disconnect, draws
  // at the ceiling, and leaves the clocks to the server".
  it("R79 leaves the match-lifecycle defaults to the server config", () => {
    provenIn(79, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R80 caps a library at LIBRARY_CAP: a new card is never created and an
  // existing one lands in the graveyard"; callToChaos.test.ts "R80 no chaos effect creates a library card,
  // so a full library only ever shrinks".
  it("R80 caps a library at LIBRARY_CAP, creating no new card and routing an existing one", () => {
    expect(config.LIBRARY_CAP).toBe(60);
    provenIn(80, "rulings-b.test.ts", "callToChaos.test.ts");
  });

  // Proved by rulings-b.test.ts "R81 carries zone, X, targets and modes in the play action, and opens a
  // PendingChoice only during resolution"; playChoices-filters.test.ts "R81 filters a hand declaration by
  // the card type it names (§10.6)", "R81 offers a backrow declaration both backrows, filtered by the list
  // of types it names", and 6 more; effects-choose.test.ts "R81 reads a prompt's mode pick out of
  // ctx.targets and a play's modes out of ctx.modes".
  it("R81 carries a play's zone, X, targets and modes in the action, and prompts only during resolution", () => {
    provenIn(81, "rulings-b.test.ts", "playChoices-filters.test.ts", "effects-choose.test.ts");
  });

  // Proved by rulings-b.test.ts "R82 ends the turn by itself when only ending, conceding and offering a draw
  // are left".
  it("R82 ends a turn by itself when only ending, conceding and offering a draw are left", () => {
    provenIn(82, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R83 brings a Reborn unit back summoning sick, so it cannot attack twice, but
  // it may still switch".
  it("R83 brings a Reborn unit back summoning sick, so it cannot attack again, but it may still switch", () => {
    provenIn(83, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R84 keeps concede, offerDraw and answerDraw out of the policy, so a random
  // game ends by death or the cap"; aiPolicy.test.ts "R84 only ever returns an action legalActions offered,
  // and never a concede or a draw offer".
  it("R84 keeps concede, offerDraw and answerDraw out of the AI policy", () => {
    expect(config.AI_END_TURN_PROBABILITY).toBe(0.1);
    provenIn(84, "rulings-b.test.ts", "aiPolicy.test.ts");
  });

  // Proved by damage.test.ts "R85 an effect may state its damage has Lifesteal, without the source carrying
  // the keyword"; effects-damage.test.ts "R85 heals the source's controller when the effect's own text has
  // Lifesteal", "R85 heals the amount actually dealt, and heals nobody when the effect has no source".
  it("R85 heals for an effect whose own text says its damage has Lifesteal, without granting the keyword", () => {
    provenIn(85, "damage.test.ts", "effects-damage.test.ts");
  });

  // Proved by comboIndex.test.ts "R86 skips a played card that no longer exists and keeps one that only
  // changed zone".
  it("R86 skips a played card that no longer exists and keeps one that only changed zone", () => {
    provenIn(86, "comboIndex.test.ts");
  });

  // M4 owns #95 Call to Chaos; the subsystem test is the machinery its script calls.
  // Proved by callToChaos.test.ts "R87 resolves the radiant pair in written order, leaves a cast card in the
  // graveyard, and rolls no substitute at the cap".
  it("R87 resolves the Call to Chaos radiant pair in written order and rolls no substitute at the cap", () => {
    provenIn(87, "callToChaos.test.ts");
  });

  // The rotation half of the same rule is rotation.test.ts "R14 bounces a card whose destination is Locked to
  // its owner's hand".
  // Proved by effects-swap.test.ts "R88 a card whose destination is Locked bounces to its owner's hand, as
  // R14 does for a rotation".
  it("R88 bounces a whole-board move into a closed zone to the card's owner's hand", () => {
    provenIn(88, "effects-swap.test.ts");
  });

  // Proved by statecheck.test.ts "R89 reports the dying card's owner, its last stats and the unit that killed
  // it", "R89 reports no killer when nothing dealt the lethal damage".
  it("R89 carries the dying card's owner, its last stats and its killer on the destroyed event", () => {
    provenIn(89, "statecheck.test.ts");
  });

  // Proved by playChoices-filters.test.ts "R90 reads two declarations off the flat targets list in order, and
  // refuses the swapped order", "R90 enumerates a declaration pair as a cross product, and both may name
  // the same card", and 3 more.
  it("R90 validates a play's choices against what the card declared and what the board allows", () => {
    provenIn(90, "playChoices-filters.test.ts");
  });

  // M4 owns #48 5pek Controller and #65.1 Spikey Pillow; `combat.switchPosition` is the machinery
  // their scripts call.
  // Proved by rulings-c.test.ts "R91 does nothing when a unit is switched to the position it already
  // holds", "R91 is not an error even for a unit that has already acted this turn".
  it("R91 does nothing when a unit is switched to the position it already holds", () => {
    provenIn(91, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R92 gives a position only to a card on the field, so a dormant or
  // absent card cannot be switched".
  it("R92 gives a position only to a card on the field, so a dormant or absent card cannot be switched", () => {
    provenIn(92, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R93 has a First Strike unit strike once: step 1 is when its strike
  // happens, not an extra one".
  it("R93 has a First Strike unit strike once, so two First Strikers trade in step 1", () => {
    provenIn(93, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R94 reads the attacker's attack once per combat, before a First
  // Strike defender's hit lands", "R94 reads the defender's attack once per combat, so a First
  // Strike survivor is struck back with the attack it had before the hit".
  it("R94 reads both units' attack once per combat, at the start of it", () => {
    provenIn(94, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R95 lands Cleave on the attacker's own hit, never on the
  // strike-back and never on a hero target".
  it("R95 lands Cleave on the attacker's own hit, never the strike-back, and never on a hero target", () => {
    provenIn(95, "rulings-c.test.ts");
  });

  // The R53 half of the same rule is combat-resolution.test.ts "R53 a sequence of forced attackers
  // stops once the target is gone".
  // Proved by rulings-c.test.ts "R96 skips a forced attacker that is already gone in silence, and
  // stops once the game has a result".
  it("R96 skips a forced attacker that is already gone, and stops once the game has a result", () => {
    provenIn(96, "rulings-c.test.ts");
  });

  // Proved by viewFor.test.ts "R97 redacts an event that names a card the viewer may not read,
  // rather than dropping it", "R97 never reads a card in a library, and blanks a shuffled-in card's
  // slot for both players".
  it("R97 redacts an event that names an unreadable card rather than dropping it", () => {
    provenIn(97, "viewFor.test.ts");
  });

  // Proved by prompts.test.ts "R98 a card that asks a question while it resolves is still itself",
  // "R98 a card that has left the resolving zone resumes with no self, from its captured data".
  it("R98 keeps a card that asks a question while it resolves as its own ctx.self", () => {
    provenIn(98, "prompts.test.ts");
  });

  // M4 owns #52, #56, #67 and #85; `traps.ts` is the machinery their scripts call.
  // Proved by rulings-c.test.ts "R99 fires a trap only when its `when` admits the event, spends it
  // on an empty effect list, and answers either side without a predicate".
  it("R99 fires a trap only when its `when` admits the event, and spends it on an empty effect list", () => {
    provenIn(99, "rulings-c.test.ts");
  });

  // R62's whole end-of-turn order is rulings-b.test.ts "R62 orders the end of a turn: end-of-turn
  // triggers, the trap window on both sides, delayed effects, then cleanup".
  // Proved by rulings-c.test.ts "R100 gives the end-of-turn window its own events, so a `turnEnded`
  // trap fires once per turn end"; trap-window-pause.test.ts "R100 re-offers the event to nobody who
  // has already seen it, so one turn end is one firing".
  it("R100 gives the end-of-turn trap window its own events, so a turnEnded trap fires once", () => {
    provenIn(100, "rulings-c.test.ts", "trap-window-pause.test.ts");
  });

  // Proved by rulings-c.test.ts "R101 pays a Tribute with a minimal set, counts a Sheep Token 2, and
  // refuses the play when the board cannot pay", "R101 lets only a card that says so tribute the
  // opponent's units"; 055-lava-golem.test.ts "R101 an enemy unit is legal fodder, and it is
  // SACRIFICED, not destroyed", "R101 three enemy units alone can pay the whole cost", "R101 an
  // enemy Sheep Token also counts 2 (§3.2 does not name a side)".
  it("R101 pays a Tribute with a minimal set, and makes an unpayable Tribute an illegal play", () => {
    provenIn(101, "rulings-c.test.ts", "../../cards/test/055-lava-golem.test.ts");
  });

  // M4 owns #85 Unlicensed Experimentation and #99 Craft a Card; R77's own clauses are fuse.test.ts.
  // Proved by rulings-c.test.ts "R102 caps the fused cost and drops every ingredient's `cost` hook,
  // so the cap wins over a cost-rewriting hook", "R102 takes the max of the ingredients'
  // `staticFlags.tribute` rather than the sum", "R102 namespaces trigger ids by ingredient, so two
  // ingredients that share an id stay two conditions", "R102 makes every consumed ingredient cease
  // to exist: no graveyard, no Death trigger, no destroyed counter", "R102 resolves a multi-target
  // Fuse's ingredients once and reuses them, since a consumed one cannot be re-found".
  it("R102 composes a Fuse member by member: capped cost, max tribute, namespaced triggers, consumed ingredients", () => {
    expect(config.FUSE_COST_CAP).toBe(4);
    provenIn(102, "rulings-c.test.ts");
  });

  // M4 owns #98 Heroic Power; R43's own clauses are heroPower.test.ts.
  // Proved by rulings-c.test.ts "R103 stores the eight power names and costs 0 for a power that has
  // not rolled", "R103 checks once-per-turn before mana, turn and phase", "R103 marks the use before
  // the effects run, and fizzles a token power in silence when the token is absent".
  it("R103 fixes the Heroic Power surface: seven names, cost 0 unrolled, once-per-turn checked first", () => {
    provenIn(103, "rulings-c.test.ts");
  });

  // M7 owns apps/server/src/config.ts; the SQL evidence is BUILD M6-T1's lifecycle script.
  // Proved by 03_match_lifecycle.sql "### R104: the room-code alphabet excludes 0, 1, I and O ###".
  it("R104 writes the code alphabet out: 32 upper-case symbols without 0, 1, I or O", () => {
    // §11 R104 spells the alphabet; the server must carry exactly it, and the schema's room-code
    // check constraint must derive from the same 32 symbols.
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    expect(alphabet).toHaveLength(32);
    expect([..."01IO"].some((symbol) => alphabet.includes(symbol))).toBe(false);
    expect(serverConstant(SERVER_CONFIG, "CODE_ALPHABET")).toBe(`"${alphabet}"`);
    // 16 symbols over 32 is 80 bits, and a 6-character room code 30 (§9.4, §9.5).
    expect(serverConstant(SERVER_CONFIG, "INVITE_CODE_LENGTH")).toBe("16");
    expect(serverConstant(SERVER_CONFIG, "ROOM_CODE_LENGTH")).toBe("6");
    expect(sourceOf(SERVER_MATCHES_SQL)).toContain(`^[${alphabet}]{6}$`);
    provenIn(104, SERVER_SQL);
  });

  // R105 is proved twice by different paths, so both are named: 03_match_lifecycle.sql
  // "### R105: a stale catalog version is refused at save and queue ###" is the gate as
  // `save_loadout` invokes it, and 01_schema_invariants.sql "=== CHECK 15 (R105): stale catalog
  // version says "update required" ===" is the raw `app.assert_catalog_version`.
  it("R105 makes the catalog version a short opaque string, compared for equality only", () => {
    // "Stamped on every `cards` row and mirrored in the server's settings; the Core set is core-1."
    expect(sourceOf(SERVER_COLLECTION_SQL)).toMatch(/catalog_version text not null/);
    expect(sourceOf(SERVER_INVITES_SQL)).toMatch(/\('catalog_version', '"core-1"'\)/);
    // "Nothing may parse or order it": the gate is an equality test and nothing else.
    expect(sourceOf(SERVER_COLLECTION_SQL)).toContain(
      "if p_version is distinct from app.catalog_version() then",
    );
    expect(sourceOf(SERVER_COLLECTION_SQL)).not.toMatch(/catalog_version\(\)\s*[<>]/);
    provenIn(105, SERVER_SQL, SERVER_SCHEMA_SQL);
  });

  // Proved by 03_match_lifecycle.sql "### R106: the circuit breaker refuses redemption while it is
  // open ###".
  it("R106 opens the circuit breaker at 100 failures in a 600-second window", () => {
    expect(serverConstant(SERVER_CONFIG, "REDEMPTION_CIRCUIT_FAILURE_THRESHOLD")).toBe("100");
    expect(serverConstant(SERVER_CONFIG, "REDEMPTION_CIRCUIT_WINDOW_SECONDS")).toBe("600");
    // The same two numbers are the seeded settings the breaker actually reads, so tuning them needs
    // no migration and the constant above is not a second source of truth.
    expect(sourceOf(SERVER_INVITES_SQL)).toMatch(/\('redemption_failure_threshold', '100'\)/);
    expect(sourceOf(SERVER_INVITES_SQL)).toMatch(/\('redemption_failure_window_seconds', '600'\)/);
    provenIn(106, SERVER_SQL);
  });

  // A server responsibility with no database behaviour: SQL cannot deliver a timing floor. BUILD
  // M6-T1's 5 ms timing test proves it at the server level.
  it("R107 pads every redemption response to a 250 ms constant-time floor", () => {
    expect(serverConstant(SERVER_CONFIG, "REDEMPTION_RESPONSE_FLOOR_MS")).toBe("250");
    // §9.4's "identical time" also needs one message for every rejection, or the floor proves
    // nothing about which rejection it was.
    expect(serverConstant(SERVER_CONFIG, "REDEMPTION_IDENTICAL_ERROR")).not.toBeNull();
  });

  // A config value with no database behaviour; BUILD M7-T1 proves the cadences at the server level.
  it("R108 runs the sweeper every 3 seconds and the reaper every 30", () => {
    expect(serverConstant(SERVER_CONFIG, "MATCHMAKER_SWEEP_INTERVAL_SECONDS")).toBe("3");
    expect(serverConstant(SERVER_CONFIG, "MATCH_REAPER_INTERVAL_SECONDS")).toBe("30");
    // The reaper is the coarser clock of the two, and both sit well inside the 120-minute ceiling (R389).
    expect(serverConstant(SERVER_CONFIG, "MATCH_CEILING_MINUTES")).toBe("120");
  });

  // A config value with no database behaviour; BUILD M7-T3 proves the limits at the server level.
  it("R109 limits a match to 5 actions a second and an account to 300 requests a minute", () => {
    expect(serverConstant(SERVER_CONFIG, "MATCH_ACTIONS_PER_SECOND")).toBe("5");
    expect(serverConstant(SERVER_CONFIG, "API_REQUESTS_PER_MINUTE")).toBe("300");
  });

  // Proved by 03_match_lifecycle.sql "### R110: a room code is reusable once its match is over ###".
  it("R110 makes a room code unique only among matches that are not yet over", () => {
    const source = sourceOf(SERVER_MATCHES_SQL);
    // The uniqueness is a *partial* index, which is the whole ruling: a finished match releases its
    // code back into the pool rather than burning it for ever.
    expect(source).toMatch(
      /create unique index if not exists matches_room_code_open_key\s+on public\.matches \(room_code\)\s+where room_code is not null and status <> 'over';/,
    );
    // And there is no unconditional unique index or unique constraint that would defeat it.
    expect(source).not.toMatch(/unique\s*\(\s*room_code\s*\)/);
    provenIn(110, SERVER_SQL);
  });

  // Proved by 03_match_lifecycle.sql "### R111: the launch grant is idempotent ###".
  it("R111 grants one copy of every non-token card when a profile becomes active, idempotently", () => {
    provenIn(111, SERVER_SQL);
  });

  // Proved by 03_match_lifecycle.sql "### R112: a reaper-resolved ceiling draw records turns 0 and
  // moves no rating ###"; results.test.ts "resolves a match past its ceiling as a draw and leaves
  // both ratings unchanged (R112)", "match-ceiling: an actor-resolved ceiling is a draw with the
  // ordinary rating move (R112)".
  it("R112 has the reaper resolve a stuck match itself, recording turns 0 and no rating move", () => {
    provenIn(112, SERVER_SQL, "../../../apps/server/test/api/results.test.ts");
  });

  // Proved by rulings-c.test.ts "R113 parks one cascade's sequences innermost-first, and a pause
  // during a resumption ahead of everything owed", "R113 raises rather than drop a work item nothing
  // knows how to resume"; prompts.test.ts "R113 registers the card-continuation work handler, so a
  // parked tail always has an owner"; trap-window-pause.test.ts "R113 owes the rest of the window
  // when a trap prompts, and the answer fires the traps it had not reached", "R113 owes the whole
  // window when a prompt is already open at its scheduled point". The sequences that ride the cursor
  // are pauses.test.ts "§10.6 chains a second prompt inside the answer and finishes both tails,
  // innermost first" and "§9.3 finishes a pause nested inside an owed sequence before the sequence's
  // own tail".
  it("R113 resumes paused sequences in workCursor order, and raises rather than lose one", () => {
    provenIn(113, "rulings-c.test.ts", "prompts.test.ts", "trap-window-pause.test.ts");
  });

  // M4 owns #21 Trample Tram and #32 Cleaver; `damage.ts` is the pipeline their scripts ride.
  // Proved by rulings-c.test.ts "R114 deals nothing to a unit already at 0 health and sends the
  // whole Trample amount to its hero". The M2 gate's 1,000 random combats cover the same rule
  // across seeds (combat.property.test.ts).
  it("R114 deals nothing to a unit already at 0 health, sending the whole Trample amount to its hero", () => {
    provenIn(114, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R115 stops a Vanilla'd permanent projecting its aura and setting
  // its own stats, while it still receives other cards' auras"; layers.test.ts "§6.3 a Vanilla
  // unit's own aura stops applying, because Vanilla clears its scripts".
  it("R115 stops a Vanilla'd permanent projecting an aura or setting its own stats, while it still receives", () => {
    provenIn(115, "rulings-c.test.ts");
  });

  // M4 owns #92 Felinor Fiender; R39's own clause is layers.test.ts "R39 layer 2 adds the sum of
  // your Felinors' layer-4 stats, and R13 counts the ones under a Stack".
  // Proved by rulings-c.test.ts "R116 adds a set-stat hook's return to the printed face as a delta,
  // floored at 0, and never lets two of them read each other".
  it("R116 makes a set-stat hook return a delta, added to the printed face and floored at 0", () => {
    provenIn(116, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R117 owes a play's remaining steps only at the moment it pauses,
  // never in advance".
  it("R117 owes a paused sequence's remaining steps only at the pause, never in advance", () => {
    provenIn(117, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R118 lets a trap's prompt interrupt a play without eating its Cry,
  // which still fires exactly once"; triggers.test.ts's "§10.3 pauses the opponent's action until
  // the trap's prompt is answered" covers the same order through the reducer.
  it("R118 lets a trap's prompt interrupt a play without eating its Cry", () => {
    expect(config.CRY_ON_PLAY_ONLY).toBe(true);
    provenIn(118, "rulings-c.test.ts");
  });

  // Proved by 033-unstable-clone-machine.test.ts "R119 a permanent does not answer its own arrival:
  // it starts counting from the next play" and "R119 a Clone Machine a played Heroic Power's Recruit
  // put on the field does not answer that play", and hidden-information.test.ts "R119 …", which pins
  // that `cardResolved.arrivedDuring` reaches neither seat's view.
  it("R119 keeps a permanent from answering the play that put it on the field", () => {
    provenIn(119, "../../cards/test/033-unstable-clone-machine.test.ts", CARDS_HIDDEN_INFORMATION_TEST);
  });

  // Proved by 041-sheepish.test.ts "R120 an Also clause stands on its own: an Immutable target
  // refuses the Transform and the rest of the text still resolves".
  it("R120 resolves an Also clause even when the clause before it did not", () => {
    provenIn(120, "../../cards/test/041-sheepish.test.ts");
  });

  // The R53 half is combat-resolution.test.ts "R53 an ordinary attack spends the attacker's exertion
  // and a forced one does not".
  // Proved by 096-my-pawn.test.ts "R121 a forced attack is declared by the effect, not the player,
  // so a trigger keyed to an opponent's declaration does not arm".
  it("R121 has a forced attack declared by the effect, not the player", () => {
    provenIn(121, "../../cards/test/096-my-pawn.test.ts");
  });

  // Proved by rulings-c.test.ts "R122 has the answering action finish what the prompt interrupted,
  // even driven without the reducer".
  it("R122 has the action that answers a prompt finish what the prompt interrupted", () => {
    provenIn(122, "rulings-c.test.ts");
  });

  // M4 owns #22 Carnivorous Cube, #55 Lava Golem and #66 The Rock; the R101 half is the Tribute cost.
  // Proved by rulings-c.test.ts "R123 carries a declared Tribute's picks in targets and its amount
  // as the play's Tribute cost".
  it("R123 carries a declared Tribute's picks in targets and its amount in the play's tributes", () => {
    provenIn(123, "rulings-c.test.ts");
  });

  // M4 owns #84 Going Long and #73; `damage.ts` steps 2 and 3 are what their scripts feed.
  // Proved by rulings-c.test.ts "R124 adds hero Armor up across its sources, where the Anti-oneshot
  // cap instead takes the smallest"; damage.test.ts "step 2: Armor 7 turns a 7 into 0, Defense adds
  // 1, Big D-fender adds 2 more, True Strike ignores it" is the unit-side half of the same layer.
  it("R124 adds hero Armor up across its sources, where the Anti-oneshot cap takes the smallest", () => {
    expect(config.ANTI_ONESHOT_CAP).toEqual({ base: 5, radiant: 3 });
    provenIn(124, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R125 sends fatigue through the whole damage pipeline, so Armor
  // absorbs the early draws". R3's own clause is rulings-a.test.ts "R3 makes the Nth draw from an
  // empty library deal N damage to that hero".
  it("R125 sends fatigue through the whole damage pipeline, Armor and the cap included", () => {
    expect([1, 2, 3, 4].map(config.FATIGUE_DAMAGE)).toEqual([1, 2, 3, 4]);
    provenIn(125, "rulings-c.test.ts");
  });

  // M4 owns #39, #50 and #78; `turn.runDelayed` is the machinery their continuations land in.
  // Proved by rulings-c.test.ts "R126 re-enters a delayed continuation under the `delayed` hook",
  // "R126 re-enters a delayed continuation that lives in the card's `resume` step table".
  it("R126 resolves both shapes a delayed continuation may take through one reader", () => {
    provenIn(126, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R127 resolves a delayed continuation whose instance is gone, with
  // ctx.self null and its data", "R127 resolves a delayed continuation whose instance has since
  // ceased to exist". R113's "a work item that cannot be resumed is a lost sequence" is the rule
  // this one keeps for the delayed path.
  it("R127 resolves a continuation with no instance, by its stored def id and captured data", () => {
    provenIn(127, "rulings-c.test.ts");
  });

  // M4 owns #13, #17, #88 and #100; `effects/damage.ts`'s `damageAll` is the sweep they call.
  // Proved by rulings-c.test.ts "R128 resolves a two-sided sweep as units in R68 order, then one
  // instance per scoped hero in that order".
  it("R128 sweeps units in R68 order, then one instance per scoped side's hero in that order", () => {
    provenIn(128, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R129 has a fizzling effect draw no randomness, which is why a
  // whole-hand discard is its own verb". What counts as nothing to do over hidden cards is R177's,
  // proved by hidden-information.test.ts "R177 #42 rolls every remaining library card …" and "R177
  // #23's cue does not tell p2 whether p1's hidden hand was already all Radiant …".
  it("R129 has a fizzling effect draw no randomness, so rngCursor never depends on the board", () => {
    provenIn(129, "rulings-c.test.ts");
  });

  // R32's own clause is rulings-a.test.ts "R32 leaves a coin-stat effect alone: Lucky has no defined
  // best, so it changes nothing"; 004-gary-the-gambler.test.ts proves the card.
  // Proved by rulings-c.test.ts "R130 leaves a roll with no better outcome alone, so Lucky costs it
  // no draw".
  it("R130 re-rolls only a roll with a defined better outcome, so Lucky costs a coin effect no draw", () => {
    provenIn(130, "rulings-c.test.ts");
  });

  // M4 owns #92 Felinor Fiender, whose own exclusion clauses are 092-felinor-fiender.test.ts.
  // Proved by rulings-c.test.ts "R131 never counts Felinor Fiender itself, even when it carries the
  // Felinor tag".
  it("R131 never counts Felinor Fiender itself, matching by instance rather than by tag", () => {
    provenIn(131, "rulings-c.test.ts");
  });

  // R150 generalised this row and closed the gap it used to name: the summing read no longer
  // floors each contributor, so the floor is the combined total's alone.
  // R39's own clause is rulings-a.test.ts "R39 gives Felinor Fiender printed plus the sum of your
  // Felinors, never below printed".
  // Proved by rulings-c.test.ts "R132 applies R39's floor to each stat's combined total, not per
  // Felinor and not across the two stats".
  it("R132 applies R39's floor to each stat's combined total, not per Felinor", () => {
    provenIn(132, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R133 weights a card played twice in one turn once, because the pool
  // is the set of cards played".
  it("R133 weights a card played twice in one turn once: the pool is the set of cards played", () => {
    provenIn(133, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R134 keeps a grade counter on the instance through a change of
  // control, and reads the new controller's turn log".
  it("R134 keeps a grade counter on the instance and reads its current controller's turn log", () => {
    provenIn(134, "rulings-c.test.ts");
  });

  // The two verbs this row needed — one that draws a named card out of a library and one that walks
  // library, then hand, then graveyard by cost — have since landed in the effects barrel.
  // R26's own clause is rulings-a.test.ts "R26 reads Genn's Greed
  // as 'exile all odd-cost cards'"; 094-genns-greed.test.ts is already written as the card should
  // behave and fails for the same reason.
  // Proved by rulings-c.test.ts "R135 exiles each card on its own, and needs a verb that walks
  // library, then hand, then graveyard".
  it("R135 exiles library, then hand, then graveyard, each card its own exile, after the draw", () => {
    expect(config.GENN_GREED_EXILES).toBe("odd");
    provenIn(135, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R136 gives a script its own event window, so an earlier event in
  // the same action is not its own".
  it("R136 gives a script its own event window, not the whole action's", () => {
    provenIn(136, "rulings-c.test.ts");
  });

  // M7 owns apps/server/src/match/actor.ts. NOTE: the server suite covers this but names no test
  // after the row, so the index asserts the scope against the actor itself.
  it("R137 gives each seat R109's action allowance, so neither player can spend the other's", () => {
    const source = sourceOf(SERVER_ACTOR);
    // The window is held per seat: one array indexed by player, not one shared list.
    expect(source).toMatch(/function floodExceeded\(player: PlayerId/);
    expect(source).toMatch(/const recent = recentActions\[player\];/);
    // Each seat's budget is R109's number, so the match's aggregate ceiling is twice it.
    expect(source).toMatch(/recent\.length >= MATCH_ACTIONS_PER_SECOND/);
    expect(serverConstant(SERVER_CONFIG, "MATCH_ACTIONS_PER_SECOND")).toBe("5");
  });

  // Proved by rulings-c.test.ts "R138 counts a cast permanent with no zone as played, resolves it,
  // and sends it to its owner's graveyard".
  it("R138 plays and resolves a cast permanent with no zone, then sends it to the graveyard", () => {
    provenIn(138, "rulings-c.test.ts");
  });

  // R103's priority is rulings-c.test.ts "R103 checks once-per-turn before mana, turn and phase".
  // Proved by rulings-c.test.ts "R139 lapses a once-per-turn limit at the turn boundary, so a later
  // turn is told whose turn it is".
  it("R139 lapses a once-per-turn limit at the turn boundary", () => {
    provenIn(139, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R140 gives a zone-less Stack play the leftmost empty zone, and
  // lifts the occupancy refusal only for a zone the play names".
  it("R140 gives a zone-less Stack play the leftmost empty zone, lifting occupancy only when named", () => {
    provenIn(140, "rulings-c.test.ts");
  });

  // NOTE: no server test names this row; the index asserts the two numbers that make it true.
  it("R141 makes L5 unreachable on its own, given R111's one-copy launch grant", () => {
    // R111 grants exactly one copy of every non-token card, and a loadout may use one copy of a
    // card, so using more copies than are owned needs a second copy, a Token, or an id outside the
    // catalog — which is L3, L4 or L6 first. Change either number and L5 becomes reachable alone.
    expect(sourceOf(SERVER_COLLECTION_SQL)).toMatch(/SPEC §11 R111: the launch quantity/);
    expect(sourceOf(SERVER_LOADOUTS_SQL)).toMatch(/L5 card % totals % copies across the loadout, only % owned/);
  });

  // R110's own proof is the SQL heading above; R142 says what the end-to-end suite may assert
  // instead, since no client can ask for a specific room code.
  it("R142 verifies R110 on the server, and end-to-end only through its consequence", () => {
    // The consequence a client can see: once the match is over, both players' in-match state is
    // cleared, so both are queue-eligible again.
    expect(sourceOf(SERVER_SQL)).toMatch(/current_match_id is null as cleared/);
    // And the reuse itself is proved where a caller can name a code: the server's own script.
    provenIn(110, SERVER_SQL);
  });

  // Proved by e2e.test.ts "R143 — the optional seed".
  it("R143 has the server mint a match's seed, with end-to-end mode the one exception", () => {
    provenIn(143, SERVER_E2E_TEST);
  });

  // Proved by e2e.test.ts "R144 — the reseed at boot".
  it("R144 reseeds the fixture accounts and invite codes per run, so a spec is repeatable", () => {
    provenIn(144, SERVER_E2E_TEST);
  });

  // NOTE: no server test names this row; the index asserts the split against the redemption path.
  it("R145 gives every code-dependent refusal the identical error, and reports account state distinctly", () => {
    const source = sourceOf(SERVER_CODES);
    // One message for everything that depends on the code (R107's constant-time floor makes the
    // timing match too).
    expect(source).toMatch(/new ApiError\("invalid_code", REDEMPTION_IDENTICAL_ERROR\)/);
    // And distinct errors for what depends only on the caller's own account, which leaks nothing
    // about the code space.
    expect(source).toMatch(/new ApiError\("account_banned"/);
    expect(source).toMatch(/new ApiError\("email_unverified"/);
  });

  // NOTE: no server test names this row; the index asserts the attribution against the result path.
  // Since the ranked ladder (R603) the attribution names the side, not the score: `winnerSideOf`
  // is `scoreForSeat`'s successor, and the assertion is the same — the winner is read off the seat,
  // never off whoever was active.
  it("R146 stamps a lifecycle result with the seat it belongs to, not with whoever was active", () => {
    const source = sourceOf(SERVER_RESULTS);
    expect(source).toMatch(/function winnerSideOf\(outcome: TerminalOutcome, seats: readonly \[MatchSeat, MatchSeat\]\)/);
    expect(source).toMatch(/outcome\.winner === seats\[0\]\.player/);
  });

  // NOTE: no server test names this row; the index asserts the guard against the clock.
  it("R147 keeps the first deadline when a second grace starts, so a flapping socket cannot extend it", () => {
    const source = sourceOf(SERVER_CLOCK);
    // The guard: a grace already counting down is left alone rather than re-armed.
    expect(source).toMatch(/startGrace: \(player: PlayerId\): void => \{[\s\S]*?if \(countdown\.timer !== null\) return;/);
  });

  // NOTE: no server test names this row; the index asserts the four codes, as R104 does its alphabet.
  it("R148 mirrors the HTTP statuses in its close codes, with 1011 for an internal fault", () => {
    const source = sourceOf(SERVER_WS);
    expect(source).toMatch(/unauthorized: 4401,/);
    expect(source).toMatch(/forbidden: 4403,/);
    expect(source).toMatch(/notFound: 4404,/);
    expect(source).toMatch(/internal: 1011,/);
    // §9.1: only the close code varies, so a socket never learns which check refused it.
    expect(source).toMatch(/private-use mirrors of the HTTP statuses/);
  });

  // NOTE: no server test names this row; the index asserts the bound against the mint.
  it("R149 mints a room code by retrying a bounded number of times, then reports none available", () => {
    const source = sourceOf(SERVER_ROOMS);
    // Bounded, not an unbounded retry: a fixed count, and a refusal when it runs out.
    expect(source).toMatch(/const CODE_ATTEMPTS = \d+;/);
    expect(source).toMatch(/for \(let attempt = 0; attempt < CODE_ATTEMPTS; attempt \+= 1\)/);
    expect(source).toMatch(/could not allocate a room code/);
  });

  // R132 is the rule this one generalises; R116 fixes what the hook returns.
  // Proved by rulings-c.test.ts "R132 applies R39's floor to each stat's combined total, not per
  // Felinor and not across the two stats".
  it("R150 keeps a stat floor off each contributor of a summing read", () => {
    provenIn(150, "rulings-c.test.ts");
  });

  // R43's own roll clauses are heroPower.test.ts.
  // Proved by rulings-c.test.ts "R151 rolls a Heroic Power's power as it arrives in a hand, not only
  // at the start of the game".
  it("R151 rolls a Heroic Power's power as it arrives anywhere a card can be looked at", () => {
    provenIn(151, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R152 clears the AI lockout at the end of the turn it was set for".
  it("R152 clears the AI lockout at the end of the turn it was set for", () => {
    provenIn(152, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R153 registers only the hooks a card's zone allows, so a hand or a
  // graveyard answers no start- or end-of-turn hook".
  it("R153 registers only the hooks a card's zone allows", () => {
    provenIn(153, "rulings-c.test.ts");
  });

  // R97 carries an amendment for this row: a fired trap is consumed into a public graveyard, so the
  // generic zone-keyed redaction would hand the opponent its identity. It is keyed to the controller.
  // Proved by rulings-c.test.ts "R154 carries the trap's row and lane on trapFired, with its
  // identity redacted for the other player".
  it("R154 carries a trap's row and lane on trapFired, its identity following R97's redaction", () => {
    provenIn(154, "rulings-c.test.ts");
  });

  // §5.1 named no step that did the flagging, so the flag was declared and written by nothing.
  // R153's graveyard gate is the flag alone now, which is the second half of this row.
  // Proved by rulings-c.test.ts "R155 flags a Spell that asks to return as step 7 lands it in the
  // graveyard, and clears it that turn", "R155 makes the flag alone the graveyard's gate, so this
  // turn's play log is not enough"; trigger-zones.test.ts "R155 the flag, not the turn log, is what
  // lets a graveyard spell answer its return"; the cards package's hand-returns.test.ts "R155 …" (the
  // flag is cleared as the card leaves the graveyard).
  it("R155 sets the return-to-hand flag at step 7 and clears it at the end of that turn", () => {
    provenIn(155, "rulings-c.test.ts", "trigger-zones.test.ts", CARDS_HAND_RETURNS_TEST);
  });

  // Proved by death-pause.test.ts "R156 owes step 3 in full rather than firing a Death hook into an
  // open prompt", with its control "the same death fires at once with no prompt open".
  it("R156 owes §4.5 step 3 in full when the check begins with a prompt already open", () => {
    provenIn(156, "death-pause.test.ts");
  });

  // Proved by apps/server rate-limit.test.ts "R157 keys a request that names no account on its
  // address, and keeps those apart too".
  it("R157 counts an accountless API request against its address, in its own namespace", () => {
    provenIn(157, SERVER_RATE_LIMIT_TEST);
  });

  // Proved by draw-pause.test.ts "R158 draws nothing more while a cast-on-draw prompt is open, and
  // owes the rest of the chain", with its cap, hand-cap, fatigue and draw-N siblings and two
  // controls that own nothing when nothing asks.
  it("R158 stops a draw at the prompt it opened and owes the rest, keeping R58's count", () => {
    provenIn(158, "draw-pause.test.ts");
  });

  // R159 to R167 are server rulings, like R104 to R112 and R137 to R149 before them: the index row
  // stays here (B4 greps this file) and the proof lives in `apps/server/test`, where the store, the
  // router and the `Timers` port are.

  // Proved by apps/server auth.test.ts "R159 remembers a confirmed email briefly and per user id,
  // and asks again once it lapses", with the three halves the ruling turns on — "never caches the
  // no, so an account that has just clicked its link is unlocked at once", "fails closed when the
  // provider cannot be reached" and "caches only what the provider gave".
  it("R159 caches only a verified email, briefly and per user id, and fails closed", () => {
    provenIn(159, SERVER_AUTH_TEST);
  });

  // R145 is the ruling this one extends, one door earlier: R145 flattens every refusal that
  // depends on the *code*, R160 every refusal that depends on whether an *account* exists.
  // Proved by apps/server auth.test.ts "R160 answers 'no such account' and 'wrong password'
  // byte-identically at sign-in", "R160 answers 'already registered' identically to every other
  // sign-up rejection", "R160 makes an address that already has an account look exactly like a new
  // one" and "R160 is one error per endpoint, not one shared between them" — with the control,
  // "the same endpoints still tell four other outcomes apart", that keeps "identical" from meaning
  // "constant".
  it("R160 answers sign-up and sign-in identically for every account-existence outcome", () => {
    provenIn(160, SERVER_AUTH_TEST);
  });

  // Proved by apps/server codes.test.ts "R161 activates exactly one account from a code minted
  // with no maxUses", with its control (a second code activates the refused caller at once), its
  // deliberate-mint sibling and the schema check that `invite_codes.max_uses` defaults the same way.
  it("R161 activates one account per invite code unless its mint says otherwise", () => {
    provenIn(161, SERVER_CODES_TEST);
  });

  // NOTE: one clause of this row is NOT proved — `src/api/cors.ts` writes `Vary: Origin` only on
  // the two allowed paths, so a refused preflight and an ordinary response to an unlisted or
  // absent origin carry none. The test file says so in place of asserting it, rather than pinning
  // the gap as correct; fixing it is a `src/` change.
  // Proved by apps/server cors.test.ts "R162 echoes the one origin that asked, never `*`, and
  // never allows credentials", "R162 gives an unlisted origin the ordinary response with no CORS
  // headers, not a 403" and their preflight, no-Origin and shared-list siblings.
  it("R162 echoes one allowed origin, never `*` or credentials, and refuses by silence", () => {
    provenIn(162, SERVER_CORS_TEST);
  });

  // Proved by apps/server catalog.test.ts "R163 serves the whole, unprojected catalog to a caller
  // with no account at all" — with the `active` route beside it proving §9.4's gate is awake —
  // plus "R163 declares `auth: \"none\"`" and "R163 hands a pending account and an anonymous
  // caller the identical bytes".
  it("R163 serves the whole catalog unauthenticated and unprojected, carrying R105's version", () => {
    provenIn(163, SERVER_CATALOG_TEST);
  });

  // Proved by apps/server catalog.test.ts "R164 reads bannedness through the catalog handle, never
  // off a card definition", "R164 keeps a ban out of the catalog data, so R105's version does not
  // move", "R164 never hands the client a copy of the list" and "R164 bans nothing in §8 at launch".
  it("R164 holds L6's ban list as server state, read through the catalog handle", () => {
    provenIn(164, SERVER_CATALOG_TEST);
  });

  // Proved at the port by apps/server decks.test.ts "R165 makes queueing with nothing saved a deck
  // failure (422)…" and "R165 answers a deck or trio that is gone…" (R253 carried the rule from the
  // one loadout to saved decks and trios), and at the endpoint by queue.test.ts "R165 …", whose
  // control queues the same profile successfully the moment it has a deck.
  it("R165 reports queueing with no loadout as a loadout failure, not a 404", () => {
    provenIn(165, SERVER_DECKS_TEST, SERVER_QUEUE_TEST);
  });

  // Proved by apps/server queue.test.ts "R166 pairs the oldest ticket against the oldest opponent
  // its window admits, not the closest" — whose fixture holds an opponent closer in rating but
  // newer, so the test can tell the two policies apart — with "R166 pairs the oldest ticket first
  // when two pairs are available in one sweep", the id tie-break and the §9.5 window control.
  it("R166 pairs the oldest ticket first, against the oldest opponent its window admits", () => {
    provenIn(166, SERVER_QUEUE_TEST);
  });

  // Proved by apps/server queue.test.ts "R167 cancels an open ticket, and says so" (the premise
  // every negative below it leans on), "R167 is idempotent: a second cancel is told nothing was
  // cancelled, not given an error" and "R167 never unmakes a pairing".
  it("R167 lets a queued player cancel, idempotently, and never unmakes a pairing", () => {
    provenIn(167, SERVER_QUEUE_TEST);
  });

  // Proved by viewFor.test.ts "R168 §10.8's N is a floor: one action's own event burst is never
  // truncated" — found by the e2e suite, where a My Pawn cancel plus its AI turn emitted 38 events
  // in one reduction and the three the cancel is made of were dropped from the front of the window.
  it("R168 keeps a whole action in the view's event window, so N is a floor and not a cap", () => {
    provenIn(168, "viewFor.test.ts");
  });

  // Proved by viewFor.test.ts's five "R169 …" tests (both seats' lists, the empty board, R48's
  // "(next turn)" caption, the label for every `PlayerModifier` kind, and the `sourceId` that never
  // travels), by the two card files for the cards §11 names — #77 Professor Curvature and
  // #78 /fullsend, which changed the game invisibly until this row — and by apps/web's
  // `animation-targets.test.tsx`, which renders the client and proves `modifiers-<side>` is an
  // element that exists, the check BUILD M5-T4's `modifierChanged` row had never had.
  it("R169 puts the player modifiers in the view on both seats, as id and caption only", () => {
    provenIn(169, "viewFor.test.ts", CARDS_CURVATURE_TEST, CARDS_FULLSEND_TEST, WEB_ANIMATION_TARGETS_TEST);
  });

  it("R170 answers a profile that vanished mid-redemption with a conflict, not a 401", () => {
    provenIn(170, SERVER_CODES_TEST);
  });

  // Proved by control-change.test.ts's "R171 …" tests (every verb, Rush and Charge, the fresh
  // exertion, same-side moves, Stack piles, the round trip, the opponent's turn),
  // control-change.property.test.ts (fast-check), and the cards package's control-change.test.ts
  // with #36 radiant, #49, #50, #52, #86 and #87.
  it("R171 makes a change of control an entry: summoning sick, with a fresh exertion", () => {
    provenIn(171, "control-change.test.ts", "control-change.property.test.ts", CARDS_CONTROL_CHANGE_TEST);
  });

  // Proved by control-change.test.ts "R172 …" (a fixture Reborn unit) and the cards package's
  // control-change.test.ts with #81 Radiant Saintess and radiant #3 Right-house defender.
  it("R172 has a stolen unit die as its controller's: Death for that player, Reborn on that side", () => {
    provenIn(172, "control-change.test.ts", CARDS_CONTROL_CHANGE_TEST);
  });

  // Proved by forced-attacks.test.ts's "R173 …" tests: #86 stealing #9 mid-run, and radiant #60's
  // tokens against a #52 Silly Silas that crossed onto their side.
  it("R173 makes a forced attack on an enemy only: a target on the attacker's own side is passed over", () => {
    provenIn(173, CARDS_FORCED_ATTACKS_TEST);
  });

  // Proved by re-entry.test.ts's "R174 …" tests (#50's steal after a Stack, a bounce and replay, a
  // Reborn), forced-attacks.test.ts's (a run against a Reborn body), after-resolution.test.ts's (a
  // trap answering a play an earlier trap took off the field), tributes.test.ts's (a target the
  // play's own Tribute sacrificed) and trigger-stays.test.ts's (a queued trigger aims at its event's
  // card on the stay the event happened on, and at every other card on the stay it has now).
  it("R174 makes a card that left the field and came back a new arrival for the effects aimed at it", () => {
    provenIn(
      174,
      CARDS_RE_ENTRY_TEST,
      CARDS_FORCED_ATTACKS_TEST,
      CARDS_AFTER_RESOLUTION_TEST,
      CARDS_TRIBUTES_TEST,
      CARDS_TRIGGER_STAYS_TEST,
    );
  });

  // Proved by re-entry.test.ts's "R175 …" tests: a Rush Token given Reborn, and a Reborn Fiender
  // fused by #85 that died on top of its pile; stacks-and-reborn.test.ts's: a Bread Token's X/X.
  it("R175 has Reborn bring back a unit token, and return a unit onto the pile it died on top of", () => {
    provenIn(175, CARDS_RE_ENTRY_TEST, CARDS_STACKS_AND_REBORN_TEST);
  });

  // Proved by combat-windows.test.ts's "R176 …" tests: First Strike first, and Cleave's Trample.
  it("R176 has My Pawn's projection follow the combat: First Strike first, every Cleave hit counted", () => {
    provenIn(176, CARDS_COMBAT_WINDOWS_TEST);
  });

  // Proved by hidden-information.test.ts's "R177 …" tests: a face-down prompt option, Transmogulate's
  // replacements (kept hidden after their replacement goes public), cost changes and buffs in a
  // hidden hand or a library, and a modifier id no hidden card numbered. The row's known limit, a
  // face-down trap named in `legalActions` by an id seen while it was public, is pinned by an
  // expected failure in turn-clock-and-legality.test.ts.
  it("R177 hides what R97 did not name: face-down prompt options, replaced hidden cards, hidden costs", () => {
    provenIn(177, CARDS_HIDDEN_INFORMATION_TEST);
  });

  // Proved by echo-and-exile.test.ts's "R178 …" tests: True Strike and Pocket Chaos with Twinspell.
  it("R178 makes a Spell's 'exile this' its landing, and takes Twinspell's grant as the Spell is played", () => {
    provenIn(178, CARDS_ECHO_AND_EXILE_TEST);
  });

  // Proved by the cards package's fuse-registry.test.ts "R179 …" (two matches, one process, one
  // fusion slot, with #85) and by this package's fuse-registry.test.ts "R179 …" (the scripts rebuilt
  // from the id alone after a JSON round trip or a wholesale re-registration, and a fusion of a
  // fusion's parenthesised id read back one way).
  it("R179 names a fused definition's ingredients in its id, so matches in one process never share one", () => {
    provenIn(179, CARDS_FUSE_REGISTRY_TEST, "fuse-registry.test.ts");
  });

  // R180 to R184 are the practice handicap (§9.9), proved by handicap.test.ts against createGame,
  // beginGame, reduce and fold directly. R180's numbers are §9.9's table, so they are asserted here
  // against `config.ts` as the "decide" rows' are.
  it("R180 gives each seat an optional handicap, stores none equal to a human's, and folds it", () => {
    expect(config.HUMAN_HANDICAP).toEqual({
      deckSize: config.DECK_SIZE,
      manaBonus: 0,
      manaCap: config.MAX_MANA,
      extraOpeningCards: 0,
      extraDrawsPerTurn: 0,
    });
    expect(config.DIFFICULTIES).toEqual(["easy", "medium", "hard"]);
    expect(config.AI_DIFFICULTY.easy).toEqual(config.HUMAN_HANDICAP);
    expect(config.AI_DIFFICULTY.medium).toEqual({
      deckSize: 25,
      manaBonus: 1,
      manaCap: 5,
      extraOpeningCards: 1,
      extraDrawsPerTurn: 0,
    });
    expect(config.AI_DIFFICULTY.hard).toEqual({
      deckSize: 30,
      manaBonus: 1,
      manaCap: 7,
      extraOpeningCards: 1,
      extraDrawsPerTurn: 1,
    });
    provenIn(180, "handicap.test.ts");
  });

  // Proved by handicap.test.ts "R181 …": Medium refreshes to 2 on its first turn and 5 from its
  // fourth, Hard to 7 from its sixth, Hinder and next-turn gains still apply on top.
  it("R181 caps a handicapped seat's max mana at min(turns + bonus, cap), modifiers on top", () => {
    provenIn(181, "handicap.test.ts");
  });

  // Proved by handicap.test.ts "R182 …": the mulligan sees 5 cards for a Medium or Hard p2 and 4
  // for p1, and a Quickdraw card replaces one of those draws.
  it("R182 adds a handicap's extra opening cards to §2.1's table entry", () => {
    provenIn(182, "handicap.test.ts");
  });

  // Proved by handicap.test.ts "R183 …": two `drawn` events, fatigue N then N + 1, and a
  // cast-on-draw prompt in the first draw owing the second to `state.work`.
  it("R183 makes a handicap's extra draws separate §2.4 draws, each with its own chain and fatigue", () => {
    expect(config.DRAWS_PER_TURN).toBe(1);
    provenIn(183, "handicap.test.ts");
  });

  // Proved by handicap.test.ts "R184 …": a 30-card Hard p2 deck is accepted, and a wrong size,
  // a duplicate or a Token is refused naming the seat.
  it("R184 holds a handicapped seat's deck to its handicap's deck size and §2.6's other rules", () => {
    provenIn(184, "handicap.test.ts");
  });

  // Proved by packages/ai observe.test.ts "R185 …": redact hashes identically across hidden-card
  // differences, determinize loses nothing the seat can see, and decide does not move.
  it("R185 lets the AI decide only from what its seat may know, simulating on determinizations", () => {
    provenIn(185, AI_OBSERVE_TEST);
  });

  // Proved by packages/ai shadowBan.test.ts "R186 …": every entry is a real card with a sweep flag,
  // and no AI deck is dealt one.
  it("R186 keeps the AI's shadow ban to its own deck-building, each entry with a sweep reason", () => {
    provenIn(186, AI_SHADOW_BAN_TEST);
  });

  // Proved by apps/web practice/core.test.ts "R187 …": a practice game folds from
  // `(seed, decks, handicaps, log)` to the worker's hash at every difficulty.
  it("R187 runs practice in the browser's worker, recording nothing and replaying exactly", () => {
    provenIn(187, WEB_PRACTICE_CORE_TEST);
  });

  // Proved by packages/ai decide.test.ts "R188 …": an unanswered offer is declined at once, and no
  // match log holds a concede, an offer or an accepting answer from the AI.
  it("R188 has the AI decline every draw offer at once and never concede or offer one", () => {
    provenIn(188, AI_DECIDE_TEST);
  });

  // R190 to R194 are sign-in and invite-code rulings (polish task 5, docs/polish/5-sign-in.md). Like
  // R157 to R170 their proofs live outside the engine, in the server, the shared package and the web
  // client, so each index row names the files and asserts each still carries a test named after it.
  const SERVER_CLIENT_ADDRESS_TEST = "../../../apps/server/test/api/client-address.test.ts";
  const SERVER_CODE_INPUT_PARITY_TEST = "../../../apps/server/test/api/code-input-parity.test.ts";
  const SERVER_REDEEM_FEEDBACK_TEST = "../../../apps/server/test/api/redeem-feedback.test.ts";
  const SHARED_CODES_TEST = "../../shared/test/codes.test.ts";
  const WEB_CODE_FIELD_TEST = "../../../apps/web/src/auth/CodeField.test.tsx";
  const WEB_AUTH_FLOWS_TEST = "../../../apps/web/src/net/auth-flows.test.ts";
  const WEB_REDIRECT_TEST = "../../../apps/web/src/auth/redirect.test.ts";
  const WEB_LOGIN_FLOWS_TEST = "../../../apps/web/src/routes/login-flows.test.tsx";
  const WEB_GATE_REFRESH_TEST = "../../../apps/web/src/net/gate-refresh.test.tsx";
  const WEB_GATE_SESSION_CHANGES_TEST = "../../../apps/web/src/net/gate-session-changes.test.tsx";
  const WEB_INVITE_FEEDBACK_TEST = "../../../apps/web/src/routes/invite-feedback.test.tsx";
  const WEB_RESET_PASSWORD_TEST = "../../../apps/web/src/routes/reset-password.test.tsx";
  const WEB_SHELL_GATE_TEST = "../../../apps/web/src/routes/shell-gate.test.tsx";

  // Proved by client-address.test.ts's "R190 …" rows: `clientAddress` takes the rightmost trusted
  // hop and never CF-Connecting-IP or X-Real-IP, requests with different leftmost entries share one
  // per-IP bucket, too few entries fall back to the peer address, the default trusts no hop,
  // `loadEnv` bounds TRUSTED_PROXY_HOPS, an IPv6 client is keyed by its /56, and `api.forwarded_for`
  // reports the fewest entries seen, never an address.
  it("R190 keys a per-IP limit on the rightmost trusted X-Forwarded-For hop, then the peer", () => {
    provenIn(190, SERVER_CLIENT_ADDRESS_TEST);
  });

  // Proved by the shared table in codes.test.ts (the reading itself), code-input-parity.test.ts
  // (the server redeems every row the table calls canonical and answers R145's identical error for
  // the rest) and CodeField.test.tsx (the field refuses an excluded character instead of dropping it).
  it("R191 reads a typed or pasted code one way on both sides, never dropping or mapping a character", () => {
    provenIn(191, SHARED_CODES_TEST, SERVER_CODE_INPUT_PARITY_TEST, WEB_CODE_FIELD_TEST);
  });

  // Proved by redeem-feedback.test.ts (§9.4 steps 2 and 3 and R109's limit answer 429 with
  // `Retry-After` and `details.retryAfterMs`, next to the unchanged `invalid_code` bytes, and the
  // status says when an account's tries come back), auth-flows.test.ts (a provider 429 is a rate
  // limit, and resend and recover stay neutral for every answer that could name an account),
  // login-flows.test.tsx (the per-address interval, a sign-up's included) and
  // invite-feedback.test.tsx (the screen shows each wait and lifts by itself when it runs out).
  it("R192 reports a rate limit as a rate limit, with its wait, never as the identical error", () => {
    provenIn(192, SERVER_REDEEM_FEEDBACK_TEST, WEB_AUTH_FLOWS_TEST, WEB_LOGIN_FLOWS_TEST, WEB_INVITE_FEEDBACK_TEST);
  });

  // Proved by redirect.test.ts (a link is parsed once and scrubbed, error text is never read, a held
  // recovery session lives in this tab's memory and sessionStorage, never localStorage, and one
  // abandoned after its access token expired is renewed, then revoked), login-flows.test.tsx (no
  // confirmation link signs this browser in, not even for the sign-up it started; a link is renewed
  // before it is checked, so the refresh token in its URL is spent; a recovery link is held at once
  // for a reset this browser asked for, and otherwise only once the player types the address it was
  // sent to; nothing from a link is shown or filled into a form; and a link's session that is not
  // kept is revoked), reset-password.test.tsx (the reset screen says when it replaces another
  // account's session, asks before its exits spend the link, and abandons it when left) and
  // shell-gate.test.tsx (a link on any path is scrubbed and handed to /login).
  it("R193 reads an emailed auth link once, scrubs it, and never signs this browser in from a confirmation", () => {
    provenIn(193, WEB_REDIRECT_TEST, WEB_LOGIN_FLOWS_TEST, WEB_RESET_PASSWORD_TEST, WEB_SHELL_GATE_TEST);
  });

  // Proved by gate-refresh.test.tsx (renewal near expiry and on a 401, and the expired sign-in
  // screen), gate-session-changes.test.tsx (a renewal the device outlived, and a renewal of the same
  // session, here or in another tab, keeps an open match socket), auth-flows.test.ts (single-flight
  // refresh, and revocation on sign-out, an expired session renewed first), invite-feedback.test.tsx
  // (a redemption refused as unauthorised is renewed and sent again), reset-password.test.tsx (a
  // recovery session that runs out while the form is open is renewed before the new password is
  // sent) and the server's auth.test.ts (the API honours a token only while the provider still has
  // its session, remembering a live answer for AUTH_SESSION_LIVE_CACHE_SECONDS, and an unreachable
  // provider signs nobody out).
  it("R194 renews a session once near expiry or on a 401, revokes it on sign-out, and the API honours only a live one", () => {
    provenIn(
      194,
      WEB_GATE_REFRESH_TEST,
      WEB_GATE_SESSION_CHANGES_TEST,
      WEB_AUTH_FLOWS_TEST,
      WEB_INVITE_FEEDBACK_TEST,
      WEB_RESET_PASSWORD_TEST,
      SERVER_AUTH_TEST,
    );
  });

  // Proved by conditionActive.test.ts's "R195 …" tests (a test-only `conditionMet` hook: the
  // viewer's hand in their own main phase only, their units and backrow on either turn, never a
  // card they don't control, never a card with no hook, the hook never called outside those) and by
  // the cards package's condition-active.test.ts, which checks the five §8 cards that implement the
  // hook (#10, #53, #68, #71, #93) against the branch each card's own resolution then takes.
  it("R195 surfaces a met printed condition as conditionActive on the viewer's own cards only", () => {
    provenIn(195, "conditionActive.test.ts", "../../cards/test/condition-active.test.ts");
  });

  // Proved by conditionActive.test.ts's "R196 …" tests, which fuse test-only hooked cards through
  // the real R77 `fuse` (in hand and on the field), and by the cards package's
  // condition-active.test.ts, which crafts #53 Reno with #68 Twisted Sorcerer and checks the glow
  // against the branches the fused Cry then takes.
  it("R196 lights a fused card when any ingredient's printed condition holds", () => {
    provenIn(196, "conditionActive.test.ts", "../../cards/test/condition-active.test.ts");
  });

  // Proved in each part of the layer. cues.test.ts "R200 …" bounds every planned cue inside its entry
  // plus FX_MAX_TAIL_MS for every recipe and duration, and bounds the killing blow's replay;
  // director.test.ts "R200 …" fires cues on frames and leaves nothing behind after D +
  // FX_MAX_TAIL_MS, even across a stalled frame; canvasFx.test.ts and particles.test.ts "R200 …" age
  // on real time; FxLayer.test.tsx "R200 …" shows mounting the layer changes no `schedule` call, the
  // reduce setting zeroes --anim-scale and the killing blow plays before the result; stage.test.tsx
  // "R200 …" bounds the stage effects (a stand-in, a hidden card, an aimed lunge) by the entry and
  // FX_HOLD_MAX_MS; css.test.ts "R200 …" draws the Divine Shield cocoon only while the layer is on.
  it("R200 keeps the effects layer from pacing anything: effects decorate the table and trail off within its tail", () => {
    provenIn(
      200,
      WEB_FX_CUES_TEST,
      WEB_FX_DIRECTOR_TEST,
      WEB_FX_LAYER_TEST,
      WEB_FX_STAGE_TEST,
      WEB_FX_CSS_TEST,
      WEB_FX_CANVAS_TEST,
      WEB_FX_PARTICLES_TEST,
    );
  });

  // Proved by animations.fx.test.ts "R201 …": the runner's `schedule` spy at speeds 2, 0.5 and 5.
  it("R201 scales the animation table and the burst budget by the viewer's effects speed", () => {
    provenIn(201, WEB_ANIMATIONS_FX_TEST);
  });

  // Proved by cues.test.ts "R202 …": hidden ids and defIds plan identical cues, and no cue carries a
  // defId or a card name.
  it("R202 draws effects from the redacted stream only", () => {
    provenIn(202, WEB_FX_CUES_TEST);
  });

  // R203 and R204 are client rulings (SPEC §10.11): the engine makes neither, and the proofs live in
  // `apps/web/src/audio`, where the cue table and the director are. Neither changes a rule.

  // Proved by apps/web cues.test.ts's "R203 …" tests (an event whose defId is R97's sentinel gives
  // no voice cue, the viewer's own trap set gives the generic `trapSet` and never speaks, and a
  // `trapFired` speaks its cast line only where R154 leaves its identity readable), and by
  // director.test.ts's "R203 …" tests (the first view, and any view whose `viewer` differs from the
  // last, voice nothing and drop every owed event, so a hotseat hand-over plays nothing; and a real
  // #41 Sheepish, set and fired through the engine's own `viewFor`, speaks only on its controller's
  // seat).
  it("R203 lets sound reveal nothing the viewer's PlayerView does not, so a hidden card never speaks", () => {
    provenIn(203, WEB_AUDIO_CUES_TEST, WEB_AUDIO_DIRECTOR_TEST);
  });

  // Proved by apps/web cues.test.ts's "R204 …" tests: a readable unit's `cardPlayed` gives its play
  // line and a Spell's or Field Spell's its cast line, a unit's `destroyed` gives its death line
  // (R89's defId), a defId the table lacks gives no line, a unit summoned without a play speaks at
  // the lowest priority while a played one's `summoned` adds nothing, `bounced`, `exiled`,
  // `transformed` and `fused` never speak, and death and trap lines outrank play and cast lines.
  it("R204 speaks a play line on cardPlayed, a death line on destroyed, and a trap's line when it fires", () => {
    provenIn(204, WEB_AUDIO_CUES_TEST);
  });

  // Proved by lasting-effects.test.ts's "R209 …" tests: Twinspell bounced, bounced and replayed,
  // destroyed, and stolen and made Radiant by #49.
  it("R209 has a permanent's lasting effect last while it is on the field, and follow its face", () => {
    provenIn(209, CARDS_LASTING_EFFECTS_TEST);
  });

  // Proved by plays-and-casts.test.ts's "R210 …" tests: The Rock tributing a Reborn unit, and a
  // radiant Right-house defender whose Death summons into the row The Rock is going to.
  it("R210 holds the zone a play names while its Tribute is paid", () => {
    provenIn(210, CARDS_PLAYS_AND_CASTS_TEST);
  });

  // Proved by prompts.test.ts and reduce.test.ts "R211 …" (a fixture prompt, the mulligan) and the
  // cards package's play-choices.test.ts with #51 KY's Private Tutor's prompt.
  it("R211 offers concede to both seats while a prompt is open, which the policy never takes", () => {
    provenIn(211, "prompts.test.ts", "reduce.test.ts", CARDS_PLAY_CHOICES_TEST);
  });

  // Proved by stays.test.ts "R212 …" (the event stream's reading, and a Stack note's life) and the
  // cards package's trigger-stays.test.ts "R212 …": #91 and #32 on a Reborn body, #89 drawn after a
  // death, and #32 drawing for the player who controlled it at the kill that #86's Death then stole
  // it from; stacks-and-reborn.test.ts "R212 …": a card that resumes under a Stack answers neither
  // the death that uncovered it nor an event before it, and a later move of the card that left
  // uncovers nothing; my-pawn.test.ts "R212 …": #89 drawn during My Pawn's AI turn does not feed
  // on a death from the window before it.
  it("R212 offers an event to the cards as they stood when it happened", () => {
    provenIn(212, "stays.test.ts", CARDS_TRIGGER_STAYS_TEST, CARDS_STACKS_AND_REBORN_TEST, "../../cards/test/my-pawn.test.ts");
  });

  // Proved by resolving-face.test.ts "R213 …": a Gifted Program stolen after firing, one bounced and
  // replayed, and a cheap card played before one arrived.
  it("R213 counts Gifted Program's first cheap card over its controller's plays that turn", () => {
    provenIn(213, CARDS_RESOLVING_FACE_TEST);
  });

  // Proved by resolving-face.test.ts "R214 …": #87 radiant's skip, #48 radiant's enemy-only switch
  // and a crafted Bigot + Twisted Sorcerer, each made Radiant by #64 as it is played.
  it("R214 reads a play's targets and modes against the face it will resolve with", () => {
    provenIn(214, CARDS_RESOLVING_FACE_TEST);
  });

  // Proved by hand-returns.test.ts "R215 …": a Corpse Eater that fed in hand, discarded and brought
  // back by Reminisce, and a crafted card a full hand burns.
  it("R215 resets a hand or library card that reaches a graveyard or exile, and keeps a hand's price in the hand", () => {
    provenIn(215, CARDS_HAND_RETURNS_TEST);
  });

  // Proved by game-over.test.ts "R216 …": Stockpile's heal after the cast that killed its hero, and
  // My Pawn's consumption after the AI turn that ended the game. The fuzz monitor's I5 checks it in
  // every random game.
  it("R216 resolves nothing after the check that ends the game", () => {
    provenIn(216, CARDS_GAME_OVER_TEST);
  });

  // Proved by draw.test.ts "R217 …" (a fixture cast whose script draws, capped as one chain) and the
  // cards package's plays-and-casts.test.ts "R217 …": CN-Virus cast under /fullsend's Combo draw.
  it("R217 has a draw a cast-on-draw cast makes continue that cast's chain", () => {
    provenIn(217, "draw.test.ts", CARDS_PLAYS_AND_CASTS_TEST);
  });

  // Proved by 069-call-to-arms.test.ts "R218 …": a Rush Token card #33 shuffled in is passed over.
  it("R218 has a Recruit pass over a unit-token card in the library", () => {
    provenIn(218, CARDS_CALL_TO_ARMS_TEST);
  });

  // Proved by 089-corpse-eater.test.ts "R219 …": a unit #46 starved below 0 max health feeds nothing.
  it("R219 never lets a gained stat be a loss", () => {
    provenIn(219, CARDS_CORPSE_EATER_TEST);
  });

  // Proved by combat-windows.test.ts "R220 …": fixture traps in §4.2 step 4's window that destroy,
  // steal or move the attacker or its target, or swap the boards, with and without a question
  // first, and a My Pawn after a trap that destroyed the attacker.
  it("R220 resolves a declared attack only while it stands as it was declared", () => {
    provenIn(220, CARDS_COMBAT_WINDOWS_TEST);
  });

  // Proved by turn-clock-and-legality.test.ts "R221 …": a radiant #26's two Echo picks listed the
  // other way round leave the state an offered answer leaves (#80's discard, until R354).
  it("R221 takes an answer's picks in the order the prompt offered them", () => {
    provenIn(221, CARDS_TURN_CLOCK_TEST);
  });

  // Proved by 097-zephyrs.test.ts and hidden-information.test.ts "R222 …": the offer is the same
  // whichever face-down trap the opponent holds and whatever the order of the caster's library.
  it("R222 plays Zephyrs' dry run on what its player may read", () => {
    provenIn(222, CARDS_ZEPHYRS_TEST, CARDS_HIDDEN_INFORMATION_TEST);
  });

  // Proved by hidden-information.test.ts "R223 …": two games through createGame whose decks differ
  // only in a card that never shows.
  it("R223 numbers a deck's cards in an order that says nothing about the deck", () => {
    provenIn(223, CARDS_HIDDEN_INFORMATION_TEST);
  });

  // Proved by setup-and-mulligan.test.ts "R224 …": a cast-on-draw card the opening draw or a
  // mulligan's replacement draws reach asks its caster, and setup opens no mulligan over the
  // question; the mulligan's answer names its prompt.
  it("R224 has setup wait for a cast's question before it goes on", () => {
    provenIn(224, CARDS_SETUP_TEST);
  });

  // Proved by setup-and-mulligan.test.ts "R225 …": two games whose decks differ only in whether one
  // seat holds a Quickdraw card give the other seat the same view — #100's price after the
  // mulligans, the deal's events, and the counts while setup waits on a cast's question.
  it("R225 deals a Quickdraw card as the last of the opening draws it replaces, counted as a draw", () => {
    provenIn(225, CARDS_SETUP_TEST);
  });

  // Proved by paused-sequences.test.ts "R226 …": a Tribute whose Death asks its controller to discard
  // a card, answered with the card being played, leaves that card in the graveyard alone.
  it("R226 plays no card that left its owner's hand before §10.5 step 4", () => {
    provenIn(226, CARDS_PAUSED_SEQUENCES_TEST);
  });

  // Proved by turn-clock-and-legality.test.ts "R227 …": a Sheepish p1 saw in p2's graveyard, returned
  // and set again, is named by `legalActions` only under a fresh id; hidden-information.test.ts's
  // "R227 …" tests pin `formerId` on both seats, and effects-summon.test.ts's the Recruit path.
  it("R227 gives a card set face-down a fresh id, so no id seen while it was public names it", () => {
    provenIn(227, CARDS_TURN_CLOCK_TEST);
  });

  // Proved by turn-stages.test.ts "R240 …": a fatigue draw Going Long's Armor absorbs whole is
  // reported by one hit of 0 on the hero, which neither a unit's trigger nor a face-down trap that
  // watches hits on a hero answers; rulings-c.test.ts's R125 case sees the same reports.
  it("R240 reports a fatigue draw whose whole hit the hero's Armor absorbs", () => {
    provenIn(240, CARDS_TURN_STAGES_TEST);
  });

  // Proved by turn-stages.test.ts "R241 …": a Spell carrying #78's end-of-turn exile, cast on draw on
  // the other player's turn, exiles nothing at the end of its caster's next turn; and by
  // setup-and-mulligan.test.ts "R241 …": setup is no player's turn, so the end-of-turn clause of a
  // Spell p1's mulligan casts is not armed for turn 1, though setup names p1 active (p2's never was).
  it("R241 arms no end-of-turn clause a card makes on the other player's turn", () => {
    provenIn(241, CARDS_TURN_STAGES_TEST, CARDS_SETUP_TEST);
  });

  // Proved by hidden-information.test.ts "R242 …": whether #28 passes over p1's public unit, and the
  // order its events go out in, give p2 the same view whatever the faces of p1's hidden cards.
  it("R242 splits a random Make Radiant between the cards each player may read by the groups' sizes", () => {
    provenIn(242, CARDS_HIDDEN_INFORMATION_TEST);
  });

  // Proved by hidden-information.test.ts "R243 …" (a Corpse Eater's meals and a Heroic Power's power
  // in hand, a crafted card's definition) and vanilla-and-positions.test.ts "R243 …" (a Vanilla copy).
  it("R243 puts in the view what a card is made of beyond its printed face", () => {
    provenIn(243, CARDS_HIDDEN_INFORMATION_TEST, CARDS_VANILLA_AND_POSITIONS_TEST);
  });

  // Proved by t-coin.test.ts "R244 …" over real games with the real catalog (after both mulligans,
  // the seat going second's last card, a handicapped seat's too, an add to hand and not a draw, a
  // full hand's burn, the fold) and by setup.test.ts "R244 …" (`OPENING_COINS` per seat, and none
  // from a catalog without the card).
  it("R244 deals The Coin to the seat going second once both mulligans are answered", () => {
    provenIn(244, CARDS_COIN_TEST, "setup.test.ts");
  });

  // Proved by t-coin.test.ts "R245 …": a 0-cost Token Spell gaining 1 temporary mana (2 Radiant)
  // above the cap, a play that goes to the graveyard, and in no deck or random pool.
  it("R245 makes The Coin a 0-cost Token Spell that gains 1 mana this turn, 2 when Radiant", () => {
    provenIn(245, CARDS_COIN_TEST);
  });

  // Proved by effects-choose.test.ts "R247 …": `offer: "index"` draws the same three cards and
  // offers their indices, and the view names none of them; by 082-kys-trial.test.ts "R247 …": #82's
  // options are three indices keyed and labelled by the number, and `legalActions` answers by
  // number; and by PromptCards.test.tsx "R247 …": the picker draws the numbers, and no card face.
  it("R247 offers #82's Discover as the numbers themselves", () => {
    provenIn(247, "effects-choose.test.ts", CARDS_KYS_TRIAL_TEST, WEB_PROMPT_CARDS_TEST);
  });

  // R250 to R264 are the decks-and-modes change: server and client rulings, indexed here like R104
  // to R112 and R159 to R167 before them. A row whose ruling is a number asserts it against
  // `apps/server/src/config.ts`, where rule 9 puts it.

  // Proved by the validator's drafts.test.ts "R250 …" (D1–D4 and nothing else at save), the store
  // contract's "R250 …" (the cap, in both stores) and decks.test.ts "R250 …" (the endpoint).
  it("R250 saves a deck as a draft: structure at save, legality at queue, ten decks at most", () => {
    expect(serverConstant(SERVER_CONFIG, "MAX_SAVED_DECKS")).toBe("10");
    expect(serverConstant(SERVER_CONFIG, "DECK_NAME_MAX_LENGTH")).toBe("40");
    expect(serverConstant(SERVER_CONFIG, "DRAFT_ISSUES_REPORTED_MAX")).toBe("50");
    provenIn(250, VALIDATOR_DRAFTS_TEST, SERVER_STORE_CONTRACT, SERVER_DECKS_TEST);
  });

  // Proved by drafts.test.ts "R251 …" (shared cards found by catalog id, the fact L4 words) and the
  // workshop's "R251 …" (a card another deck holds is marked unavailable, with that deck's name).
  it("R251 compares catalog ids across a trio: Radiant is never a second card", () => {
    provenIn(251, VALIDATOR_DRAFTS_TEST, WEB_WORKSHOP_TEST);
  });

  // Proved by drafts.test.ts "R252 …" (T1–T3), the store contract's "R252 …" (slots emptied by a
  // deck's deletion, a foreign deck refused) and decks.test.ts "R252 …".
  it("R252 keeps up to five trios of three slots, any of them empty", () => {
    expect(serverConstant(SERVER_CONFIG, "MAX_SAVED_TRIOS")).toBe("5");
    provenIn(252, VALIDATOR_DRAFTS_TEST, SERVER_STORE_CONTRACT, SERVER_DECKS_TEST);
  });

  // Proved by drafts.test.ts "R253 …" (L2, L3, L5, L6 for a deck; L1–L6 for a trio) and
  // queue.test.ts "R253 …" (the enqueue refusals, with the decks' names).
  it("R253 queues a Best-of-1 deck on L2, L3, L5, L6 and a trio on L1–L6", () => {
    provenIn(253, VALIDATOR_DRAFTS_TEST, SERVER_QUEUE_TEST);
  });

  // Proved by 04_decks_and_series.sql's R254 heading: a loadout saved before migration 0007 comes
  // out as three decks and "My trio", and the loadout rows are still there.
  it("R254 migrates every loadout into three decks and one trio, losing nothing", () => {
    provenIn(254, SERVER_DECKS_SQL);
  });

  // Proved by deckCode.test.ts "R255 …": the round trip, the caps, the version and checksum, and
  // what an import drops and marks.
  it("R255 shares a deck as a versioned, checksummed, length-capped code", () => {
    // Version 2 since patch v0.2.0 (B2.2): each number carries its set; version 1 still reads as Core.
    expect(serverConstant(SERVER_CONFIG, "DECK_CODE_VERSION")).toBe("2");
    expect(serverConstant(SERVER_CONFIG, "DECK_CODE_CORE_ONLY_VERSION")).toBe("1");
    expect(serverConstant(SERVER_CONFIG, "DECK_CODE_MAX_INPUT_LENGTH")).toBe("512");
    provenIn(255, WEB_DECK_CODE_TEST);
  });

  // Proved by sync.test.ts "R256 …" (debounce, the local mirror, offline and back), the store
  // contract's "R256 …" (an upsert keyed by the client's id) and decks.test.ts "R256 …".
  it("R256 autosaves by client-minted id and keeps unsaved edits on the device", () => {
    expect(serverConstant(SERVER_CONFIG, "DECK_AUTOSAVE_DEBOUNCE_MS")).toBe("800");
    expect(serverConstant(SERVER_CONFIG, "DECK_AUTOSAVE_RETRY_SECONDS")).toBe("5");
    provenIn(256, WEB_DECK_SYNC_TEST, SERVER_STORE_CONTRACT, SERVER_DECKS_TEST);
  });

  // Proved by queue.test.ts "R257 …" (pairing only within a mode, the legacy deckIndex), the store
  // contract's "R257 …" (a ticket's mode and trio, counted per mode) and play.test.tsx "R257 …".
  it("R257 pairs a ticket only within its mode", () => {
    provenIn(257, SERVER_QUEUE_TEST, SERVER_STORE_CONTRACT, WEB_PLAY_TEST);
  });

  // Proved by queue.test.ts "R258 …" (both seats dealt, no deck needed) and engine.real.test.ts
  // "R258 …" (the real weighted draw: twenty distinct deckable cards, the same for the same seed).
  it("R258 deals All Random decks from the weighted random deck-builder", () => {
    provenIn(258, SERVER_QUEUE_TEST, SERVER_ENGINE_REAL_TEST);
  });

  // Amended by R330–R336 (Conquest). What stands — the frozen trios, the hidden pick, the seeds and
  // the seats, the hidden deck names — is proved by series-rules.test.ts and series.test.ts "R259 …".
  it("R259 plays a series from the trios frozen at queue, one deck a side each game, picks hidden until both are in", () => {
    provenIn(259, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST);
  });

  // Replaced by R333, which keeps its clock and its abandonment: series-rules.test.ts and
  // series.test.ts name R260 on the tests of what stands.
  it("R260 abandons a series nobody picks in (the clock is R333's now)", () => {
    provenIn(260, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST);
  });

  // Replaced by R334, which keeps its concede, disconnect and forfeit: series-rules.test.ts and
  // series.test.ts name R261 on those tests.
  it("R261 loses a game, not the series, to a concede or a disconnect (the rest is R334's now)", () => {
    provenIn(261, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST);
  });

  // Proved by series.test.ts "R262 …": one rating move per series, its games' rows unchanged.
  it("R262 rates a series once, when it ends", () => {
    provenIn(262, SERVER_SERIES_TEST);
  });

  // Proved by series-recovery.test.ts "R263 …" (the sweeper starts a game a restart left unstarted;
  // a second process continues the series) and the store contract's "R263 …" (compare-and-set).
  it("R263 keeps a series in the database, so it survives a restart", () => {
    expect(serverConstant(SERVER_CONFIG, "SERIES_SWEEP_INTERVAL_SECONDS")).toBe("5");
    expect(serverConstant(SERVER_CONFIG, "SERIES_START_GRACE_SECONDS")).toBe("15");
    expect(serverConstant(SERVER_CONFIG, "SERIES_START_GIVE_UP_SECONDS")).toBe("120");
    provenIn(263, SERVER_SERIES_RECOVERY_TEST, SERVER_STORE_CONTRACT);
  });

  // Proved by rooms.test.ts "R264 …", the store contract's "R264 …" (a room's mode and trio) and
  // play.test.tsx "R264 …" (a join in the wrong mode switches the lobby to the room's).
  it("R264 makes a room in its host's mode and refuses a joiner in another", () => {
    provenIn(264, SERVER_ROOMS_TEST, SERVER_STORE_CONTRACT, WEB_PLAY_TEST);
  });

  // Proved by mulligan-concurrent.test.ts "R265 …": over 60 seeds, and again with cast-on-draw
  // replacements and a handicapped seat, the two answer orders deal one game (the same hash), both
  // orders' logs fold to it, and a state waiting on one answer survives JSON and goes on the same;
  // by actor.test.ts "R265 …": the actor takes both seats' answers in either order; and by
  // recovery.test.ts "R265 …": a fold of either order's log rebuilds the same views.
  it("R265 opens both players' mulligans at once and resolves them in seat order once both are in", () => {
    provenIn(265, "mulligan-concurrent.test.ts", SERVER_ACTOR_TEST, SERVER_RECOVERY_TEST);
  });

  // Proved by mulligan-concurrent.test.ts "R266 …": the other seat's view is the same whatever was
  // kept, and says only that the answer is in; and by observe.test.ts "R266 …": `redact` leaves the
  // AI the same state whatever the human kept; and by actor.test.ts "R266 …": no frame to the other
  // seat carries it.
  it("R266 seals a mulligan answer until both are in, and shows the other player only that it is in", () => {
    provenIn(266, "mulligan-concurrent.test.ts", AI_OBSERVE_TEST, SERVER_ACTOR_TEST);
  });

  // Proved by mulligan-concurrent.test.ts "R267 …": a fixture cast-on-draw card in p1's replacement
  // draw discards one of p2's offered cards and gives p2 a new one before p2's sealed answer resolves.
  it("R267 reads a sealed mulligan answer against the hand it resolves against", () => {
    provenIn(267, "mulligan-concurrent.test.ts");
  });

  // Proved by mulligan-concurrent.test.ts "R268 …": the engine's `timeout` keeps the whole hand, only
  // the timing-out seat's, with no rng draw; clock.test.ts and actor.test.ts "R268 …" prove the one
  // shared deadline, never re-armed, whose expiry times out every seat still owing.
  it("R268 runs one mulligan clock for both players, and keeps the hand of a player it times out", () => {
    provenIn(268, "mulligan-concurrent.test.ts", SERVER_CLOCK_TEST, SERVER_ACTOR_TEST);
  });

  // Proved by mulligan-concurrent.test.ts "R269 …": the offer is on both views until it is answered
  // or its offerer's turn ends, a late answer is refused, and a lapsed offer blocks nothing; and by
  // actor.test.ts "R269 …": through the actor, the accepted draw is rated 0.5 each.
  it("R269 lets a draw offer stand until it is answered or its offerer's turn ends", () => {
    provenIn(269, "mulligan-concurrent.test.ts", SERVER_ACTOR_TEST);
  });

  // Proved by actor.test.ts "R270 …": a client frame carrying the nonce the mulligan expiry is about
  // to mint is refused as malformed, and the expiry still times out the seat left.
  it("R270 refuses a client nonce with the server's own prefix", () => {
    provenIn(270, SERVER_ACTOR_TEST);
  });

  // Proved by radiant-standard.test.ts "R275 …": every Unit face's attack and health are at least
  // twice its base face's, a 0 staying 0, with the exceptions the test names (none).
  it("R275 holds every Radiant face to about twice its base face", () => {
    provenIn(275, CARDS_RADIANT_STANDARD_TEST);
  });

  // Proved by radiant-standard.test.ts "R276 …": every catalog entry's Radiant face differs from its
  // base face in text, stats or keywords, the five cards that had none included.
  it("R276 gives every card a Radiant face that changes it", () => {
    provenIn(276, CARDS_RADIANT_STANDARD_TEST);
  });

  // Proved by radiantDiff.test.ts "R277 …": the word diff marks exactly what the Radiant text adds,
  // case aside, and every card's Radiant face renders it gold, bold and underlined.
  it("R277 prints a Radiant face whole and marks what differs from the base", () => {
    provenIn(277, WEB_RADIANT_DIFF_TEST);
  });

  // Proved by catalog.test.ts "R278 …" (the tag is on #13 and #14 alone), filters.test.ts
  // "R278 …" (the deck builder offers and applies it), and the schema's half, migration 0010:
  // seed-catalog.test.ts "R278 …" (every catalog tag is one the latest cards_tags_check admits),
  // 01_schema_invariants.sql "=== CHECK 18 (R278): … ===" and seed-catalog.spec.ts "R278 …" (the
  // real catalog seeds into Postgres, #13 and #14 tagged Jlockeed).
  it("R278 tags #13 and #14 Jlockeed, a filter and nothing else", () => {
    provenIn(
      278,
      CARDS_CATALOG_TEST,
      WEB_FILTERS_TEST,
      SERVER_SEED_CATALOG_TEST,
      SERVER_SCHEMA_SQL,
      SERVER_SEED_CATALOG_SPEC,
    );
  });

  // Proved by references.test.ts "R279 …" in packages/cards (the map against the texts, both ways,
  // and every token but The Coin named) and in apps/web (the reference opens the named face).
  it("R279 links the cards and tokens a card's text names", () => {
    provenIn(279, CARDS_REFERENCES_TEST, WEB_REFERENCES_TEST);
  });

  // Proved by preview.test.ts "R280 …" in the engine (where `viewFor` carries `preview` and where
  // not), in packages/cards (each Core formula, and what it may read), and computed.test.tsx "R280 …"
  // (the braces in hand and on the field, none in the collection).
  it("R280 carries the number a formula comes to now in the view", () => {
    provenIn(280, "preview.test.ts", CARDS_PREVIEW_TEST, WEB_COMPUTED_TEST);
  });

  // Proved by 038-quickstriker.test.ts "R281 …": the Radiant face's 2X is one damage instance.
  it("R281 deals Radiant Quickstriker's 2X as one hit", () => {
    provenIn(281, CARDS_QUICKSTRIKER_TEST);
  });

  // Proved by 050-k-pop-fanatic.test.ts "R282 …": the rider lands only on a card the steal took.
  it("R282 makes Radiant only a permanent Radiant K-Pop Fanatic's steal took", () => {
    provenIn(282, CARDS_KPOP_FANATIC_TEST);
  });

  // Proved by 096-my-pawn.test.ts "R283 …": the attacker is destroyed after the cancel and before
  // the AI turn, and an Indestructible one is knocked down instead.
  it("R283 has Radiant My Pawn destroy the attacker it stops", () => {
    provenIn(283, CARDS_MY_PAWN_TEST);
  });

  // Proved by handicap.test.ts "R290 …" (AI_TUTORIAL's numbers, `heroHealth` stored only off 30 and
  // validated, the hero starting at 20, the mana cap, the fold) and by packages/ai
  // tutorial-tier.test.ts "R290 …": the greedy baseline at a human's resources beats the AI at the
  // tutorial handicap in most of a frozen series of games.
  it("R290 gives the tutorial opponent a handicap below Easy: 12 cards, 3 mana, a hero at 20", () => {
    expect(config.AI_TUTORIAL).toEqual({
      deckSize: 12,
      manaBonus: 0,
      manaCap: 3,
      extraOpeningCards: 0,
      extraDrawsPerTurn: 0,
      heroHealth: 20,
    });
    expect(config.DIFFICULTIES).not.toContain("tutorial");
    provenIn(290, "handicap.test.ts", AI_TUTORIAL_TIER_TEST);
  });

  // Proved by apps/web tutorial/lessons.test.ts "R291 …": legal decks, an AI deck of exactly the
  // handicap's size free of the shadow ban and of what the lesson has not taught, a fixed deal, and a
  // start through the practice core with the lesson's decks and the tutorial handicap.
  it("R291 plays each lesson with a fixed seed, seat and two fixed decks", () => {
    provenIn(291, WEB_TUTORIAL_LESSONS_TEST);
  });

  // Proved by apps/web tutorial/coach.test.ts "R292 …": the coach machine on hand-built views.
  it("R292 has the coach read only the view, legal actions and the AI's turn, and never strand a player", () => {
    provenIn(292, WEB_TUTORIAL_COACH_TEST);
  });

  // Proved by each lesson's scripts/<id>.test.ts "R293 …": the lesson played through the real
  // practice core by a player following the coach, by a sensible one ignoring it, and by a random one.
  it("R293 makes every lesson winnable by following its coach", () => {
    provenIn(293, ...WEB_TUTORIAL_LESSON_TESTS);
  });

  // Proved by apps/web tutorial/progress.test.ts "R294 …": the on-device store and the unlock order.
  it("R294 keeps tutorial progress on the device and opens the lessons in order", () => {
    provenIn(294, WEB_TUTORIAL_PROGRESS_TEST);
  });

  // Proved by ownLibrary.test.ts "R310 …": the list's order, grouping and fields, the opponent's
  // library left a count, and two orders of the same library giving the same view.
  it("R310 gives the viewer their own library as a list without its order", () => {
    provenIn(310, "ownLibrary.test.ts");
  });

  // Proved by ownLibrary.test.ts "R311 …" (the deck, a mulligan's returns, a shuffle-in, a change
  // inside the library) and again by the cards that shuffle in or change a library card: #33, #90, #42.
  it("R311 lists what the owner was shown of each card going in, and not what changed unseen", () => {
    provenIn(311, "ownLibrary.test.ts", ...CARD_TESTS_R311);
  });

  // Proved by ownLibrary.test.ts "R312 …", by #87's library swap and #83's library replacements, and
  // by packages/ai's observe.test.ts: the AI's own redacted state hides what its list counts unknown.
  it("R312 counts a card its owner was never shown as unknown", () => {
    provenIn(312, "ownLibrary.test.ts", ...CARD_TESTS_R312);
  });

  // Proved by apps/web game/PileBrowser.test.tsx "R313 …": the library pile's preview and dialog.
  it("R313 lets the viewer look through their own library pile, and not the opponent's", () => {
    provenIn(313, WEB_PILE_BROWSER_TEST);
  });

  // Proved by apps/web tutorial/coach.test.ts "R314 …" (every lesson's steps and tips, and expiry)
  // and routes/practice-tutorial.test.tsx "R314 …" (no Skip step on the page; Got it and Exit are).
  it("R314 has no Skip step in the tutorial, and nothing that strands the player", () => {
    provenIn(314, WEB_TUTORIAL_COACH_TEST, WEB_PRACTICE_TUTORIAL_TEST);
  });

  // Proved by overflow-events.test.ts "R315 …": a fatigue draw through `reduce` reports `fatigue`
  // before its hit on both seats, one per draw of a draw N, still when Armor takes the hit whole, and
  // never for a draw #75 replaces.
  it("R315 reports each fatigue draw as `fatigue`, public, just before its hit", () => {
    provenIn(315, OVERFLOW_EVENTS_TEST);
  });

  // Proved by overflow-events.test.ts "R316 …": each of R80's three outcomes, what both seats read of
  // it, nothing below the cap, and a CN-Virus chain at the cap.
  it("R316 reports every card a full library turns away as `libraryOverflow`, with its outcome", () => {
    provenIn(316, OVERFLOW_EVENTS_TEST);
  });

  // Proved by overflow-events.test.ts "R317 …": a burn through `reduce` read by both seats, a burned
  // card hidden again once it is back in its owner's hand, and a unit-token card burned out of existence.
  it("R317 lets both players read a burned card while it stays public", () => {
    provenIn(317, OVERFLOW_EVENTS_TEST);
  });

  // Proved by apps/web game/overflow.test.tsx "R318 …" (the rows, the notices on both seats, face and
  // back, the settings), game/animations.window.test.ts "R318 …" (each new event handed to each
  // seat's runner exactly once in real games that reach all three) and fx/cues.test.ts "R318 …" (the
  // `fatigue`, `overflow` and `burn` recipes, the same for a hidden card as for a readable one).
  it("R318 shows fatigue, a full hand and a full library on both seats, each once", () => {
    provenIn(318, WEB_OVERFLOW_TEST, WEB_ANIMATIONS_WINDOW_TEST, WEB_FX_CUES_TEST);
  });

  // Proved by apps/web audio/cues.test.ts "R319 …": each overflow's own sound, the same for any card.
  it("R319 gives each overflow a sound of its own that says nothing of the card", () => {
    provenIn(319, WEB_AUDIO_CUES_TEST);
  });

  // Proved by apps/server test/api/tutorial.test.ts (the routes: active only, the union, the clamped
  // choice, the body's checks), test/db/contract.ts (both stores), and the SQL suite's 05 (the merge
  // function) and 02 (a player reads only its own row and writes none) headings.
  it("R320 keeps an active account's tutorial progress on the server, merged and never removed", () => {
    provenIn(320, SERVER_TUTORIAL_API_TEST, SERVER_STORE_CONTRACT, SERVER_TUTORIAL_SQL, SERVER_RLS_SQL);
  });

  // Proved by apps/web tutorial/accountSync.test.ts (load, push-up, one request at a time, failures
  // dropped), tutorial/progress.test.ts (the union and the newest choice) and routes/practice.test.tsx.
  it("R321 merges the device's tutorial progress with the account's as a union, never stepping back", () => {
    provenIn(321, WEB_TUTORIAL_ACCOUNT_SYNC_TEST, WEB_TUTORIAL_PROGRESS_TEST, WEB_PRACTICE_ROUTE_TEST);
  });

  // Proved by apps/web tutorial/TutorialPath.test.tsx "R322 …": Hide and Show, focus, touch size.
  it("R322 lets the player hide the lesson path while a lesson is still to do, and show it again", () => {
    provenIn(322, WEB_TUTORIAL_PATH_TEST);
  });

  // Proved by apps/web auth/pkce.test.ts (the verifier, its challenge and where it is kept),
  // net/auth-flows.test.ts (the mailers' challenge, the exchange), auth/redirect.test.ts (the code
  // read on /login and / only, and scrubbed) and routes/login-flows.test.tsx (a code on the screen).
  it("R323 sends a PKCE challenge with every mailer and exchanges a returning code for the link's session", () => {
    provenIn(323, WEB_PKCE_TEST, WEB_AUTH_FLOWS_TEST, WEB_REDIRECT_TEST, WEB_LOGIN_FLOWS_TEST);
  });

  // Proved by the same files' "R324 …" tests: no verifier here, a refused code, a browser that
  // cannot hash, and an implicit-flow link mailed before the switch.
  it("R324 confirms a link opened elsewhere without an error, and still reads a link from before", () => {
    provenIn(324, WEB_AUTH_FLOWS_TEST, WEB_REDIRECT_TEST, WEB_LOGIN_FLOWS_TEST);
  });

  // Proved by series-rules.test.ts "R330 …" (a deck that wins is locked, a lost one comes back, three
  // wins with three decks take the series, and over 400 seeded series a side's wins are always its
  // won decks) and series.test.ts "R330 …" (a won deck refused through the API).
  it("R330 plays the trio mode as Conquest: a win with each deck takes the series, and a deck that wins is locked", () => {
    expect(serverConstant(SERVER_CONFIG, "SERIES_WINS_NEEDED")).toBe("3");
    provenIn(330, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST);
  });

  // Proved by series-rules.test.ts "R331 …" (hidden, final, completing both starts the game),
  // series.test.ts "R331 …" (a second slot refused, the same slot answered as success, a pick in the
  // database before it is acknowledged), series-recovery.test.ts "R331 …" (a pick survives a
  // restart, sealed and hidden) and series.test.tsx "R331 …" (choose, lock in, then wait).
  it("R331 seals each player's pick until both are in, and keeps it across a restart", () => {
    provenIn(331, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST, SERVER_SERIES_RECOVERY_TEST, WEB_SERIES_TEST);
  });

  // Proved by series-rules.test.ts and series.test.ts "R332 …", series.test.tsx "R332 …" and
  // SeriesBanner.test.tsx "R332 …".
  it("R332 picks a player's last deck for them, and starts the game when both are down to one", () => {
    provenIn(332, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST, WEB_SERIES_TEST, WEB_SERIES_BANNER_TEST);
  });

  // Proved by series-rules.test.ts and series.test.ts "R333 …", and series.test.tsx "R333 …".
  it("R333 gives a late picker their first deck that has not won, and abandons a series nobody picks in", () => {
    expect(serverConstant(SERVER_CONFIG, "SERIES_PICK_SECONDS")).toBe("60");
    provenIn(333, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST, WEB_SERIES_TEST);
  });

  // Proved by series-rules.test.ts and series.test.ts "R334 …": draws lock nothing, the cap and what
  // it decides, concede and disconnect lose a game, forfeit between games only.
  it("R334 counts a draw for neither side, caps a series at seven games, and loses only a game to a concede", () => {
    expect(serverConstant(SERVER_CONFIG, "SERIES_MAX_GAMES")).toBe("7");
    provenIn(334, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST);
  });

  // Proved by series-rules.test.ts and series.test.ts "R335 …".
  it("R335 alternates who goes first by game number, draws included", () => {
    provenIn(335, SERVER_SERIES_RULES_TEST, SERVER_SERIES_TEST);
  });

  // Proved by series-rules.test.ts "R336 …" (the projection, at every point of a series),
  // series.test.tsx "R336 …" and SeriesBanner.test.tsx "R336 …" (both sides' won decks on screen).
  it("R336 shows each side both sides' won decks, and nothing else of the other side's trio", () => {
    provenIn(336, SERVER_SERIES_RULES_TEST, WEB_SERIES_TEST, WEB_SERIES_BANNER_TEST);
  });

  // Proved by series-rules.test.ts "R337 …": a Best-of-3 row at one win each goes on as Conquest.
  it("R337 carries a series begun as a Best of 3 on as a Conquest", () => {
    provenIn(337, SERVER_SERIES_RULES_TEST);
  });

  // Proved by series.test.tsx "R338 …" and SeriesBanner.test.tsx "R338 …": the pick on the series
  // screen, and the way on from the board to it and to the game it starts.
  it("R338 puts the pick on the series screen, laid out as the mulligan is", () => {
    provenIn(338, WEB_SERIES_TEST, WEB_SERIES_BANNER_TEST);
  });

  // Proved by trioCode.test.ts "R339 …" (the round trip, totality, every refusal, each deck read as a
  // deck code's) and DeckWorkshop.test.tsx "R339 …" (Copy trio code, and a code that cannot be read).
  it("R339 shares a trio and its decks as a versioned, checksummed, length-capped code", () => {
    expect(serverConstant(SERVER_CONFIG, "TRIO_CODE_VERSION")).toBe("2");
    expect(serverConstant(SERVER_CONFIG, "TRIO_CODE_CORE_ONLY_VERSION")).toBe("1");
    expect(serverConstant(SERVER_CONFIG, "TRIO_CODE_MAX_INPUT_LENGTH")).toBe("2048");
    provenIn(339, WEB_TRIO_CODE_TEST, WEB_WORKSHOP_TEST);
  });

  // Proved by drafts.test.ts "R340 …" (the sentence), decks.test.ts "R340 …" (the server's refusal,
  // nothing written), sync.test.ts and DeckWorkshop.test.tsx "R340 …" (refused before it is sent).
  it("R340 fits a trio import under both caps or makes nothing, saying how many slots it needs", () => {
    provenIn(340, VALIDATOR_DRAFTS_TEST, SERVER_DECKS_TEST, WEB_DECK_SYNC_TEST, WEB_WORKSHOP_TEST);
  });

  // Proved by decks.test.ts "R341 …" (every check, the rollback, the retry), sync.test.ts "R341 …"
  // (one request, ids reused on a retry) and DeckWorkshop.test.tsx "R341 …".
  it("R341 checks a trio import on the server and writes it all or nothing", () => {
    provenIn(341, SERVER_DECKS_TEST, WEB_DECK_SYNC_TEST, WEB_WORKSHOP_TEST);
  });

  // Proved by auto-end-turn.test.ts "R345 …": off, an idle turn waits for End turn and on again it
  // ends at once; the preference is the sender's own, taken from either seat at any moment, never
  // offered by legalActions, shown only in the viewer's own view, and folded with the log; by
  // actor.test.ts "R345 …": the actor carries it over the wire and refuses a malformed one; and by
  // apps/web test/ux/settings.test.tsx "R345 …": the switch goes out as setAutoEndTurn, once.
  it("R345 lets each player turn R82's automatic turn end off for themselves", () => {
    provenIn(345, "auto-end-turn.test.ts", SERVER_ACTOR_TEST, WEB_SETTINGS_TEST);
  });

  // Proved by damage.test.ts "R346 step 2: …" (a Pierce source skips Armor on a unit and a hero, and
  // nothing else), lethal.test.ts "R346 R44 …" (My Pawn's projection), 044-true-strike.test.ts's
  // "R346 …" (a spell's printed Pierce), and t-ghoul.test.ts's "R346 …" (the Ghoul Token's hits).
  it("R346 makes a Pierce source's damage skip Armor, and adds Pierce to the random-keyword pool", () => {
    expect(config.RANDOM_KEYWORD_POOL).toContain("Pierce");
    provenIn(346, "damage.test.ts", "lethal.test.ts", CARDS_TRUE_STRIKE_TEST, CARDS_GHOUL_TEST);
  });

  // Proved by layers.test.ts "R347 …" (printed, granted and Defense Position's Taunt all give way)
  // and vanilla-and-positions.test.ts "R46 R347 …" (a knock-down with no Taunt to take reports none).
  it("R347 gives an Indestructible unit no Taunt, whatever grants it", () => {
    provenIn(347, "layers.test.ts", CARDS_VANILLA_POSITIONS_TEST);
  });

  // Proved by turn.test.ts "R348 …" (the refusal and legalActions share one check), and the cards'
  // 074-adaptive-ui.test.ts and 024-efficiency-dividend.test.ts "R348 …".
  it("R348 holds a chosen X to at least 1", () => {
    expect(config.MIN_CHOSEN_X).toBe(1);
    provenIn(348, "turn.test.ts", CARDS_ADAPTIVE_UI_TEST, CARDS_DIVIDEND_TEST);
  });

  // Proved by layers.test.ts "R349 …" (layer 1 doubles a fallback unit's stats and its X) and
  // t-ghoul.test.ts "R349 …" (the Ghoul Token summoned Radiant, made Radiant, and fused).
  it("R349 doubles the stats of a unit that becomes Radiant with no Radiant form", () => {
    expect(config.RADIANT_FALLBACK_FACTOR).toBe(2);
    provenIn(349, "layers.test.ts", CARDS_GHOUL_TEST);
  });

  // Proved by effects-delay.test.ts "R350 …" (THIS_TURN) and 090-cn-viral-injection.test.ts "R350 …"
  // (the copies at the turn's end, on either player's turn, and a chain that never draws its own).
  it("R350 holds CN-Virus's copies to the end of the turn it is cast on", () => {
    provenIn(350, "effects-delay.test.ts", CARDS_CN_TEST);
  });

  // Proved by viewFor.test.ts "R351 …": the cost on the opponent's marker, the same number in the
  // controller's view, and the controller's `unrevealed` mark.
  it("R351 shows a face-down Trap's cost to both players", () => {
    provenIn(351, "viewFor.test.ts");
  });

  // Proved by 098-heroic-power.test.ts "R352 …": the two Discovers, the fusion at R77's cost, the
  // radiant face, and the use spent once.
  it("R352 gives Heroic Power its eighth power, Stitching", () => {
    provenIn(352, CARDS_HEROIC_POWER_TEST);
  });

  // Proved by t-ghoul.test.ts "R353 …": the card, its X/X and its Pierce.
  it("R353 adds the Ghoul Token, an X/X with Pierce", () => {
    provenIn(353, CARDS_GHOUL_TEST);
  });

  // Proved by 080-zao-gao.test.ts "R354 …": the random discard, the CN tag and the Radiant face's
  // third keyword.
  it("R354 makes Zao Gao's discard random and its Radiant tokens roll three keywords", () => {
    provenIn(354, CARDS_ZAO_GAO_TEST);
  });

  // Proved by tribute.test.ts "R360 …" (the engine's placement: the lane named, else the leftmost
  // open zone, the player's own side when there is none, the Radiant face never), 055-lava-golem.test.ts
  // "R360 …" on the real card, and 097-zephyrs.test.ts "R360 …": the scorer's dry run sees it too.
  it("R360 summons #55's base face for the opponent when its Tribute takes an opposing unit", () => {
    provenIn(360, "tribute.test.ts", CARDS_LAVA_GOLEM_TEST, CARDS_ZEPHYRS_TEST);
  });

  // Proved by query.test.ts "R361 …" (`killerOf`: R42's killer while it acts on the field, else
  // nobody) and 086-miss-mrow.test.ts "R361 …" (combat, a Cry's damage, a mutual death, a Spell, a
  // full row).
  it("R361 has Miss Mrow take the unit that destroyed her, and nothing when no unit did", () => {
    provenIn(361, "query.test.ts", CARDS_MROW_TEST);
  });

  // Proved by 092-felinor-fiender.test.ts "R362 …": printed plus twice the sum, dormant Felinors included.
  it("R362 gives the Radiant Felinor Fiender its printed stats plus twice its Felinors'", () => {
    provenIn(362, CARDS_FIENDER_TEST);
  });

  // Proved by 077-professor-curvature.test.ts "R363 …" (a 6 costs 5, radiant 4) and modifiers.test.ts
  // "R48 R363 …" (the cost as it currently stands).
  it("R363 reaches every card whose cost is then 4 or more with Professor Curvature", () => {
    provenIn(363, CARDS_CURVATURE_TEST);
  });

  // Proved by effects-core.test.ts "R364 …" (up to max and never past it) and 078-fullsend.test.ts
  // "R364 …" (4 of 4 leaves 3, 4 of 6 leaves 4).
  it("R364 makes a Refresh give back spent mana up to max mana and no further", () => {
    provenIn(364, "effects-core.test.ts", CARDS_FULLSEND_TEST);
  });

  // Proved by 083-transmogulate.test.ts "R365 …": the hand is replaced one for one, hidden from the opponent.
  it("R365 has Transmogulate replace the hand as one of R35's other zones", () => {
    provenIn(365, CARDS_TRANSMOGULATE_TEST);
  });

  // Proved by card-text.test.ts "R366 …": every card's text uses the patch's words and shape.
  it("R366 writes every card's text in patch v0.1.1's words", () => {
    provenIn(366, CARDS_CARD_TEXT_TEST);
  });

  // v0.1.1's presentation and wording (issue #27). The proofs are named inline rather than as
  // constants above, so this block merges beside the patch's other blocks without touching theirs.

  // Proved by apps/web facedown.test.tsx "R370 …" (the gem and the label on both seats, the hover
  // and the sheet, a back with no cost as before), showcase/plan.test.ts and CardShowcase.test.tsx
  // "R370 …" (the cost of a card the opponent set), Log.test.tsx "R370 …" and Card.test.tsx's B16
  // "R370 …" rows (a hand back still shows and opens nothing).
  it("R370 draws a face-down trap's cost on its back, in its overlay, the showcase and the log", () => {
    provenIn(
      370,
      "../../../apps/web/src/game/facedown.test.tsx",
      "../../../apps/web/src/game/showcase/plan.test.ts",
      "../../../apps/web/src/game/showcase/CardShowcase.test.tsx",
      "../../../apps/web/src/game/Log.test.tsx",
    );
  });

  // Proved by view-marks.test.ts "R371 …" (the mark exactly where the other seat sees a back, never
  // on a public card, following control) and apps/web facedown.test.tsx "R371 …" (the tag, the veil
  // attribute, the note in the hover preview and the sheet).
  it("R371 marks your own face-down trap as one the other player cannot see", () => {
    provenIn(371, "view-marks.test.ts", "../../../apps/web/src/game/facedown.test.tsx");
  });

  // Proved by packages/cards 093-combo-index.test.ts "R372 …" (the letters, the preview on both
  // faces and seats, N against the real rise, S, the hand, the short text), view-marks.test.ts
  // "R372 …" (`gradeLetter` and a preview's `display` through the view) and apps/web
  // facedown.test.tsx "R372 …" (the badge's letter and "Grade {C}" on the face).
  it("R372 shows Combo-Index's grade by its letter, and the plays it asks for", () => {
    provenIn(
      372,
      "../../cards/test/093-combo-index.test.ts",
      "view-marks.test.ts",
      "../../../apps/web/src/game/facedown.test.tsx",
    );
  });

  // Proved by apps/web wording.test.ts "R373 …" (no player-readable string in the client says
  // library or sacrifice) and cards/rules.test.ts "R373 …" (the glossary in players' words).
  it("R373 shows players Deck for the rules' library and Tribute for Sacrifice", () => {
    provenIn(373, "../../../apps/web/src/wording.test.ts", "../../../apps/web/src/cards/rules.test.ts");
  });

  // Proved by apps/web routes/landingFan.test.ts "R374 …" (the pool, the hand's shape, a seeded deal,
  // variety, the edges) and routes/landing.test.tsx "R374 …" (one deal per visit, drawn from the
  // injected source).
  it("R374 deals the landing page's hand at random on each visit", () => {
    provenIn(374, "../../../apps/web/src/routes/landingFan.test.ts", "../../../apps/web/src/routes/landing.test.tsx");
  });

  // Proved by packages/cards patches.test.ts "R375 …" (issue #39's versions, in patches.json's order,
  // before v0.2.0). The rest of the patch history is R388's and R507's, below.
  it("R375 keeps issue #39's versions of the patch history, in their order, under R388", () => {
    provenIn(375, CARDS_PATCHES_TEST);
  });

  // Proved by game-summary.test.ts "R376 …" (the record read off a hand-written game and off random
  // fixture games, a cast never a play, no record without a result, empty opening hands before a
  // turn), packages/cards game-summary.test.ts "R376 …" (the same oracles over real cards, The Coin
  // in the second seat's opening hand), packages/shared stats.test.ts "R376 …" (a record read back),
  // and apps/server game-records.test.ts "R376 …" (a live match filed once after its result, under
  // its mode, the patch and two human pilots; never at the result's expense; bound at the
  // composition root), engine.real.test.ts "R376 …" (the real port), db/contract.ts "R376 …" (both
  // stores: a match's mode read off its room, its tickets or its series; one record per id) and
  // sql/08_game_records.sql (the table's checks).
  it("R376 files every finished game's record: mode, patch, pilots, first seat, decks, hands, draws and plays", () => {
    provenIn(
      376,
      "game-summary.test.ts",
      "../../cards/test/game-summary.test.ts",
      "../../shared/test/stats.test.ts",
      "../../../apps/server/test/api/game-records.test.ts",
      "../../../apps/server/test/match/engine.real.test.ts",
      "../../../apps/server/test/db/contract.ts",
      "../../../apps/server/test/sql/08_game_records.sql",
    );
  });

  // Proved by packages/shared stats.test.ts "R377 …" (each breakdown counted by hand, a mirror once
  // per deck, the played delta and its baseline, any combination of mode, patch and pilot, the table
  // with the games beside every rate) and apps/server db/card-stats.test.ts "R377 …" (stats:cards's
  // options and one card's row).
  it("R377 reads each card's four breakdowns, with the games beside every rate, by mode, patch and pilot", () => {
    provenIn(377, "../../shared/test/stats.test.ts", "../../../apps/server/test/db/card-stats.test.ts");
  });

  // Proved by packages/ai dev-run.test.ts "R378 …" (All Random's deal to two AI seats, each game a
  // development record of the patch it tests, with the patch in its id so another patch's run of the
  // same seeds is other records), packages/shared stats.test.ts "R378 …" (live unless
  // asked), apps/server db/card-stats.test.ts "R378 …" (stats:cards reads a run only when asked, and
  // the same patch's live games in a second query; stats:import adds development records and nothing
  // else) and db/contract.ts "R378 …" (both stores filter by source, mode and patch, and keep `dev:`
  // ids to development records).
  it("R378 keeps the AI's development runs apart from live data unless they are asked for", () => {
    provenIn(
      378,
      "../../ai/test/dev-run.test.ts",
      "../../shared/test/stats.test.ts",
      "../../../apps/server/test/db/card-stats.test.ts",
      "../../../apps/server/test/db/contract.ts",
    );
  });

  // Patch v0.2.0's catalog rows (docs/classic-sets.md B2, B4.2, B4.3; issue #40).

  // Proved by cards query.test.ts "R380 …" (a pool that names no set reaches all three, one that
  // names a set keeps to it), and packages/ai deck.test.ts and observe.test.ts "R380 …" (the AI's
  // decks and determinizations draw from every set).
  it("R380 makes one format of every set: a pool that names no set draws from all of them", () => {
    provenIn(380, CARDS_QUERY_TEST, AI_DECK_TEST, AI_OBSERVE_TEST);
  });

  // Proved by cards references.test.ts "R381 …" (rules words name no card unless refs list it) and
  // catalog.test.ts "R381 …" (no two cards share a name: Book of Wildfire, Grand Counterspell).
  it("R381 keeps every name distinct and reads the rules-word names as rules words", () => {
    provenIn(381, CARDS_REFERENCES_TEST, CARDS_CATALOG_TEST);
  });

  // Proved by cards query.test.ts "R382 …" (the Fruit pool and the Grapes, Dropshipping's pool).
  it("R382 puts the five Grapes in every Fruit pool and every token in Dropshipping's", () => {
    provenIn(382, CARDS_QUERY_TEST);
  });

  // Proved by animated.test.ts, effects-animate.test.ts "R383 …".
  it("R383 makes an Animated card a Unit while it is animated, and sends it home", () => {
    provenIn(383, "animated.test.ts", "effects-animate.test.ts");
  });

  // Proved by activate.test.ts "R384 …".
  it("R384 gives cards Activate abilities their controller uses as an action", () => {
    provenIn(384, "activate.test.ts");
  });

  // Proved by brittle.test.ts, effects-brittle.test.ts "R385 …".
  it("R385 counts Brittle down at its controller's turn start and crumbles the card at 0", () => {
    provenIn(385, "brittle.test.ts", "effects-brittle.test.ts");
  });

  // Proved by effects-tune.test.ts, instance-data.test.ts, params.test.ts "R386 …".
  it("R386 tunes a card's numbers with Degrade and Upgrade, on the instance", () => {
    provenIn(386, "effects-tune.test.ts", "instance-data.test.ts", "params.test.ts");
  });

  // Proved by pools.test.ts, query.test.ts, self-generation.test.ts "R387 …".
  it("R387 never lets a card generate itself, keyed by definition id", () => {
    provenIn(387, "pools.test.ts", "../../cards/test/query.test.ts", "../../cards/test/self-generation.test.ts");
  });

  // Proved by cards patches.test.ts "R388 …" (the history, the snapshots, the version everywhere),
  // loc.test.ts's patch snapshot, the server's catalog.test.ts "R388 …" (GET /api/catalog/:version) and
  // apps/web patches/diff.test.ts "R388 …" (the History section and Patch notes page diff every field).
  it("R388 makes card patches data and the catalog version the newest patch", () => {
    provenIn(388, CARDS_PATCHES_TEST, SERVER_CATALOG_TEST, "../../../apps/web/src/patches/diff.test.ts");
  });

  // Proved by the server's clock.test.ts "R389 …" (the 120-minute ceiling), and turn-cap.test.ts
  // "R389 …" (60 player-turns, fatigue ending two idle decks first) and rulings-a.test.ts "R2 …".
  it("R389 doubles the turn cap and the match ceiling with it", () => {
    expect(config.TURN_CAP_PLAYER_TURNS).toBe(60);
    expect(serverConstant(SERVER_CONFIG, "MATCH_CEILING_MINUTES")).toBe("120");
    provenIn(389, SERVER_CLOCK_TEST, "turn-cap.test.ts");
  });

  // Proved by packages/ai shadowBan.test.ts "R390 …" (pass 2's numbers, at risk at half strength, the
  // at-risk list a pure function of pass 1 and the two tables, the filler's keep-out and lifted ban,
  // pass-2 evidence for a judgement ban, suspects, and one real pass-2 game on its named seed).
  it("R390 sweeps the shadow ban in two passes, leaning toward the cards at risk", () => {
    provenIn(390, AI_SHADOW_BAN_TEST);
  });

  // Proved by tribute-zones.test.ts "R391 …".
  it("R391 lets a Tribute pay for the zone its card takes", () => {
    provenIn(391, "tribute-zones.test.ts");
  });

  // Proved by cards classic/015-nose-hunter.test.ts "R392 …" (the random discard is the Activate's
  // cost, once per turn; an empty hand can't activate it).
  it("R392 reads C #15 Nose Hunter's \"Discard a random card: …\" as an Activate whose cost is the discard", () => {
    provenIn(392, CLASSIC_015_TEST);
  });

  // Proved by cards classic/028-second-wind.test.ts "R393 …" (the Cry's discards land before the Aura
  // starts, so they are playable from the graveyard).
  it("R393 lets C #28 Second Wind's discarded hand be played from the graveyard", () => {
    provenIn(393, CLASSIC_028_TEST);
  });

  // Proved by cards classic/033-joro.test.ts "R394 …" (from the hand only, one targeting, the first pick).
  it("R394 has C #33 Joro answer a targeting from its owner's hand only", () => {
    provenIn(394, CLASSIC_033_TEST);
  });

  // Proved by cards classic/038-jackiestan-auctioneer.test.ts "R395 …" (face-down only the activation
  // condition is live; the "whenever" starts with the next play).
  it("R395 keeps C #38 Jackiestan Auctioneer's \"whenever\" text off until it has activated", () => {
    provenIn(395, CLASSIC_038_TEST);
  });

  // Proved by the Classic cards that compare costs, each "R396 …": C #10, #18, #25, #32 and #39.
  it("R396 reads an X card on the field at the X it was played for", () => {
    provenIn(396, CLASSIC_010_TEST, CLASSIC_018_TEST, CLASSIC_025_TEST, CLASSIC_032_TEST, CLASSIC_039_TEST);
  });

  // Proved by cards classic/048-hired-shrimp.test.ts "R397 …" (the base face's unfiltered guess that
  // fizzles, the Radiant face's filtered offer with face-down cards always offered and judged at
  // resolution, and `loc` read from the catalog).
  it("R397 keeps C #48 Hired Shrimp's guess: its base Cry destroys only a permanent with more lines of code", () => {
    provenIn(397, CLASSIC_048_TEST);
  });

  // Proved by cards classic/050-voidwalker.test.ts "R398 …" (its own card reaches the graveyard as it dies).
  it("R398 exiles what would go to a graveyard while C #50 Voidwalker stands, but not Voidwalker itself", () => {
    provenIn(398, CLASSIC_050_TEST);
  });

  // Proved by the engine's copied-text.test.ts "R399 …" (fixture copiers) and cards classic/057-echo.test.ts
  // "R399 …" (the record, the view, nothing before any Spell, two Echoes never loop).
  it("R399 gives C #57 Echo the text of the last Spell either player played", () => {
    provenIn(399, "copied-text.test.ts", CLASSIC_057_TEST);
  });

  // Proved by cards classic/062-living-bomb.test.ts "R400 …" (each player's own plagued permanents, at
  // the start of their turn; the Radiant face on the opponent's turn only).
  it("R400 has C #62 Living Bomb destroy the turn player's own plagued permanents", () => {
    provenIn(400, CLASSIC_062_TEST);
  });

  // Proved by cards classic/066-eu-striker.test.ts "R401 …" (neither trigger answers the play that moved it).
  it("R401 never lets C #66 EU Striker's triggers answer the play that moved it", () => {
    provenIn(401, CLASSIC_066_TEST);
  });

  // Proved by cards classic/078-mutate-spell.test.ts "R402 …" (a Field Spell with Activate ♾️, the three
  // branches, and the Radiant fuse onto a card of yours of its type).
  it("R402 reads C #78 Mutate Spell as a Field Spell with Activate ♾️", () => {
    provenIn(402, CLASSIC_078_TEST);
  });

  // Proved by the engine's self-tribute.test.ts "R403 …" and cards classic/088-siphon-squad.test.ts "R403 …"
  // (live while face-down, the self-Tribute at every state check, the Radiant 0 set last).
  it("R403 keeps a Trap with no activation condition live while face-down (C #88 Siphon Squad)", () => {
    provenIn(403, "self-tribute.test.ts", CLASSIC_088_TEST);
  });

  // Proved by the engine's quests.test.ts "R404 …" (each goal kind, completion at the state check, the
  // reward prompt, the Radiant paths) and cards classic/090-in-too-deep.test.ts "R404 …" (the tree).
  it("R404 runs C #90 In Too Deep's quests and rewards", () => {
    provenIn(404, "quests.test.ts", CLASSIC_090_TEST);
  });

  // Proved by cards classic-plus/002-groom-shroom.test.ts "R405 …" (a board filled with Felinor Units given
  // Taunt; the declared attack still hits the hero) and classic-plus/030-felinor-fuser.test.ts "R405 …".
  it("R405 reads C+ #2's Felinors as Felinor-tagged Units, the attack that set it off still hitting the hero", () => {
    provenIn(405, PLUS_002_TEST, PLUS_030_TEST);
  });

  // Proved by cards classic-plus/007-the-house.test.ts "R406 …" (one of the twins, 2 in 3 the defender).
  it("R406 has C+ #7 The House summon #3 Right-house defender 2 in 3, else a Wrong-House Attacker", () => {
    provenIn(406, PLUS_007_TEST);
  });

  // Proved by cards classic-plus/009-silence.test.ts "R407 …" (an aura stops, a face-down trap sits inert,
  // an Animated card loses Animated where it stands).
  it("R407 leaves a Vanilla backrow card with no text", () => {
    provenIn(407, PLUS_009_TEST);
  });

  // Proved by cards classic-plus/012-6-frozen-wastes.test.ts and 012-7-legion-of-the-hungry.test.ts "R408 …".
  it("R408 reads a Field Spell's unlabelled one-time text as its Cry", () => {
    provenIn(408, PLUS_012_6_TEST, PLUS_012_7_TEST);
  });

  // Proved by cards classic-plus/012-8-frostspatula.test.ts "R409 …" (copies, the originals staying put).
  it("R409 has C+ #12.8 Frostspatula's resummon make copies", () => {
    provenIn(409, PLUS_012_8_TEST);
  });

  // Proved by cards classic-plus/014-forever.test.ts "R410 …" (returns after it resolves; a discarded or
  // countered Spell does not come back).
  it("R410 reads C+ #14 Forever&'s \"leaves your hand\" as \"is played and resolves\"", () => {
    provenIn(410, PLUS_014_TEST);
  });

  // Proved by cards classic-plus/019-league-of-losers.test.ts and 019-3-mid-loser.test.ts "R411 …".
  it("R411 fires C+ #19.3 Mid Loser's Cry when League of Losers summons it", () => {
    provenIn(411, PLUS_019_TEST, PLUS_019_3_TEST);
  });

  // Proved by cards classic-plus/019-2-jungle-loser.test.ts and 019-5-bot-loser.test.ts "R412 …".
  it("R412 reads Tranquility as \"can't go Berserk\" and credits Jungle Loser's kill to Bot Loser", () => {
    provenIn(412, PLUS_019_2_TEST, PLUS_019_5_TEST);
  });

  // Proved by cards classic-plus/022-blood-moon.test.ts "R413 …" (the heal that sets it off is converted).
  it("R413 reads C+ #22 Blood Moon's \"is healed\" as \"would be healed\"", () => {
    provenIn(413, PLUS_022_TEST);
  });

  // Proved by cards classic-plus/025-soul-shot.test.ts "R414 …" (attack plus health, then cost, then lane).
  it("R414 gives C+ #25 Soul Shot's Lucky its comparator", () => {
    provenIn(414, PLUS_025_TEST);
  });

  // Proved by cards classic-plus/026-tommy-tempo.test.ts "R415 …" (a play, an attack, a switch, an
  // activation or ending the turn by hand is the one more action).
  it("R415 reads C+ #26 Tommy Tempo's \"one more action\" as one main-phase action", () => {
    provenIn(415, PLUS_026_TEST);
  });

  // Proved by cards classic-plus/027-zephrys-zealotism.test.ts "R416 …" and engine perfectHand.test.ts "R416 …".
  it("R416 keeps C+ #27 Zephrys Zealotism's hand size and its pool to Classic and Classic+", () => {
    provenIn(416, PLUS_027_TEST, "perfectHand.test.ts");
  });

  // Proved by cards classic-plus/029-portal-to-the-past.test.ts "R417 …" and engine lastBoards.test.ts "R417 …".
  it("R417 makes each seat's last board a setup input of the match", () => {
    provenIn(417, PLUS_029_TEST, "lastBoards.test.ts");
  });

  // Proved by cards classic-plus/033-ivory-tower.test.ts "R418 …" and engine carried-damage.test.ts "R418 …".
  it("R418 lets a Unit top C+ #33 Ivory Tower's backrow pile, the Tower acting beneath it", () => {
    provenIn(418, PLUS_033_TEST, "carried-damage.test.ts");
  });

  // Proved by cards classic-plus/035-rollback.test.ts "R419 …" (the three steps, hidden information, JSON
  // and a whole game replayed) and engine boardHistory.test.ts "R419 …" (the snapshots and the restore).
  it("R419 returns the board to a snapshot taken at the start of an earlier turn", () => {
    provenIn(419, PLUS_035_TEST, "boardHistory.test.ts");
  });

  // Proved by cards classic-plus/042-kys-test.test.ts and engine kyTest.test.ts "R420 …" (the two
  // prompts, the rewards, the key that never leaves the engine, a paused prompt through JSON).
  it("R420 asks C+ #42 KY's Test's difficulty, then a problem whose key never leaves the engine", () => {
    provenIn(420, CLASSIC_PLUS_042_TEST, "kyTest.test.ts");
  });

  // Proved by cards classic-plus/060-doctors-orders.test.ts "R421 …" (a Field Spell whose Cry and start of
  // turn add an All Purpose Apple).
  it("R421 reads C+ #60 Doctors Orders as a Field Spell", () => {
    provenIn(421, CLASSIC_PLUS_060_TEST);
  });

  // Proved by cards classic-plus/062-kys-papaya.test.ts and engine papaya.test.ts "R422 …" (cells one
  // prompt at a time, the lowest-degree curve in exact rationals, every card on it exiled).
  it("R422 draws C+ #62 KY's Papaya's curve through the cells its caster picks", () => {
    provenIn(422, CLASSIC_PLUS_062_TEST, "papaya.test.ts");
  });

  // Proved by cards 095-call-to-chaos.test.ts and classic-plus/073 and engine callToChaos.test.ts and
  // callToChaosPlus.test.ts "R423 …" (three different effects, in the list's order, both editions).
  it("R423 casts three different random effects on either Call to Chaos's Radiant face", () => {
    provenIn(423, "../../cards/test/095-call-to-chaos.test.ts", CLASSIC_PLUS_073_TEST, "callToChaos.test.ts", "callToChaosPlus.test.ts");
  });

  // Proved by cards classic-plus/073-1-classic-golem.test.ts and engine transform-variants.test.ts "R424 …"
  // (the transform after the combat; "may attack again" passes to the new Unit).
  it("R424 transforms C+ #73.1 Classic Golem after the combat of an attack it declared on a Unit", () => {
    provenIn(424, CLASSIC_PLUS_073_1_TEST, "transform-variants.test.ts");
  });

  // Proved by cards classic-plus/074 and engine twiceForward.test.ts "R425 …" (a Field Trap that fuses
  // every second play of the opponent's and grows its Brittle).
  it("R425 makes C+ #74 Twice Forward One Step Backwards a Field Trap that fuses every second play", () => {
    provenIn(425, CLASSIC_PLUS_074_TEST, "twiceForward.test.ts");
  });

  // Proved by after-attack.test.ts, 032-prem-panther.test.ts "R426 …".
  it("R426 draws for Prem Panther only after it attacks and survives", () => {
    provenIn(426, "after-attack.test.ts", "../../cards/test/032-prem-panther.test.ts");
  });

  // Proved by corePatches.test.ts, 041-sheepish.test.ts "R427 …".
  it("R427 fires Sheepish after the Cry of the Unit it answers", () => {
    provenIn(427, "corePatches.test.ts", "../../cards/test/041-sheepish.test.ts");
  });

  // Proved by 022-carnivorous-cube.test.ts "R428 …".
  it("R428 lets Carnivorous Cube eat only Units", () => {
    provenIn(428, "../../cards/test/022-carnivorous-cube.test.ts");
  });

  // Proved by corePatches.test.ts, 031-kys-math-equation.test.ts "R429 …".
  it("R429 counts KY's Math Equation's plays and stops its cost at (4)", () => {
    provenIn(429, "corePatches.test.ts", "../../cards/test/031-kys-math-equation.test.ts");
  });

  // Proved by 060-bear-honeypot.test.ts "R430 …".
  it("R430 holds Bear Honeypot while its controller's unit row is full", () => {
    provenIn(430, "../../cards/test/060-bear-honeypot.test.ts");
  });

  // Proved by 021-hinder.test.ts "R431 …".
  it("R431 makes Hinder's base face discard 1 card of its caster's choice", () => {
    provenIn(431, "../../cards/test/021-hinder.test.ts");
  });

  // Proved by cards card-text.test.ts "R432 …" (every face's cost words), apps/web wording.test.ts "R432 …"
  // (no player-readable client string writes the old cost noun) and facedown.test.tsx "R432 …".
  it("R432 writes a specific cost as \"(N) Cost\" and a price as \"costs (N)\"", () => {
    provenIn(432, CARDS_CARD_TEXT_TEST, "../../../apps/web/src/wording.test.ts", "../../../apps/web/src/game/facedown.test.tsx");
  });

  // R433's client half: apps/web game/dealtDeck.test.tsx "R433 …" (a mostly unknown deck is backs under
  // "Your deck", with its counts) and routes/play.test.tsx "R433 …" (nothing lists a dealt deck).
  it("R433 lists a dealt deck with only the cards its owner has been shown", () => {
    provenIn(433, "../../../apps/web/src/game/dealtDeck.test.tsx", WEB_PLAY_TEST);
  });

  // R434's client half: apps/web game/reveal.test.tsx and game/Hand.test.tsx "R434 …" (the opponent's
  // hand turns face up at the end, and the result lists it).
  it("R434 reveals both hands once the game is over", () => {
    provenIn(434, "../../../apps/web/src/game/reveal.test.tsx", "../../../apps/web/src/game/Hand.test.tsx");
  });

  // Proved by apps/web fx/constants.test.ts, fx/settings.test.ts, settings/wiring.test.tsx and
  // game/animations.fx.test.ts "R435 …" (the range and step, the clamp, the slider and its readout, and
  // the runner's durations and burst budget at 0.25x and 3x).
  it("R435 runs the effects speed from 0.25x to 3x on a slider", () => {
    provenIn(
      435,
      "../../../apps/web/src/fx/constants.test.ts",
      "../../../apps/web/src/fx/settings.test.ts",
      "../../../apps/web/src/settings/wiring.test.tsx",
      WEB_ANIMATIONS_FX_TEST,
    );
  });

  // R436's client half: apps/web fx/chaos.test.ts "R436 …" (each rolled effect named on both seats, the
  // reels inside R200's bounds, the still banner and the live region).
  it("R436 names the effects Call to Chaos rolled, to both players", () => {
    provenIn(436, "../../../apps/web/src/fx/chaos.test.ts");
  });

  // R437's client half: apps/web cards/CardMarks.test.tsx "R437 …" (the aura and badge in the mark's
  // colours on units, backrow cards and a back, the fallback, reduced motion).
  it("R437 shows a mark on the card it is aimed at", () => {
    provenIn(437, "../../../apps/web/src/cards/CardMarks.test.tsx");
  });

  // R438: apps/web cards/keywordVisuals.test.tsx "R438 …" (a treatment for every keyword kind, the layers
  // and caps, canAct, Brittle's count, reduced motion, Vanilla).
  it("R438 draws every keyword on a board unit", () => {
    provenIn(438, "../../../apps/web/src/cards/keywordVisuals.test.tsx");
  });

  // Proved by apps/web game/Clock.test.tsx "R439 …" (the thresholds, whose clock, a paused clock, the
  // reduced state) and routes/match.test.tsx "R439 …" (the frame reaches the clock on every turn).
  it("R439 marks the last 30 seconds of a turn clock", () => {
    provenIn(439, "../../../apps/web/src/game/Clock.test.tsx", "../../../apps/web/src/routes/match.test.tsx");
  });

  // Proved by effects-tune.test.ts, effects-brittle.test.ts, effects-cardScope.test.ts,
  // instance-data.test.ts "R440 …".
  it("R440 never tells a player how many hidden cards a change reached", () => {
    provenIn(
      440,
      "effects-tune.test.ts",
      "effects-brittle.test.ts",
      "effects-cardScope.test.ts",
      "instance-data.test.ts",
    );
  });

  // Proved by brittle.test.ts "R441 …".
  it("R441 spends a crumbled Brittle count and starts a given one from the print", () => {
    provenIn(441, "brittle.test.ts");
  });

  // Proved by effects-tune.test.ts "R442 …".
  it("R442 draws a Degrade or Upgrade's row, then its item, uniformly", () => {
    provenIn(442, "effects-tune.test.ts");
  });

  // Proved by effects-enchant.test.ts "R443 …".
  it("R443 carries enchantments onto copies and fusions, each once", () => {
    provenIn(443, "effects-enchant.test.ts");
  });

  // Proved by effects-flicker.test.ts "R444 …".
  it("R444 flickers a card out and back into its zone as a fresh, summoning-sick entry", () => {
    provenIn(444, "effects-flicker.test.ts");
  });

  // Proved by animated.test.ts "R445 …".
  it("R445 does not count animating as summoning", () => {
    provenIn(445, "animated.test.ts");
  });

  // Proved by backrow-piles.test.ts "R446 …".
  it("R446 makes a carried Unit a Unit that neither attacks nor is attacked", () => {
    provenIn(446, "backrow-piles.test.ts");
  });

  // Proved by backrow-piles.test.ts, redact-backrow-piles.test.ts "R447 …".
  it("R447 lets only the top of a backrow pile act, and shows the pile as a count", () => {
    provenIn(447, "backrow-piles.test.ts", "../../ai/test/redact-backrow-piles.test.ts");
  });

  // Proved by announce.test.ts, effects-move.test.ts, redact-announce.test.ts "R448
  // …".
  it("R448 announces a play before it moves, in a window traps and Counters answer", () => {
    provenIn(
      448,
      "announce.test.ts",
      "effects-move.test.ts",
      "../../ai/test/redact-announce.test.ts",
    );
  });

  // Proved by play-step3.test.ts "R449 …".
  it("R449 applies step 3's replacement and tag rules to a play", () => {
    provenIn(449, "play-step3.test.ts");
  });

  // Proved by targeting.test.ts "R450 …".
  it("R450 makes targeting one point, where target costs are paid and interceptors answer", () => {
    provenIn(450, "targeting.test.ts");
  });

  // Proved by playCounts.test.ts "R451 …".
  it("R451 records plays by type, by tag, the last Spell and each player's last face-up card", () => {
    provenIn(451, "playCounts.test.ts");
  });

  // Proved by effects-cast.test.ts, play-pipeline-b-replay.test.ts "R452 …".
  it("R452 makes every choice of a random cast at random", () => {
    provenIn(452, "effects-cast.test.ts", "play-pipeline-b-replay.test.ts");
  });

  // Proved by effects-cast.test.ts "R453 …".
  it("R453 casts a card from anywhere but the field, or a new card of a named definition", () => {
    provenIn(453, "effects-cast.test.ts");
  });

  // Proved by graveyard-play.test.ts "R454 …".
  it("R454 plays a card from its player's graveyard under a permission", () => {
    provenIn(454, "graveyard-play.test.ts");
  });

  // Proved by cost-rules.test.ts "R455 …".
  it("R455 applies price rules after R65's discounts, in a fixed order", () => {
    provenIn(455, "cost-rules.test.ts");
  });

  // Proved by effects-turnEnd.test.ts "R456 …".
  it("R456 ends the turn from an effect once the action has resolved", () => {
    provenIn(456, "effects-turnEnd.test.ts");
  });

  // Proved by draw-limit.test.ts "R457 …".
  it("R457 counts every draw on its turn for its player, and limits draws from the field", () => {
    provenIn(457, "draw-limit.test.ts");
  });

  // Proved by delayed-kinds.test.ts "R458 …".
  it("R458 times next-turn and rest-of-game effects", () => {
    provenIn(458, "delayed-kinds.test.ts");
  });

  // Proved by draw-limit.test.ts "R459 …".
  it("R459 casts a card enchanted to cast on draw as it is drawn", () => {
    provenIn(459, "draw-limit.test.ts");
  });

  // Proved by replacements.test.ts "R460 …".
  it("R460 applies several replacements of one event one at a time, in R68 order", () => {
    provenIn(460, "replacements.test.ts");
  });

  // Proved by replacements.test.ts "R461 …".
  it("R461 does not count a card exiled instead of dying as a death", () => {
    provenIn(461, "replacements.test.ts");
  });

  // Proved by replacements.test.ts "R462 …".
  it("R462 reads each replacement moment as it is written", () => {
    provenIn(462, "replacements.test.ts");
  });

  // Proved by replacements.test.ts, damage-pipeline.test.ts "R463 …".
  it("R463 lets collected cards leave together, and keeps a hidden text from guarding", () => {
    provenIn(463, "replacements.test.ts", "damage-pipeline.test.ts");
  });

  // Proved by effects-summonThis.test.ts "R464 …".
  it("R464 orders deck triggers after hand triggers and before graveyard ones", () => {
    provenIn(464, "effects-summonThis.test.ts");
  });

  // Proved by prompt-kinds.test.ts, answer-key.test.ts "R465 …".
  it("R465 keeps an answer prompt's key inside the engine", () => {
    provenIn(465, "prompt-kinds.test.ts", "../../ai/test/answer-key.test.ts");
  });

  // Proved by effects-give.test.ts "R466 …".
  it("R466 makes a card taken from another player's pile the taker's", () => {
    provenIn(466, "effects-give.test.ts");
  });

  // Proved by effects-cry.test.ts "R467 …".
  it("R467 runs a Unit's Cry when an effect triggers it", () => {
    provenIn(467, "effects-cry.test.ts");
  });

  // Proved by fuse-variants.test.ts "R468 …".
  it("R468 bounds a fused id, past the cap a digest of its ingredients", () => {
    provenIn(468, "fuse-variants.test.ts");
  });

  // Proved by fuse-variants.test.ts "R469 …".
  it("R469 gives a Radiant ingredient's face to the fused card", () => {
    provenIn(469, "fuse-variants.test.ts");
  });

  // Proved by fuse-variants.test.ts "R470 …".
  it("R470 fuses into a hand or deck card, whose cost does not change", () => {
    provenIn(470, "fuse-variants.test.ts");
  });

  // Proved by effects-plague.test.ts "R471 …".
  it("R471 places Plague Tokens one placement at a time, on cards that act", () => {
    provenIn(471, "effects-plague.test.ts");
  });

  // Proved by cards references.test.ts "R480 …".
  it("R480 names the Pancake tokens and the AI generated cards by the tag a card's text names", () => {
    provenIn(480, CARDS_REFERENCES_TEST);
  });

  // Proved by apps/server test/sql/09_catalog_growth.sql "=== R481: … ===".
  it("R481 grants a new catalog version's new cards to every active account, once", () => {
    provenIn(481, SERVER_CATALOG_GROWTH_SQL);
  });

  // Proved by cards params.test.ts "R482 …".
  it("R482 writes a card's tunable numbers as {key} in the faces that show them", () => {
    provenIn(482, CARDS_PARAMS_TEST);
  });

  // Proved by apps/web cards/rules.test.ts "R500 …" (the two short lines, their length, Units only).
  it("R500 writes the glossary's Cry and Tribute rows as short reminders", () => {
    provenIn(500, "../../../apps/web/src/cards/rules.test.ts");
  });

  // Proved by apps/web audio/voice-assets.test.ts "R501 …" (a SAPI persona's hash, --catalog, the
  // persona's ranges, the 6 MiB budget), voice-lines.test.ts "R501 …" and voiceData.test.ts "R501 …";
  // gen-voice.test.ts's "R501 …" cases render through SAPI and ffmpeg where a machine has them.
  it("R501 renders the voice set on macOS or Windows, within 6 MiB", () => {
    provenIn(
      501,
      "../../../apps/web/src/audio/voice-assets.test.ts",
      "../../../apps/web/src/audio/voice-lines.test.ts",
      "../../../apps/web/src/audio/voiceData.test.ts",
    );
  });

  // Proved by apps/web fx/cardFx.test.ts "R502 …" (the signal in the redacted stream, both seats,
  // Hinder's crystals and Blood Ridden's stream, never naming a hidden card, R200's bounds).
  it("R502 shows a cast on draw on both seats", () => {
    provenIn(502, "../../../apps/web/src/fx/cardFx.test.ts");
  });

  // Proved by apps/web cards/art/motifs.test.ts "R503 …" (a motif per name, distinct faces over the whole
  // catalog, the families), with art.test.ts, CardFace.test.tsx and model.test.ts (the set mark and a
  // token's printed rarity).
  it("R503 draws every card a face of its own, and its set on the frame", () => {
    provenIn(503, "../../../apps/web/src/cards/art/motifs.test.ts");
  });

  // Proved by apps/web game/Hand.test.tsx "R504 …" (the outline, its size rule, either seat).
  it("R504 keeps an empty hand's place on the board", () => {
    provenIn(504, "../../../apps/web/src/game/Hand.test.tsx");
  });

  // Proved by apps/web routes/play.test.tsx "R505 …".
  it("R505 shows the queue counts on the mode tiles alone", () => {
    provenIn(505, WEB_PLAY_TEST);
  });

  // Proved by apps/web audio/moments.test.ts, cues.test.ts and clockAlarm.test.ts "R506 …" (the play a
  // sound answers, Hinder's crack, #27's drain, a cast on draw, the families, the clock alarm).
  it("R506 lets sound answer the card moments of v0.2.0", () => {
    provenIn(506, "../../../apps/web/src/audio/moments.test.ts");
  });

  // Proved by apps/web patches/PatchNotes.test.tsx "R507 …" (the page's grouping, filter and marks),
  // patches/history.test.ts and patches/CardHistory.test.tsx "R507 …" (the History section).
  it("R507 marks a patch's changes in its own teal and lists the cards each patch touched", () => {
    provenIn(
      507,
      "../../../apps/web/src/patches/PatchNotes.test.tsx",
      "../../../apps/web/src/patches/history.test.ts",
      "../../../apps/web/src/patches/CardHistory.test.tsx",
    );
  });

  // Proved by apps/web practice/core.test.ts "R508 …" (the board a finished free game gives, the next game's
  // input on the human's seat alone, the fold, a lesson), practice/lastBoard.test.ts and controller.test.ts
  // "R508 …" (the device's copy, untrusted and blocked storage, the controller carrying it both ways).
  it("R508 keeps the human's last practice board on the device for the next practice game", () => {
    provenIn(
      508,
      "../../../apps/web/src/practice/core.test.ts",
      "../../../apps/web/src/practice/lastBoard.test.ts",
      "../../../apps/web/src/practice/controller.test.ts",
    );
  });

  // Proved by apps/web game/ActivateControl.test.tsx and game/activate.test.ts "R510 …" (the control, its
  // count and reason, a press built from legalActions only, drag to target, Heroic Power).
  it("R510 puts an Activate control on every card that has an ability", () => {
    provenIn(510, "../../../apps/web/src/game/ActivateControl.test.tsx", "../../../apps/web/src/game/activate.test.ts");
  });

  // Proved by apps/web cards/copies.test.tsx "R511 …" (the copied text on every face Echo shows, filled with
  // the view's numbers, the Radiant line kept, the inspect note, and a real game's Echo after Book of Knowledge).
  it("R511 prints the Spell text a copier has on its face", () => {
    provenIn(511, "../../../apps/web/src/cards/copies.test.tsx");
  });

  // Proved by apps/web cards/rules.test.ts "R512 …" (the new rows in players' words, Degrade and Upgrade split).
  it("R512 gives the glossary a row for every term v0.2.0's cards print", () => {
    provenIn(512, "../../../apps/web/src/cards/rules.test.ts");
  });

  // Proved by apps/web cards/cardState.test.tsx "R513 …" (tuned numbers, stats and keywords marked, the
  // overall mark, Brittle, enchantments, piles and lines of code on every surface).
  it("R513 marks what Degrade, Upgrade and KY's Constant changed on a card", () => {
    provenIn(513, "../../../apps/web/src/cards/cardState.test.tsx");
  });

  // Proved by apps/web game/PromptE18.test.tsx "R514 …" (the offered zones glow and answer on the board).
  it("R514 answers a cell prompt on the board", () => {
    provenIn(514, "../../../apps/web/src/game/PromptE18.test.tsx");
  });

  // Proved by apps/web game/PromptE18.test.tsx "R515 …" (the running total, greying, Confirm).
  it("R515 shows a budgeted pick's total and greys what would go over", () => {
    provenIn(515, "../../../apps/web/src/game/PromptE18.test.tsx");
  });

  // Proved by cards classic/007-infiniscepter.test.ts "R520 …" (an X Spell's copy is cast with the X its
  // caster picks, 1 to their current mana, unpaid).
  it("R520 casts C #7 InfiniScepter's copy of an X-cost Spell with the X its caster chooses", () => {
    provenIn(520, CLASSIC_007_TEST);
  });

  // Proved by cards classic/009-income-tax.test.ts "R521 …" (burned and cast-on-draw cards were drawn; a
  // limited draw never happened; an empty-deck draw counts but gives nothing).
  it("R521 counts every draw that happened toward C #9 Income Tax", () => {
    provenIn(521, CLASSIC_009_TEST);
  });

  // Classic #46–#90's own rows (the cards-classic-b workstream's block).

  // Proved by cards classic/090-in-too-deep.test.ts "R540 …" (reward J's 100 mana on the next turn).
  it("R540 grants C #90's reward J as next-turn mana", () => {
    provenIn(540, CLASSIC_090_TEST);
  });

  // Proved by cards classic/090-in-too-deep.test.ts "R541 …" and the engine's quests.test.ts "R541 …".
  it("R541 counts every draw that took a card toward C #90's quest 1", () => {
    provenIn(541, CLASSIC_090_TEST, "quests.test.ts");
  });

  // Proved by cards classic/090-in-too-deep.test.ts "R542 …" (the side a card died on, the side a hit landed on).
  it("R542 counts C #90's deaths and damage by who controlled them as they happened", () => {
    provenIn(542, CLASSIC_090_TEST);
  });

  // Proved by cards classic/090-in-too-deep.test.ts "R543 …" (every reward in the tree's order, no reward prompt).
  it("R543 grants C #90's Radiant rewards in the tree's order", () => {
    provenIn(543, CLASSIC_090_TEST);
  });

  // Proved by the engine's copied-text.test.ts "R545 …" and cards classic/057-echo.test.ts "R545 …".
  it("R545 has C #57 Echo choose a copied X with its play, after paying its own (1)", () => {
    provenIn(545, "copied-text.test.ts", CLASSIC_057_TEST);
  });

  // Proved by the engine's copied-text.test.ts "R546 …" and cards classic/057-echo.test.ts "R546 …".
  it("R546 fixes C #57 Echo's copied text as its play begins", () => {
    provenIn(546, "copied-text.test.ts", CLASSIC_057_TEST);
  });

  // Proved by the engine's copied-text.test.ts "R547 …" and cards classic/057-echo.test.ts "R547 …".
  it("R547 gives C #57 Echo the copied Spell's static text, but no return from the graveyard", () => {
    provenIn(547, "copied-text.test.ts", CLASSIC_057_TEST);
  });

  // Proved by cards classic/066-eu-striker.test.ts "R548 …" (both triggers answer a resolved play).
  it("R548 has C #66 EU Striker answer its owner's plays once they resolve", () => {
    provenIn(548, CLASSIC_066_TEST);
  });

  // Proved by cards classic/058-common-resources.test.ts "R549 …" (Hinder off the enemy deck's bottom:
  // the repeat comes from your own deck).
  it("R549 repeats a cast on draw taken from the opponent's deck with a draw from your own", () => {
    provenIn(549, CLASSIC_058_TEST);
  });

  // Proved by cards classic/063-crop-dusting.test.ts "R550 …" (the firing trap takes its own placement).
  it("R550 places C #63 Crop Dusting's tokens on the firing trap too", () => {
    provenIn(550, CLASSIC_063_TEST);
  });

  // Proved by cards classic-plus/026-tommy-tempo.test.ts "R560 …" (the hand uncast, a full hand burning it).
  it("R560 sends C+ #26 Tommy Tempo with no zone to the hand uncast", () => {
    provenIn(560, PLUS_026_TEST);
  });

  // Proved by cards classic-plus/031-fusion-lab.test.ts "R561 …" (the Radiant ingredient in both forms).
  it("R561 lends C+ #31 Fusion Lab's Radiant ingredient to both of the fusion's forms", () => {
    provenIn(561, PLUS_031_TEST);
  });

  // Proved by cards classic-plus/035-rollback.test.ts "R562 …" and engine boardHistory.test.ts "R562 …".
  it("R562 rolls back as far as the history goes", () => {
    provenIn(562, PLUS_035_TEST, "boardHistory.test.ts");
  });

  // Proved by engine boardHistory.test.ts "R563 …" (a Reborn return let go) and the card test "R563 …".
  it("R563 releases the zones a Rollback restores", () => {
    provenIn(563, "boardHistory.test.ts", PLUS_035_TEST);
  });

  // Proved by engine lastBoards.test.ts "R564 …" and cards classic-plus/029-portal-to-the-past.test.ts "R564 …".
  it("R564 keeps a last board as card and face, dropping what the match cannot rebuild", () => {
    provenIn(564, "lastBoards.test.ts", PLUS_029_TEST);
  });

  // Proved by apps/server match/last-boards.test.ts "R565 …" (written in the result's transaction, frozen
  // on the match row, never the opponent's face-down cards).
  it("R565 stores each profile's last board on the server", () => {
    provenIn(565, SERVER_LAST_BOARDS_TEST);
  });

  // Proved by engine boardHistory.test.ts "R566 …" and cards classic-plus/035-rollback.test.ts "R566 …".
  it("R566 keeps a put-back card's instance whole but its turn state", () => {
    provenIn(566, "boardHistory.test.ts", PLUS_035_TEST);
  });

  // Proved by cards classic-plus/008-withering-storm.test.ts "R569 …".
  it("R569 draws C+ #8 Withering Storm's 4 among the cards a Degrade can change", () => {
    provenIn(569, PLUS_008_TEST);
  });

  // Proved by cards classic-plus/010-new-wraps.test.ts "R570 …" (the grant recorded; a later Vanilla keeps it).
  it("R570 records C+ #10 New Wraps' Reborn on a Unit that already has Reborn", () => {
    provenIn(570, PLUS_010_TEST);
  });

  // Proved by cards classic-plus/012-8-frostspatula.test.ts "R409 R572 …" (a mutual kill counts).
  it("R572 counts C+ #12.8 Frostspatula's kill in its own last combat", () => {
    provenIn(572, PLUS_012_8_TEST);
  });

  // Proved by cards classic-plus/037-wardrum.test.ts "R578 …" (a cast inside the 3rd play is the 4th).
  it("R578 counts C+ #37 Wardrum's plays in play order", () => {
    provenIn(578, PLUS_037_TEST);
  });

  // Proved by cards classic-plus/042-kys-test.test.ts and engine kyTest.test.ts "R580 …" (a + b from
  // the rng, three different near misses).
  it("R580 generates C+ #42 KY's Test's Easy problems from the rng", () => {
    provenIn(580, CLASSIC_PLUS_042_TEST, "kyTest.test.ts");
  });

  // Proved by cards classic-plus/040-appropriations.test.ts "R581 …" (one roll per card, Radiant ones too).
  it("R581 rolls every card of the field, hand and deck for C+ #40 Appropriations' Culture", () => {
    provenIn(581, CLASSIC_PLUS_040_TEST);
  });

  // Proved by cards classic-plus/043-ai-slop.test.ts "R582 …" (one card is added as it is).
  it("R582 adds C+ #43 AI Slop's one card unfused when its count is 1", () => {
    provenIn(582, CLASSIC_PLUS_043_TEST);
  });

  // Proved by cards preview.test.ts and classic-plus/044, 045 "R583 …" (the Radiant face's preview
  // names the permanents each choice would exile, never an enemy face-down card).
  it("R583 previews the permanents C+ #44 and #45's Radiant face would exile", () => {
    provenIn(583, CARDS_PREVIEW_TEST, CLASSIC_PLUS_044_TEST, CLASSIC_PLUS_045_TEST);
  });

  // Proved by cards classic-plus/064-mulch-muncher.test.ts "R584 …" (the discount prices a play only).
  it("R584 discounts C+ #64 Mulch Muncher only where a play takes it from", () => {
    provenIn(584, CLASSIC_PLUS_064_TEST);
  });

  // Proved by cards classic-plus/070-chaos-machine.test.ts "R585 …" (it may Upgrade itself).
  it("R585 lets C+ #70 Chaos Machine pick itself", () => {
    provenIn(585, CLASSIC_PLUS_070_TEST);
  });

  // Proved by cards classic-plus/t-ai-03-hallucination.test.ts and engine library-copies.test.ts
  // "R586 …" (copies in the order drawn; a small deck copied whole with no draw).
  it("R586 hands T-AI-3 Hallucination's copies over in the order drawn", () => {
    provenIn(586, CLASSIC_PLUS_T_AI_03_TEST, "library-copies.test.ts");
  });

  // Proved by cards classic-plus/t-ai-06-datacenter-fire.test.ts and engine effects-datacenter.test.ts
  // "R588 …" (an animated Field Spell is a Unit, neither destroyed nor counted).
  it("R588 sweeps T-AI-6 Datacenter Fire's Field Spells from the backrow alone", () => {
    provenIn(588, CLASSIC_PLUS_T_AI_06_TEST, "effects-datacenter.test.ts");
  });

  // Proved by cards classic-plus/074 and engine twiceForward.test.ts "R589 …" (an exiled card is
  // nothing to fuse; the Brittle still grows).
  it("R589 fuses into C+ #74 only a card still on the field or in a graveyard", () => {
    provenIn(589, CLASSIC_PLUS_074_TEST, "twiceForward.test.ts");
  });

  // Proved by cards classic-plus/047-joggs-box.test.ts "R593 …" (a Call the Box casts is link 1 of its
  // chain; engine effects-cast-chaos.test.ts proves the cast itself).
  it("R593 makes a Call to Chaos a random cast makes a link of its chain", () => {
    provenIn(593, CLASSIC_PLUS_047_TEST);
  });

  // Proved by cards classic-plus/052 "R594 …" (an Upgrade before the cast holds for the rest of the game).
  it("R594 reads C+ #52's numbers as it resolves and carries them", () => {
    provenIn(594, CLASSIC_PLUS_052_TEST);
  });

  // Proved by cards classic-plus/065-2 and 065-3 and engine effects-fruit.test.ts "R596 …" (a card
  // cast on draw, and the card its chain then brings, take no price).
  it("R596 reads \"it\" after a draw as the card that draw itself put in the hand", () => {
    provenIn(596, CLASSIC_PLUS_065_2_TEST, CLASSIC_PLUS_065_3_TEST, "effects-fruit.test.ts");
  });

  // The AI workstream's rows (from R600).

  // Proved by packages/ai shadowBan.test.ts "R390 R600 …" (watched when its own numbers put it at
  // risk and it was not banned; off the list when it was at risk only by the old tables and is clean).
  it("R600 keeps a card on SHADOW_WATCH only while its own numbers keep it at risk", () => {
    provenIn(600, AI_SHADOW_BAN_TEST);
  });

  // Proved by packages/ai shadowBan.test.ts "R390 R601 …" (6 affordable turns and no play, or 8 plays,
  // over pass 2's games at that tier, forced and filler summed; pass 1's numbers never added in).
  it("R601 judges a neverPlayed or selfHarm ban on pass 2's numbers alone", () => {
    provenIn(601, AI_SHADOW_BAN_TEST);
  });

  // Proved by packages/ai redact-live-face-down.test.ts "R602 …" (a face-down Siphon Squad: the AI's
  // view keeps its units' shown Attack and Health, the card stays a placeholder, and every move its
  // determinizations offer is legal on the true board).
  it("R602 keeps in the AI's view what a live face-down card visibly does", () => {
    provenIn(602, "../../ai/test/redact-live-face-down.test.ts");
  });

  // The ranked ladder's rows (issue #49, SPEC §9.12).

  // Proved by apps/server test/ranked/glicko2.test.ts "R603 …" (Glickman's worked example, draws as
  // half-wins against reference values, and one rated game as one rating period) and
  // test/api/ranked.test.ts "R603 rating the same game twice changes nothing" (idempotent rating).
  it("R603 rates every player with a hidden, deterministic Glicko-2 rating", () => {
    provenIn(603, SERVER_GLICKO_TEST, SERVER_RANKED_TEST, SERVER_RANKED_SQL, SERVER_RANKED_CONTRACT);
  });

  // Proved by test/api/ranked.test.ts "R604 a ranked series through the results writer" (a room's
  // series moves nothing, a queue's moves it once) and test/api/results.test.ts "ranked and
  // unranked (R604, R611)" (a room challenge records both ratings unchanged; a ranked match moves
  // both hidden ratings, their deviations and both seasons).
  it("R604 moves a rating or a rank only for the ranked match type", () => {
    provenIn(604, SERVER_RANKED_TEST, SERVER_RANKED_RESULTS_TEST, SERVER_RANKED_SQL, SERVER_RANKED_CONTRACT);
  });

  // Proved by test/ranked/ladder.test.ts "R605 the ladder's shape" (five Grape tiers of three
  // divisions, Raisin until placements are played) and test/api/ranked.test.ts "R605 placements
  // through rated games".
  it("R605 shows Raisin placements, then five Grape tiers of three divisions", () => {
    provenIn(605, SERVER_LADDER_TEST, SERVER_RANKED_TEST, SERVER_RANKED_CONTRACT);
  });

  // Proved by test/ranked/ladder.test.ts "R606 …" (the mid-rank percentile, the tier spread, the
  // one-pip lean, convergence, the streak bonus below Mythic Grape, holding the top).
  it("R606 leans pips gently toward the hidden rating and bonuses win streaks", () => {
    provenIn(606, SERVER_LADDER_TEST);
  });

  // Proved by test/ranked/ladder.test.ts "R607 the tier floor and the season's peak" (no drop below
  // the reached Grape tier; the season's best as the profile's badge).
  it("R607 floors each season's Grape tier and keeps its peak as a badge", () => {
    provenIn(607, SERVER_LADDER_TEST, SERVER_RANKED_CONTRACT);
  });

  // Proved by test/ranked/ladder.test.ts "R608 Jlorious" (top JLORIOUS_SIZE Mythic players by
  // rating; every Mythic player when fewer qualify; numbered positions; falling out returns to
  // Mythic) and test/api/ranked.test.ts "R608 Jlorious through the server".
  it("R608 ranks the top 100 Mythic players by rating as numbered Jlorious", () => {
    provenIn(608, SERVER_LADDER_TEST, SERVER_RANKED_TEST, SERVER_RANKED_CONTRACT);
  });

  // Proved by test/ranked/season.test.ts "R609 …" (season per minor version; the soft reset's pull,
  // deviation widening, order-independence, nobody to reset) and test/api/ranked.test.ts "R609
  // seasons on the server".
  it("R609 opens a season per minor version with a soft reset", () => {
    provenIn(609, SERVER_SEASON_TEST, SERVER_RANKED_TEST, SERVER_RANKED_SQL, SERVER_RANKED_CONTRACT);
  });

  // Proved by test/api/ranked.test.ts "R610 bots" (a bot rated like a player from its own rating,
  // with no rank, season row or leaderboard place, and outside the percentiles).
  it("R610 keeps each AI bot's own rating, off the player leaderboard", () => {
    provenIn(610, SERVER_RANKED_TEST, SERVER_RANKED_SQL, SERVER_RANKED_CONTRACT);
  });

  // Proved by test/api/results.test.ts "R611 records the rated game …" (version, pilots, result,
  // both ratings and ranks before and after).
  it("R611 records every rated game with versions, pilots, result and before/after", () => {
    provenIn(611, SERVER_RANKED_RESULTS_TEST, SERVER_RANKED_SQL, SERVER_RANKED_CONTRACT);
  });

  // Proved by test/api/ranked.test.ts "R612 what the client reads" (own rank, leaderboard, match
  // ranks, never a rating) and test/api/auth.test.ts "R612 sends no rating …".
  it("R612 reads the rank everywhere and the hidden rating nowhere", () => {
    provenIn(612, SERVER_RANKED_TEST, SERVER_AUTH_TEST, SERVER_RANKED_SQL);
  });

  // Proved by apps/web routes/almanac.test.tsx "R630 …" (the public route, its footer link and sitemap
  // entry, every card with tokens, the read-only browse pane, the detail view, filters and sort) and
  // game/deckbuilder/filters.test.ts "R630 …" (the almanac's pool and tag chips).
  it("R630 opens a public, read-only Card Almanac of every card, tokens included", () => {
    provenIn(630, "../../../apps/web/src/routes/almanac.test.tsx", WEB_FILTERS_TEST);
  });

  // R631 is a client ruling (SPEC §10.11): proved by apps/web musicPlan.test.ts "R631 …" (the
  // priority stack and dynamic music off), musicDirector.test.ts "R631 …" (the viewer's own state,
  // casts at R204's moments and only when readable, a theme's end, station switches, the match's
  // sting and rotation, the hotseat hand-over) and music.test.ts "R631 …" (bar-line crossfades, a
  // sting's hand-off, the turn mix, resuming, focus and nothing scheduled on a stopped context).
  it("R631 plays each viewer's own music from their own view, by the priority stack", () => {
    provenIn(631, WEB_MUSIC_PLAN_TEST, WEB_MUSIC_DIRECTOR_TEST, WEB_MUSIC_PLAYER_TEST);
  });

  // R632 is a client ruling (SPEC §9.2): proved by apps/web net/session.test.ts "R632 …" (the tab's
  // storage, an older build's session moved, the fixture's key, blocked storage, sign-out) and
  // routes/shell-gate.test.tsx "R632 …" (another tab's sign-out leaves this tab signed in).
  it("R632 keeps a session in its tab's storage and never in localStorage", () => {
    provenIn(632, WEB_SESSION_TEST, "../../../apps/web/src/routes/shell-gate.test.tsx");
  });

  // Proved by apps/server test/api/settings.test.ts (the routes: active only, the caps, the body's
  // checks), test/db/contract.ts (both stores), and the SQL suite's 11 (the merge function) and 02
  // (a player reads only its own row and writes none) headings.
  it("R633 keeps an active account's game settings on the server, in groups with the time each changed", () => {
    provenIn(633, SERVER_SETTINGS_API_TEST, SERVER_STORE_CONTRACT, SERVER_SETTINGS_SQL, SERVER_RLS_SQL);
  });

  // Proved by apps/server test/api/settings.test.ts "R634 …" and test/db/contract.ts (a group replaces
  // the stored one only when strictly later), the SQL suite's 11, and apps/web settings/accountSync.test.tsx
  // "R634 …" (load, push-up, debounce, one request at a time, failures dropped, a clock running ahead).
  it("R634 replaces a group of the account's settings only with a strictly later one, and merges the device's the same way", () => {
    provenIn(634, SERVER_SETTINGS_API_TEST, SERVER_STORE_CONTRACT, SERVER_SETTINGS_SQL, WEB_SETTINGS_SYNC_TEST);
  });

  // Proved by setup-aside.test.ts "R635 …": nothing is cast in setup, the cards are shuffled in after
  // the mulligans at random places and without a word to the other seat, an all-cast-on-draw deck
  // deals an empty hand with no fatigue and turn 1's chain meets R58's cap, and a mulligan can be
  // dealt fewer cards back than it returned; and by 021-hinder.test.ts's "R431, R635 …" (a real game).
  it("R635 sets cast-on-draw cards aside through setup and shuffles them in once the mulligans are done", () => {
    provenIn(635, "setup-aside.test.ts", "../../cards/test/021-hinder.test.ts");
  });

  // Proved by windfury.test.ts "R636 …" (the second attack in `legalActions` and the reducer, the switch
  // the first one spends, the count read at the second declaration, Deft Duelist beside it) and
  // config.test.ts / rulings-a.test.ts "R21 …" (Windfury in the random keyword pool).
  it("R636 lets a Unit with Windfury attack twice each turn", () => {
    provenIn(636, "windfury.test.ts");
  });

  // Proved by temporary.test.ts "R637 …" (the end-of-turn discard in hand order, the other player's hand,
  // a played card, a deck, granted and Vanilla) and the card side in packages/cards
  // test/classic-plus/054-book-of-books.test.ts "R637 …" (the Books Book of Books adds).
  it("R637 discards a Temporary card from its owner's hand at the end of their turn", () => {
    provenIn(637, "temporary.test.ts", "../../cards/test/classic-plus/054-book-of-books.test.ts");
  });

  // Proved by brittle.test.ts "R638 …" (a held count never ticks or crumbles in a hand or a deck, starts
  // its cycle as the card enters the field, is no arrival on a move between field zones, and is kept
  // through leaving the field), and the card side in packages/cards (Dropshipping's and Hallucination's tests).
  it("R638 ticks a Brittle count on the field only", () => {
    provenIn(638, "brittle.test.ts");
  });

  // Proved by apps/web stats/model.test.ts, stats/track.test.ts (what the viewer was shown and what the
  // events count), stats/store.test.ts (localStorage, tolerant), stats/useGameStats.test.tsx (once, at the
  // end), routes/landingFan.test.ts (the pool, the weighting, one rotation step) and routes/landing.test.tsx
  // (the threshold, the interval, holding still, a face that opens, "Your table").
  it("R639 keeps the player's statistics on the device and rotates the homescreen through every set once there are enough games", () => {
    provenIn(
      639,
      WEB_STATS_MODEL_TEST,
      WEB_STATS_TRACK_TEST,
      WEB_STATS_STORE_TEST,
      WEB_STATS_HOOK_TEST,
      WEB_LANDING_FAN_TEST,
      WEB_LANDING_TEST,
    );
  });

  // Proved by setup-aside.test.ts "R640 …": five Quickdraw cards deal three to the first seat and four
  // to the second, five to a Medium seat going second, the hand is the table's size whatever the deck
  // holds, and the surplus are ordinary cards a later draw can take.
  it("R640 deals a seat at most as many Quickdraw cards as it has opening draws", () => {
    provenIn(640, "setup-aside.test.ts");
  });

  // Proved by packages/cards/test/versions.test.ts "R650 …": a `vA.B.Y` micro patch is named after
  // the newest version in patches.json with the next letter.
  it("R650 names a micro patch after the newest version, with the next letter", () => {
    provenIn(650, "../../cards/test/versions.test.ts");
  });
});

describe("SPEC §11 index completeness", () => {
  /**
   * The documented invariant of `sqlHeadings` (03_match_lifecycle.sql's header, docs/architecture.md
   * §12): an SQL evidence script credits a row only through a `### R<n>: …` / `=== … (R<n>): … ===`
   * heading, and a bare mention in prose is not a proof.
   *
   * R107, R108 and R109 are the case that breaks first if the matcher is ever loosened to a
   * substring search: `03` names all three in a comment precisely to record that it does **not**
   * prove them, so a substring search would credit exactly the three rows the file disclaims.
   */
  it("credits an SQL row only from a heading, so R107–R109's prose disclaimer is not a proof", () => {
    const sqlFiles = [SERVER_SQL, SERVER_SCHEMA_SQL];
    const credited = (row: number): string[] =>
      sqlFiles.filter((file) => proofsFor(file, row).length > 0);

    // The six rows the SQL genuinely proves, each from a heading.
    for (const row of [104, 105, 106, 110, 111, 112]) {
      expect(credited(row), `R${row} should be credited by an SQL heading`).not.toEqual([]);
    }
    // The three it names only to disclaim. The prose really is there, or this proves nothing.
    for (const row of [107, 108, 109]) {
      expect(sourceOf(SERVER_SQL), `R${row} should still be named in the file's prose`).toMatch(
        new RegExp(`\\bR${row}\\b`),
      );
      expect(credited(row), `R${row} must not be credited from prose`).toEqual([]);
    }
  });

  it("has one test per §11 row and names no row the spec does not have", () => {
    const spec = readFileSync(new URL("../../../SPEC.md", import.meta.url), "utf8");
    const rows = [...spec.matchAll(/^\| R(\d+) \|/gm)].map((match) => Number(match[1]));
    const named = rulingTitles("rulings.test.ts").map((title) => Number(/^R(\d+)/.exec(title)?.[1]));

    expect(rows.length).toBeGreaterThan(0);
    // Ascending, no duplicates, and exactly the rows §11 has: a new row makes this red.
    expect(named).toEqual(rows);
  });
});
