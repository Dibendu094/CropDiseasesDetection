import { useCallback, useEffect, useRef, useState } from "react";

import {
  buildReportHtml,
  downloadReport,
  fileToDataUrl,
  reportFilename,
  type ReportInput,
} from "../../lib/report";
import { Button, type ButtonSize } from "../ui";

/**
 * The control that saves the diagnosis as a printable HTML file (Req 7.11 support material).
 *
 * **Why the work is async at all.** Embedding the photo means reading the picked `File` into a
 * `data:` URL, and `FileReader` is asynchronous. A 10 MB JPEG takes long enough on a phone that a
 * silent button looks broken, so the read is wrapped in a busy state and `Button`'s `loading` prop
 * disables the control — a second click while the first read is in flight would build a second
 * document and hand the browser two downloads.
 *
 * **Why a failed photo read still produces a report.** The guidance is the point of the document; the
 * photo is context. If the file cannot be read, the report is built without it rather than abandoned,
 * because a farmer who wanted the treatment table gets it either way. Only a failure to produce the
 * document at all is surfaced.
 *
 * **Why the failure is inline and not thrown.** This runs in an event handler, where a throw is
 * unhandled — it reaches the console and the user sees nothing change. The message is rendered next to
 * the button that failed, which is where the person who pressed it is looking. `role="alert"` is safe
 * here: the page's single `LiveRegion` announces the diagnosis and request errors, never this, so
 * nothing is spoken twice.
 *
 * The busy state is dropped on unmount through a ref, so a read that resolves after the result panel
 * has been cleared does not write to a component that is gone.
 */

/** The button's accessible name, exported so a test names the control the same way the UI does. */
export const DOWNLOAD_REPORT_LABEL = "Download report";

/** Shown while the photo is being read and the document assembled. */
export const DOWNLOAD_REPORT_BUSY_LABEL = "Preparing report…";

/** Shown when no document could be produced — a browser without Blob URL support, or a build error. */
export const DOWNLOAD_REPORT_ERROR =
  "The report could not be created. Try again, or use your browser's print option.";

export interface DownloadReportButtonProps {
  /**
   * Everything the report prints, minus the photo. Built by `reportInputFromPrediction` on the
   * diagnosis path; the history path builds the same struct from a scan detail.
   */
  input: ReportInput;
  /**
   * The submitted photo. Read into a `data:` URL and embedded when present; the report is generated
   * without an image when absent, which is the case for any caller that no longer holds the `File`.
   */
  file?: File;
  /** Control size. Defaults to `sm`, so the button sits inside a header row without dominating it. */
  size?: ButtonSize;
  /** Extra classes for the wrapper. */
  className?: string;
}

export function DownloadReportButton({
  input,
  file,
  size = "sm",
  className,
}: DownloadReportButtonProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleClick = useCallback((): void => {
    setFailed(false);
    setBusy(true);

    const run = async (): Promise<void> => {
      let imageDataUrl: string | undefined;
      if (file !== undefined) {
        try {
          imageDataUrl = await fileToDataUrl(file);
        } catch {
          // The photo is context, the guidance is the document. Carry on without the image.
          imageDataUrl = undefined;
        }
      }

      const withImage: ReportInput =
        imageDataUrl === undefined ? input : { ...input, imageDataUrl };
      const html = buildReportHtml(withImage);
      const ok = downloadReport(html, reportFilename(withImage));

      if (!mounted.current) return;
      setBusy(false);
      setFailed(!ok);
    };

    void run().catch(() => {
      if (!mounted.current) return;
      setBusy(false);
      setFailed(true);
    });
  }, [file, input]);

  return (
    <div className={["flex flex-col items-start gap-1", className].filter(Boolean).join(" ")}>
      <Button
        variant="secondary"
        size={size}
        loading={busy}
        onClick={handleClick}
        data-testid="download-report"
      >
        {busy ? DOWNLOAD_REPORT_BUSY_LABEL : DOWNLOAD_REPORT_LABEL}
      </Button>
      {failed ? (
        <p role="alert" className="wrap-anywhere text-small text-clay-700">
          {DOWNLOAD_REPORT_ERROR}
        </p>
      ) : null}
    </div>
  );
}

export default DownloadReportButton;
