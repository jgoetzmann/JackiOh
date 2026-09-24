// The keyword glossary the inspect views print beside a card (docs/polish/6-cards.md, Surface B).
//
// Every `rule` is SPEC's own "Rule" column, copied verbatim: §6.1 for unit keywords, §6.2 for
// triggers and timing words, §6.3 for verbs. §5.2 has no Rule column, so Radiant's line is §6.3's
// "Make Radiant" rule followed by §5.2's sentence about a card in hand or library. If SPEC changes
// a rule, this file is the bug (CLAUDE.md: SPEC wins).
//
// One exception: where a row's own **Ruling** overrides its Rule column, the glossary states the
// ruling, because a player reads this as what the card does. Cry's Rule column says "enters the
// field for the first time", but its ruling in the same §6.2 row says it fires only when the card is
// played from hand or cast, and never for a copy, a Recruit, a Reborn, a token or a Transform
// result (§6.3's Summon and Recruit rows agree). RULED_TERMS lists these rows for rules.test.ts.
//
// `label` is what the rules-text tokenizer (rules.ts) looks for, case-sensitively, and `aliases`
// are the other spellings the catalog uses for the same term.

import type { KeywordKind } from "@jackioh/shared";

export type TriggerTermId =
  | "Cry"
  | "Death"
  | "Start of turn"
  | "End of turn"
  | "Start of game"
  | "Once per turn"
  | "Aura"
  | "Combo"
  | "Echo"
  | "Cast on draw"
  | "Quickdraw";
export type VerbTermId =
  | "Discover"
  | "Tribute"
  | "Embiggen"
  | "Recruit"
  | "Fuse"
  | "Transform"
  | "Vanilla"
  | "Lock"
  | "Choose one"
  | "Radiant";
export type GlossaryTermId = KeywordKind | TriggerTermId | VerbTermId;
export type GlossaryEntry = {
  id: GlossaryTermId;
  label: string;
  /** SPEC's "Rule" column, copied verbatim (§6.1 keywords, §6.2 triggers, §6.3 verbs, §5.2 Radiant). */
  rule: string;
  section: "§5.2" | "§6.1" | "§6.2" | "§6.3";
  /** Other spellings matched in rules text. */
  aliases: readonly string[];
};

const NONE: readonly string[] = [];

function keyword(id: KeywordKind, rule: string): GlossaryEntry {
  return { id, label: id, rule, section: "§6.1", aliases: NONE };
}

function trigger(id: TriggerTermId, rule: string, aliases: readonly string[] = NONE): GlossaryEntry {
  return { id, label: id, rule, section: "§6.2", aliases };
}

function verb(id: VerbTermId, rule: string): GlossaryEntry {
  return { id, label: id, rule, section: "§6.3", aliases: NONE };
}

export const GLOSSARY: Readonly<Record<GlossaryTermId, GlossaryEntry>> = {
  // §6.1 Unit keywords
  Taunt: keyword("Taunt", "Enemies must attack Taunt units first"),
  Rush: keyword("Rush", "May attack units, not heroes, on summon turn"),
  Charge: keyword("Charge", "May attack units and heroes on summon turn"),
  "First Strike": keyword("First Strike", "Deals damage before non-First-Strike units"),
  Poisonous: keyword("Poisonous", "Destroys any unit it damages"),
  Lifesteal: keyword("Lifesteal", "Damage dealt heals your hero"),
  Reborn: keyword("Reborn", "First death: return at 1 health without Reborn"),
  "Divine Shield": keyword("Divine Shield", "Negate the first damage instance, then lose it"),
  Trample: keyword("Trample", "Excess damage hits the hero"),
  Cleave: keyword("Cleave", "Also damages units adjacent to the target"),
  Indestructible: keyword("Indestructible", "Can't be destroyed or damaged; can be exiled or sacrificed"),
  Immutable: keyword("Immutable", "Text can't be changed or transformed"),
  Stack: keyword("Stack", "May be played onto an occupied zone"),
  "Can't attack": keyword("Can't attack", "Cannot declare attacks"),
  Armor: keyword("Armor", "Reduce each damage instance by X"),
  Lucky: keyword("Lucky", "Repeat a luck-based roll X extra times, keep the best"),

  // §6.2 Triggers and timing words
  // §6.2's ruling, not its Rule column (see the header).
  Cry: trigger(
    "Cry",
    "When you play this card from your hand, or it is cast (Cast on draw, Echo, Call to Chaos). Not when it is summoned, copied, Recruited, Reborn or Transformed into",
  ),
  Death: trigger("Death", "When sent from the field to the GY"),
  "Start of turn": trigger("Start of turn", "Controller's turn start, before the draw", ["Start of your turn"]),
  "End of turn": trigger("End of turn", "Controller's turn end, before cleanup"),
  "Start of game": trigger("Start of game", "After mulligan, before turn 1", ["Start of Game"]),
  "Once per turn": trigger("Once per turn", "Activated ability limit", ["Once per Turn"]),
  Aura: trigger("Aura", "Effect while in play"),
  Combo: trigger("Combo", "Extra effect if X or more cards were played earlier this turn"),
  Echo: trigger("Echo", "Recast this card X more times"),
  "Cast on draw": trigger("Cast on draw", "Plays itself on draw, then draw again"),
  Quickdraw: trigger("Quickdraw", "Starts in your opening hand instead of a draw"),

  // §6.3 Actions and verbs
  Discover: verb("Discover", "Choose 1 of 3 options"),
  Tribute: verb(
    "Tribute",
    "As an additional cost of playing a card, sacrifice X of your units; a card whose own text tributes (Carnivorous Cube) sacrifices what that text names instead, which may be any of your other permanents, backrow included (R41)",
  ),
  Embiggen: verb("Embiggen", "Two prices, bigger effect for the bigger one"),
  Recruit: verb("Recruit", "Summon from library, scanning top down"),
  Fuse: verb("Fuse", "Combine effects, stats and cost, cost capped at 4"),
  Transform: verb("Transform", "Replace a card with another in place"),
  Vanilla: verb("Vanilla", "Remove a unit's text"),
  Lock: verb("Lock", "Zone can't be summoned into"),
  "Choose one": verb("Choose one", "Modal effect"),

  // §5.2 Radiant
  Radiant: {
    id: "Radiant",
    label: "Radiant",
    rule: "Upgrade a card. In hand or library: cost unchanged, stats and text swap to the radiant form.",
    section: "§5.2",
    aliases: NONE,
  },
};

/** The terms whose `rule` states their SPEC row's ruling instead of its Rule column (see the header). */
export const RULED_TERMS: readonly GlossaryTermId[] = ["Cry"];

/** Two-letter marks rather than glyphs, so a snapshot is stable and a screen reader gets the name. */
export const KEYWORD_MARK: Readonly<Record<KeywordKind, string>> = {
  Taunt: "TA",
  Rush: "RU",
  Charge: "CH",
  "First Strike": "FS",
  Poisonous: "PO",
  Lifesteal: "LS",
  Reborn: "RB",
  "Divine Shield": "DS",
  Trample: "TR",
  Cleave: "CL",
  Indestructible: "ND",
  Immutable: "IM",
  Stack: "ST",
  "Can't attack": "NA",
  Armor: "AR",
  Lucky: "LK",
};
