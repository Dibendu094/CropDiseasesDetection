import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error('Mount point "#root" is missing from index.html.');
}

// `App` owns the router and the layout shell; this file only mounts it.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
