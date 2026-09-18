// #11 Tempo Timmy (SPEC §8.1): 3/3 → 6/6 Unit, Human, cost 1. Base "Rush, First Strike", radiant
// "Charge, First Strike". §8's Engine cell is "Keywords only", so there is nothing to script.
//
// The radiant cell lists keywords without "Plus", so it is the radiant form's COMPLETE keyword list
// (§8 Conventions, "Reading a Radiant cell"): Rush is gone and Charge replaces it — §4.1's two
// sickness lifts, Rush for unit targets only and Charge for units and the hero. Both faces' keyword
// lists are printed in `catalog.json` (verified: base `[Rush, First Strike]`, radiant
// `[Charge, First Strike]`) and §10.4 layer 1 reads them off the running face, so re-granting them
// here would double them up. An empty Script is the whole card.

import type { Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-011");

export const base: Script = {};

export const radiant: Script = {};
