import { useMediaQuery } from "./useMediaQuery";

/**
 * Whether the operating system asks for reduced motion (Req 11.6).
 *
 * `index.css` already collapses every CSS animation and hover transform inside one global
 * `@media (prefers-reduced-motion: reduce)` block, so nothing that is purely styling needs this
 * hook. What CSS cannot reach is a *decision* taken in JavaScript: the `ResultBox` staggers its
 * recommendation sections by 60 ms per step, and a stagger is a set of delays computed in a
 * component, not a rule a media query can neutralise. Those callers read this value and skip the
 * delay entirely.
 *
 * Built on {@link useMediaQuery} rather than a second `matchMedia` subscription, so the SSR guard,
 * the re-read on mount, and the legacy `addListener` fallback all live in exactly one place.
 */

/** The query, exported so a test can target it without retyping the string. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * @returns `true` while the user prefers reduced motion, `false` otherwise and wherever media
 * queries are unavailable — the same conservative default as the CSS, which animates by default
 */
export function useReducedMotion(): boolean {
  return useMediaQuery(REDUCED_MOTION_QUERY);
}

export default useReducedMotion;
