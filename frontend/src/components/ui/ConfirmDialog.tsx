import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { Button, type ButtonVariant } from "./Button";

/**
 * A modal confirmation, used before a destructive action — today the History delete (Req 9.5).
 *
 * Requirement 9.5 is only half about the markup. The other half is that the dialog must not lose the
 * user's place, so four behaviours are implemented here rather than left to each caller:
 *
 * 1. **Focus moves in.** On open, focus goes to Cancel, not Confirm. A dialog guarding a delete
 *    should not have the irreversible option one Enter press away.
 * 2. **Focus stays in.** Tab and Shift+Tab cycle within the dialog. Focus that has escaped — a
 *    click on the backdrop, a programmatic move — is pulled back on the next Tab.
 * 3. **Focus goes back.** Whatever was focused when the dialog opened is refocused on close, which
 *    for the History page is the Delete button of the row in question. The element is checked for
 *    `isConnected` first: confirming a delete removes that row, and focusing a detached node throws
 *    away the focus position entirely.
 * 4. **Escape cancels.** Same path as the Cancel button, so `onCancel` is the single close handler.
 *
 * `aria-modal="true"` tells assistive technology the rest of the page is unavailable, and
 * `aria-labelledby` names the dialog from its visible title rather than a duplicated string.
 *
 * Rendered inline rather than through a portal: the overlay is `fixed inset-0`, so its position does
 * not depend on where it sits in the tree, and staying inline keeps it inside the React tree that
 * owns it. Body scrolling is locked while open and the previous value restored on close.
 */

/** Tab stops inside the dialog. `:not([disabled])` matters: a busy Confirm must drop out of the cycle. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface ConfirmDialogProps {
  /** Whether the dialog is mounted and visible. Nothing renders when `false`. */
  open: boolean;
  /** The question, e.g. "Delete this scan?". Becomes the accessible name. */
  title: string;
  /** What confirming will do, including anything irreversible about it. */
  description?: ReactNode;
  /** Confirm label. Defaults to "Delete". */
  confirmLabel?: string;
  /** Cancel label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Confirm variant. Defaults to `destructive`. */
  confirmVariant?: ButtonVariant;
  /** Called when the user confirms. */
  onConfirm: () => void;
  /** Called on Cancel, Escape, and a backdrop click. The single close path. */
  onCancel: () => void;
  /** Confirm request in flight: the button shows a spinner and both controls stop responding. */
  busy?: boolean;
  /** Whether a click on the backdrop cancels. Defaults to `true`. */
  dismissOnBackdrop?: boolean;
  /** Extra classes for the dialog panel. */
  className?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  confirmVariant = "destructive",
  onConfirm,
  onCancel,
  busy = false,
  dismissOnBackdrop = true,
  className,
}: ConfirmDialogProps): JSX.Element | null {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    // Effects run after commit, so the Cancel button already exists. The panel is the fallback for
    // the theoretical case where the button did not render.
    (cancelRef.current ?? dialogRef.current)?.focus();

    return () => {
      body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected === true) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  const focusableNodes = useCallback((): readonly HTMLElement[] => {
    const dialog = dialogRef.current;
    if (!dialog) return [];
    return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape") {
        // Stop here: an Escape meant for the dialog must not also close a menu behind it.
        event.stopPropagation();
        onCancel();
        return;
      }

      if (event.key !== "Tab") return;

      const nodes = focusableNodes();
      // Indexed rather than `at()`: the `ES2020` lib target does not declare it.
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) {
        // Nothing to move to — keep focus where it is rather than letting Tab leave the dialog.
        event.preventDefault();
        return;
      }

      const active = document.activeElement;
      const inside = active instanceof Node && dialogRef.current?.contains(active) === true;

      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [focusableNodes, onCancel],
  );

  if (!open) return null;

  const hasDescription = description !== undefined && description !== null && description !== "";

  return (
    <div
      data-testid="confirm-dialog-overlay"
      // `ink.900` at 60%: dark enough to read as inert, not so dark the page vanishes.
      className="fixed inset-0 z-50 flex animate-fade-in items-end justify-center bg-ink-900/60 p-4 sm:items-center"
      onClick={(event) => {
        if (dismissOnBackdrop && !busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasDescription ? descriptionId : undefined}
        onKeyDown={handleKeyDown}
        // Focusable as a fallback target only; it is not in the Tab order. No `outline: none` here —
        // suppressing the ring on a focus target is exactly what Req 12.4 rules out.
        tabIndex={-1}
        className={[
          "w-full max-w-md animate-fade-in-up rounded-2xl bg-white p-6 shadow-md",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <h2 id={titleId} className="wrap-anywhere text-h3 text-ink-900">
          {title}
        </h2>
        {hasDescription ? (
          <p id={descriptionId} className="mt-2 wrap-anywhere text-body text-ink-700">
            {description}
          </p>
        ) : null}
        {/* Cancel first in the DOM: it takes initial focus and is the safe default on Enter. */}
        <div className="mt-6 flex flex-col-reverse gap-3 xs:flex-row xs:justify-end">
          <Button variant="secondary" buttonRef={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
