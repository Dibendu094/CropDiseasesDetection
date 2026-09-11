import { render, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { renderWithRouter } from "../../test/harness";
import { Footer, FOOTER_ADVISORY } from "./Footer";
import { Layout } from "./Layout";

describe("Layout", () => {
  it("is a full-height white flex column", () => {
    const { container } = renderWithRouter(<Layout>page</Layout>);
    const shell = container.firstElementChild;

    expect(shell).not.toBeNull();
    expect(shell).toHaveClass("min-h-screen", "flex", "flex-col", "bg-white");
  });

  it("renders the routed page through the outlet on every route (Req 1.1)", () => {
    for (const path of ["/", "/diagnosis", "/history"] as const) {
      const { unmount } = renderWithRouter(
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<h1>Home</h1>} />
            <Route path="/diagnosis" element={<h1>Diagnosis</h1>} />
            <Route path="/history" element={<h1>History</h1>} />
          </Route>
        </Routes>,
        { route: path },
      );

      expect(screen.getByRole("main")).toBeInTheDocument();
      expect(screen.getByRole("heading")).toBeInTheDocument();
      expect(screen.getByRole("contentinfo")).toHaveTextContent(FOOTER_ADVISORY);

      unmount();
    }
  });

  it("places the navigation slot above the page content and the footer below it", () => {
    renderWithRouter(<Layout nav={<nav aria-label="Main">links</nav>}>page</Layout>);

    const nav = screen.getByRole("navigation", { name: "Main" });
    const main = screen.getByRole("main");
    const footer = screen.getByRole("contentinfo");

    // DOCUMENT_POSITION_FOLLOWING === 4: the argument comes after the node in document order.
    expect(nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Footer", () => {
  it("carries the advisory line", () => {
    render(<Footer />);

    expect(screen.getByRole("contentinfo")).toHaveTextContent(FOOTER_ADVISORY);
    expect(FOOTER_ADVISORY).toMatch(/local agricultural expert/i);
  });

  it("carries no imagery of any kind (Req 1.6)", () => {
    const { container } = render(<Footer />);

    expect(container.querySelectorAll("img, svg, picture, canvas, video")).toHaveLength(0);
  });
});
