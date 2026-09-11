import { useId } from "react";
import type { ChangeEvent } from "react";

import { useMetadata } from "../../hooks/useMetadata";

/**
 * The required crop selector — Step 1 of the diagnosis flow.
 *
 * Crop selection is now required before a photo can be uploaded. The selector
 * shows a placeholder "Choose a crop…" as the first (disabled) option so the
 * user knows they must pick. There is no "detect automatically" option.
 *
 * Picking a crop restricts each model's softmax to that crop's class indices
 * and renormalises over them, making the answer more reliable.
 */

/** Sentinel value for "nothing chosen yet" — cannot be submitted. */
export const NO_CROP_VALUE = "";

/** Loading placeholder text. */
export const CROP_LOADING_LABEL = "Loading crops…";

/** Shown when crop list could not be loaded. */
export const CROP_UNAVAILABLE_LABEL = "Crop list not available";

/** Helper text explaining benefit of crop selection. */
export const CROP_HELPER_TEXT =
  "Picking your crop narrows the model to that crop's diseases, so the answer is more reliable.";

/** Hint when unavailable. */
export const CROP_UNAVAILABLE_HINT =
  "The crop list could not be loaded. Try restarting the backend and refreshing.";

// Keep AUTO_CROP_VALUE as alias for backward compatibility with any tests
export const AUTO_CROP_VALUE = NO_CROP_VALUE;

const SELECT_CLASSES = [
  "w-full rounded-xl border bg-white",
  "px-3 py-2.5 text-body",
  "transition-all duration-200 focus-ring",
  "disabled:cursor-not-allowed disabled:bg-stone-100 disabled:opacity-60",
].join(" ");

export interface CropSelectProps {
  value: string;
  onChange: (crop: string) => void;
  disabled?: boolean;
  className?: string;
}

export function CropSelect({
  value,
  onChange,
  disabled = false,
  className,
}: CropSelectProps): JSX.Element {
  const { data, error, loading } = useMetadata();
  const selectId = useId();
  const helperId = useId();

  const crops = data?.crops ?? [];
  const isReady = !loading && error === null && crops.length > 0;

  // Determine if the current value is a real crop
  const isValidCrop = crops.includes(value);

  const helperText = error !== null ? CROP_UNAVAILABLE_HINT : CROP_HELPER_TEXT;

  return (
    <div
      data-testid="crop-select"
      data-state={loading ? "loading" : error !== null ? "error" : "ready"}
      className={["flex w-full flex-col gap-1.5", className].filter(Boolean).join(" ")}
    >
      <label htmlFor={selectId} className="flex items-center gap-2 text-small font-heading font-semibold text-ink-900">
        Crop
        <span className="rounded-full bg-clay-50 border border-clay-200 px-2 py-0.5 text-caption font-semibold text-clay-600">
          required
        </span>
      </label>

      <select
        id={selectId}
        data-testid="crop-select-input"
        aria-describedby={helperId}
        aria-required="true"
        disabled={disabled || loading || error !== null}
        value={isValidCrop ? value : NO_CROP_VALUE}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          onChange(event.target.value);
        }}
        className={[
          SELECT_CLASSES,
          isValidCrop
            ? "border-leaf-300 text-ink-900 shadow-glow-sm"
            : "border-stone-200 text-ink-400",
        ].join(" ")}
      >
        {loading ? (
          <option value={NO_CROP_VALUE} disabled>{CROP_LOADING_LABEL}</option>
        ) : error !== null || crops.length === 0 ? (
          <option value={NO_CROP_VALUE} disabled>{CROP_UNAVAILABLE_LABEL}</option>
        ) : (
          <>
            {/* Placeholder — disabled so user must actively choose */}
            <option value={NO_CROP_VALUE} disabled>
              Choose a crop…
            </option>
            {crops.map((crop) => (
              <option key={crop} value={crop}>
                {crop}
              </option>
            ))}
          </>
        )}
      </select>

      <p id={helperId} className="text-small text-ink-500">
        {helperText}
      </p>

      {isReady && isValidCrop ? (
        <p className="text-caption font-medium text-leaf-600 flex items-center gap-1.5">
          <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 shrink-0">
            <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z" clipRule="evenodd" />
          </svg>
          Crop selected — now upload a photo below
        </p>
      ) : null}
    </div>
  );
}

export default CropSelect;
