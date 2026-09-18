// #53 Reno (SPEC §8.3, §6.3 Heal, §3). Unit 4/6 → 8/12, Human, cost 3, Common.
//   Base:    "Cry: if your hero is below 30, set it to 30"
//   Radiant: "60" — §8 Conventions: "a cell that changes only a number changes only that number",
//            so the radiant face is the same clause with 30 replaced by 60, not a second heal.
//
// The Engine cell is `health = max(health, 30)`, which is §6.3's "Heal up to 30" reading of Heal:
// `heal({ target, upTo })`. On a hero that is `healHeroUpTo` (engine/src/damage.ts), and it is a
// floor, never a ceiling — "if (hero.health >= floor) return 0", so a hero at 35 is left at 35 and
// no `healed` event is emitted for it. §3 gives a hero no maximum health, so nothing caps the 30
// or the 60 either; a hero already above the floor simply has nothing happen (§6.3, R19).
//
// R19 is why this is a legal target at all ("a heal may name any unit or hero"), and the target is
// named, not chosen: "your hero" is `{ of: "selfHero" }`, the controller's hero (§8 Conventions,
// "'Your' means the controller"), so there is no prompt and no play-time declaration here (R81).

import type { Script } from "@jackioh/engine";
import { heal } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-053");

/** The floor each face raises the hero to. §8: base 30, radiant 60. */
const BASE_FLOOR = 30;
const RADIANT_FLOOR = 60;

/** The two faces differ only in the number, so one builder writes both (§8 Conventions). */
function reno(floor: number): Script {
  return {
    cry: () => [heal({ target: { of: "selfHero" }, upTo: floor })],
  };
}

export const base: Script = reno(BASE_FLOOR);

export const radiant: Script = reno(RADIANT_FLOOR);
