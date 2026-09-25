// What a "Choose one" option says to the player (presentation only, CLAUDE.md rule 7).
//
// A card script's mode options are its public interface (`packages/cards` owns them, e2e answers
// with them): short machine words such as Pocket Chaos's "health", "board" and "library". The
// picker used to print those words bare under "Choose one", with nothing saying which card asked or
// what each option does. This map gives each one a label and a line of detail, written from the
// card's §8 text, keyed by the card's id and the option string. The option string stays the key the
// answer sends; an option this map does not know is printed with a capital letter and no detail.

type ModeText = { label: string; detail: string };

export const MODE_TEXT: Readonly<Record<string, Readonly<Record<string, ModeText>>>> = {
  // #17 Flood (radiant): "Choose one: bounce all units, bounce all enemy units, destroy all enemy units; then draw 1".
  "core-017": {
    "bounce all units": { label: "Bounce all units", detail: "Every unit returns to its owner's hand. Then draw 1." },
    "bounce all enemy units": { label: "Bounce enemy units", detail: "Your opponent's units return to their hand. Then draw 1." },
    "destroy all enemy units": { label: "Destroy enemy units", detail: "Destroy every enemy unit. Then draw 1." },
  },
  // #24 Efficiency Dividend: "deal X damage to a target; heal a target 2X; gain floor(X/2) mana next turn".
  "core-024": {
    damage: { label: "Deal X damage", detail: "Deal X damage to a target." },
    heal: { label: "Heal 2X", detail: "Heal a target by twice X." },
    mana: { label: "Mana next turn", detail: "Gain half of X, rounded down, as mana next turn." },
  },
  // #30 Archivist: "draw the highest-cost card in your library, or the lowest".
  "core-030": {
    highest: { label: "Highest cost", detail: "Draw the highest-cost card in your library." },
    lowest: { label: "Lowest cost", detail: "Draw the lowest-cost card in your library." },
  },
  // #48 5pek Controller (radiant): "Choose: all enemy units, or all units".
  "core-048": {
    enemy: { label: "Enemy units", detail: "Switch the position of every enemy unit." },
    all: { label: "All units", detail: "Switch the position of every unit." },
  },
  // #87 Pocket Chaos: "swap hero health, swap boards (every zone, lane-preserving), or swap libraries";
  // radiant: "You may skip adding it".
  "core-087": {
    health: { label: "Swap hero Health", detail: "You and your opponent trade hero Health." },
    board: { label: "Swap boards", detail: "Every zone changes sides, each card keeping its lane." },
    library: { label: "Swap libraries", detail: "You and your opponent trade libraries." },
    gift: { label: "Give a copy", detail: "Add a Pocket Chaos to your opponent's hand." },
    skip: { label: "Keep it to yourself", detail: "Your opponent gets no Pocket Chaos." },
  },
  // #88 Twisting Nether (radiant): "Choose: all enemy permanents, or all".
  "core-088": {
    enemy: { label: "Enemy permanents", detail: "Destroy every enemy permanent." },
    all: { label: "All permanents", detail: "Destroy every permanent on both sides." },
  },
};

/**
 * The options whose words change on the card's Radiant face, keyed like `MODE_TEXT`. Any option
 * missing here reads the same on both faces.
 */
export const RADIANT_MODE_TEXT: Readonly<Record<string, Readonly<Record<string, ModeText>>>> = {
  // #24 Efficiency Dividend, radiant: "deal 2X damage to a target; heal a target 4X; gain X mana
  // next turn" (§8 #24, R275), every mode doubled.
  "core-024": {
    damage: { label: "Deal 2X damage", detail: "Deal twice X damage to a target." },
    heal: { label: "Heal 4X", detail: "Heal a target by four times X." },
    mana: { label: "Mana next turn", detail: "Gain X mana next turn." },
  },
};

/**
 * An option's label and detail for card `defId` on the face it will resolve with (`radiant`); an
 * unknown one is its own word, capitalised.
 */
export function modeText(
  defId: string | undefined,
  option: string,
  radiant = false,
): { label: string; detail?: string } {
  const face = radiant && defId !== undefined ? RADIANT_MODE_TEXT[defId]?.[option] : undefined;
  if (face !== undefined) return face;
  const known = defId === undefined ? undefined : MODE_TEXT[defId]?.[option];
  if (known !== undefined) return known;
  return { label: option.length === 0 ? option : `${option.charAt(0).toUpperCase()}${option.slice(1)}` };
}
