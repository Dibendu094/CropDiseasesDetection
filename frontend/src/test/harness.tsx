import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation, type Location } from "react-router-dom";

type UserEventApi = ReturnType<typeof userEvent.setup>;

export interface RenderWithRouterOptions extends Omit<RenderOptions, "wrapper"> {
  /** Initial path, e.g. `"/history"` or an unknown path for the not-found view. */
  route?: string;
  /** Full history stack; takes precedence over `route` when given. */
  entries?: readonly string[];
  /** Index into `entries`; defaults to the last entry. */
  initialIndex?: number;
}

export interface RenderWithRouterResult extends RenderResult {
  /** Pre-configured user-event instance for interaction tests. */
  user: UserEventApi;
  /** Router location at the time of the call. */
  currentLocation: () => Location;
  /** Shorthand for `currentLocation().pathname`. */
  currentPath: () => string;
}

/**
 * Render `ui` inside a `MemoryRouter` with a controllable initial path.
 *
 * The router is supplied as the RTL `wrapper`, so `rerender` keeps it in place.
 * A hidden probe tracks the location, letting tests assert where navigation
 * landed without reaching into router internals.
 */
export function renderWithRouter(
  ui: ReactNode,
  options: RenderWithRouterOptions = {},
): RenderWithRouterResult {
  const { route = "/", entries, initialIndex, ...renderOptions } = options;
  const stack = entries && entries.length > 0 ? [...entries] : [route];
  const index = initialIndex ?? stack.length - 1;

  let location: Location | null = null;

  function LocationProbe(): null {
    location = useLocation();
    return null;
  }

  function Wrapper({ children }: { children?: ReactNode }) {
    return (
      <MemoryRouter initialEntries={stack} initialIndex={index}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    );
  }

  const result = render(<>{ui}</>, { wrapper: Wrapper, ...renderOptions });

  const currentLocation = (): Location => {
    if (!location) {
      throw new Error("Router location is unavailable — nothing has rendered yet.");
    }
    return location;
  };

  return {
    ...result,
    user: userEvent.setup(),
    currentLocation,
    currentPath: () => currentLocation().pathname,
  };
}
