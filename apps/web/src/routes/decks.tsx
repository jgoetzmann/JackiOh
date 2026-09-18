// `/decks` — the loadout editor (BUILD M6-T3, SPEC §9.4 L1–L6).
//
// PLACEHOLDER. The real screen is owned by the deckbuilder task; this file exists so `main.tsx`
// can route to it and typecheck. Replace the whole body, keep the default export's name.

export default function DecksRoute() {
  return (
    <div className="app-shell">
      <h1>JackiOh — decks</h1>
      <p className="notice">The loadout editor is not built yet.</p>
    </div>
  );
}
