import { BrowserRouter, Route, Routes } from "react-router-dom";

import { Layout } from "./components/layout/Layout";
import { NOT_FOUND_PATH, ROUTES, type NavRoute } from "./lib/constants";
import { DiagnosisPage } from "./pages/DiagnosisPage";
import { HistoryPage } from "./pages/HistoryPage";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";

/**
 * The route table (Req 1.3, 1.5).
 *
 * One `BrowserRouter`, one pathless parent `<Route element={<Layout />}>`, and every page as a
 * child of it — so the navigation and the footer mount once and survive client-side navigation
 * instead of remounting per page.
 *
 * The three navigable routes are *mapped* from `ROUTES` rather than transcribed, exactly as the
 * `Navbar` maps them. `ROUTES` is typed as a fixed three-entry tuple over the literal paths, so a
 * link and its route cannot drift apart, and neither list can gain, lose, or misspell an entry
 * without a type error (Req 1.2, 1.3). The catch-all uses `NOT_FOUND_PATH`.
 */

/**
 * The element for one navigable route.
 *
 * The switch is exhaustive over `RoutePath`, so adding a fourth path to `ROUTES` fails to compile
 * until its page is wired up here.
 *
 * @param route - one entry of `ROUTES`
 * @returns the element React Router renders inside `Layout`'s `<Outlet />`
 */
function pageElement(route: NavRoute): JSX.Element {
  switch (route.path) {
    case "/":
      return <HomePage />;
    case "/diagnosis":
      return <DiagnosisPage />;
    case "/history":
      return <HistoryPage />;
  }

  throw new Error(`Unsupported route: ${route.path}`);
}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        {/* Pathless parent: the shell for every page, including the not-found view. */}
        <Route element={<Layout />}>
          {ROUTES.map((route) => (
            <Route key={route.path} path={route.path} element={pageElement(route)} />
          ))}
          <Route path={NOT_FOUND_PATH} element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
