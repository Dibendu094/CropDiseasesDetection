import { screen } from "@testing-library/react";
import { Link, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { renderWithRouter } from "./harness";
import { setMatchingQueries, setReducedMotion, setViewportWidth } from "./setup";

function TestRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <div>
            <h1>Home</h1>
            <Link to="/history">History</Link>
          </div>
        }
      />
      <Route path="/history" element={<h1>History</h1>} />
      <Route path="*" element={<h1>Not found</h1>} />
    </Routes>
  );
}

describe("renderWithRouter", () => {
  it("renders the route matching the requested initial path", () => {
    const { currentPath } = renderWithRouter(<TestRoutes />, { route: "/history" });

    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
    expect(currentPath()).toBe("/history");
  });

  it("falls through to the catch-all route for an unknown path", () => {
    renderWithRouter(<TestRoutes />, { route: "/nope/deeper" });

    expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
  });

  it("tracks client-side navigation", async () => {
    const { user, currentPath } = renderWithRouter(<TestRoutes />);
    expect(currentPath()).toBe("/");

    await user.click(screen.getByRole("link", { name: "History" }));

    expect(currentPath()).toBe("/history");
    expect(screen.getByRole("heading", { name: "History" })).toBeInTheDocument();
  });
});

describe("matchMedia stub", () => {
  it("answers width queries from the configured viewport and notifies listeners", () => {
    const list = window.matchMedia("(min-width: 768px)");
    const onChange = vi.fn();
    list.addEventListener("change", onChange);

    expect(list.matches).toBe(true);

    setViewportWidth(400);

    expect(list.matches).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("answers prefers-reduced-motion from the configured preference", () => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);

    setReducedMotion(true);

    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    expect(window.matchMedia("(prefers-reduced-motion: no-preference)").matches).toBe(false);
  });

  it("resets between tests", () => {
    // The previous test set a 400 px viewport and reduced motion; both are gone.
    expect(window.matchMedia("(min-width: 768px)").matches).toBe(true);
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
  });

  it("lets a test override arbitrary queries", () => {
    setMatchingQueries({ "(orientation: portrait)": true });

    expect(window.matchMedia("(orientation: portrait)").matches).toBe(true);
    // Unlisted queries still fall back to the built-in evaluation.
    expect(window.matchMedia("(min-width: 768px)").matches).toBe(true);
    expect(window.matchMedia("(orientation: landscape)").matches).toBe(false);
  });
});
