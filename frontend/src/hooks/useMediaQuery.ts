import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and re-render when it starts or stops matching.
 *
 * The `Navbar` needs this because the collapse at 768 px (Req 12.2) is a *rendering* decision, not
 * only a styling one: the three links exist either as an inline row or inside a collapsible panel,
 * never both, so "exactly three navigation links" (Req 1.2) and "exactly one active link" (Req 1.4)
 * stay true at every width. A Tailwind `md:hidden` pair would keep two copies in the DOM.
 *
 * Reading `matchMedia` during the initial `useState` means the first paint is already correct — a
 * phone does not render the desktop row and then swap. The effect re-reads on mount to cover a
 * width that changed between render and commit, then listens for later changes.
 */

/** `true` when `window.matchMedia` exists — false under SSR or a bare test environment. */
function canQuery(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

/** Current answer for `query`, or `false` where media queries are unavailable. */
function matchesNow(query: string): boolean {
  return canQuery() ? window.matchMedia(query).matches : false;
}

/**
 * @param query a media query string, e.g. `"(min-width: 768px)"`
 * @returns whether the query currently matches
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => matchesNow(query));

  useEffect(() => {
    if (!canQuery()) return;

    const list = window.matchMedia(query);
    // The width may have moved between the render that seeded state and this commit.
    setMatches(list.matches);

    const handleChange = (event: MediaQueryListEvent): void => setMatches(event.matches);

    // `addEventListener` on a MediaQueryList is unavailable on older WebKit, which only has the
    // deprecated `addListener`. Both are cheap to support.
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", handleChange);
      return () => list.removeEventListener("change", handleChange);
    }
    list.addListener(handleChange);
    return () => list.removeListener(handleChange);
  }, [query]);

  return matches;
}

export default useMediaQuery;
