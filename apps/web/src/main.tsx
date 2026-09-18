// Entry point. The client is a `PlayerView` renderer (CLAUDE.md rule 7, SPEC §10.8): this file
// picks a route and gets out of the way. Routing is a pathname switch rather than a router
// dependency — M5 ships one real route, the dev hotseat (BUILD M5-T3).

import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";

const HotseatRoute = lazy(() => import("./routes/dev/hotseat.tsx"));

const DEV_ONLY = import.meta.env.MODE !== "production";

function Landing() {
  return (
    <div className="app-shell">
      <h1>JackiOh</h1>
      <p className="notice">
        M5 ships the hotseat client only. Open{" "}
        <code>/dev/hotseat?seed=42&amp;a=first20&amp;b=first20</code> to play both seats on one
        device. The matchmaking and room-code screens arrive with M6.
      </p>
    </div>
  );
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="app-shell">
      <h1>JackiOh</h1>
      <p className="notice">
        No route for <code>{path}</code>.
      </p>
    </div>
  );
}

function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return <Landing />;
  if (path === "/dev/hotseat") {
    if (!DEV_ONLY) return <NotFound path={path} />;
    return (
      <Suspense fallback={<div className="app-shell">Loading…</div>}>
        <HotseatRoute />
      </Suspense>
    );
  }
  return <NotFound path={path} />;
}

const host = document.getElementById("root");
if (host === null) throw new Error("index.html is missing #root");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
