# Polish 6: card faces, inspect and the deck builder

Branch `polish/6-cards`, worktree `.claude/worktrees/polish-6-cards`. The brief is section 6 of
[reference.md](reference.md), and its ownership tables, conventions and SPEC §11 range (R206–R208)
apply. Ports: web 5176, server 8786, component 5286 (`E2E_COMPONENT_PORT`).

## Goal

Cards stop being grey squares. A new presentation module, `apps/web/src/cards/`, draws every
face-up card as a tall Hearthstone-style card (about 5:7). Each card has:

- a cost gem;
- an art window;
- a name ribbon;
- a type line and tag badges;
- a rarity gem, on a frame that changes with rarity (Common, Rare, Epic, Legendary with a crest,
  Mythic with animated foil) and with type (Unit, Spell, Field Spell, Trap, Field Trap);
- a rules box with keywords and `Cry:` / `Death:` in bold;
- sword and drop stats on units;
- a gold-foil Radiant face.

On the board a unit becomes a compact minion with an oval portrait. Every card has deterministic
procedural SVG art keyed by its id, in a base and a radiant variant, plus a manifest where real art
can drop in later without a 404 storm.

To inspect a card:

- **Desktop:** hover for 300 ms to see an enlarged card.
- **Touch:** long-press to open an inspect sheet.

The deck builder becomes a grid of full cards with:

- cost, type, tag, rarity, text and owned filters;
- six sorts;
- a Hearthstone-style deck list with a mana curve and a 20/20 count;
- a detail view with both faces side by side and a keyword glossary.

It is all presentation. No rule moves into the client (CLAUDE.md rule 7). `Card.tsx` keeps every
`data-testid` and `data-*` attribute that tests, e2e and the animation table read, and the M5-T1
board still fits 1280×720 and 390×844.

## Research

### What Hearthstone does

- **Card anatomy.** The mana cost sits in a blue crystal in the top-left corner. Every card has a
  portrait, a title and a main panel with card text. A minion shows Attack on a yellow sword at the
  bottom left and Health on a red blood drop at the bottom right.
  ([Card](https://hearthstone.wiki.gg/wiki/Card), [Minion](https://hearthstone.wiki.gg/wiki/Minion))
- **Rarity.** A gem at the bottom centre of the art is white for Common, blue for Rare, purple for
  Epic and orange for Legendary. Legendary cards add "the elite dragon around the portrait". Free
  and Core cards have no gem. ([Rarity](https://hearthstone.wiki.gg/wiki/Rarity))
- **Golden cards.** "Golden cards feature a golden frame" and "each has a unique animation". They
  are purely cosmetic. ([Golden card](https://hearthstone.wiki.gg/wiki/Golden_card))
- **Minions on the board.** A minion is drawn as a portrait. "Taunt is shown by a large shield-like
  border." Other states get their own marks: a skull, a lightning bolt, a flask, and "zzz" while
  exhausted. The frame brightens when the minion can attack. Hovering a minion or a card shows the
  whole card. ([Minion](https://hearthstone.wiki.gg/wiki/Minion))
- **Collection manager.**
  - "Players can click on a card in their collection to add a copy of it to that deck, or … drag
    cards into or out of the current deck list."
  - Clicking a deck-list entry removes it.
  - "Individual cards can be inspected in more detail by right-clicking them."
  - Mana filters are numbered icons, 0 to 7+.
  - Search takes keywords (attack, health, mana, rarity, type, owned) and combines them.
  - A mana-curve graph runs 0 to 7+.

  ([Collection manager](https://hearthstone.wiki.gg/wiki/Collection_manager),
  [Managing the Collection Manager](https://news.blizzard.com/en-us/article/21790299/managing-the-collection-manager),
  [Mana curve](https://hearthstone.fandom.com/wiki/Mana_curve))
- **Deck list tiles.** Each entry is a wide strip of the card art (256×59 "tiles … used when a
  card is placed in a deck") with the cost on the left and the name over the art.
  ([HearthstoneJSON images](https://hearthstonejson.com/docs/images.html))

### What we borrow

| Hearthstone | JackiOh |
| --- | --- |
| Blue mana crystal, top left | `.cost-gem`, top left. Green when cheaper than printed, red when dearer (`data-tone`). |
| Portrait: oval for minions, framed window for spells | `CardArt` shapes: `portrait` (Unit), `window` (Spell), `arch` (Field Spell), `notched` (Trap, Field Trap), `oval` (board minion), `strip` (deck tile) |
| Name banner across the art | `.card-name` ribbon, auto-shrunk to fit |
| Tribe banner at the bottom centre | `.cf-tag` badges at the bottom centre, plus the `.card-type` line |
| Rarity gem below the art: white, blue, purple, orange | `.cf-gem[data-rarity]` in those colours. Mythic, which Hearthstone lacks, gets a prismatic gem. Token cards get no gem, like Free/Core cards in Hearthstone. |
| Legendary dragon crest | An original crest (laurel and wings, CSS/SVG) over the art for Legendary and Mythic |
| Golden frame and animation | The Radiant face: a gold-foil frame, gold-shifted art and a shimmer. Radiant changes the card's game state (§5.2); it is not a cosmetic like Hearthstone's golden cards. |
| Yellow sword and red drop | `.cf-atk` and `.cf-hp` on full cards; `.stat-attack` and `.stat-health` on minions. Damaged health is red and buffed stats are green (`data-tone`). |
| Taunt shield frame, Divine Shield bubble, "zzz" | The minion shows a Taunt frame (`data-taunt`) and a `.shield-icon` bubble. No "zzz": `canAct` is false for every unit of the player who is not active and a sick unit may still switch (§4.1), so it cannot say "asleep". Whether a unit can attack is `legalActions`' highlight (task 7). |
| Hover shows the whole card | `inspect-hover` after `HOVER_DELAY_MS` = 300 ms |
| Click adds, drag adds, click on a deck tile removes, right-click inspects | The brief wins over Hearthstone here: a click on a pool card opens the detail view (whose "Add to Deck N" adds it), the card's "+" adds it in one tap, a drag adds, a click on a tile removes, and a right-click opens the detail view |
| Mana filter 0–7+, keyword search, curve 0–7+ | Cost chips `0`–`5`, `6+` and `X`, because Core tops out at 6 plus the 100-cost Ceaseless Void. Free-text search. The curve uses the same buckets. |
| Deck tiles with an art strip | `.db-tile` with a cost gem, the name, `CardArt shape="strip"` and a rarity pip |

### What we deliberately do not take

- No Blizzard art, frames, fonts, crests, logos or card backs, and no trademarks. Every frame,
  gem, crest and back is original CSS or inline SVG, and all art is procedural until real
  `apps/web/public/art/*.webp` files land.
- There are no class tabs (JackiOh has no classes), no crafting, no golden or diamond tiers, and
  no flavour text or artist line (the catalog carries neither).
- **Hearthstone's click-to-add in the pool.** The brief says "in the deck builder, a click opens a
  detail view", so a click on a pool card opens it and its "Add to Deck N" adds the card. Adding
  still takes one gesture: the "+" on every pool card, or a drag onto a deck. (The fix stage changed
  this after review; `Deckbuilder.test.tsx`'s two click tests and `routes/decks.test.tsx`'s one now
  use the detail's add or the "+", a deliberate test change flagged in the PR.)
- **The Radiant face is read, not concatenated** (`cards/radiantText.ts`). SPEC §8's reading rule
  decides what a radiant face prints:
  - a cell that lists keywords without "Plus" is the complete keyword list, so it replaces the base
    keyword line (radiant Jilliax, #56, prints "Charge, Taunt, Lifesteal, Indestructible" and never
    base's Rush or Divine Shield); "Plus X" adds X to the base line; a cell that names no keywords
    keeps the base line less any keyword the catalog's `radiant.keywords` drops (#86's Can't
    attack);
  - a clause the cell restates (the same leading §6.2 trigger: `Cry:`, `Death:`, `Aura:`,
    `Combo N:`, …) replaces that base sentence (radiant Bigot prints one Cry, #46 one Aura);
  - anything else the cell says (a changed number, "Also …", a new trigger) prints under a gold
    rule after the kept base text, and a bare "same" is not printed.
  When the radiant cell is empty or equal to the base text (#8, #38, #80, #81, #96, the tokens with
  no radiant form), the base text prints whole.

## Surface

Everything below is a boundary between slices, or between this task and tasks 1 and 7 or the
integration branch. Types come from `@jackioh/shared` (`CardDef`, `CardType`, `Tag`, `Rarity`,
`SetName`, `CardCost`, `Keyword`, `KeywordKind`, `UnitView`, `CardView`) and `@jackioh/validator`
(`CatalogSnapshot`, `Collection`).

### Files

```
apps/web/src/cards/                     (new)
  index.ts            B  the barrel; everything outside cards/ imports from here
  model.ts            B  FaceModel, faceModel()
  glossary.ts         B  GLOSSARY, KEYWORD_MARK, GlossaryTermId, GlossaryEntry
  rules.ts            B  tokenizeRules(), termsIn(), glossaryFor(), RulesToken
  fit.ts              B  nameTier(), textTier(), useFitText()
  constants.ts        B  face numbers (CLAUDE.md rule 9: named, never inline)
  icons.tsx           B  sword, drop, gem and crest glyphs (aria-hidden SVG, no <text>)
  RulesText.tsx       B  tokens → text and <strong class="cf-term">
  CardFace.tsx        B  the tall card (full | compact)
  MinionFace.tsx      B  the board minion
  CardBack.tsx        B  the textless back
  cards.css           B  frames, rarity, foil, minion, back, container queries, rarity tokens
  settings.ts         C  card settings store
  art/                A
    index.ts  hash.ts  themes.ts  emblems.ts  procedural.ts  svg.ts  manifest.ts
    CardArt.tsx  art.css
  inspect/            C
    index.ts  constants.ts  testids.ts  store.ts  useInspectTrigger.tsx  placement.ts
    HoverPreview.tsx  InspectSheet.tsx  CardDetail.tsx  Glossary.tsx  inspect.css
apps/web/src/game/Card.tsx              B  (rewritten internals, same exports)
apps/web/src/game/catalog.ts            B  (additive: CardInfo.def)
apps/web/src/game/deckbuilder/          D
  Deckbuilder.tsx  deckbuilder.css  testids.ts  loadout.ts  deckSize.ts  fixtures.ts   (existing)
  filters.ts  FilterBar.tsx  PoolGrid.tsx  DeckSidebar.tsx  ManaCurve.tsx             (new)
apps/web/src/routes/decks.tsx           D  (no change expected)
```

**Import rule.** Inside `apps/web/src/cards/**`, import a sibling by its file path
(`../CardFace.tsx`, `./store.ts`) and never through `cards/index.ts`, so the barrel cannot create
an import cycle. Code outside `cards/` imports only from `apps/web/src/cards/index.ts`.

### A. Art: `apps/web/src/cards/art/index.ts`

```ts
import type { ReactElement } from "react";
import type { CardType, Tag } from "@jackioh/shared";

export type ArtThemeId =
  | "human" | "felinor" | "ky" | "cn" | "fruit" | "chaos" | "quickdraw" | "token"
  | "unit" | "spell" | "field-spell" | "trap" | "field-trap";
export type Composition = "figure" | "burst" | "landscape" | "sigil";
export type EmblemGlyph =
  | "shield" | "cat" | "book" | "virus" | "fruit" | "vortex" | "bolt" | "coin"
  | "sword" | "star" | "tower" | "eye" | "rune"
  | "flame" | "moon" | "crown" | "hourglass" | "crystal";
export type ArtShape = "portrait" | "window" | "arch" | "notched" | "oval" | "strip";

/** Everything the SVG is drawn from. Coordinates are in a 0..100 box, numbers rounded to 2 dp. */
export type Backdrop = "none" | "moon" | "rings" | "pillars" | "beams" | "clouds" | "stars" | "arches" | "waves" | "grid";
export type SkyScheme = "dusk" | "night" | "dawn" | "split";
export const LAYOUTS: Readonly<Record<Composition, readonly string[]>>;
  // figure: centre, left, right, close; burst: star, spiral, orbit, shatter;
  // landscape: range, sea, towers, dunes; sigil: ring, diamond, eye, wheel
export type ArtSpec = {
  theme: ArtThemeId;
  composition: Composition;
  variant: "base" | "radiant";
  layout: string;          // one of LAYOUTS[composition]
  backdrop: Backdrop;      // drawn as the first `ridges`
  skyScheme: SkyScheme;
  sky: { from: string; to: string; angle: number };
  glow: { cx: number; cy: number; r: number; color: string; opacity: number };
  ridges: readonly { d: string; fill: string; opacity: number }[];
  emblem: { glyph: EmblemGlyph; x: number; y: number; size: number; rotate: number; fill: string; stroke: string };
  /** A second, smaller glyph in the corner furthest from the emblem, or null. */
  accent: { glyph: EmblemGlyph; x: number; y: number; size: number; rotate: number; fill: string; stroke: string } | null;
  motes: readonly { x: number; y: number; r: number; fill: string; opacity: number }[];
  /** Empty on the base variant; 7 to 11 rays on the radiant one. */
  rays: readonly { angle: number; width: number; opacity: number }[];
};

/** Which ids have real art in apps/web/public/art/. Ships empty. */
export type ArtManifest = Readonly<Record<string, { readonly base?: true; readonly radiant?: true }>>;
export const ART_MANIFEST: ArtManifest;

export function hashId(id: string): number;                   // FNV-1a, 32-bit unsigned
export function seededRandom(seed: number): () => number;     // mulberry32, [0, 1)
export function themeFor(tags: readonly Tag[], type: CardType): ArtThemeId;
export function compositionFor(type: CardType): Composition;
/** Pure. The seed is hashId(defId); the radiant variant reuses the base geometry. */
export function artSpec(defId: string, theme: ArtThemeId, composition: Composition, radiant: boolean): ArtSpec;
/** `data:image/svg+xml,…`: one <svg viewBox="0 0 100 100">, no <text>, no <title>, no external refs. */
export function artDataUri(spec: ArtSpec): string;
/** `${import.meta.env.BASE_URL}art/<id>.webp` or `…/<id>-radiant.webp`; `tint` = gold overlay on base art. */
export function artUrl(defId: string, radiant: boolean, manifest?: ArtManifest): { src: string; tint: boolean } | null;

export type CardArtProps = {
  defId: string;
  radiant: boolean;
  tags: readonly Tag[];
  type: CardType;
  shape: ArtShape;
  /** For tests. Defaults to ART_MANIFEST. */
  manifest?: ArtManifest;
  className?: string;
};
export function CardArt(props: CardArtProps): ReactElement;
```

- **Theme priority** (first match wins): Call to Chaos → `chaos`, CN → `cn`, KY → `ky`, Felinor →
  `felinor`, Fruit → `fruit`, Quickdraw → `quickdraw`, Human → `human`. After the tags, a
  Token-tagged card gets `token`; anything else gets its type theme (`unit`, `spell`,
  `field-spell`, `trap`, `field-trap`). The theme sets the palette, the emblem and the motes.
- **Per-card variety.** A theme sets the palette and the kind of picture only. Each card draws,
  from a stream salted off its seed (`VARIETY_SALT`), its own:
  - layout (`LAYOUTS[composition]`: a figure centred, left, right or close up; a spell as a
    starburst, spiral, orbit or shatter; a field as a range, sea, towers or dunes; a trap sigil as a
    ring, diamond, eye or wheel);
  - backdrop motif (`BACKDROPS`), drawn faint behind the composition;
  - sky scheme (dusk, night, a warm dawn horizon, or a split second hue);
  - emblem from the theme's wider `EMBLEM_POOLS` entry (a tribe's signature glyph weighted first;
    the type themes use only glyphs no tribe signs with), a hue turn of up to `HUE_DRIFT[theme]`
    (26 to 38 degrees), and, on about 70% of cards, a small accent glyph in a free corner.

  All of it is the same on the base and radiant faces (B1, B2). No two catalog cards of one theme
  share their layout, backdrop, sky and emblem (B40); the salt was chosen so that holds and every
  small tribe spreads over several layouts.
- **Composition by type:** Unit → `figure`, Spell → `burst`, Field Spell → `landscape`, Trap and
  Field Trap → `sigil`.
- **Radiant variant:** the same `composition`, `ridges[].d`, `emblem.glyph`, `emblem.x` and
  `emblem.y` as the base, a gold-shifted palette, and non-empty `rays`.
- **Caching.** `artDataUri` results are memoised in a module-level `Map` keyed
  `${defId}|${radiant}|${composition}`. The map is cleared once it passes 512 entries, because
  transient `t-<n>` defs can be minted without bound.
- **DOM contract:**
  - `CardArt` renders `<span class="cf-art cf-art--<shape>" data-art="procedural|real"
    data-art-theme=… data-art-variant="base|radiant" aria-hidden="true">`.
  - Procedural art is the span's inline `background-image`: the data URI, with `background-size:
    cover`.
  - Real art is `<img class="cf-art-img" alt="" loading="lazy" decoding="async"
    draggable={false}>`, plus `<span class="cf-art-tint">` when `tint` is set.
  - An `error` on the img swaps to procedural.
  - `.cf-art` is `display: block; width: 100%; height: 100%` of whatever box its parent gives it,
    and clips itself to its shape. Sizing it is the parent's job.

### B. Faces: `apps/web/src/cards/index.ts`

```ts
// model.ts
export type FaceLayout = "full" | "compact" | "minion";
export type StatTone = "base" | "buffed" | "reduced" | "damaged";
export type FaceCost = {
  /** What the gem shows: the view's live number whenever there is one, "X" for an X card, else the printed price. */
  text: string;
  /** `data-cost`: the live number when there is one (CardView.cost), else `text`. */
  value: string;
  tone: "base" | "down" | "up";
  /** The embiggen price beside the gem while the gem shows the base price; null once the live cost moved off it. */
  alt: string | null;
};
export type FaceStats = { attack: number; health: number; maxHealth: number; attackTone: StatTone; healthTone: StatTone };
export type FaceModel = {
  defId: string;
  /** False when no catalog def was available (the `unknownCard` fallback). */
  known: boolean;
  name: string;
  type: CardType;
  tags: readonly Tag[];
  rarity: Rarity | null;
  index: string | null;
  set: SetName | null;
  radiant: boolean;
  cost: FaceCost;
  /** Units only: live when `live` was given, else the printed face; null for non-units and unknown stats. */
  stats: FaceStats | null;
  /** Base face: { base text, null }. Radiant face: radiantText.ts's reading, { kept keyword line and clauses, what the cell adds or restates | null }. */
  text: { base: string; radiant: string | null };
  /** Live keywords when `live` was given, else the printed face's keywords. */
  keywords: readonly Keyword[];
};
export type FaceSource = {
  defId: string;
  def?: CardDef;
  /** Fallbacks when `def` is absent (CardInfo.name, BackrowView.type). */
  name?: string;
  type?: CardType;
  radiant: boolean;
  /** CardView.cost. */
  liveCost?: number;
  /** UnitView's current numbers. */
  live?: { attack: number; health: number; maxHealth: number; keywords: readonly Keyword[] };
};
export function faceModel(source: FaceSource): FaceModel;
```

**Tone rules.** "Printed" means the face being shown: `def.radiant` when radiant, else `def.base`.
The embiggen base price counts as the printed cost.

- **Cost tone:** `down` when the live cost is below the printed price, `up` when above, `base`
  otherwise. It is always `base` for an X card or an unknown card, and for an embiggen card whose
  live cost is its embiggen price (it was paid that on the field).
- **Attack tone:** `buffed` above printed, `reduced` below, `base` otherwise.
- **Health tone:** `damaged` when health < maxHealth. Otherwise `buffed` or `reduced` when
  maxHealth is above or below printed health, else `base`.
- A missing printed value always gives `base`.

```ts
// glossary.ts
export type TriggerTermId =
  | "Cry" | "Death" | "Start of turn" | "End of turn" | "Start of game" | "Once per turn"
  | "Aura" | "Combo" | "Echo" | "Cast on draw" | "Quickdraw";
export type VerbTermId =
  | "Discover" | "Tribute" | "Embiggen" | "Recruit" | "Fuse" | "Transform" | "Vanilla"
  | "Lock" | "Choose one" | "Radiant";
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
export const GLOSSARY: Readonly<Record<GlossaryTermId, GlossaryEntry>>;
/** Moved unchanged out of Card.tsx: TA RU CH FS PO LS RB DS TR CL ND IM ST NA AR LK. */
export const KEYWORD_MARK: Readonly<Record<KeywordKind, string>>;

// rules.ts
export type RulesToken = { kind: "text"; text: string } | { kind: "term"; text: string; term: GlossaryTermId };
export function tokenizeRules(text: string): RulesToken[];
/** Distinct terms in order of first appearance. */
export function termsIn(text: string): GlossaryTermId[];
/** termsIn(base), then termsIn(radiant ?? ""), then face.keywords' kinds; distinct; mapped to entries. */
export function glossaryFor(face: FaceModel): GlossaryEntry[];

// fit.ts
export type LengthTier = "s" | "m" | "l" | "xl" | "xxl";
export function nameTier(name: string): LengthTier;   // ≤12 s, ≤18 m, ≤24 l, ≤30 xl, else xxl
export function textTier(text: string): LengthTier;   // ≤40 s, ≤90 m, ≤160 l, ≤260 xl, else xxl (base + radiant clause)
/**
 * Binary-searches the inline custom property `--cf-fit` (FIT_MIN..1, FIT_STEPS steps) on `ref`
 * until scrollHeight ≤ clientHeight + 1 and scrollWidth ≤ clientWidth + 1. Re-runs on resize
 * (ResizeObserver when present) and when `content` changes. If FIT_MIN still overflows it sets
 * `data-clamped="true"` and the CSS line-clamps with an ellipsis. A no-op when the element has no
 * layout (clientWidth and clientHeight both 0, which is every element in jsdom).
 */
export function useFitText(ref: RefObject<HTMLElement | null>, content: string): void;

// constants.ts
export const FACE_ASPECT = 5 / 7;
export const NAME_TIER_MAX = { s: 12, m: 18, l: 24, xl: 30 } as const;
export const TEXT_TIER_MAX = { s: 40, m: 90, l: 160, xl: 260 } as const;
export const TIER_SCALE: Readonly<Record<LengthTier, number>> = { s: 1, m: 0.92, l: 0.82, xl: 0.72, xxl: 0.62 };
export const FIT_MIN = 0.55;
export const FIT_STEPS = 6;
/** Below this face height the rules box, tags and type line hide. Mirrored in cards.css's @container rule. */
export const FACE_TEXT_MIN_HEIGHT_PX = 150;

// CardFace.tsx, MinionFace.tsx, CardBack.tsx
export type CardFaceProps = { face: FaceModel; layout?: "full" | "compact"; className?: string };
export function CardFace(props: CardFaceProps): ReactElement;
export type MinionFaceProps = { face: FaceModel; unit: UnitView; className?: string };
export function MinionFace(props: MinionFaceProps): ReactElement;
export function CardBack(): ReactElement;

// index.ts also re-exports, by name: CardArt, ART_MANIFEST, artUrl, ArtShape, ArtManifest (from ./art);
// useInspectTrigger, closeInspect, CardDetail, InspectSubject, InspectOptions, InspectBindings,
// CardDetailProps and the INSPECT_* testids (from ./inspect); and everything in ./settings.ts.
```

**Glossary rules.** Each rule is SPEC's Rule column verbatim, except where the row's own ruling
overrides that column (`RULED_TERMS`): Cry says "When you play this card from your hand, or it is
cast (Cast on draw, Echo, Call to Chaos). Not when it is summoned, copied, Recruited, Reborn or
Transformed into", which is §6.2's ruling, not its "enters the field for the first time".

**Glossary terms.** The glossary has the 16 `KEYWORD_KINDS`, plus the §6.2 terms (Cry, Death,
Start of turn, End of turn, Start of game, Once per turn, Aura, Combo, Echo, Cast on draw,
Quickdraw), the §6.3 terms (Discover, Tribute, Embiggen, Recruit, Fuse, Transform, Vanilla, Lock,
Choose one) and Radiant (§5.2). Aliases: "Start of turn" also matches "Start of your turn", "Start
of game" matches "Start of Game", and "Once per turn" matches "Once per Turn".

**Tokenizer.**

- Matching is case-sensitive and longest-first.
- A term matches only at a word boundary: the characters on either side are not `[A-Za-z0-9]`, so
  "Locked" and "taunt" stay plain text.
- A match extends over a following ` <digits|X>` and then a `:`. So "Cry:" is one term, "Armor 2"
  is one term, and "Combo 2:" is one term.

**CardFace DOM** (`layout="full"`). Every element is a `span`, `strong` or `img`, so a face can sit
inside a `<button>`:

```
span.cf[data-layout="full"][data-card-type][data-rarity?][data-name-tier][data-text-tier]
       [data-foil="animated|static|none"][data-radiant-face?]
  span.cf-scale                              container-type: size; container-name: cardface
    span.cost-gem[data-cost][data-tone][data-digits?]  {cost.text}  (+ span.cf-cost-alt when cost.alt);
                                             data-digits="3" on a three-character price (100) steps its size down
    span.cf-crest                            Legendary and Mythic only
    span.cf-art-frame > CardArt              shape: Unit portrait, Spell window, Field Spell arch, Trap/Field Trap notched
    span.card-name                           the name as ONE text node; inline style --cf-fit only
    span.cf-gem[data-rarity]                 absent for Token and unknown rarity
    span.card-type                           the CardType string
    span.card-text[data-clamped?]            inline style --cf-fit only
      span.cf-text-base                      RulesText(text.base)
      span.cf-text-radiant                   RulesText(text.radiant), only when non-null
    span.cf-tags > span.cf-tag[data-tag]     one per tag (Token included)
    span.cf-stats                            Units with stats only
      span.cf-atk[data-face-attack][data-tone]   sword icon + number
      span.cf-hp[data-face-health][data-tone]    drop icon + number
```

- **`data-foil`:** `animated` for Mythic and radiant faces while `animatedFoil` is on, `static` for
  them while it is off, and `none` for everything else. The CSS never animates under
  `prefers-reduced-motion: reduce`.
- **`layout="compact"`** (a face-up backrow card) renders cost, art, name, rarity gem and
  `.card-type`, but no `.card-text`, tags or stats.
- **Container query.** `@container cardface (max-height: 149px)` hides `.card-text`, `.cf-tags`
  and `.card-type`. The 149 mirrors `FACE_TEXT_MIN_HEIGHT_PX`. The text stays in the DOM.
- **Sizing.** `.cf` sits in normal flow: `position: relative; height: 100%; aspect-ratio: 5 / 7;
  max-width: 100%; margin-inline: auto`. It sets `pointer-events: none`. Everything inside is
  positioned against `.cf-scale` in `cqh`/`cqw`, so the card scales as one piece. Font sizes are
  `calc(<base cqh> * <tier scale> * var(--cf-fit, 1))`.
- **Forbidden inside a face:** `data-attack`, `data-health`, `data-keyword`, `data-testid`, the
  `card` class token, and any inline `width` or `min-width`.

**MinionFace DOM.** Every element that the board's tests and e2e read stays here, under the same
names.

```
span.cf[data-layout="minion"][data-card-type][data-rarity?][data-foil][data-radiant-face?][data-taunt?]
  span.cf-scale
    span.cf-portrait > CardArt shape="oval"  (ring coloured by rarity; .cf-crest for Legendary/Mythic)
    span.cost-gem[data-cost][data-tone]      small, top left
    span.card-name                           name plate under the portrait, one text node
    span.stats
      span.stat.stat-attack[data-attack][data-tone]                      {attack}
      span.stat.stat-health[data-health][data-max-health][data-tone]     {health}<span class="cf-max">/{maxHealth}</span>
      span.stat.stat-armor[data-armor]                                   only when armor > 0
    span.keywords > span.keyword.keyword-icon[data-keyword][data-n?][data-chip?][title]   text `${KEYWORD_MARK}` + (` ${n}` when numbered)
                   + span.cf-kw-more "+n"    when more than KEYWORD_CHIPS_MAX (3) chips would show
    span.shield-icon[data-icon="shield"][aria-label="Divine Shield"]    while Divine Shield (a bubble)
```

Keyword chips run down the left edge under the cost gem at an 8px floor. Every keyword keeps its
`[data-keyword]` badge in the DOM, but Taunt (the frame), Divine Shield (the bubble) and Armor while
the armor plate shows are drawn as states and their badge is `data-chip="hidden"`; past three chips
the rest fold into a `.cf-kw-more` "+n" whose title lists them. There is no exhausted mark.

`.stat-health`'s `textContent` stays `"{health}/{maxHealth}"`, which BUILD M5-T1's "current over
max" requires. `.cf` fills its zone (`width: 100%; height: 100%; aspect-ratio: auto`).

**CardBack DOM.** `span.cf-back` (a CSS pattern and an aria-hidden SVG emblem) plus the legacy
`span.card-back-mark`. It has no text node, no `<text>` or `<title>`, and nothing that names a
card.

### `Card.tsx`: what survives, and what is new

`Card.tsx` keeps every export: `cx`, `isLegal`, `isSelected`, `legalAttr`, `DRAG_MIME`,
`encodeTarget`, `decodeTarget`, `beginDrag`, `allowDrop`, `completeDrop`, `Pops`, `PopLayer`,
`CardProps`, and the default `Card`. `CardProps` is unchanged. The face-up root stays one `div`
with these attributes:

| Kept, same meaning | New |
| --- | --- |
| `class`: `card`, `card-unit` or `card-spell`, `radiant`, `props.className`; `card-back` on backs | `class` also gets `cf-host cf-host--<minion\|full\|compact>` |
| `data-testid`, `data-legal` (clickable only), `data-selected`, `data-animating`, `aria-disabled`, `tabIndex`, `draggable`, `onClick`, `onKeyDown`, `onDragStart`, `onDragOver`, `onDrop` | the eight inspect handlers, spread after the drag props |
| `data-def-id`, `data-radiant`, `data-owner`, `data-controller`, `data-position`, `data-can-act`; `data-face-down="true"` and `aria-label` on backs | `data-face`, `data-rarity` (when known), `data-card-type` (`props.type ?? face.type`), `data-field-trap="true"` on a Field Trap. animations.css already reads `data-field-trap`. |
| inline `style={{ transform: "rotate(90deg) scale(0.72)" }}` for DEF, and no `style` attribute otherwise | nothing: faces put inline styles on inner elements only |
| `title={name}` | kept only while `hoverPreviews` is off, because the preview replaces it |

Descendants kept with the same meaning:

- `.cost-gem[data-cost]` and `.card-name`;
- the minion block above: `.stats`, `.stat-*`, `[data-keyword]`, `.shield-icon`;
- `.counter.counter-plague[data-counter="plague"]` and `.counter.counter-grade[data-counter="grade"]`;
- `.buried-badge[data-buried]` and `.position-tag`;
- the `switch-<instanceId>` button;
- `.pop-layer > .damage-pop / .heal-pop / .loss-pop`.

`Card.tsx` draws the counters, buried badge, position tag, switch button and pop layer as siblings
of `.cf`, not inside it, so they stay clickable while `.cf` has `pointer-events: none`.

The form comes from the props:

- `card === null` → `CardBack`, with no inspect subject.
- `unit` given → `MinionFace` with `data-face="minion"`.
- `type` given (a face-up backrow card) → `CardFace layout="compact"`.
- Anything else (hand, resolving) → `CardFace layout="full"`.

Card builds `faceModel({ defId, def: info.def, name: info.name, type: props.type, radiant,
liveCost: card.cost, live })`, then calls `useInspectTrigger({ key: testId ?? card.instanceId,
face })` and returns `<>{root}{inspect.overlay}</>`. The overlay is a sibling of the root, not a
child.

**`catalog.ts` (additive).** `CardInfo` gains `def?: CardDef`, and `lookupFromDefs` sets it to the
whole def. Nothing else in the file changes.

### C. Inspect: `apps/web/src/cards/inspect/index.ts` and `apps/web/src/cards/settings.ts`

```ts
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from "react";

export type InspectSubject = { key: string; face: FaceModel };
export type InspectOptions = {
  /** Default true: a mouse or pen hover opens the preview (also gated by settings.hoverPreviews). */
  hover?: boolean;
  /** Default true: a touch long-press opens the sheet, or calls onLongPress when given. */
  longPress?: boolean;
  onLongPress?: () => void;
  /** When given, a mouse right-click calls it and prevents the native menu. The deck builder only;
      the board leaves right-click to task 7's drag cancel. */
  onContextMenu?: () => void;
};
export type InspectHandlers = {
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
};
export type InspectBindings = { handlers: InspectHandlers; overlay: ReactElement | null; open: "hover" | "sheet" | null };
/** `subject === null` gives no-op handlers and a null overlay. */
export function useInspectTrigger(subject: InspectSubject | null, options?: InspectOptions): InspectBindings;
/** Closes the open overlay, or only the one for `key`. Task 7's drag layer may call it when a drag starts. */
export function closeInspect(key?: string): void;

export type CardDetailProps = { def: CardDef; onClose: () => void; actions?: ReactNode; meta?: ReactNode };
export function CardDetail(props: CardDetailProps): ReactElement;

export type Rect = { left: number; top: number; width: number; height: number };
export function placePreview(
  anchor: Rect,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
): { left: number; top: number; side: "right" | "left" | "above" | "below" };

// constants.ts
export const HOVER_DELAY_MS = 300;
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP_PX = 10;
export const CLICK_SUPPRESS_MS = 600;
export const PREVIEW_HEIGHT_PX = 380;   // capped by CSS at 80vh
export const PREVIEW_GAP_PX = 12;
export const PREVIEW_MARGIN_PX = 8;

// testids.ts
export const INSPECT_HOVER = "inspect-hover";
export const INSPECT_SHEET = "inspect-sheet";
export const INSPECT_DETAIL = "inspect-detail";
export const INSPECT_SCRIM = "inspect-scrim";
export const INSPECT_CLOSE = "inspect-close";
export const INSPECT_FACE = "inspect-face";
export const INSPECT_FACE_BASE = "inspect-face-base";
export const INSPECT_FACE_RADIANT = "inspect-face-radiant";
export const INSPECT_GLOSSARY = "inspect-glossary";
```

```ts
// apps/web/src/cards/settings.ts: task 7's panel mounts these at integration
export type CardSettings = { hoverPreviews: boolean; animatedFoil: boolean };
export const CARD_SETTINGS_KEY = "jackioh.cards.settings.v1";
export const CARD_SETTINGS_DEFAULTS: Readonly<CardSettings>; // { hoverPreviews: true, animatedFoil: true }
export const CARD_SETTINGS_FIELDS: readonly {
  key: keyof CardSettings;
  section: "gameplay" | "visuals";        // hoverPreviews → gameplay, animatedFoil → visuals
  label: string;
  description: string;
}[];
export function readCardSettings(): CardSettings;
export function writeCardSettings(patch: Partial<CardSettings>): CardSettings;
export function subscribeCardSettings(listener: () => void): () => void;
export function useCardSettings(): CardSettings;   // useSyncExternalStore over the three above
```

**Store.** One module-level `{ key, mode: "hover" | "sheet", anchor: Rect } | null`. Each trigger
subscribes with `useSyncExternalStore`, and its snapshot is null unless the store's key is its own,
so the other cards do not re-render.

**Hover.**

- A `pointerenter` whose `pointerType` is mouse, pen or empty (treated as mouse) starts a
  `HOVER_DELAY_MS` timer. When it fires, the preview opens anchored at
  `currentTarget.getBoundingClientRect()`.
- `pointerleave` clears the timer and closes the preview.
- Any `pointerdown` on the trigger closes the preview.
- Document-level listeners, installed while an overlay is open, close it on Escape, window `blur`,
  a capturing `scroll`, and `visibilitychange` to hidden.

**Long-press.**

- A `pointerdown` with `pointerType === "touch"` starts a `LONG_PRESS_MS` timer. A move of more
  than `LONG_PRESS_SLOP_PX` from the start point, a `pointerup` or a `pointercancel` clears it.
- When the timer fires, it calls `onLongPress` or opens the sheet, and arms the click suppressor.
- **Click suppressor:** `onClickCapture` swallows (`preventDefault` + `stopPropagation`) the next
  click on the trigger. It disarms on the next `pointerdown` or after `CLICK_SUPPRESS_MS`.
- `onContextMenu` prevents the native menu while a touch press is pending or has fired, and calls
  `options.onContextMenu` for a mouse right-click when that option is given.

**Overlays.**

- Every overlay is a `createPortal` into `document.body`.
- Its root stops propagation of `click`, `pointerdown`, `pointerup`, `mousedown`, `keydown`,
  `contextmenu`, `dragstart`, `dragover` and `drop`. React bubbles portal events through the
  React tree, so without this a click on "Close" would reach `Zone` or `Card` `onClick`.
- `inspect-hover` is `position: fixed` with `pointer-events: none` and `aria-hidden="true"`. It
  holds `[data-testid=inspect-face] > CardFace` at `PREVIEW_HEIGHT_PX` and, beside it,
  `Glossary`.
- `inspect-sheet` is a bottom sheet with `role="dialog"`, `aria-modal="true"` and
  `aria-label={name}`. It holds the face, the glossary and `inspect-close`, with an
  `inspect-scrim` backdrop.
- `CardDetail` is a centred `role="dialog"` holding:
  - `inspect-face-base` and `inspect-face-radiant`, side by side at every width;
  - a meta line: `#<index> · <set> · <rarity> · <type>` plus ` · <tags>` when there are any;
  - `.inspect-rules`, the base text and the radiant clause again at reading size, shown on screens
    ≤ 560 px wide and for any card whose printed text is tier `xl` or `xxl` (`data-long`), because
    two faces side by side on a phone print a long card at about 5 px;
  - the glossary of both faces;
  - the caller's `meta` and `actions`, then `inspect-close`, with an `inspect-scrim` backdrop.
- Opening any overlay first calls `closeInspect()`. Closing the sheet or the detail restores focus
  to the element that was focused when it opened.
- `Glossary` renders `ul[data-testid=inspect-glossary] > li[data-glossary-term=<id>]` with the
  label in `strong` and the rule text. It renders nothing when the list is empty.
- z-order is set in `inspect.css`: `--z-inspect-hover: 60`, `--z-inspect-modal: 70`. That is above
  the prompt scrim (40) and the animation layers (≤ 50).

### D. Deck builder: `apps/web/src/game/deckbuilder/`

```ts
// filters.ts: pure, and the only place the builder's filter and sort semantics live
export type CostBucket = "0" | "1" | "2" | "3" | "4" | "5" | "6+" | "X";
export const COST_BUCKETS: readonly CostBucket[];        // in that order
export const CURVE_TOP = 6;                               // the "6+" boundary
export const FILTER_TYPES: readonly CardType[];           // Unit, Spell, Field Spell, Trap, Field Trap
export const FILTER_TAGS: readonly Tag[];                 // Human, Felinor, KY, CN, Fruit, Call to Chaos, Quickdraw
export const FILTER_RARITIES: readonly Rarity[];          // Common, Rare, Epic, Legendary, Mythic
export type PoolFilter = {
  costs: ReadonlySet<CostBucket>;
  types: ReadonlySet<CardType>;
  tags: ReadonlySet<Tag>;
  rarities: ReadonlySet<Rarity>;
  search: string;
  ownedOnly: boolean;
};
export const DEFAULT_FILTER: PoolFilter;                  // empty sets, "", ownedOnly true
export type SortKey = "cost" | "name" | "rarity" | "attack" | "health" | "type";
export const SORT_KEYS: readonly SortKey[];
export type PoolSort = { key: SortKey; dir: "asc" | "desc" };
export const DEFAULT_SORT: PoolSort;                      // { key: "cost", dir: "asc" }
export function costBucket(cost: CardCost): CostBucket;  // n≥6 → "6+"; embiggen → its base; "X" → "X"
export function costOrder(cost: CardCost): number;       // n; embiggen base; X → +Infinity
export function searchMatches(def: CardDef, query: string): boolean;
/** Cost, type, tag, rarity and search; ownership is visiblePool's job. Empty set = no constraint. */
export function matchesFilter(def: CardDef, filter: PoolFilter): boolean;
export function sortPool(ids: readonly string[], catalog: CatalogSnapshot, sort: PoolSort): string[];
/** poolFrom(catalog, filter.ownedOnly ? collection : null), filtered, then sorted. */
export function visiblePool(catalog: CatalogSnapshot, collection: Collection | null, filter: PoolFilter, sort: PoolSort): readonly string[];
/** Per-bucket counts; ids the catalog does not know are skipped. */
export function manaCurve(cardIds: readonly string[], catalog: CatalogSnapshot): Readonly<Record<CostBucket, number>>;
/** Tile order: costOrder, then name, then id; unknown ids last. Never used for what save() sends. */
export function deckListOrder(cardIds: readonly string[], catalog: CatalogSnapshot): string[];
```

**Sort semantics.**

- Rarity order is Common < Rare < Epic < Legendary < Mythic. Type order is Unit, Spell, Field
  Spell, Trap, Field Trap.
- Attack and health sort on the base face's stats. Cards without stats go last in both directions.
- `dir` flips only the primary key. Ties then break ascending by `costOrder`, then name
  (`localeCompare`, `sensitivity: "base"`), then the numeric catalog `index`.

**Search.** The query is trimmed and split on whitespace. Every term must occur, case-insensitively,
in the haystack: the name, type, tags, rarity, base and radiant text, and printed keyword kinds of
both faces.

```ts
// testids.ts: additions only; every existing export stays byte-identical
export function slugOf(value: string): string;            // lower-case, runs of [^a-z0-9] → "-", trimmed
export const DB_FILTERS = "db-filters";
export const DB_SEARCH = "db-search";
export function filterCostId(bucket: CostBucket): string;   // `db-filter-cost-${bucket}`  ("db-filter-cost-6+", "db-filter-cost-X")
export function filterTypeId(type: CardType): string;       // `db-filter-type-${slugOf(type)}`
export function filterTagId(tag: Tag): string;              // `db-filter-tag-${slugOf(tag)}`
export function filterRarityId(rarity: Rarity): string;    // `db-filter-rarity-${slugOf(rarity)}`
export const DB_FILTER_OWNED = "db-filter-owned";
export const DB_FILTER_CLEAR = "db-filter-clear";
export const DB_FILTER_TOGGLE = "db-filter-toggle";       // phone-width fold for the chip rows (aria-expanded)
export const DB_SORT = "db-sort";
export const DB_SORT_DIR = "db-sort-dir";
export const DB_RESULT_COUNT = "db-result-count";
export const DB_EMPTY = "db-empty";
export function addPoolId(cardId: string): string;          // `db-add-${cardId}`: the "+" that adds in one tap
export const DB_DECK_STATUS = "db-deck-status";           // the polite status toast after an add or removal
export const DB_DETAIL_ADD = "db-detail-add";
export const DB_SIDEBAR = "db-sidebar";
export function deckCurveId(deck: number): string;          // `deck-curve-${deck}`
```

**Screen structure.** Existing testids are unchanged; the new ones are shown in brackets.

```
div.app-shell.app-shell--wide.deckbuilder [deckbuilder]
  BackLink, h1
  div.db-layout                                 grid areas "browse sidebar" (≤760 px: one column, sidebar first)
    aside.db-sidebar …                          (below; first in the DOM, so focus and reading order match the phone)
    section.db-browse
      div.db-filters [db-filters][data-expanded] search, owned checkbox, sort select + dir, fold toggle [db-filter-toggle],
                                                div.db-filter-chips (the chips, button[aria-pressed]), clear, count.
                                                At ≤ 760 px wide or ≤ 500 px tall the chips fold behind the toggle
      section.db-pool [card-pool]               CSS grid, repeat(auto-fill, minmax(min(196px, calc(50% - 5px)), 1fr)): 4 columns on a desktop, 2 at 390 px
        div.db-item[data-card]
          button.db-card [card-pool-<id>]       data-card, data-legal, data-in-deck, data-refused, aria-disabled,
                                                draggable (unchanged); + data-owned, aria-label "<name>, <cost> mana
                                                <type>, <rarity>[, in Deck N][, not in your collection]. Show details",
                                                click opens CardDetail,
                                                inspect handlers { hover: false, onLongPress, onContextMenu }
            CardFace (base face, layout full)   aria-hidden
            span.db-held                        "Deck N" when data-in-deck is set (aria-hidden: the label says it)
          button.db-add [db-add-<id>]           "+", aria-label "Add <name> to Deck N", aria-disabled while held;
                                                28 px drawn, 44 px hit area (::before)
      p.db-deck-status [db-deck-status]         role=status, aria-live=polite: "<name> added to Deck N · n/20",
                                                cleared after DECK_STATUS_MS; fixed, pointer-events none
      p [db-empty]                              when nothing matches
    aside.db-sidebar [db-sidebar]
      div.db-tabs[role=tablist] > button [deck-tab-<n>] (+ span [deck-count-<n>] "n/20")   unchanged
      section.db-deck [deck-drop-<n>][role=tabpanel][data-deck][data-active] hidden unless active
        header: "Deck N", n/20, ManaCurve [deck-curve-<n>] > span.db-bar[data-bucket][data-count] ×8
        ul.db-deck-list [deck-list-<n>]
          li [deck-<n>-card-<id>]
            button.db-tile [deck-card-<n>-<id>][data-card][data-rarity]   click removes (unchanged);
                                                aria-label "Remove <name> from Deck N", aria-keyshortcuts "I";
                                                inspect handlers (hover preview + long-press sheet); a right-click,
                                                I, the context-menu key or Shift+F10 open CardDetail
              span.db-tile-cost  span.db-tile-name  span.db-tile-art > CardArt shape="strip"  span.db-tile-pip[data-rarity]
      div.db-actions > button [loadout-save], span [loadout-saved]        unchanged
  p [loadout-save-error], ul [loadout-errors] > li [loadout-error-<rule>]  unchanged
  CardDetail when open, actions = button [db-detail-add] "Add to Deck N" (disabled while held)
```

**Deck builder constraints.**

- Hidden deck panels must stay `display: none`: `deckbuilder.css` carries
  `.db-deck[hidden] { display: none }`, because an author `display` rule beats the UA's `[hidden]`.
- Nothing on `/decks` may be `position: sticky` or `fixed` except the inspect overlays and the
  status toast, which has `pointer-events: none`. Cypress scrolls a click or drag target to the
  top of the viewport and fails on an element that anything covers.
- On a desktop at least 501 px tall the builder is one screen tall (`100dvh`): the pool scrolls
  inside its column from its own top to the screen's foot, and the deck list fills what the
  sidebar has left.
- Filter and sort state is not persisted. Filters that survive a reload could hide cards and
  confuse both players and spec 09.

**`e2e/support/testids.ts` (additive).** One new block, "A14: card faces, inspect and deck-builder
browse (polish 6)", mirrors every new name above (`INSPECT_*`, `DB_*`, the id functions and
`slugOf`) name for name. No existing line changes.

### CSS ownership and the root-style policy

| File | Slice | Styles |
| --- | --- | --- |
| `cards/art/art.css` | A | `.cf-art*` only |
| `cards/cards.css` | B | `.cf*`, the `.card.cf-host*` root rules below, and the `:root` tokens `--rarity-common`, `--rarity-rare`, `--rarity-epic`, `--rarity-legendary`, `--rarity-mythic`, `--rarity-token`, `--frame-unit`, `--frame-spell`, `--frame-field-spell`, `--frame-trap`, `--frame-field-trap`, `--foil-gold` (the deck builder reuses `--rarity-*`) |
| `cards/inspect/inspect.css` | C | `.inspect-*`, `--z-inspect-*` |
| `game/deckbuilder/deckbuilder.css` | D | `.db-*`, `.deckbuilder` |

The `.card` root's box, highlight and motion belong to board.css (task 7) and animations.css
(task 1). cards.css touches the root only through selectors that include `.cf-host`, and only
these properties:

- `padding: 0`;
- `background` and `border-color` for the resting state, whose selector excludes
  `[data-legal="true"]`, `[data-selected="true"]` and `.radiant`, so the highlight and radiant
  rules still win (for example
  `.card.cf-host--minion:not([data-legal="true"]):not([data-selected="true"]):not(.radiant)`);
- `user-select` and `-webkit-touch-callout: none`.

It never sets `width`, `height`, `max-width`, `overflow`, `transform`, `transition`, `animation`,
`box-shadow`, `outline`, `opacity`, `filter`, `cursor`, `touch-action` or `z-index` on the root.
Global `.stat` in index.css is neutralised inside faces by `.cf .stat` resets. No slice edits
index.css or board.css.

The root's sibling badges on a minion are placed by cards.css (`.card.cf-host--minion > …`),
not only offset: index.css's `.app-shell button` (9px 16px padding) otherwise turns the switch
button into a slab across the portrait, so cards.css draws it as a small round badge in the
top-right corner, where task 7's board.css also puts it (the cost gem has the top left and the
keyword chips the left edge). The counters sit on the portrait's right above the name plate, and a
compact backrow card's on the art's lower left. The ATK position tag is kept for assistive tech but visually hidden (ATK is the
resting state and DEF already rotates the card); DEF shows as a small steel tab on the top edge.
The deck builder does the same for its own buttons by scoping every button rule under
`.deckbuilder.app-shell`.

### Events, settings keys, SPEC rows

- **Events:** no new `GameEvent` type and no `ANIMATIONS` row. The faces read the same view the
  board already renders.
- **Settings:** one localStorage key, `jackioh.cards.settings.v1`. Every read and write is wrapped
  in `try/catch`.
- **SPEC:** no §11 rows.

## Behaviors

**Art (slice A)**

- **B1.** `artSpec(defId, theme, composition, radiant)` is pure and deterministic: equal arguments
  give deep-equal specs, and `Math.random` is never called (vitest, `vi.spyOn(Math, "random")`).
- **B2.** The base and radiant specs of one card share their composition: `composition`, every
  `ridges[i].d`, `emblem.glyph`, `emblem.x` and `emblem.y`. They differ in `sky`, and only the
  radiant spec has non-empty `rays` (vitest).
- **B3.** For every id in `CATALOG` and both variants, `artDataUri(spec)` starts with
  `data:image/svg+xml,` and contains none of `NaN`, `undefined`, `<text` or `<title`. No two ids
  produce the same base URI (vitest).
- **B4.** `themeFor(tags, type)` takes the first match of Call to Chaos → chaos, CN → cn, KY → ky,
  Felinor → felinor, Fruit → fruit, Quickdraw → quickdraw, Human → human. Then a Token-tagged card
  gets `token`, and anything else gets its type theme. `compositionFor` maps Unit → figure, Spell
  → burst, Field Spell → landscape, and Trap and Field Trap → sigil (vitest table).
- **B5.** `artUrl(defId, radiant, manifest)` returns (vitest):
  - null for an unlisted id;
  - `{ src: BASE_URL + "art/<id>.webp", tint: false }` for a listed base;
  - `{ src: BASE_URL + "art/<id>-radiant.webp", tint: false }` when the radiant file is listed;
  - the base src with `tint: true` for a radiant request when only the base is listed.

  `ART_MANIFEST` ships empty.
- **B6.** For an unlisted id, `<CardArt>` renders `span.cf-art[data-art="procedural"]` with a
  `data:image/svg+xml` background and no `<img>`. For a listed id it renders `img[alt=""]` with
  `data-art="real"`, and an `error` event on that img switches to procedural. The art is
  `aria-hidden="true"` with an empty `textContent` (jsdom).

**Faces (slice B)**

- **B7.** `faceModel` of a base face returns the def's name, type, tags, rarity, printed stats and
  keywords, with `text = { base, radiant: null }`. Of a radiant face, it takes stats and keywords
  from `def.radiant`, and its text is `radiantText.ts`'s reading of the two cells by SPEC §8's
  rule (vitest, every catalog card):
  - a cell that lists keywords without "Plus" replaces the base keyword line (radiant #56 prints
    "Charge, Taunt, Lifesteal, Indestructible", never Rush or Divine Shield; #25 prints
    "Indestructible", not "Armor 7"); "Plus X" adds X; a cell naming no keywords keeps the base
    line less any keyword `def.radiant.keywords` lacks (#86's Can't attack);
  - a clause the cell restates (same leading §6.2 trigger) replaces that base sentence (#2, #15,
    #46 print one Cry or Aura, the radiant one);
  - whatever else the cell says is `text.radiant`, a bare "same" is dropped, and an empty cell or
    one equal to the base text keeps the base text whole with `radiant: null` (core-008,
    core-t-felinor);
  - on every radiant face, the keyword line names only `def.radiant.keywords` and prints all of
    them, and no clause is printed twice.
- **B8.** `faceModel` cost (vitest + jsdom):
  - a `liveCost` below or above the printed price (a number, or an embiggen card's base) gives
    `tone` "down" or "up";
  - an X card shows `text: "X"` while `value` is the live number;
  - an embiggen card with no live cost, or a live cost at its base, shows its base with `alt` set
    to the embiggen price;
  - any other live cost is what the gem shows, with `alt: null` (the view's number, SPEC §10.10:
    a /fullsend discount to 1 shows 1). A live cost equal to the embiggen price (paid on the
    field) is toned `base`.

  `.cost-gem` renders `text`, `data-cost={value}` and `data-tone`.
- **B9.** `faceModel` stat tones (vitest):
  - live health below max health gives `healthTone: "damaged"`;
  - attack or max health above the printed face gives "buffed", below gives "reduced", and equal
    gives "base";
  - with no def (an unknown card), both tones are "base".
- **B10.** `tokenizeRules` marks glossary labels and aliases as terms: case-sensitive, at word
  boundaries, longest first, and extended over a following ` <digits|X>` and `:`. For example
  (vitest + jsdom):
  - "Cry: deal 2" → the term `Cry:`;
  - "Armor 2" → the term `Armor 2`;
  - "Start of your turn:" → the term Start of turn;
  - "taunt" and "Locked" stay text.

  `RulesText` renders each term as `strong.cf-term[data-term]`.
- **B11.** `GLOSSARY` has one entry per `KEYWORD_KINDS` kind, carrying SPEC §6.1's rule text and
  the two-letter mark Card.tsx used (TA RU CH FS PO LS RB DS TR CL ND IM ST NA AR LK). It also has
  every §6.2, §6.3 and §5.2 term listed under Surface, each with non-empty rule text. A term in
  `RULED_TERMS` (Cry) states its row's ruling instead of the Rule column: Cry fires when played
  from hand or cast, never when summoned, copied, Recruited, Reborn or Transformed into (vitest,
  pinned to SPEC's row).
- **B12.** `<CardFace layout="full">` renders only `span`, `strong` and `img` elements (jsdom):
  - `.cost-gem`;
  - `.cf-art-frame > .cf-art`;
  - `.card-name`, holding the name as a single text node;
  - `.cf-gem[data-rarity]`, absent for Token and unknown rarity;
  - `.card-type` with the type;
  - one `.cf-tag[data-tag]` per tag;
  - `.card-text`, empty when the card has no text;
  - for Units only, `.cf-atk[data-face-attack][data-tone]` and
    `.cf-hp[data-face-health][data-tone]`.

  It renders no `data-attack`, `data-health`, `data-keyword` or `data-testid`.
- **B13.** `.cf` carries `data-layout`, `data-card-type`, `data-rarity` (omitted when unknown),
  `data-name-tier`, `data-text-tier` and `data-foil`. `.cf-crest` renders only for Legendary and
  Mythic. `data-foil` is "animated" for Mythic and radiant faces while `animatedFoil` is on,
  "static" for them while it is off, and "none" otherwise (jsdom).
- **B14.** A radiant face sets `data-radiant-face="true"` on `.cf` and renders its art with
  `data-art-variant="radiant"`. Whenever `text.radiant` is not null, it prints `.cf-text-base`
  followed by `.cf-text-radiant` under a gold rule; an empty `.cf-text-base` (the cell replaced
  the only base clause) is not drawn. The radiant panel is the type's colour gilded and the gold
  edge keeps a tint of the rarity, so a radiant Trap and Field Trap, or Common and Rare, never
  share a frame; a Field Trap's art window is a hexagon, a Trap's a chamfered box (jsdom +
  Cypress component).
- **B15.** `nameTier` and `textTier` return s, m, l, xl or xxl by the Surface thresholds, and
  `useFitText` changes nothing without layout (jsdom). In Chrome, for every catalog card and both
  faces, `.card-name` and `.card-text` stay within their boxes, with scroll ≤ client + 1 on both
  axes (Cypress component):
  - at 270 px wide, no element carries `data-clamped`;
  - at 170 px wide, only faces whose printed text exceeds 260 characters may carry
    `data-clamped="true"`.
- **B16.** `Card` with `card: null` renders one `.card.card-back` with an empty `textContent`, no
  `data-def-id`, no `data-testid` and no `.card-name`. Hovering or long-pressing it opens nothing
  (jsdom).
- **B17.** `Card` keeps every root attribute and descendant listed under "`Card.tsx`: what
  survives", with the DEF rotation as the only inline style on the root, and it keeps all its
  exports. The regenerated Board snapshot is the only existing expectation that changes (jsdom:
  the existing `Board.test.tsx`, `animation-targets.test.tsx` and `Prompt.test.tsx`, plus
  `Card.test.tsx`).
- **B18.** `Card` picks the form from its props (jsdom):
  - with `unit`: `data-face="minion"`, with `.cf-portrait` holding an oval `CardArt`;
  - with `type` (a face-up backrow card): `data-face="compact"`, with `.card-type` reading the
    `BackrowView.type`;
  - otherwise (hand, resolving): `data-face="full"`, with `.card-text`.
- **B19.** A face-up `Card` root also carries (jsdom):
  - classes `cf-host cf-host--<form>`;
  - `data-rarity` when known, and `data-card-type`;
  - `data-field-trap="true"` on a Field Trap;
  - `title` (the name) only while `hoverPreviews` is off.

  Inside it, each keyword badge has the classes `keyword keyword-icon`, and the `.cf` of a unit
  with Taunt has `data-taunt="true"`. No unit draws an exhausted or asleep mark: `canAct` is false
  for every unit of the player who is not active, and a sick unit may still switch (§4.1). Taunt,
  Divine Shield and plated Armor are drawn as states (`data-chip="hidden"` on their badge); the
  other keywords show as at most `KEYWORD_CHIPS_MAX` (3) chips, the last becoming a `.cf-kw-more`
  "+n" whose title lists the rest. Every keyword keeps its `[data-keyword]` badge.
- **B20.** No element inside a card carries the `card` class token, and no new testid starts with
  `card-` or `hand-card-`. So a stacked-pile zone holds one `.card`, the fixture board holds 20,
  and `cy.fieldCardByName` and `cy.handCardByName` resolve to the named card (jsdom query over
  `fullBoardView()`, plus the existing `Board.test.tsx`).
- **B21.** With the real catalog in `CatalogContext`, `Game` rendering `fullBoardView()` inside
  `.app-shell.app-shell--wide` has no horizontal overflow and all 20 field cards visible at
  1280×720 and 390×844, and `board-layout.cy.tsx` passes unchanged. At both sizes a visible
  keyword chip is at least 8 px (10 px tall), no switch button, counter or buried badge covers a
  cost gem or a name, and a damaged or reduced stat reads red (Cypress component).

**Inspect (slice C)**

- **B22.** A mouse or pen pointer resting on a face-up card for `HOVER_DELAY_MS` (300 ms) opens
  `inspect-hover` in `document.body`, showing the card's `CardFace` with live cost and stats, and
  its glossary. Leaving earlier opens nothing, and leaving later closes it. A touch pointer never
  opens it, and no pointer does while `hoverPreviews` is false (jsdom, fake timers).
- **B23.** A pointerdown on the trigger, Escape, a window blur or a scroll closes the hover
  preview. Opening any inspect overlay closes the one already open, so the document holds at most
  one of `inspect-hover`, `inspect-sheet` and `inspect-detail` (jsdom).
- **B24.** A touch pointer held for `LONG_PRESS_MS` (450 ms) without moving more than
  `LONG_PRESS_SLOP_PX` (10 px) opens `inspect-sheet` (`role="dialog"`, `aria-modal`, focus on
  `inspect-close`), or calls `onLongPress` instead when one is given. Moving past the slop, or
  lifting first, cancels it. The click after a long-press is swallowed, so the Board's `onClick` is
  not called, and `contextmenu` during a touch press is prevented (jsdom, fake timers).
- **B25.** `inspect-sheet` and `inspect-detail` close on `inspect-close`, on `inspect-scrim` and on
  Escape, and give focus back to the element that had it. Tab and Shift+Tab stay inside the open
  sheet or detail: from its last control (or from outside) Tab goes to its first, and Shift+Tab
  from its first goes to its last. No click, pointer, key or drag event inside any overlay reaches
  a Board, Zone, Hand or Deckbuilder handler (jsdom: the `onClick` spies stay uncalled).
- **B26.** `inspect-glossary` lists one `li[data-glossary-term]` per entry of `glossaryFor(face)`,
  each showing its `GLOSSARY` label and rule, in this order: the terms in the base text, then in
  the radiant clause, by first appearance; then the face's keywords not yet listed. On a radiant
  face those are the printed texts (B7), so radiant #56 explains Charge and Indestructible and
  never Rush or Divine Shield. Nothing is rendered when the list is empty (jsdom).
- **B27.** `placePreview(anchor, viewport, size, prefer = "beside")` returns the right side when
  the preview fits there, else left, else above, else below. With `prefer: "above"` it tries above
  first, then the same order: a full face in a row (the hand, the resolving strip, a prompt
  option) asks for it, so the preview rises over the card instead of covering the neighbour the
  pointer is heading for. `left` and `top` are clamped so the box stays `PREVIEW_MARGIN_PX` (8)
  inside the viewport (vitest table).
- **B28.** Card settings live under the localStorage key `jackioh.cards.settings.v1` (jsdom, with
  a throwing `Storage` stub):
  - `readCardSettings` returns `CARD_SETTINGS_DEFAULTS` when storage is empty, holds invalid JSON
    or throws, and fills missing keys from the defaults;
  - `writeCardSettings` keeps working in memory when storage throws;
  - `useCardSettings` re-renders on every write.
- **B29.** `<CardDetail def>` renders `inspect-detail` with `inspect-face-base` and
  `inspect-face-radiant` side by side, a meta line with `#<index>`, the set, rarity, type and tags,
  the glossary of both faces, and the caller's `actions` (jsdom). The faces and the info column
  (meta, rules at reading size, glossary) scroll in `.inspect-detail-body`; the actions row with
  Close is pinned under it. On a wide screen up to 900 px tall the info column stands beside the
  faces, so at 1280×720 Add to Deck and Close are on screen as the detail opens, for the longest
  card too (Cypress component, B38).

**Deck builder (slice D)**

- **B30.** The pool (`card-pool`) is a grid of `div.db-item`s. Each holds the `card-pool-<id>`
  button, which contains a full `CardFace` of the base face, and a sibling `db-add-<id>` "+"
  button. The card's accessible name is the card ("<name>, <cost> mana <type>, <rarity>, in Deck
  N. Show details"), not only its name. Every existing deckbuilder testid and data attribute keeps
  its meaning, so `loadout.test.ts`, `messages.test.ts` and spec 09 (which adds by drag) pass
  unchanged; the three tests that added by clicking the card now click its "+" or the detail's
  Add (a deliberate change, see B38).
- **B31.** Filtering (vitest + jsdom):
  - cost chips `0`–`5`, `6+` and `X`, type chips, tag chips and rarity chips are toggle buttons
    with `aria-pressed`;
  - chips OR within a group and AND across groups;
  - `costBucket` files an embiggen card under its base price, 100 under `6+`, and X under `X`;
  - `db-result-count[data-count]` equals the number of pool items shown, and `db-empty` appears at
    0;
  - `db-filter-clear` restores the default filter.
- **B32.** `db-search` keeps a card when every whitespace-separated term of the query occurs,
  case-insensitively, in its name, type, tags, rarity, base or radiant text, or printed keyword
  kinds (vitest + jsdom).
- **B33.** `db-filter-owned` is checked by default and limits the pool to owned cards (jsdom):
  - unchecked, it shows every non-token catalog card, with `data-owned="false"` on unowned ones;
    its "+" still adds one, so the validator's L5 sentence appears;
  - with `collection === null`, it is disabled and no `data-owned` is rendered.
- **B34.** `db-sort` (cost, name, rarity, attack, health, type) and `db-sort-dir` (`data-dir` asc
  or desc; the default is cost asc) order the grid (vitest + DOM order):
  - ties break by cost, then name, then catalog index, always ascending;
  - for attack and health, cards with no stats come last in both directions.
- **B35.** `db-sidebar` holds the `deck-tab-<n>` tabs with their `deck-count-<n>`, and one
  `deck-drop-<n>` panel per deck. Only the active panel is visible; the rest are `hidden` but
  mounted. Each list shows its tiles ordered by cost then name, each with a cost gem, the name, an
  art strip and a rarity pip, while the draft order sent to `save` is unchanged. The sidebar comes
  before the browse column in the DOM, so a phone's focus and reading order match what it draws
  first (the desktop grid still places it on the right by area name). A tile's focus ring is drawn
  inside the tile, where the scrolling list cannot clip it (jsdom + a CSS read).
- **B36.** `deck-curve-<n>` has one bar per bucket (`0`–`5`, `6+`, `X`), each with `data-bucket`
  and a `data-count` equal to the deck's cards in that bucket (vitest `manaCurve` + jsdom).
- **B37.** A pool card that any deck holds shows a `.db-held` badge naming that deck ("Deck N")
  beside its existing `data-in-deck`, so a card another deck uses is marked on the grid (jsdom).
- **B38.** A click on a pool card (the brief: "a click opens a detail view"), a right-click, a
  touch long-press, or Enter or Space on the focused card opens `inspect-detail` for that card
  (jsdom):
  - the detail's `db-detail-add` puts the card into the active deck, and is disabled while any
    deck holds it;
  - the card's `db-add-<id>` "+" adds it in one tap and opens nothing; while another deck holds
    the card it is `aria-disabled` and a press is refused as a drag is (L4);
  - hovering a deck tile opens `inspect-hover`, clicking the tile still removes the card, and a
    right-click, I, the context-menu key or Shift+F10 on it open its detail.
- **B39.** On `/decks`, `Deckbuilder` with the real catalog has no horizontal overflow at 390×844
  and 1280×720, and shows at least two pool columns at 390 px. At 1280×720 the page does not
  scroll and the pool's own bottom edge is on screen (Cypress component).
- **B40.** Per-card art variety: every catalog card draws a layout from its composition's
  `LAYOUTS`, a backdrop, a sky scheme and an emblem, the same on both variants, and no two catalog
  cards of one theme share all four. Every theme of four or more cards spreads over at least two
  layouts, three backdrops and two skies, and the four largest themes use every layout (vitest).
- **B41.** After each add or removal, `db-deck-status` (`role="status"`, polite) names the card,
  the deck and its count ("Bigot added to Deck 1 · 7/20"), or the deck that already holds a card
  a "+" could not add, and clears after `DECK_STATUS_MS` (jsdom, fake timers).
- **B42.** A prompt option that names a card (a mulligan, a Discover, a card from hand) draws the
  card's full `CardFace` inside the `prompt-option-<key>` button, filling the box prompt.css gives
  it, with the hand's hover preview (`prefer: "above"`) and long-press sheet. A click still picks
  it; an option that names no card keeps its name and text (jsdom `PromptCards.test.tsx` +
  Cypress component).

## Tests

**Runner.** Everything in jsdom is the vitest project `web`: `apps/web/vitest.config.ts`, jsdom,
`globals: false`, with setup in `src/test/setup.ts`, which provides the jest-dom matchers, the
`matchMedia` stub and `setReducedMotion`. Run one file with
`pnpm vitest run --project web <file>`. Each file calls `cleanup()` in `afterEach`, because
`globals: false`.

**Harness**

- **Board and card fixtures:** `apps/web/src/test/fixtures.ts` (`fullBoardView`, `unit`, `card`,
  `faceUpBackrow`, `baseView`, `resetIds`). They are the only `PlayerView` source, per that file's
  own rule.
- **Real catalog:** `import { CATALOG } from "@jackioh/cards"`, the package's public export.
  `packages/cards/src/catalog-data.ts` says it is the only module that reads `catalog.json`. Wrap
  it as `<CatalogContext.Provider value={lookupFromDefs(CATALOG)}>`.
- **Deck builder, existing contract:** `apps/web/src/game/deckbuilder/fixtures.ts`, unchanged.
  Filter and sort tests build a small varied `CatalogSnapshot` inline in the test file: costs 0,
  1, 6, 100, "X" and an embiggen pair; all five types; several tags and rarities; one card with no
  text.
- **Pointer events:** use `@testing-library/react`'s `fireEvent.pointerEnter` and `pointerLeave`,
  which RTL maps to the `pointerover` and `pointerout` React listens on, and
  `fireEvent.pointerDown`, `pointerMove`, `pointerUp` and `contextMenu`, passing `{ pointerType,
  clientX, clientY }`. The hook treats a missing `pointerType` as "mouse". If jsdom drops
  `pointerType` from the init dict, define a `PointerEvent` subclass of `MouseEvent` in the test
  file.
- **Timers:** `vi.useFakeTimers()` with `vi.advanceTimersByTime(HOVER_DELAY_MS)` and
  `vi.advanceTimersByTime(LONG_PRESS_MS)`.
- **Storage:** stub `Storage.prototype.getItem` and `setItem` to throw.
- **Settings reset:** `writeCardSettings(CARD_SETTINGS_DEFAULTS)` in `afterEach`.
- **Pure modules** (`art/*`, `model.ts`, `rules.ts`, `fit.ts` tiers, `placement.ts`, `filters.ts`)
  are tested without rendering.

**Cypress component specs (new).** Each spec mounts real client components in Chrome through the
existing component runner (`e2e/cypress.config.ts` → `component`). Run one with
`E2E_COMPONENT_PORT=5286 pnpm --dir e2e test:component -- --spec cypress/component/<file>` and
typecheck it with `pnpm --dir e2e typecheck:component`.

- The specs import the catalog as `CATALOG` from `../../../packages/cards/src/catalog-data.ts`.
  That is the package's one reader of `catalog.json`; `e2e/` cannot resolve `@jackioh/cards`. They
  import client code from `../../../apps/web/src/...`, as `board-layout.cy.tsx` does.
- Selectors come from `e2e/support/testids.ts` (block A14), or are the CSS classes fixed under
  Surface.
- Fit is measured as `scrollHeight <= clientHeight + 1 && scrollWidth <= clientWidth + 1` inside
  `.should()`, so it retries while `useFitText` settles.

**Files and behaviours**

| Behaviours | File | Kind |
| --- | --- | --- |
| B1–B5 | `apps/web/src/cards/art/art.test.ts` | vitest, pure |
| B6 | `apps/web/src/cards/art/CardArt.test.tsx` | vitest, jsdom, `manifest` prop injected |
| B7–B9 | `apps/web/src/cards/model.test.ts` | vitest, pure, real `CATALOG` |
| B10–B11 | `apps/web/src/cards/rules.test.ts` | vitest, pure (+ one `RulesText` render) |
| B8, B12–B15 (jsdom half) | `apps/web/src/cards/CardFace.test.tsx` | vitest, jsdom |
| B16–B20 | `apps/web/src/game/Card.test.tsx` | vitest, jsdom, `fullBoardView()` with and without a catalog |
| B15 (pixel half), B21 | `e2e/cypress/component/card-faces.cy.tsx` | Cypress component: every catalog card, both faces, at 270 px and 170 px; the full board with the real catalog at 1280×720 and 390×844 |
| B22–B25 | `apps/web/src/cards/inspect/inspect.test.tsx` | vitest, jsdom, fake timers, via `Board` and a bare trigger |
| B26 | `apps/web/src/cards/inspect/inspect.test.tsx` | vitest, jsdom |
| B27 | `apps/web/src/cards/inspect/placement.test.ts` | vitest, pure |
| B28 | `apps/web/src/cards/settings.test.ts` | vitest, jsdom |
| B29 | `apps/web/src/cards/inspect/CardDetail.test.tsx` | vitest, jsdom, real `CATALOG` |
| B31–B36 (pure half) | `apps/web/src/game/deckbuilder/filters.test.ts` | vitest, pure, inline varied catalog |
| B30–B38 | `apps/web/src/game/deckbuilder/browse.test.tsx` | vitest, jsdom, `Deckbuilder` with deckbuilder fixtures and the inline catalog |
| B39 | `e2e/cypress/component/deckbuilder-layout.cy.tsx` | Cypress component: `Deckbuilder` with the real catalog, a collection owning every non-token card, at 390×844 and 1280×720 |
| B40 | `apps/web/src/cards/art/art.test.ts` | vitest, pure |
| B41 | `apps/web/src/game/deckbuilder/browse.test.tsx` | vitest, jsdom, fake timers |
| B42 | `apps/web/src/game/PromptCards.test.tsx`, `e2e/cypress/component/card-faces.cy.tsx` | vitest, jsdom; Cypress component |

**Existing suites that must stay green, unedited:**

- `Board.test.tsx`. Its snapshot is regenerated once with `-u` by slice B's reconcile; the `.snap`
  is the only file that changes.
- `animation-targets.test.tsx`, `animations.test.ts`, `Prompt.test.tsx`, `Game`-level tests.
- `loadout.test.ts`, `messages.test.ts`. `Deckbuilder.test.tsx` (two tests) and
  `routes/decks.test.tsx` (one) changed on purpose when a click on a pool card began opening the
  detail view (B38): they add with the "+" or the detail's Add, and the PR flags it.
- The component spec `board-layout.cy.tsx`.
- The e2e specs that read card attributes: 01–04, 09 (networked; needs the server on 8786), 11
  and 12.

## Out of scope

- Real card art. The manifest ships empty; artists drop `apps/web/public/art/<id>.webp` and
  `<id>-radiant.webp` files in later and list them in `manifest.ts`.
- The hand fan, tap-to-lift, drag to play, highlight colours and touch-target sizing (task 7), and
  anything else in `Board.tsx`, `Zone.tsx`, `Hand.tsx`, `Backrow.tsx`, `board.css`, `prompt.css`
  or `Game.tsx`.
- Event-driven effects: summon slam, the Radiant shimmer burst on `radiantSet`, death dissolve,
  Divine Shield shatter (task 1). This task draws the resting look only.
- The settings panel UI. Task 7 mounts `CARD_SETTINGS_FIELDS` at integration.
- Sounds on hover or inspect (task 2).
- Keyboard-driven inspect on the board. In the deck builder a pool card opens its detail on
  Enter or Space, and a deck tile on I, the context-menu key or Shift+F10.
- Persisting deck-builder filters or sort, deck codes, multiple loadouts, crafting, flavour text
  and artist credits.
- Changing SPEC §10.8's catalog finding. The client still loads the catalog beside the view, as
  `catalog.ts` documents.

## Slices

Every file below belongs to exactly one slice. Test files belong to the testers, and no slice
creates or edits a `*.test.ts(x)` or `*.cy.tsx`, except that slice B regenerates the Board
snapshot. Slice builders code against the Surface above, not against each other's files.

### Slice A: art

- **Owns:** `apps/web/src/cards/art/` (`index.ts`, `hash.ts`, `themes.ts`, `emblems.ts`,
  `procedural.ts`, `svg.ts`, `manifest.ts`, `CardArt.tsx`, `art.css`), excluding tests.
- **Behaviours:** B1–B6.
- **Shared edits:** none.

### Slice B: faces and `Card.tsx`

- **Owns:** `apps/web/src/cards/index.ts`, `model.ts`, `glossary.ts`, `rules.ts`, `fit.ts`,
  `constants.ts`, `icons.tsx`, `RulesText.tsx`, `CardFace.tsx`, `MinionFace.tsx`, `CardBack.tsx`,
  `cards.css`; `apps/web/src/game/Card.tsx`; and `apps/web/src/game/__snapshots__/Board.test.tsx.snap`
  (regenerated with `vitest -u` only).
- **Behaviours:** B7–B21.
- **Minimal additive edits:**
  - `apps/web/src/game/catalog.ts`: add `def?: CardDef` to `CardInfo`, and `def` in
    `lookupFromDefs`'s return.
  - `apps/web/README.md`: one `cards/` line in the Layout block.

### Slice C: inspect and settings

- **Owns:** `apps/web/src/cards/inspect/` (`index.ts`, `constants.ts`, `testids.ts`, `store.ts`,
  `useInspectTrigger.tsx`, `placement.ts`, `HoverPreview.tsx`, `InspectSheet.tsx`,
  `CardDetail.tsx`, `Glossary.tsx`, `inspect.css`), excluding tests; and
  `apps/web/src/cards/settings.ts`.
- **Behaviours:** B22–B29.
- **Shared edits:** none.

### Slice D: deck builder

- **Owns:** `apps/web/src/game/deckbuilder/Deckbuilder.tsx`, `deckbuilder.css`, `testids.ts`,
  `loadout.ts`, `deckSize.ts`, `fixtures.ts` (the last three are unchanged unless a new export is
  needed, and existing exports are never changed); the new `filters.ts`, `FilterBar.tsx`,
  `PoolGrid.tsx`, `DeckSidebar.tsx` and `ManaCurve.tsx`; and `apps/web/src/routes/decks.tsx` (no
  change expected).
- **Behaviours:** B30–B39.
- **Minimal additive edit:** `e2e/support/testids.ts`, the new A14 block only.

### Testers

- **Tester 1 (art and faces):** B1–B21. Creates `apps/web/src/cards/art/art.test.ts`,
  `apps/web/src/cards/art/CardArt.test.tsx`, `apps/web/src/cards/model.test.ts`,
  `apps/web/src/cards/rules.test.ts`, `apps/web/src/cards/CardFace.test.tsx`,
  `apps/web/src/game/Card.test.tsx` and `e2e/cypress/component/card-faces.cy.tsx`.
- **Tester 2 (inspect and deck builder):** B22–B39. Creates
  `apps/web/src/cards/inspect/inspect.test.tsx`, `apps/web/src/cards/inspect/placement.test.ts`,
  `apps/web/src/cards/inspect/CardDetail.test.tsx`, `apps/web/src/cards/settings.test.ts`,
  `apps/web/src/game/deckbuilder/filters.test.ts`, `apps/web/src/game/deckbuilder/browse.test.tsx`
  and `e2e/cypress/component/deckbuilder-layout.cy.tsx`.

## SPEC changes

None. Every decision here is presentation: face layout, the Radiant face printing what §8's
reading rule makes of its cell (`radiantText.ts`), the glossary stating §6.2's Cry ruling, cost
buckets for the filter, and inspect gestures. None of them is a rule of the game, so R206–R208 stay unused. No §10.10 edit is needed,
since §10.10 is task 1's and this task adds no event animation.

## Risks

- **The Board snapshot conflicts with task 7.** Both tasks change the DOM that `Board.test.tsx`
  snapshots, and each regenerates `__snapshots__/Board.test.tsx.snap`. At integration, take either
  side and run `pnpm vitest run --project web apps/web/src/game/Board.test.tsx -u` once. Never
  merge the snapshot by hand.
- **Task 7 also edits the `Card.tsx` root.** Task 7 adds highlight or drag attributes, and perhaps
  pointer handlers, on the root. If both sides define the same `onPointer*` prop, merge them into
  one handler that calls both. `closeInspect()` is exported so a drag start can dismiss a preview.
- **Specificity against board.css.** cards.css resting-state root rules use `:not([data-legal=…])
  :not([data-selected=…]):not(.radiant)`, so the highlight rules win whatever order the CSS loads
  in. If task 7 styles a new highlight attribute through `border-color` rather than
  `box-shadow`/`outline`, add that attribute to the `:not()` list at integration.
- **Container units and `aspect-ratio`.** These need Chrome 105+, Safari 16+ or Firefox 110+. The
  Cypress Chrome and Electron runners qualify; older browsers get unscaled but unclipped text. The
  component specs are the only proof of fit and overflow, because jsdom has no layout.
- **The longest rules texts** (core-093, core-095, core-098 at 341–400 characters, and core-051's
  radiant face at 269) shrink to about 6 px at grid size. B15 allows them to clamp at 170 px wide.
  The detail view (both faces at about 260 px) and the hover preview (380 px tall) must show them
  in full. If they don't, raise `PREVIEW_HEIGHT_PX` rather than lowering `FIT_MIN`.
- **An intrinsic width of zero.** An element with size containment, or only absolutely positioned
  children, reports zero intrinsic width, which would collapse the resolving card inside its
  `inline-flex` strip. That is why `.cf` stays in normal flow with `aspect-ratio`, and only
  `.cf-scale` carries `container-type: size`.
- **Hover previews in e2e.** Cypress `.click()` fires `pointerover` before `pointerdown`. The
  pointerdown cancels the hover timer, and the preview has `pointer-events: none` anyway, so it can
  never cover an element Cypress clicks.
- **Prefix collisions.** `cy.fieldCardByName` and `cy.handCardByName` select
  `[data-testid^="card-"]` and `[data-testid^="hand-card-"]` and then call `.contains(name)`. A new
  testid with either prefix, such as a `card-preview`, would hijack them. All new ids start with
  `inspect-`, `db-` or `deck-curve-` (B20). A pre-existing risk remains: another hand card's rules
  text can name a card (#3's radiant Death). Minions no longer print rules text, which reduces it.
- **Long-press against task 7's touch drag.** A move past 10 px cancels the long-press, and task 7
  starts drags on movement. Swallowing the click after a long-press stops a sheet opening from also
  playing the card. The suppressor disarms after 600 ms, so it cannot eat an unrelated later click.
- **Portal events bubbling through the React tree.** Overlay roots stop propagation (B25).
  Rendering the overlay as a sibling of the card root also keeps the root's own `onClickCapture`
  from seeing clicks inside the overlay.
- **Spec 09 against the new layout.** Its drags click the deck tab before dropping, so the
  `hidden` inactive panels are visible by the time they are hit. The default filter shows every
  owned card, and the e2e account owns every card (R111). There is no sticky chrome on `/decks`
  that could cover a target.
- **`messages.test.ts`** greps every client source for the validator's sentence fragments. New
  code must never spell an L1–L6 sentence. The detail view's "In Deck N" and the tile labels are
  not validator prose.
- **A click in the pool opens the detail view** (see Research), as the brief says, where
  Hearthstone's click adds. Adding stays one gesture (the "+", or a drag). If the user prefers
  click-to-add, only `PoolGrid.tsx`'s click wiring and the three click tests change back.
- **Task 7 places the same minion badges** (merge note). Both branches move the switch button to
  the top-right corner at 2px (cards.css `.card.cf-host--minion > .switch-button`, task 7's
  `.board .switch-button`), so they agree. Both also move the counters and a Stack's buried badge
  (task 7's `.zone .card-unit .counter`, same specificity as cards.css's rule, so load order
  decides). At integration pick one placement deliberately and rerun `card-faces.cy.tsx`'s B21,
  which fails if any badge covers a cost gem or a name.
- **Hand cards print no rules text at board size** (merge note). A face under
  `FACE_TEXT_MIN_HEIGHT_PX` (150 px) hides `.card-text`, and the board's `--card-h` tops out at
  112 px, so in play the text is read from the 300 ms hover preview or the long-press sheet. Task
  7's hand fan and tap-to-lift can raise a lifted or hovered hand card past 150 px; the text then
  shows with no change here.
- **`Prompt.tsx` is task 7's file** (merge note). Its `CardOption` body now draws a `CardFace`
  plus the inspect trigger (a minimal edit, flagged in the PR), and cards.css's
  `.app-shell .prompt-card:has(> .cf-option)` only drops index.css's button padding so the face
  fills the box. If task 7's bottom-sheet pickers resize `.prompt-card`, the face follows it.
