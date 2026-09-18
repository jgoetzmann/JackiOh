// #8 Mr. Vanilla (SPEC §8.1): a 1-cost 3/3 → 7/7 Human Unit whose whole text, on both faces, is
// "Immutable". A card whose text is keywords only has no hooks, so both Scripts are empty — an
// empty Script is the answer, not a placeholder.
//
// Immutable is PRINTED on both faces in `catalog.json` (`base.keywords` and `radiant.keywords` both
// hold `{ kind: "Immutable" }`), and §10.4 layer 1 puts printed keywords on the unit, so re-granting
// it from a script would be the same keyword twice from two sources.
//
// §8.1's Engine cell, "Blocks Vanilla, Transform, Fuse-onto", is R23, and every part of it lives in
// the engine, keyed off the keyword rather than off this card:
//   - `vanilla` and `transform` (engine/src/effects/transform.ts:121, :155) return early on
//     `unitHas(state, card, "Immutable")`, which is what makes #41 Sheepish "fire and do nothing"
//     (R17: the trap is still consumed) and what makes #83 Transmogulate leave an Immutable board
//     card alone (a Transform);
//   - Fuse-onto is refused by the Fuse subsystem and by #85's target choice (R23, R77): an
//     Immutable permanent is never chosen as a Fuse target;
//   - Radiant is still allowed, because the radiant text is the card's OWN text (§5.2, R23): the
//     `radiant` flag is not a text change, so #26 Glowy Jelly Bean, #27, #28 and #64 all work on it
//     and this card then reads its radiant face — which is, again, Immutable;
//   - #61 Prejudiced Postdoc may copy it, because the Vanilla applies to the COPY and not to this
//     card (R23).
//
// So there is nothing for this file to do, and nothing it may do: a script here could only restate
// a rule the engine already enforces for every Immutable card (#19r Midrange Menace, #66r).

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-008");

export const base: Script = {};

export const radiant: Script = {};
