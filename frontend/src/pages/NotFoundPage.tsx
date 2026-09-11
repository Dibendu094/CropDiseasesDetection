import { Link } from "react-router-dom";

import { SectionHeading } from "../components/ui";

/**
 * The catch-all view for an address that matches no route (Req 1.5).
 *
 * It renders inside `Layout`, so the navigation is still there — this page only has to say what
 * happened and offer one obvious way back.
 *
 * The way back is a `Link`, not a `Button` with a navigate handler: an address is an anchor's job,
 * so middle-click and "open in new tab" keep working, and an `<a>` may not contain a `<button>`.
 * The classes mirror `Button`'s `primary` variant (`leaf.600` on white text at 5.84:1, `leaf.700`
 * on hover, `.focus-ring`, 200 ms `transition-colors`) rather than introducing a second look.
 */

const HOME_LINK_CLASSES = [
  "focus-ring inline-flex min-h-11 items-center justify-center gap-2",
  "rounded-lg bg-leaf-600 px-6 py-3",
  "font-heading text-body-lg font-semibold text-white",
  "transition-colors hover:bg-leaf-700",
].join(" ");

export function NotFoundPage(): JSX.Element {
  return (
    <section
      aria-labelledby="not-found-heading"
      className="mx-auto w-full max-w-5xl animate-fade-in-up px-4 py-12 sm:px-6 sm:py-20"
    >
      <p className="numeric text-caption font-medium uppercase tracking-wide text-ink-500">
        Error 404
      </p>

      <SectionHeading
        id="not-found-heading"
        level={1}
        className="mt-3"
        description="The address you opened does not match any page in this app."
      >
        Page not found
      </SectionHeading>

      <p className="mt-6 max-w-xl wrap-anywhere text-body text-ink-700">
        The link may be out of date, or the address may have a typo. Everything the app can do is
        reachable from the navigation above.
      </p>

      <div className="mt-8">
        <Link to="/" className={HOME_LINK_CLASSES}>
          Back to home
        </Link>
      </div>
    </section>
  );
}

export default NotFoundPage;
