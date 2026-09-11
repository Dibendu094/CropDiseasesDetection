import { useState } from "react";
import type { MouseEvent } from "react";

import { api } from "../../api/client";
import type { HistoryItem } from "../../api/types";
import { formatTimestamp } from "../../lib/format";
import { Badge, Button, Card, ConfidenceMeter } from "../ui";

/**
 * One saved scan: the stored image, what it was diagnosed as, how confident that was, when it was
 * taken, and the two controls — View and Delete (Req 9.7).
 *
 * Six decisions worth stating.
 *
 * **The image comes from `api.imageUrl(item.id)`, not `item.image_url`.** The backend sends a
 * root-relative path (`/api/history/{id}/image`), which in development resolves against the Vite
 * origin on :5173 rather than the API on :8000 — every thumbnail would 404. `api.imageUrl` builds it
 * from the same `VITE_API_BASE_URL` the fetches use, so one setting moves both.
 *
 * **The image box has its own size before the bytes arrive.** A 4:3 ratio box with `width`/`height`
 * on the `<img>` reserves the space up front, so a grid of a dozen lazily-loaded thumbnails settles
 * once instead of shoving the cards below it down one by one as each image decodes (Req 12.1).
 *
 * **The alt text names the scan, not the file.** `Scan from {date} diagnosed as {display_name}` is
 * the string the design fixes for history (Req 12.5). Both halves are total: `formatTimestamp`
 * returns a stated placeholder for an unparseable date rather than `Invalid Date`, so the alt text is
 * never empty and never reads "image".
 *
 * **The percentage is the backend's.** `ConfidenceMeter` is handed `confidence_percent` as sent and
 * prints it with one decimal, which is what keeps this card and the result card from disagreeing by
 * a rounding step on the same scan.
 *
 * **The model is not shown.** Which checkpoint produced the result is an implementation detail a
 * grower has no use for, and the result card already declines to render it — a history card that did
 * would be the one place in the UI leaking it. `item.model_used` stays on the type and in the payload
 * for logs and debugging; nothing here reads it.
 *
 * **Both controls name their row.** View and Delete sit side by side in the footer, so a bare "View"
 * or "Delete" reached out of context says nothing about which of a dozen scans it acts on. Each
 * carries an `aria-label` naming the date and the diagnosis, and each hands its own element back to
 * the page so focus can be restored when the dialog it opened closes.
 */

export interface HistoryCardProps {
  /** The scan to render. */
  item: HistoryItem;
  /**
   * Asked to open this scan in full. The second argument is the View button that was pressed, for the
   * same reason as on `onDelete`: the page focuses it before opening `ScanDetailDialog`, so closing
   * the dialog returns focus to the row the user was reading rather than the top of the page.
   */
  onView: (item: HistoryItem, trigger: HTMLButtonElement) => void;
  /**
   * Asked to delete this scan. The second argument is the Delete button that was pressed: the page
   * focuses it before opening `ConfirmDialog`, which is how the dialog knows where to put focus back
   * when the user cancels (Req 9.5).
   */
  onDelete: (item: HistoryItem, trigger: HTMLButtonElement) => void;
  /** This row's delete is in flight: the button shows a spinner and stops responding. */
  deleting?: boolean;
}

/** Reserves the thumbnail's space up front; matches the `width`/`height` ratio on the `<img>`. */
const IMAGE_WIDTH = 480;
const IMAGE_HEIGHT = 360;

export function HistoryCard({
  item,
  onView,
  onDelete,
  deleting = false,
}: HistoryCardProps): JSX.Element {
  const when = formatTimestamp(item.created_at);
  const hasHindi = item.crop_hindi.trim() !== "";
  const [imageError, setImageError] = useState(false);

  return (
    <Card
      as="li"
      padding="none"
      interactive
      // `overflow-hidden` so the thumbnail is clipped by the card's own radius.
      className="flex h-full flex-col overflow-hidden group"
      data-testid="history-card"
    >
      {/* Thumbnail with gradient overlay and zoom on hover */}
      <div className="aspect-[4/3] w-full shrink-0 overflow-hidden bg-stone-100 relative">
        {!imageError ? (
          <img
            src={api.imageUrl(item.id)}
            alt={`Scan from ${when} diagnosed as ${item.display_name}`}
            width={IMAGE_WIDTH}
            height={IMAGE_HEIGHT}
            loading="lazy"
            decoding="async"
            onError={() => setImageError(true)}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-stone-100 p-4 text-center">
            <span className="text-2xl" aria-hidden="true">🌱</span>
            <span className="text-caption font-medium text-ink-400">Photo preview unavailable</span>
          </div>
        )}
        {/* Gradient overlay: fades image bottom into card surface */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-white/20 to-transparent pointer-events-none"
        />
        {/* Crop badge, floating over the image */}
        <div className="absolute top-3 left-3">
          <Badge tone="leaf">{item.crop}</Badge>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5 sm:p-6">
        <h3 className="wrap-anywhere text-h3 text-ink-900 leading-snug">{item.display_name}</h3>

        {hasHindi ? (
          <span lang="hi" className="mt-1 wrap-anywhere text-small text-ink-400">
            {item.crop_hindi}
          </span>
        ) : null}

        {/* `animate={false}`: a dozen bars filling at once reads as noise, and the grid's own
            fade-in already carries the entrance. */}
        <ConfidenceMeter
          percent={item.confidence_percent}
          size="sm"
          className="mt-5"
          animate={false}
        />

        {/* `mt-auto` pins the footer to the bottom, so the controls line up across a row of cards
            whose titles wrap to different heights. */}
        <div className="mt-auto pt-5">
          <time dateTime={item.created_at} className="numeric text-caption text-ink-400 font-medium">
            {when}
          </time>

          {/* View first: it is the safe action, and the destructive one should not be the control a
              thumb lands on. `justify-between` keeps them apart at the 360 px floor (Req 12.1). */}
          <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-stone-100 pt-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                onView(item, event.currentTarget);
              }}
              aria-label={`View the details of the scan from ${when} diagnosed as ${item.display_name}`}
            >
              View details
            </Button>
            <Button
              variant="destructive"
              size="sm"
              loading={deleting}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                onDelete(item, event.currentTarget);
              }}
              // Names the row for anyone who reaches the button out of context, where a bare
              // "Delete" says nothing about which of a dozen scans it removes.
              aria-label={`Delete the scan from ${when} diagnosed as ${item.display_name}`}
            >
              Delete
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default HistoryCard;
