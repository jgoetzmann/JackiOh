// The card pool as a grid of full cards (docs/polish/6-cards.md, Surface D).
//
// Every pool entry is a `div.db-item` holding two buttons:
//   - `card-pool-<id>`, the card itself. Its testid, `data-card`, `data-legal`, `data-in-deck`,
//     `data-refused`, `aria-disabled` and `draggable` are exactly what they were, so spec 09's drags
//     read it unchanged. It draws the base face as a `CardFace`, says whether the profile owns the
//     card (`data-owned`) and badges the deck that holds it (`.db-held`).
//   - `db-add-<id>`, the "+" that puts the card in the open deck in one tap.
//
// A click on the card opens its detail view, as the brief asks ("in the deck builder, a click opens
// a detail view with both faces side by side and a glossary"), and the detail's "Add to Deck N"
// adds it. So does a right-click, or a touch long-press, which is why the inspect trigger here
// runs with `hover: false` and hands both gestures to `onInspect`. Adding takes one gesture still:
// the "+", or a drag onto a deck.
//
// The card's accessible name is the card, not just its name: cost, type, rarity, the deck that
// holds it, and what a click does. The face inside is decoration to a screen reader (it repeats
// the name), and the detail view reads the rules out in full.

import { useMemo, type DragEvent, type ReactElement } from "react";

import type { CardCost, CardDef } from "@jackioh/shared";
import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import { CardFace, faceModel, useInspectTrigger } from "../../cards/index.ts";
import { deckHolding, type Draft } from "./loadout.ts";
import { CARD_POOL, addPoolId, poolCardId } from "./testids.ts";

type PoolGridProps = {
  /** The visible pool, already filtered and sorted (`visiblePool`). */
  ids: readonly string[];
  /** The deck the "+" adds to, for its label. */
  activeDeck: number;
  catalog: CatalogSnapshot;
  /** Null when the collection could not be read: then nothing claims to be owned or unowned. */
  collection: Collection | null;
  draft: Draft;
  refusedCardId: string | null;
  onAdd: (cardId: string) => void;
  onInspect: (cardId: string) => void;
  onDragStart: (cardId: string, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

type PoolItemProps = {
  cardId: string;
  def: CardDef;
  activeDeck: number;
  heldBy: number | null;
  /** True or false when the collection is known, null when it is not. */
  owned: boolean | null;
  refused: boolean;
  onAdd: (cardId: string) => void;
  onInspect: (cardId: string) => void;
  onDragStart: (cardId: string, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

/** "2 mana", "X mana", "2 or 4 mana" (embiggen). */
function costWords(cost: CardCost): string {
  if (typeof cost === "number") return `${String(cost)} mana`;
  if (cost === "X") return "X mana";
  return `${String(cost.base)} or ${String(cost.embiggen)} mana`;
}

/** The pool card's accessible name: "Bigot, 2 mana Unit, Common, in Deck 1. Show details". */
export function poolCardLabel(def: CardDef, heldBy: number | null, owned: boolean | null): string {
  const parts = [def.name, `${costWords(def.cost)} ${def.type}`, def.rarity];
  if (heldBy !== null) parts.push(`in Deck ${String(heldBy)}`);
  if (owned === false) parts.push("not in your collection");
  return `${parts.join(", ")}. Show details`;
}

function PoolItem(props: PoolItemProps): ReactElement {
  const { cardId, def, activeDeck, heldBy, owned, refused, onAdd, onInspect, onDragStart, onDragEnd } = props;

  const face = useMemo(() => faceModel({ defId: cardId, def, radiant: false }), [cardId, def]);
  const inspect = useInspectTrigger(
    { key: poolCardId(cardId), face },
    {
      hover: false,
      onLongPress: () => {
        onInspect(cardId);
      },
      onContextMenu: () => {
        onInspect(cardId);
      },
    },
  );

  return (
    <div className="db-item" data-card={cardId}>
      <button
        type="button"
        className="db-card"
        data-testid={poolCardId(cardId)}
        data-card={cardId}
        // `e2e/support/testids.ts` already exports this as ILLEGAL (M5-T2's vocabulary): a card the
        // builder will not put in the open deck, because one is already held.
        data-legal={heldBy === null ? "true" : "false"}
        data-in-deck={heldBy === null ? undefined : String(heldBy)}
        data-refused={refused ? "true" : undefined}
        data-owned={owned === null ? undefined : owned ? "true" : "false"}
        data-rarity={def.rarity}
        aria-disabled={heldBy !== null}
        aria-label={poolCardLabel(def, heldBy, owned)}
        draggable
        onDragStart={(event) => {
          onDragStart(cardId, event);
        }}
        onDragEnd={onDragEnd}
        onClick={() => {
          onInspect(cardId);
        }}
        {...inspect.handlers}
      >
        <span className="db-card-face" aria-hidden="true">
          <CardFace face={face} layout="full" />
        </span>
        {heldBy === null ? null : (
          <span className="db-held" aria-hidden="true">{`Deck ${String(heldBy)}`}</span>
        )}
      </button>
      <button
        type="button"
        className="db-add"
        data-testid={addPoolId(cardId)}
        // Held by a deck: the same refusal a drag gets (L4), so it still reports, but says it is off.
        aria-disabled={heldBy !== null}
        aria-label={`Add ${def.name} to Deck ${String(activeDeck)}`}
        title={`Add to Deck ${String(activeDeck)}`}
        onClick={() => {
          onAdd(cardId);
        }}
      >
        <span aria-hidden="true">+</span>
      </button>
      {inspect.overlay}
    </div>
  );
}

export default function PoolGrid(props: PoolGridProps): ReactElement {
  const { ids, activeDeck, catalog, collection, draft, refusedCardId, onAdd, onInspect, onDragStart, onDragEnd } = props;

  return (
    <section className="db-pool" aria-label="Card pool" data-testid={CARD_POOL}>
      {ids.map((cardId) => {
        const def = catalog.cards[cardId];
        if (def === undefined) return null;
        return (
          <PoolItem
            key={cardId}
            cardId={cardId}
            def={def}
            activeDeck={activeDeck}
            heldBy={deckHolding(draft, cardId)}
            owned={collection === null ? null : (collection[cardId] ?? 0) > 0}
            refused={refusedCardId === cardId}
            onAdd={onAdd}
            onInspect={onInspect}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        );
      })}
    </section>
  );
}
