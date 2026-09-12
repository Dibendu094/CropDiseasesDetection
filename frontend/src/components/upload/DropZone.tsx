import { useCallback, useId, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent, ReactNode } from "react";

import { ACCEPTED_MIME_ATTR, MAX_UPLOAD_MB } from "../../lib/constants";

/**
 * The drop target and the file picker — two of the three intake paths (Req 3.2, 3.3).
 *
 * They are one component because they are one control from the user's side: the whole panel is the
 * thing you drop onto, and the thing you activate to browse. A native `<input type="file">` cannot
 * be that panel — it renders as a button and cannot be styled into a drop zone — so the panel is a
 * `role="button" tabIndex={0}` element that forwards activation to a hidden input, and the input is
 * removed from the Tab order so there is exactly one stop, not two.
 *
 * Doing it that way means the keyboard behaviour a real `<button>` gives for free has to be written
 * out, which is Req 12.3: Enter and Space both activate, and both go through the same handler as a
 * click, so a keyboard user and a pointer user cannot end up on different paths.
 * `preventDefault()` on Space is the load-bearing line — without it the page scrolls under the
 * picker the moment it opens.
 *
 * Drag state is counted rather than toggled. `dragenter` and `dragleave` fire for descendants too,
 * so a boolean flipped on `dragleave` drops the highlight as soon as the pointer crosses the icon
 * inside the zone. A depth counter only clears at zero, which is what keeps the distinct hover
 * state steady while the file is anywhere over the panel (Req 3.5).
 *
 * Nothing here validates the file. `validateImage` runs in `UploadBox`, one level up, so all three
 * intake paths are checked by the same code rather than each path checking for itself (Req 4.4).
 */

/** Only the first file is taken: the pipeline diagnoses one photo per submission. */
function firstFile(list: FileList | null): File | null {
  if (!list || list.length === 0) return null;
  return list[0] ?? null;
}

export interface DropZoneProps {
  /**
   * Called with the dropped or picked file. Not validated yet — the caller owns that, so every
   * intake path shares one check.
   */
  onFileSelected: (file: File) => void;
  /** Prompt inside the zone. Defaults to a line naming both paths. */
  label?: string;
  /**
   * Supporting line under the prompt. Defaults to the accepted formats and the size limit, which is
   * the detail that stops a user picking a 40 MB file and waiting for a rejection.
   */
  hint?: string;
  /** Ignore drops and activation, e.g. while a prediction is in flight. */
  disabled?: boolean;
  /** Extra content below the hint, such as the camera control. Its own clicks do not open the picker. */
  children?: ReactNode;
  /** Extra classes for the zone. */
  className?: string;
}

const BASE_CLASSES = [
  "flex w-full flex-col items-center justify-center gap-3",
  "rounded-2xl border-2 border-dashed p-8 text-center sm:p-10",
  "transition-all duration-200 focus-ring cursor-pointer",
].join(" ");

/** Idle state — inviting hover state. */
const IDLE_CLASSES = "border-stone-200 bg-stone-50/50 hover:border-leaf-400 hover:bg-leaf-50/60 hover:shadow-glow-sm";

/** The distinct state while a file is over the zone (Req 3.5): filled surface and solid edge. */
const DRAGGING_CLASSES = "border-leaf-500 bg-leaf-50 shadow-glow scale-[1.01]";

const DISABLED_CLASSES = "cursor-not-allowed border-stone-200 bg-stone-100 opacity-50";

export function DropZone({
  onFileSelected,
  label = "Drop your leaf photo here",
  hint = `or tap to browse · take a picture`,
  disabled = false,
  children,
  className,
}: DropZoneProps): JSX.Element {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Depth, not a flag: `dragleave` from a descendant must not clear the highlight. */
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const openPicker = useCallback((): void => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // `"Spacebar"` is the legacy IE/Edge key value; harmless to accept.
      const isSpace = event.key === " " || event.key === "Spacebar";
      if (event.key !== "Enter" && !isSpace) return;
      // Space scrolls the page by default, which would move the zone out from under the user while
      // the picker opens. Enter is guarded too, so neither key can submit a surrounding form.
      event.preventDefault();
      openPicker();
    },
    [openPicker],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const file = firstFile(event.target.files);
      // Clear the input before handing the file on: without this, picking the same file again after
      // a Clear fires no `change` event and the selection silently fails to come back.
      event.target.value = "";
      if (file) onFileSelected(file);
    },
    [onFileSelected],
  );

  const resetDrag = useCallback((): void => {
    dragDepth.current = 0;
    setDragging(false);
  }, []);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      if (disabled) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      if (disabled) return;
      // Both `dragover` and `dragenter` must be prevented or the browser keeps its own drop
      // behaviour and opens the image in a new tab instead.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (!dragging) setDragging(true);
    },
    [disabled, dragging],
  );

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      resetDrag();
      if (disabled) return;
      const file = firstFile(event.dataTransfer?.files ?? null);
      if (file) onFileSelected(file);
    },
    [disabled, onFileSelected, resetDrag],
  );

  return (
    <div
      data-testid="drop-zone"
      // Reflects the drag state for tests and for any styling that needs it without a class probe.
      data-dragging={dragging ? "true" : "false"}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-describedby={hintId}
      // `aria-disabled` rather than removing the tab stop: a control that vanishes from the Tab
      // order mid-interaction takes the user's place with it.
      aria-disabled={disabled || undefined}
      onClick={openPicker}
      onKeyDown={handleKeyDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={[
        BASE_CLASSES,
        disabled ? DISABLED_CLASSES : dragging ? DRAGGING_CLASSES : IDLE_CLASSES,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Upload cloud icon — animated float when idle */}
      <span
        aria-hidden="true"
        className={[
          "inline-flex h-16 w-16 items-center justify-center rounded-2xl transition-all duration-200",
          dragging
            ? "bg-leaf-500 text-white shadow-glow scale-110"
            : "bg-leaf-50 text-leaf-500 group-hover:text-leaf-600",
          !disabled && !dragging ? "animate-float" : "",
        ].filter(Boolean).join(" ")}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-8 w-8"
        >
          <path d="M12 16V4" />
          <path d="m7 9 5-5 5 5" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      </span>

      <div>
        <p className="text-body font-heading font-semibold text-ink-900">
          {dragging ? "Release to upload" : label}
        </p>
        <p id={hintId} className="mt-1 text-small text-ink-400">
          {hint}
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-1.5" aria-label="Accepted photo formats">
          {["JPG", "JPEG", "PNG", `max ${MAX_UPLOAD_MB} MB`].map((format) => (
            <span
              key={format}
              className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400"
            >
              {format}
            </span>
          ))}
        </div>
      </div>

      {children ? (
        // Stops a click on the camera control from bubbling to the zone and opening the picker too.
        <div
          className="mt-1"
          onClick={(event) => {
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
        >
          {children}
        </div>
      ) : null}
      {/* Visually hidden rather than `display: none`: still clickable through `.click()`, still a
          real labelled control for assistive technology, and `tabIndex={-1}` keeps the panel as the
          single tab stop (Req 12.3). Nothing sets `outline: none` on it. */}
      <input
        ref={inputRef}
        id={inputId}
        data-testid="drop-zone-input"
        type="file"
        accept={ACCEPTED_MIME_ATTR}
        // A name of its own, not the zone's: two controls answering to the same label is ambiguous
        // to a screen reader and to `getByLabelText`.
        aria-label="Choose a crop photo file"
        tabIndex={-1}
        disabled={disabled}
        onChange={handleChange}
        // `input.click()` dispatches a click event that bubbles back to the zone, whose own
        // `onClick` would call `input.click()` again — the classic double-open. Stopping it here is
        // what keeps one activation to one picker.
        onClick={(event) => {
          event.stopPropagation();
        }}
        className="sr-only"
      />
    </div>
  );
}

export default DropZone;
