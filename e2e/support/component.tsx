// Loaded before every COMPONENT spec (cypress.config.ts -> component.supportFile).
//
// The e2e support file (support/e2e.ts) is not loaded here and must not be: it overwrites
// `cy.wait`, registers `cy.seedGame` and friends against `window.__jackioh`, and calls a Node task
// that only the e2e runner registers. A component spec drives no server and no hotseat route — it
// mounts a component with a fixture `PlayerView` and measures what the browser lays out.
//
// The only global state this file sets up is the pair the real client boots with:
//
//   - `cy.mount`, the React adapter Cypress ships (`cypress/react`, React 19);
//   - `apps/web/src/index.css`, which `apps/web/src/main.tsx` imports as the app's only global
//     stylesheet. It carries the design tokens board.css reads (`--card-w`, `--gap`, …), the
//     `* { box-sizing: border-box }` reset the board's geometry depends on, and `body { margin: 0 }`.
//     Without it the board would be measured against browser defaults — an 8px body margin and no
//     tokens — which is not the layout any user ever sees.
//
// Nothing else is imported. In particular there is no catalog provider: `CatalogContext` defaults
// to null and `useCardInfo` falls back to the def id, exactly as the client does before
// `GET /api/catalog` answers (routes/match.tsx). A card's face is then its def id, which is the
// SHORTEST name a card can render — see the note in cypress/component/board-layout.cy.tsx.

import { mount } from "cypress/react";

import "../../apps/web/src/index.css";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- the shape Cypress documents.
  namespace Cypress {
    interface Chainable {
      /** Mount a React element into `[data-cy-root]` (support/component-index.html). */
      mount: typeof mount;
    }
  }
}

Cypress.Commands.add("mount", mount);

// An uncaught error in the component is a spec failure; nothing here swallows it. (The default
// behaviour — this line only makes the intent explicit, as support/e2e.ts does for the e2e run.)
Cypress.on("uncaught:exception", () => true);
