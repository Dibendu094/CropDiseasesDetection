/**
 * The UI primitives, re-exported from one place so a page imports `{ Button, Card }` from
 * `components/ui` rather than reaching into individual files.
 *
 * Each primitive also has a default export in its own module, matching the rest of the codebase.
 */

export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export { Card, type CardElement, type CardPadding, type CardProps } from "./Card";
export {
  ConfidenceMeter,
  type ConfidenceMeterProps,
  type ConfidenceMeterSize,
  type ConfidenceTone,
} from "./ConfidenceMeter";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { ErrorNotice, type ErrorNoticeProps } from "./ErrorNotice";
export { LiveRegion, type LiveRegionProps } from "./LiveRegion";
export { SectionHeading, type HeadingLevel, type SectionHeadingProps } from "./SectionHeading";
export { Spinner, type SpinnerProps, type SpinnerSize } from "./Spinner";
