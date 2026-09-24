// The effects library (BUILD M3-T1): the one place a card script gets its verbs.
//
// A card script never touches state (CLAUDE.md rule 5); it composes `Effect[]` out of the factories
// below, and the resolver applies them. So this barrel is the whole vocabulary a card file may
// import — `import { summon, damage } from "../effects"` inside the engine, or from
// `@jackioh/engine/effects` in `packages/cards`. A verb that is not re-exported here does not exist
// as far as a card script is concerned, which is why every module in this directory is listed.
//
// Order follows the SPEC §6.3 verb table (Summon, Destroy, Sacrifice, Exile, … Swap), with the
// target vocabulary first because every other verb's arguments are written in it, and the two
// non-§6.3 modules (buff, memory) last. Each module is re-exported by name rather than with
// `export *`: the surface is then readable as the verb list it is, and a name that two modules
// come to export — or one that a module renames away — fails `pnpm typecheck` instead of silently
// vanishing from the barrel (an ESM ambiguous star export resolves to `undefined` at runtime).
//
// Collisions: as of this writing there are none. All 63 names below are distinct, so no module
// "wins" over another and nothing had to be dropped. Three names do shadow same-named helpers
// elsewhere in the engine, which is deliberate and not a conflict here, because the root
// `@jackioh/engine` index exposes this directory as a namespace (`export * as effects`):
//   - `addToHand`, `draw`   — the effect factories; `../draw` has the pipeline functions of the
//                             same names that these call into.
//   - `loseHealth`          — the effect factory; `../damage` has the hero-health helper it calls.
//   - `counter`             — the §6.3 Counter verb, from `move.ts`. It is unrelated to
//                             `counters.ts`, whose verbs are `plague`, `clearPlague` and `lock`.
// Verbs that §6.3 lists but this directory does not implement live outside it and are not part of
// the card-script surface: Play/Cast (`../resolve`), Switch position as a PLAYER ACTION
// (`../combat`, which spends exertion; the effect form is `position.ts` per R20), and Tribute,
// Embiggen and Replace, which are play-validator or resolver concerns rather than effects.
// Forced attack, Cancel an attack, Rotate and Fuse were on that list and are not any more: §6.3
// lists them as verbs, and #9, #52, #60, #96 and #99 need them from a card hook, which has no
// `EngineSink` of its own. Each is a thin wrapper that never reimplements what it wraps.

// The target, player and board-scope vocabulary every verb below is written in (§6.3, §10.6).
// `BoardScope` is the second half of that vocabulary: `TargetSpec` names ONE card, because
// `resolveTarget` answers with one `DamageTarget | null`, so a verb that sweeps a whole board — and
// every card-facing `*All` verb below — is written in a scope instead (§3.1, §3.2, R13, R68).
export {
  adjacentTo,
  cardsInScope,
  instanceOf,
  matchesScope,
  playerOf,
  resolveTarget,
  sidesOf,
} from "./targets";
export type { BoardScope, PlayerSpec, TargetSpec } from "./targets";

// Summon, Recruit, and the copy and random-pool forms (§6.3, §5.1, §6.2, R21, R57, R64).
export { fillBoard, recruit, summon, summonCopy, summonRandom } from "./summon";
export type {
  RecruitFilter,
  StatsOverride,
  SummonArgs,
  SummonCopyArgs,
  SummonPlacement,
} from "./summon";

// Destroy, Sacrifice, and the board-wide and adjacent forms (§6.3, §4.5, §3.1, R46, R59).
export { destroy, destroyAdjacentTo, destroyAll, sacrifice } from "./destroy";

// Exile, Bounce, Discard, Counter, and the board-wide, whole-hand and by-cost forms
// (§6.3, §2.4, §3.1, R11, R12, R16, R26, R31, R66, R135).
export {
  EXILE_ZONE_ORDER,
  bounce,
  bounceAll,
  counter,
  discard,
  discardHand,
  discardRandom,
  exile,
  exileAdjacentTo,
  exileAll,
  exileHand,
  exileMatching,
} from "./move";
export type { CostFilter, ExileZone } from "./move";

// Steal (§6.3).
export { steal, stealAll } from "./steal";
export type { StealTarget } from "./steal";

// Transform, Vanilla (§6.3).
export { transform, vanilla } from "./transform";
export type { TransformTarget } from "./transform";

// Heal (§6.3, R19).
export { heal } from "./heal";
export type { HealArgs } from "./heal";

// Discover, Choose one and the target/hand prompts (§6.3, §10.6, R50, R81).
export {
  chooseFromHand,
  chooseMode,
  chooseTarget,
  chosenOptions,
  discoverFromCatalog,
  discoverFromGraveyard,
  discoverFromLibrary,
  targetsInScope,
} from "./choose";
export type { DiscoverOffer, LibraryFilter, TargetScope } from "./choose";

// Plague Token, Lock (§6.3, §3.2).
export { clearPlague, lock, plague } from "./counters";
export type { ZoneSpec } from "./counters";

// Mana, next-turn mana (§6.3, §2.3).
export { gainMana, nextTurnMana } from "./mana";

// Damage, for one target or a whole scope (§6.3, §4.4).
export { damage, damageAll } from "./damage";
export type { DamageAllArgs, DamageEffectArgs } from "./damage";

// Lose health (§6.3, R18).
export { loseHealth } from "./loseHealth";

// Draw, of the top card or of a card the script named out of a library (§6.3, §2.4, R4, R58, R135).
export { draw, drawFromLibrary } from "./draw";

// Add to hand: creates OR moves the card (§6.3, §2.4, R4, R57, R60, R65).
export { addRandomFromCatalog, addRandomFromGraveyard, addToHand } from "./addToHand";

// Exile out of a library, by random draw or from the bottom (§6.3, §3.2, R11, R60).
export { exileBottomOfLibrary, exileRandomFromLibrary } from "./library";

// Shuffle into a library (§6.3, R80).
export { shuffleCopiesOfSelf, shuffleInto } from "./shuffleInto";

// Make Radiant, by name, by random pick, or by a roll per card (§6.3, §5.2, §6.1, R60, R74).
export { radiantChance, setRadiant, setRadiantRandom } from "./radiant";
export type { RadiantTarget, RadiantZone } from "./radiant";

// Switch position as an effect, which spends no exertion (§6.3, R20).
export { switchAllPositions, switchPositionOf } from "./position";

// Cost (§6.3, R65, R77).
export { setCostMod, setCostOverride } from "./cost";

// Swap (§6.3, R73).
export { SWAP_ROWS, swap, swapBoard, swapHealth, swapLibrary } from "./swap";
export type { SwapWhat } from "./swap";

// Stat buffs and keyword grants: layer 4 of §10.4 rather than a §6.3 row of their own (R21, R78).
export { buff, buffAllUnits, grantKeyword, grantRandomKeywords } from "./buff";
export type { BuffAmount } from "./buff";

// Forced attack, Cancel an attack, and My Pawn's AI playout: thin Effect wrappers over `../combat`
// and `../subsystems/aiPolicy`, which a card hook cannot call itself for want of an `EngineSink`
// (§6.3, §4.2, §10.7, R44, R53, R84).
export { aiPlaysOutTurn, cancelAttack, forcedAttacks, forcedAttacksOn } from "./combat";
export type { ForcedAttackerFilter, ForcedSide, ForcedTarget } from "./combat";

// A delayed effect, resolved at its R62 point in creation order (§2.2, §10.6, R62, R68).
export { DELAYED_HOOK, delay } from "./delay";
export type { DelayAt } from "./delay";

// Player-scoped modifiers with their expiry (§2.2, §2.3, §6.3 Cost, R30, R48, R65).
export { addPlayerModifier } from "./playerMods";

// Coin flips (§6.3, §10.7): every flip goes through `ctx.rng`, never `Math.random`.
export { flipCoins } from "./coins";

// Fuse (§6.3, R77, R102) and Rotate (§6.3, §3.1, R14, R88): both wrap their subsystem whole.
export { fuseCards } from "./fuse";
export { rotate } from "./rotate";

// What a card remembers on its own instance (§10.1, R43).
export { remember, rememberRandom } from "./memory";

// One effect per card of a set read once off the board, which a pause resumes over whole (R113, R66).
export { forEachCard } from "./each";
