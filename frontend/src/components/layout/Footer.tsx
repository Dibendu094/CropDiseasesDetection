export const FOOTER_ADVISORY =
  "Diagnoses are a decision-support aid. Confirm treatment with a local agricultural expert before any chemical application.";

export interface FooterProps {
  className?: string;
}

export function Footer({ className }: FooterProps): JSX.Element {
  return (
    <footer
      className={["mt-auto border-t border-stone-100 bg-stone-50", className].filter(Boolean).join(" ")}
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="wrap-anywhere text-small text-ink-500">{FOOTER_ADVISORY}</p>
          <p className="shrink-0 text-caption text-stone-400 font-semibold tracking-widest uppercase select-none">
            Crop Disease Detection
          </p>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
