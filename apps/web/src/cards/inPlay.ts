// What a face in play prints where the card in play and the card as printed part ways (SPEC §10.10).
//
// A card in the collection is its catalog definition, both faces printed in full. A card in a game
// is the card as the view says it stands (R243), and three cards print something else there:
//
// - #98 Heroic Power rolled one of seven powers as it arrived (R43, R151). In play its text is that
//   power alone, read off the view's `power` (a hand card's `CardView.power`, a backrow card's
//   `HeroPowerView`), with its X; the collection keeps the list of seven.
// - A card with the Call to Chaos tag (#95) reads "???" in play. What it does is rolled when it
//   resolves (§8 #95), and the game keeps it a mystery; the collection prints the real text, so a
//   player building a deck can still read it.
// - A unit a Vanilla took the text of (§6.3, R115) prints that its text is gone: the definition the
//   client reads still names the keywords and scripts it no longer has, and the view says so
//   (`UnitView.vanilla`, R243).
//
// Presentation only (CLAUDE.md rule 7): every word here is the card's §8 text or says what the view
// already says. `POWER_WORDS` is keyed by the power's name as the view carries it and written from
// §8 #98's clauses, base and radiant, the way `game/modeText.ts` words a "Choose one" option;
// `inPlay.test.ts` holds it to the engine's own table so the two cannot drift apart.

import type { Tag } from "@jackioh/shared";

/** §8 #98, the one card whose text in play is the power it rolled. */
export const HEROIC_POWER_ID = "core-098";

/** §5: the tag whose cards read {@link CONCEALED_TEXT} in play (#95 Call to Chaos). */
export const CONCEALED_TAG: Tag = "Call to Chaos";

/** What a concealed card's rules box reads in play. */
export const CONCEALED_TEXT = "???";

/** What a Vanilla unit's rules box reads (§6.3 Vanilla: "remove a unit's text"). */
export const VANILLA_TEXT = "Vanilla: its text is gone";

/** R43, R243: the power a #98 Heroic Power rolled, by the name the view gives it, and its X. */
export type RolledPower = { name: string; x: number };

type PowerWords = { base: string; radiant: string };

/** §8 #98's seven clauses, base and radiant, by the power's name in the view (R243). */
export const POWER_WORDS: Readonly<Record<string, PowerWords>> = {
  recruit: { base: "Recruit a permanent", radiant: "Recruit a permanent and make it Radiant" },
  draw: { base: "Lose 2 health, draw 1", radiant: "Lose 2 health, draw 2" },
  ping: { base: "Deal 1 damage to a target", radiant: "Deal 2 damage to a target" },
  burn: { base: "Deal 2 damage to each opposing hero", radiant: "Deal 4 damage to each opposing hero" },
  rush: { base: "Summon a Rush Token", radiant: "Summon two Rush Tokens" },
  felinor: { base: "Summon a Felinor Token", radiant: "Summon two Felinor Tokens" },
  discover: { base: "Discover a Unit", radiant: "Discover a Radiant Unit" },
};

/**
 * A Heroic Power's text in play: its keyword line, then the one power it rolled with its X, as
 * §8 #98 words each power ("Once per turn, spend X"). Null for a name this table does not know,
 * which leaves the printed text in place rather than inventing one.
 */
export function powerText(power: RolledPower, radiant: boolean, keywordLine: string): string | null {
  const words = POWER_WORDS[power.name];
  if (words === undefined) return null;
  const clause = `Once per turn, spend ${String(power.x)}: ${radiant ? words.radiant : words.base}. Playing it activates it once`;
  return keywordLine === "" ? clause : `${keywordLine}. ${clause}`;
}

/** Whether a card with these tags reads {@link CONCEALED_TEXT} in play. */
export function concealedInPlay(tags: readonly Tag[]): boolean {
  return tags.includes(CONCEALED_TAG);
}
