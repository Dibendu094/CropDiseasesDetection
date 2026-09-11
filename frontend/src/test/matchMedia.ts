/**
 * Configurable `window.matchMedia` stub for jsdom.
 *
 * jsdom ships a `matchMedia` that always reports `matches: false` and ignores
 * listeners, which is not enough for two things the app depends on:
 *
 * - the Navbar collapsing below 768 px (Req 12.2), which reads a width query
 * - `useReducedMotion()` (Req 11.6), which reads `prefers-reduced-motion`
 *
 * So instead of a hard-coded always-false stub, tests describe the environment
 * (`setViewportWidth`, `setReducedMotion`, or arbitrary `setMatchingQueries`)
 * and the stub answers width and reduced-motion queries from that state.
 * Changing the environment notifies live `MediaQueryList` listeners, so
 * components that subscribe re-render the way they would in a browser.
 *
 * `src/test/setup.ts` installs the stub and resets it before every test.
 */

/** Full override: a predicate, an exact-query lookup, or a list of matching queries. */
export type MediaQueryOverrides =
  | ((query: string) => boolean)
  | Readonly<Record<string, boolean>>
  | readonly string[];

export interface MediaEnvironment {
  /** Viewport width in CSS pixels, used to answer min-width / max-width queries. */
  readonly width: number;
  /** Whether `prefers-reduced-motion: reduce` matches. */
  readonly reducedMotion: boolean;
  /** Optional per-test overrides consulted before the built-in evaluation. */
  readonly overrides: MediaQueryOverrides | null;
}

const DEFAULT_WIDTH = 1024;

let environment: MediaEnvironment = {
  width: DEFAULT_WIDTH,
  reducedMotion: false,
  overrides: null,
};

type ChangeListener = (event: MediaQueryListEvent) => void;

interface StubEntry {
  readonly query: string;
  readonly listeners: Set<ChangeListener>;
  list: MediaQueryList;
  matches: boolean;
}

const entries = new Set<StubEntry>();

// --- query evaluation ---------------------------------------------------------

const LENGTH_PATTERN = /\(\s*(min|max)-width\s*:\s*(-?[\d.]+)(px|em|rem)?\s*\)/g;
const REDUCED_MOTION_PATTERN = /prefers-reduced-motion\s*:\s*([a-z-]+)/;

function toPixels(value: number, unit: string | undefined): number {
  return unit === "em" || unit === "rem" ? value * 16 : value;
}

function evaluateSingle(query: string, env: MediaEnvironment): boolean {
  const reducedMotion = REDUCED_MOTION_PATTERN.exec(query);
  if (reducedMotion) {
    // `(prefers-reduced-motion)` with no value is shorthand for `reduce`.
    return reducedMotion[1] === "no-preference" ? !env.reducedMotion : env.reducedMotion;
  }

  let sawWidthFeature = false;
  let satisfied = true;
  LENGTH_PATTERN.lastIndex = 0;
  for (let match = LENGTH_PATTERN.exec(query); match; match = LENGTH_PATTERN.exec(query)) {
    const bound = toPixels(Number(match[2]), match[3]);
    if (Number.isNaN(bound)) continue;
    sawWidthFeature = true;
    satisfied &&= match[1] === "min" ? env.width >= bound : env.width <= bound;
  }

  return sawWidthFeature ? satisfied : false;
}

function evaluate(query: string): boolean {
  const { overrides } = environment;

  if (typeof overrides === "function") {
    return overrides(query);
  }
  if (Array.isArray(overrides)) {
    if ((overrides as readonly string[]).includes(query)) return true;
  } else if (overrides) {
    const table = overrides as Readonly<Record<string, boolean>>;
    if (Object.prototype.hasOwnProperty.call(table, query)) {
      return table[query] ?? false;
    }
  }

  // A comma-separated query list matches when any of its branches matches.
  return query
    .split(",")
    .some((branch) => evaluateSingle(branch.trim(), environment));
}

// --- MediaQueryList stub ------------------------------------------------------

function createEntry(query: string): StubEntry {
  const listeners = new Set<ChangeListener>();
  const entry: StubEntry = {
    query,
    listeners,
    matches: evaluate(query),
    // Filled in below; the list's getters close over `entry`.
    list: undefined as unknown as MediaQueryList,
  };

  const list = {
    get media() {
      return query;
    },
    get matches() {
      return entry.matches;
    },
    onchange: null as ChangeListener | null,
    addEventListener(type: string, listener: ChangeListener): void {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener(type: string, listener: ChangeListener): void {
      if (type === "change") listeners.delete(listener);
    },
    // Deprecated API, still used by some libraries.
    addListener(listener: ChangeListener): void {
      listeners.add(listener);
    },
    removeListener(listener: ChangeListener): void {
      listeners.delete(listener);
    },
    dispatchEvent(event: Event): boolean {
      notifyEntry(entry, event as MediaQueryListEvent);
      return true;
    },
  };

  entry.list = list as unknown as MediaQueryList;
  return entry;
}

function notifyEntry(entry: StubEntry, event: MediaQueryListEvent): void {
  const onchange = (entry.list as { onchange?: ChangeListener | null }).onchange;
  onchange?.call(entry.list, event);
  for (const listener of [...entry.listeners]) {
    listener(event);
  }
}

function refreshAll(): void {
  for (const entry of entries) {
    const next = evaluate(entry.query);
    if (next === entry.matches) continue;
    entry.matches = next;
    notifyEntry(entry, {
      matches: next,
      media: entry.query,
      type: "change",
    } as MediaQueryListEvent);
  }
}

// --- public helpers -----------------------------------------------------------

/** Install the stub on `window`. Safe to call repeatedly. */
export function installMatchMediaStub(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const entry = createEntry(query);
      entries.add(entry);
      return entry.list;
    },
  });
}

/** Drop every live list and return to the default environment. */
export function resetMediaEnvironment(): void {
  entries.clear();
  environment = { width: DEFAULT_WIDTH, reducedMotion: false, overrides: null };
}

/** Set the viewport width used to answer min-width / max-width queries. */
export function setViewportWidth(width: number): void {
  environment = { ...environment, width };
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(window, "outerWidth", { configurable: true, writable: true, value: width });
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  refreshAll();
  window.dispatchEvent(new Event("resize"));
}

/** Set whether `prefers-reduced-motion: reduce` matches. */
export function setReducedMotion(reducedMotion: boolean): void {
  environment = { ...environment, reducedMotion };
  refreshAll();
}

/**
 * Override specific queries. A predicate answers every query; a record or a
 * list answers the queries it names and falls back to width / reduced-motion
 * evaluation for the rest. Pass `null` to clear.
 */
export function setMatchingQueries(overrides: MediaQueryOverrides | null): void {
  environment = { ...environment, overrides };
  refreshAll();
}

/** Current environment, for assertions and debugging. */
export function getMediaEnvironment(): MediaEnvironment {
  return environment;
}
