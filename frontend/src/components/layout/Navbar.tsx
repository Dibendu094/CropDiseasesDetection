import { useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";

import { ROUTES } from "../../lib/constants";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { BrandMark } from "./BrandMark";

export const DESKTOP_MEDIA_QUERY = "(min-width: 768px)";
export const APP_NAME = "Crop Disease Detection";
const APP_NAME_LEAD = "Crop";
const APP_NAME_REST = APP_NAME.slice(APP_NAME_LEAD.length);
export const MENU_TOGGLE_LABEL = "Main menu";

/* ── White glassmorphism nav with green highlights ──────────────── */
const LINK_BASE =
  "focus-ring relative font-heading font-medium transition-all duration-200 px-4 py-2 text-small rounded-xl";

const LINK_ACTIVE =
  "bg-leaf-50 font-semibold text-leaf-700 border border-leaf-200 shadow-glow-sm";

const LINK_IDLE =
  "text-ink-600 hover:text-leaf-700 hover:bg-leaf-50/60 border border-transparent";

function linkClasses(isActive: boolean, extra: string): string {
  return [LINK_BASE, extra, isActive ? LINK_ACTIVE : LINK_IDLE].join(" ");
}

function MenuGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      width="20" height="20" viewBox="0 0 20 20"
      fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" focusable="false" aria-hidden="true"
      className="transition-all duration-300"
    >
      {open ? (
        <><path d="M5 5l10 10" /><path d="M15 5L5 15" /></>
      ) : (
        <><path d="M3 6h14" /><path d="M3 10h14" /><path d="M3 14h14" /></>
      )}
    </svg>
  );
}

export interface NavbarProps {
  className?: string;
}

export function Navbar({ className }: NavbarProps): JSX.Element {
  const isDesktop = useMediaQuery(DESKTOP_MEDIA_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { pathname } = useLocation();
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => { if (isDesktop) setMenuOpen(false); }, [isDesktop]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  return (
    <nav
      aria-label="Main"
      className={[
        "sticky top-0 z-40 transition-all duration-300",
        scrolled
          ? "bg-white/95 backdrop-blur-xl border-b border-stone-200 shadow-md"
          : "bg-white/85 backdrop-blur-lg border-b border-stone-100",
        className,
      ].filter(Boolean).join(" ")}
    >
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
        <div className="flex h-[68px] items-center justify-between gap-3">

          {/* Brand */}
          <Link
            to="/"
            className="focus-ring flex items-center gap-2.5 rounded-xl py-1 group"
            data-testid="brand-link"
          >
            <BrandMark />
            <span className="whitespace-nowrap font-heading text-body-lg font-bold">
              <span className="gradient-text">{APP_NAME_LEAD}</span>
              <span className="text-ink-900">{APP_NAME_REST}</span>
            </span>
          </Link>

          {isDesktop ? (
            <ul className="flex items-center gap-1" data-testid="nav-links-inline">
              {ROUTES.map((route) => (
                <li key={route.path}>
                  <NavLink
                    to={route.path}
                    end={route.path === "/"}
                    className={({ isActive }) => linkClasses(isActive, "block")}
                  >
                    {route.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          ) : (
            <button
              ref={toggleRef}
              type="button"
              aria-label={MENU_TOGGLE_LABEL}
              aria-expanded={menuOpen}
              aria-controls={panelId}
              onClick={() => setMenuOpen((o) => !o)}
              className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-xl border border-stone-200 bg-white text-ink-700 transition-all hover:bg-leaf-50 hover:text-leaf-700 hover:border-leaf-200 hover:shadow-glow-sm"
              data-testid="menu-toggle"
            >
              <MenuGlyph open={menuOpen} />
            </button>
          )}
        </div>
      </div>

      {isDesktop ? null : (
        <div
          id={panelId}
          hidden={!menuOpen}
          className="border-t border-stone-100 bg-white/98 backdrop-blur-xl animate-slide-down"
          data-testid="menu-panel"
        >
          <ul className="mx-auto w-full max-w-5xl px-4 py-3 sm:px-6 space-y-1">
            {ROUTES.map((route) => (
              <li key={route.path}>
                <NavLink
                  to={route.path}
                  end={route.path === "/"}
                  className={({ isActive }) => linkClasses(isActive, "block")}
                >
                  {route.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}

export default Navbar;
