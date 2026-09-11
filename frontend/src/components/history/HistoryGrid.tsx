import type { HistoryItem } from "../../api/types";

import { HistoryCard } from "./HistoryCard";

/**
 * The saved scans as a responsive grid of `HistoryCard`s.
 *
 * A `<ul>`, not a stack of `<div>`s: a screen reader announces "list, 12 items" and offers
 * item-by-item navigation, which is the difference between browsing a history and reading twelve
 * unrelated panels. `HistoryCard` renders its `Card` as the `<li>`, so no wrapper element sits
 * between the list and its children to break that relationship.
 *
 * Column counts follow the design's responsive table: one column below 640 px, two from 640 px, three
 * from 1024 px. The card content is fluid at every step and nothing carries a fixed pixel width, so
 * the single column still fits the 360 px floor (Req 12.1).
 *
 * The grid is presentation only. It holds no delete or detail state of its own and forwards `onView`
 * and `onDelete` untouched, because both dialogs, the announcement, and the focus handling belong to
 * the page — one page, one dialog open at a time (Req 9.5, 12.6).
 */

export interface HistoryGridProps {
  /** The scans to render, in the order the backend sent them — newest first (Req 9.2). */
  items: readonly HistoryItem[];
  /** Forwarded to each card: the scan to open in full and the View button that was pressed. */
  onView: (item: HistoryItem, trigger: HTMLButtonElement) => void;
  /** Forwarded to each card: the scan asked about and the Delete button that was pressed. */
  onDelete: (item: HistoryItem, trigger: HTMLButtonElement) => void;
  /** Id of the scan currently being deleted, so only that row shows a busy control. */
  deletingId?: string | null;
  /** Extra classes for the list. */
  className?: string;
}

export function HistoryGrid({
  items,
  onView,
  onDelete,
  deletingId = null,
  className,
}: HistoryGridProps): JSX.Element {
  return (
    <ul
      data-testid="history-grid"
      className={[
        "grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {items.map((item) => (
        // Keyed by scan id: a delete removes one row, and React must keep the surviving cards
        // mounted rather than shifting content between them by index.
        <HistoryCard
          key={item.id}
          item={item}
          onView={onView}
          onDelete={onDelete}
          deleting={deletingId === item.id}
        />
      ))}
    </ul>
  );
}

export default HistoryGrid;
