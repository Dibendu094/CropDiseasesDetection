import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { installMatchMediaStub, resetMediaEnvironment } from "./matchMedia";

// jsdom has no layout engine, so anything reading media queries needs a stub.
// It is configurable per test rather than always-false — see ./matchMedia.ts.
installMatchMediaStub();

beforeEach(() => {
  resetMediaEnvironment();
});

afterEach(() => {
  cleanup();
  resetMediaEnvironment();
});

// Re-exported so a test can reach the media helpers from one place.
export {
  getMediaEnvironment,
  installMatchMediaStub,
  resetMediaEnvironment,
  setMatchingQueries,
  setReducedMotion,
  setViewportWidth,
} from "./matchMedia";
export type { MediaEnvironment, MediaQueryOverrides } from "./matchMedia";
