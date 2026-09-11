import type { ReactNode } from "react";
import { Outlet } from "react-router-dom";

import { Footer } from "./Footer";
import { Navbar } from "./Navbar";

/**
 * The application shell: a `min-h-screen` white flex column holding the navigation, the routed page,
 * and the footer (Req 1.1, 11.1).
 *
 * `App.tsx` (task 13.4) mounts this as the single parent route, so every page renders inside it
 * through `<Outlet />` and the shell survives client-side navigation without a remount.
 *
 * The navigation arrives through the `nav` slot, defaulting to `<Navbar />`. A page test that wants
 * the shell without the navigation can pass `nav={null}` and skip it.
 */

export interface LayoutProps {
  /**
   * The persistent top navigation, rendered above the page content. Defaults to `<Navbar />`;
   * passing a node — including `null` — overrides it.
   */
  nav?: ReactNode;
  /** The footer, rendered below the page content. Defaults to `<Footer />`. */
  footer?: ReactNode;
  /**
   * Page content. Normally left unset so the routed element renders through `<Outlet />`; a test or
   * a story can pass a node instead and skip the router.
   */
  children?: ReactNode;
}

export function Layout({ nav = <Navbar />, footer, children }: LayoutProps): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {nav}
      {/* One `<main>` landmark for the whole app, so no page has to declare its own. `flex-1`
          gives the routed page the slack between the navigation and the footer. */}
      <main id="main-content" className="flex flex-1 flex-col">
        {children ?? <Outlet />}
      </main>
      {footer ?? <Footer />}
    </div>
  );
}

export default Layout;
