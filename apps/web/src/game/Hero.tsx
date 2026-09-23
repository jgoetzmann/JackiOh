// A hero: health, armor and the Heroic Power (SPEC §3, BUILD M5-T1).
//
// The hero is a click target like any card — `hero-<side>` — so an attack can land on it, by a
// click or by a pointer drag the DragLayer resolves through the same testid. Whether it may be
// attacked is `props.highlight.legal`, and whether it glows green is `props.highlight.glow`;
// Taunt lives in the engine.
//
// The modifier badges (BUILD M5-T4 `modifierChanged`: "badge list equals the view's modifiers")
// come from `SideView.modifiers`, which R169 put in the view — `{ id, label }` per §10.1 modifier,
// on both seats. The list is rendered here and nowhere else, so `modifiers-<side>` (the testid the
// M5-T4 animation table resolves `modifierChanged` to) has exactly one element per seat. The
// container is rendered even when the list is empty, because the fade the table plays on it is
// the animation for the modifier that has just *left*.
//
// Nothing is derived here: the label is the view's, the order is the view's, and a modifier the
// view does not carry is not drawn. Reconstructing badges from the event window would be a guess —
// it is the last N events (§10.8), so a badge could appear and never leave.
//
// SECOND FINDING, on `HeroView.powers`: the view now carries every Heroic Power a player
// controls, each separately once-per-turn (R43), and each one's `instanceId`. `contract.ts` has
// one `testid.power` and `BoardControl = "power"` carries no instance id, so only `power`
// (`powers[0]`) is clickable; the rest are drawn as tags. Addressing the second power needs a
// target that names it, e.g. `{ on: "power"; instanceId }` on `ClickTarget`.

import type { ReactElement } from "react";

import { animTestid } from "./animations.ts";
import { cx, isLegal, isSelected, legalAttr, PopLayer, type Pops } from "./Card.tsx";
import {
  sideView,
  testid,
  type AnimatingMap,
  type BoardControl,
  type ClickTarget,
  type Highlight,
  type Side,
} from "./contract.ts";
import { glowAttr } from "./glow.ts";
import type { PlayerView } from "@jackioh/shared";

export type HeroProps = {
  view: PlayerView;
  side: Side;
  highlight?: Highlight;
  animating?: AnimatingMap;
  onClick?: (target: ClickTarget) => void;
  onControl?: (control: BoardControl) => void;
  pops?: Pops;
};

export default function Hero(props: HeroProps): ReactElement {
  const { view, side } = props;
  const seat = sideView(view, side);
  const hero = seat.hero;

  const testId = testid.hero(side);
  const legal = isLegal(props.highlight, testId);
  const selected = isSelected(props.highlight, testId);
  const target: ClickTarget = { on: "hero", side };

  const powerLegal = isLegal(props.highlight, testid.power);

  const modifiersId = animTestid.modifiers(side);
  const modifiers = seat.modifiers ?? [];

  return (
    <div
      className={cx("hero", `hero-${side}`)}
      data-testid={testId}
      data-side={side}
      data-legal={legalAttr(legal)}
      data-selected={selected ? "true" : undefined}
      data-animating={props.animating?.get(testId)}
      data-glow={glowAttr(props.highlight, testId)}
      aria-disabled={legal ? undefined : "true"}
      aria-label={side === "you" ? "Your hero" : "Opponent hero"}
      tabIndex={legal ? 0 : undefined}
      onClick={() => {
        if (!legal) return;
        props.onClick?.(target);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (!legal) return;
        props.onClick?.(target);
      }}
    >
      <span className="hero-seat">{side === "you" ? "You" : "Opponent"}</span>
      <span className="hero-health" data-health={hero.health} title="Health">
        {hero.health}
      </span>
      {hero.armor > 0 && (
        <span className="hero-armor" data-armor={hero.armor} title="Hero armor">
          {hero.armor}
        </span>
      )}

      {hero.power !== null &&
        (side === "you" ? (
          // The one `power` testid in the DOM. `usedThisTurn` is drawn, not obeyed: the engine
          // decides through `legalActions`, which is what `props.highlight` carries.
          <button
            type="button"
            className="power-button"
            data-testid={testid.power}
            data-instance-id={hero.power.instanceId}
            data-legal={legalAttr(powerLegal)}
            data-selected={isSelected(props.highlight, testid.power) ? "true" : undefined}
            data-animating={props.animating?.get(testid.power)}
            data-glow={glowAttr(props.highlight, testid.power)}
            data-used={hero.power.usedThisTurn ? "true" : "false"}
            data-x={hero.power.x}
            aria-disabled={powerLegal ? undefined : "true"}
            disabled={!powerLegal}
            title={`${hero.power.name} (X ${hero.power.x})`}
            onClick={(event) => {
              event.stopPropagation();
              if (!powerLegal) return;
              props.onControl?.("power");
            }}
          >
            {hero.power.name}
            <span className="power-x">{hero.power.x}</span>
          </button>
        ) : (
          <span className="power-tag" data-used={hero.power.usedThisTurn ? "true" : "false"} data-x={hero.power.x}>
            {hero.power.name}
            <span className="power-x">{hero.power.x}</span>
          </span>
        ))}

      {/* Any further power this player controls (R43). Drawn, not clickable: see the note above. */}
      {(hero.powers ?? [])
        .filter((power) => power.instanceId !== hero.power?.instanceId)
        .map((power) => (
          <span
            key={power.instanceId}
            className="power-tag power-extra"
            data-instance-id={power.instanceId}
            data-used={power.usedThisTurn ? "true" : "false"}
            data-x={power.x}
          >
            {power.name}
            <span className="power-x">{power.x}</span>
          </span>
        ))}

      {/* R169: one badge per `SideView.modifiers` entry, in the view's order. Always present, so
          `modifierChanged` has an element to fade even when the badge that changed is the one that
          has just gone. */}
      <span
        className="modifiers"
        data-testid={modifiersId}
        data-count={modifiers.length}
        data-animating={props.animating?.get(modifiersId)}
        aria-label={side === "you" ? "Your modifiers" : "Opponent modifiers"}
      >
        {modifiers.map((modifier) => (
          <span
            key={modifier.id}
            className="modifier-badge"
            data-modifier-id={modifier.id}
            title={modifier.label}
          >
            {modifier.label}
          </span>
        ))}
      </span>

      <PopLayer pops={props.pops} />
    </div>
  );
}
