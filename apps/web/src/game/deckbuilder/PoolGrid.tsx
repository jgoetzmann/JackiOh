// The card pool as a grid of full cards (docs/polish/6-cards.md, Surface D).
//
// Every pool entry is a `div.db-item` holding two buttons:
//   - `card-pool-<id>`, the card itself: `data-card`, `data-legal` ("false" when the open deck will
//     not take it), `data-in-deck="true"` when the open deck holds it, `data-unavailable="true"` and
//     `data-held-by="<deck name>"` when a deck it is being compared with holds it (R251: a card is
//     its catalog id, so one copy per trio), `data-refused`, `data-owned`, `aria-disabled` and
//     `draggable`. It draws the base face as a `CardFace` and badges where the card already is
//     (`.db-held`: "In deck", or "In <deck name>").
//   - `db-add-<id>`, the "+" that puts the card in the open deck in one tap.
//
// A click on the card opens its detail view, as the brief asks ("in the deck builder, a click opens
// a detail view with both faces side by side and a glossary"), and the detail's "Add to <deck>"
// adds it. So does a right-click, or a touch long-press, which is why the inspect trigger here
// runs with `hover: false` and hands both gestures to `onInspect`. Adding takes one gesture still:
// the "+", or a drag onto the deck.
//
// The card's accessible name is the card, not just its name: cost, type, rarity, the deck that
// holds it, and what a click does. The face inside is decoration to a screen reader (it repeats
// the name), and the detail view reads the rules out in full.

import { useMemo, type DragEvent, type ReactElement } from "react";

import type { CardCost, CardDef } from "@jackioh/shared";
import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import { CardFace, faceModel, useInspectTrigger } from "../../cards/index.ts";
import { CARD_POOL, addPoolId, poolCardId } from "./testids.ts";
import type { Holder } from "./workshop.ts";

/** Where a pool card already is: in the open deck, in a compared deck, or nowhere that matters. */
export type PoolPlace = "deck" | Holder | null;

type PoolGridProps = {
  /** The visible pool, already filtered and sorted (`visiblePool`). */
  ids: readonly string[];
  /** The open deck's name, for the "+" label. */
  deckName: string;
  catalog: CatalogSnapshot;
  /** Null when the collection could not be read: then nothing claims to be owned or unowned. */
  collection: Collection | null;
  /** The cards the open deck holds. */
  inDeck: ReadonlySet<string>;
  /** Card id → the compared deck that holds it (R251). */
  holders: ReadonlyMap<string, Holder>;
  refusedCardId: string | null;
  onAdd: (cardId: string) => void;
  onInspect: (cardId: string) => void;
  onDragStart: (cardId: string, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

type PoolItemProps = {
  cardId: string;
  def: CardDef;
  deckName: string;
  place: PoolPlace;
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

/** The badge on a card that is already somewhere: "In deck", or "In <compared deck>". */
export function placeWords(place: PoolPlace): string | null {
  if (place === null) return null;
  return place === "deck" ? "In deck" : `In ${place.name}`;
}

/** The pool card's accessible name: "Bigot, 2 mana Unit, Common, in Control, unavailable. Show details". */
export function poolCardLabel(def: CardDef, place: PoolPlace, owned: boolean | null): string {
  const parts = [def.name, `${costWords(def.cost)} ${def.type}`, def.rarity];
  if (place === "deck") parts.push("in this deck");
  else if (place !== null) parts.push(`in ${place.name}, unavailable`);
  if (owned === false) parts.push("not in your collection");
  return `${parts.join(", ")}. Show details`;
}

function PoolItem(props: PoolItemProps): ReactElement {
  const { cardId, def, deckName, place, owned, refused, onAdd, onInspect, onDragStart, onDragEnd } = props;
  const badge = placeWords(place);

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
        // builder will not put in the open deck, because it is there already or a compared deck
        // holds it.
        data-legal={place === null ? "true" : "false"}
        data-in-deck={place === "deck" ? "true" : undefined}
        data-unavailable={place !== null && place !== "deck" ? "true" : undefined}
        data-held-by={place !== null && place !== "deck" ? place.name : undefined}
        data-refused={refused ? "true" : undefined}
        data-owned={owned === null ? undefined : owned ? "true" : "false"}
        data-rarity={def.rarity}
        aria-disabled={place !== null}
        aria-label={poolCardLabel(def, place, owned)}
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
        {badge === null ? null : (
          <span className="db-held" data-place={place === "deck" ? "deck" : "other"} aria-hidden="true">
            {badge}
          </span>
        )}
      </button>
      <button
        type="button"
        className="db-add"
        data-testid={addPoolId(cardId)}
        // Already placed: the same refusal a drag gets, so it still reports why, but says it is off.
        aria-disabled={place !== null}
        aria-label={`Add ${def.name} to ${deckName}`}
        title={`Add to ${deckName}`}
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
  const { ids, deckName, catalog, collection, inDeck, holders, refusedCardId, onAdd, onInspect, onDragStart, onDragEnd } = props;

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
            deckName={deckName}
            place={inDeck.has(cardId) ? "deck" : (holders.get(cardId) ?? null)}
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
