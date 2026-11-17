/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

// Theme: light by default; "dark" or "system" are explicit choices (Settings).
document.documentElement.dataset.theme = localStorage.getItem("corral-theme") ?? "light";

// Offline mode: cache the shell and last-known API responses. Production only —
// the worker would fight Vite's HMR in dev.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is a progressive enhancement */
    });
  });
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <ErrorBoundary>
    <StrictMode>
      <App />
    </StrictMode>
  </ErrorBoundary>,
);
