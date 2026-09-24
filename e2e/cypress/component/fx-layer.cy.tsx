// Polish 1 (docs/polish/1-animations.md): the effects layer in a real browser. B28's real DPR,
// B35's board shake through `boardShakeSink`, and B40's browser half (the layer takes no click,
// the canvas really draws, the board still fits).
//
// Mounted the way board-layout.cy.tsx mounts the board, for the reasons its header gives: `Game`
// inside `.app-shell.app-shell--wide`, on `fullBoardView()`. Then rerendered with the same view plus
// three appended events, which `Game` hands to its runner as new (the first view's window was
// empty): an 8-damage spell hit on the enemy's 10/10 in lane 5, a summon into the viewer's lane 3,
// and the viewer's turn starting. The FX layer decorates all three with its production defaults:
// real `requestAnimationFrame`, `resolveAnchor`, `createSurface` and `boardShakeSink(document)`.
//
// Nothing here waits on a clock. The two checks that depend on an effect being on screen are
// taken in the page, on its own animation frames, by a watcher started before the events arrive
// (`watchFrames`); the board's inline `translate` while it shakes is recorded by a
// MutationObserver installed at the same moment. The spec then asserts on what they saw with
// retried `should`s.
//
// Why in the page and in that order. The splat is over the idle card for only
// FX_SPLAT_HOLD_MS (650 ms): it lands with the bolt at 0.55 of the 300 ms damage entry and the
// card's own `data-animating` clears at 300 ms. Reading the canvas (`getImageData`) is a
// synchronous GPU readback, and the first one after the canvas first draws is the expensive one
// (30 to 70 ms against about 3 ms for the rest, on a loaded machine). This spec once polled pixels
// first, and on a cold first test under heavy load the page froze for over a second right where
// those readbacks ran, before the splat was due. By the next frame the splat's whole life had
// passed, the director rightly skipped it (R200), and the splat check failed. So the watcher
// looks for the splat first, and reads pixels only after it has seen the splat. A readback
// returns the canvas as it was at the call, so even a slow one still sees the bolt's burst,
// which lives 320 to 700 ms from ~180 ms.
//
// Run: E2E_COMPONENT_PORT=5281 pnpm --dir e2e test:component --spec cypress/component/fx-layer.cy.tsx

import { FX_MAX_DPR } from "../../../apps/web/src/fx/constants.ts";
import Game from "../../../apps/web/src/game/Game.tsx";
import { fullBoardView, withEvents } from "../../../apps/web/src/test/fixtures.ts";

type PlayerView = ReturnType<typeof fullBoardView>;
type GameEvent = Parameters<typeof withEvents>[1][number];

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 720 },
  { label: "phone", width: 390, height: 844 },
] as const;

const BOARD = '[data-testid="board"]';
const LAYER = '[data-testid="fx-layer"]';
const CANVAS = '[data-testid="fx-canvas"]';
const FX_DOM = '[data-testid="fx-dom"]';
const SPLAT = '[data-fx="splat"]';

/** How far around the target card a lit pixel still counts as "near" it, in CSS px. */
const NEAR_PX = 48;

/** The burst, built from the fixture's own ids so a fixture change cannot leave it pointing at nothing. */
function burstFor(view: PlayerView): { events: GameEvent[]; targetId: string } {
  const target = view.opponent.units[4];
  if (target === null || target === undefined) throw new Error("fullBoardView() has no enemy unit in lane 5");
  if (target.health <= 8) throw new Error("the lane-5 enemy must survive 8 damage so its card stays on the board");
  const spell = Array.isArray(view.you.hand) ? view.you.hand[0] : undefined;
  if (spell === undefined) throw new Error("fullBoardView() has no card in the viewer's hand");
  return {
    targetId: target.instanceId,
    events: [
      // Non-combat, from a card in the viewer's hand: a spell projectile, then the impact.
      { type: "damage", sourceId: spell.instanceId, targetId: target.instanceId, amount: 8, combat: false },
      { type: "summoned", player: view.viewer, instanceId: "fx-summoned", defId: "core-019", row: "units", lane: 3 },
      { type: "turnStarted", player: view.viewer, turn: view.turn + 1 },
    ],
  };
}

/** True when any canvas pixel within `margin` CSS px of `box` has a non-zero alpha. */
function litNear(canvas: HTMLCanvasElement, box: DOMRect, margin: number): boolean {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return false;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const x0 = Math.max(0, Math.floor((box.left - margin - rect.left) * sx));
  const y0 = Math.max(0, Math.floor((box.top - margin - rect.top) * sy));
  const x1 = Math.min(canvas.width, Math.ceil((box.right + margin - rect.left) * sx));
  const y1 = Math.min(canvas.height, Math.ceil((box.bottom + margin - rect.top) * sy));
  if (x1 <= x0 || y1 <= y0) return false;
  const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 0) return true;
  }
  return false;
}

/** How long the frame watcher runs before it gives up, in ms of page time: far past every effect's tail. */
const WATCH_MS = 6_000;

/** What `watchFrames` saw. Every flag only ever turns true. */
type Seen = {
  /** A frame showed the splat while the damaged card's own motion was over. */
  splatOverIdleCard: boolean;
  /** …and on one such frame, `elementFromPoint` at the card's centre was inside the card and the document fitted. */
  clickLandsOnCard: boolean;
  /** After that, a canvas pixel within NEAR_PX of the card was lit. */
  litNearCard: boolean;
  /** What the last splat frame found at the card's centre, for the failure message. */
  lastHit: string;
};

function unseen(): Seen {
  return { splatOverIdleCard: false, clickLandsOnCard: false, litNearCard: false, lastHit: "" };
}

/**
 * Samples the page once per animation frame, writing into `seen`, until it has seen everything or
 * WATCH_MS pass. The pixel readback runs only once the splat has been seen: see the header for why.
 * Returns its own stop.
 */
function watchFrames(win: Window, card: string, seen: Seen): () => void {
  const doc = win.document;
  const start = win.performance.now();
  let handle = 0;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const target = doc.querySelector<HTMLElement>(card);
    if (target !== null && !seen.clickLandsOnCard) {
      const splat = doc.querySelector(`${FX_DOM} ${SPLAT}`);
      if (splat !== null && !target.hasAttribute("data-animating")) {
        seen.splatOverIdleCard = true;
        const box = target.getBoundingClientRect();
        const hit = doc.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        const fits = doc.documentElement.scrollWidth <= win.innerWidth;
        seen.lastHit = hit === null ? "nothing" : (hit.getAttribute("data-testid") ?? hit.getAttribute("class") ?? hit.tagName);
        if (hit !== null && target.contains(hit) && fits) seen.clickLandsOnCard = true;
      }
    }
    if (target !== null && seen.splatOverIdleCard && !seen.litNearCard) {
      const canvas = doc.querySelector<HTMLCanvasElement>(CANVAS);
      if (canvas !== null && litNear(canvas, target.getBoundingClientRect(), NEAR_PX)) seen.litNearCard = true;
    }
    const done = seen.clickLandsOnCard && seen.litNearCard;
    if (!done && win.performance.now() - start < WATCH_MS) handle = win.requestAnimationFrame(tick);
  };
  handle = win.requestAnimationFrame(tick);
  return () => {
    stopped = true;
    win.cancelAnimationFrame(handle);
  };
}

function expectNoHorizontalOverflow(doc: Document, where: string): void {
  const win = doc.defaultView;
  expect(win, "the document has a window").to.not.eq(null);
  if (win === null) return;
  expect(doc.documentElement.scrollWidth, `the document fits ${where}`).to.be.at.most(win.innerWidth);
}

describe("Polish 1: the effects layer over a real board", () => {
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${viewport.width}x${viewport.height}`;

    it(`B40 B35 B28: a spell hit lights the canvas, shakes the board, blocks no click and leaves nothing behind at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);

      const view = fullBoardView();
      const { events, targetId } = burstFor(view);
      const card = `[data-testid="card-${targetId}"]`;
      const noop = (): void => undefined;

      const record = { translate: [] as string[], rotate: [] as string[] };
      const prior = { translate: "", rotate: "" };
      let observer: MutationObserver | null = null;
      // Filled by the frame watcher; `cy.wrap(seen).should(…)` retries against it (an assertion
      // chained after `.then()` would run once and not retry).
      const seen = unseen();
      let stopWatching: (() => void) | null = null;

      cy.mount(
        <div className="app-shell app-shell--wide">
          <Game view={view} legal={[]} onAction={noop} />
        </div>,
      ).then(({ rerender }) => {
        // Before anything plays: the layer is on, holds its canvas, and the board fits.
        cy.get(LAYER).should("have.attr", "data-fx", "on");
        cy.get(CANVAS).should("exist");
        cy.get(FX_DOM).should("exist");
        cy.document().should((doc) => expectNoHorizontalOverflow(doc, where));

        cy.get(BOARD).then(($board) => {
          const board = $board[0] as HTMLElement;
          prior.translate = board.style.translate;
          prior.rotate = board.style.rotate;
          observer = new MutationObserver(() => {
            record.translate.push(board.style.translate);
            record.rotate.push(board.style.rotate);
          });
          observer.observe(board, { attributes: true, attributeFilter: ["style"] });
          const win = board.ownerDocument.defaultView;
          if (win === null) throw new Error("the board has no window");
          stopWatching = watchFrames(win, card, seen);
        });

        cy.then(() => rerender(
          <div className="app-shell app-shell--wide">
            <Game view={withEvents(view, events)} legal={[]} onAction={noop} />
          </div>,
        ));
      });

      // B40: while the splat is still over the card (and the card's own motion, which makes the
      // card itself pointer-transparent, is over), a click at the card's centre lands on the card.
      // Then the canvas really draws near the card the spell hit. Both are what the frame watcher saw.
      cy.wrap(seen).should((saw: Seen) => {
        expect(saw.splatOverIdleCard, "its damage splat is on screen after the card's own damage motion has finished").to.eq(true);
        expect(saw.clickLandsOnCard, `elementFromPoint at the card's centre is inside the card, and the board fits (last hit: ${saw.lastHit})`).to.eq(true);
        expect(saw.litNearCard, "a lit canvas pixel near the damaged card").to.eq(true);
      });

      // B28: the backing store is the CSS size times the clamped device pixel ratio.
      cy.window().then((win) => {
        const dpr = Math.min(Math.max(win.devicePixelRatio || 1, 1), FX_MAX_DPR);
        cy.get(CANVAS).should(($canvas) => {
          const canvas = $canvas[0] as HTMLCanvasElement;
          const rect = canvas.getBoundingClientRect();
          expect(rect.width, "the canvas has a CSS width").to.be.greaterThan(0);
          expect(canvas.width, "backing width = CSS width x DPR").to.be.closeTo(rect.width * dpr, 1);
          expect(canvas.height, "backing height = CSS height x DPR").to.be.closeTo(rect.height * dpr, 1);
        });
      });

      // The runner settles exactly as it would without effects.
      cy.get("[data-animating]").should("not.exist");

      // Every DOM effect is removed once its tail has run.
      cy.get(FX_DOM).should(($root) => {
        expect(($root[0] as HTMLElement).childElementCount, "fx-dom is empty").to.eq(0);
      });

      // B35: the shake reached the board as an inline translate, and the board's prior inline
      // values are back.
      cy.get(BOARD).should(($board) => {
        const board = $board[0] as HTMLElement;
        expect(
          record.translate.some((value) => value !== "" && value !== prior.translate),
          "the board carried an inline translate while it shook",
        ).to.eq(true);
        expect(board.style.translate, "translate restored").to.eq(prior.translate);
        expect(board.style.rotate, "rotate restored").to.eq(prior.rotate);
      });

      cy.document().should((doc) => expectNoHorizontalOverflow(doc, where));
      cy.then(() => {
        observer?.disconnect();
        stopWatching?.();
      });
    });
  }
});
