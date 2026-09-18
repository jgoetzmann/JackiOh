// `/invite` — the code screen a pending account sees (SPEC §9.4, BUILD M6-T1).
//
// PLACEHOLDER. The real screen is owned by the deckbuilder/code-screen task; this file exists so
// `main.tsx` can route to it and typecheck. Replace the whole body, keep the default export.

export default function InviteRoute() {
  return (
    <div className="app-shell">
      <h1>JackiOh — invite code</h1>
      <p className="notice">The code screen is not built yet.</p>
    </div>
  );
}
