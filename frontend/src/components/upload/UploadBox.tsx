import { useCallback, useReducer, useState } from "react";

import { validateImage } from "../../lib/validateImage";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ErrorNotice } from "../ui/ErrorNotice";
import { CameraCapture } from "./CameraCapture";
import { CropSelect } from "./CropSelect";
import { DropZone } from "./DropZone";
import { ImagePreview } from "./ImagePreview";

/**
 * The intake panel: crop selection FIRST, then photo upload.
 *
 * The crop is now required. The drop zone, camera, and submit are all locked
 * until the user picks a crop. Once a crop is chosen the photo intake paths
 * become available. This ensures every diagnosis carries a crop restriction,
 * improving the model's accuracy over auto-detection.
 */

export type UploadBoxState =
  | { readonly status: "empty"; readonly rejection: string | null }
  | { readonly status: "selected"; readonly file: File; readonly rejection: string | null };

export type UploadBoxAction =
  | { readonly type: "select"; readonly file: File }
  | { readonly type: "reject"; readonly message: string }
  | { readonly type: "clear" };

export const INITIAL_UPLOAD_STATE: UploadBoxState = { status: "empty", rejection: null };

export function uploadBoxReducer(state: UploadBoxState, action: UploadBoxAction): UploadBoxState {
  switch (action.type) {
    case "select":
      return { status: "selected", file: action.file, rejection: null };
    case "reject":
      return { ...state, rejection: action.message };
    case "clear":
      return INITIAL_UPLOAD_STATE;
  }
}

/**
 * Crop is required: submit needs a selected file AND a non-empty crop value.
 */
export function canSubmit(state: UploadBoxState, busy: boolean, crop: string): boolean {
  return state.status === "selected" && !busy && crop.trim() !== "";
}

export const REJECTION_TITLE = "That photo cannot be used";

export interface UploadBoxProps {
  onSubmit: (file: File, crop?: string) => void;
  busy?: boolean;
  onClear?: () => void;
  submitLabel?: string;
  className?: string;
}

export function UploadBox({
  onSubmit,
  busy = false,
  onClear,
  submitLabel = "Diagnose this photo",
  className,
}: UploadBoxProps): JSX.Element {
  const [state, dispatch] = useReducer(uploadBoxReducer, INITIAL_UPLOAD_STATE);
  const [crop, setCrop] = useState<string>("");

  const cropSelected = crop.trim() !== "";

  const handleFile = useCallback((file: File): void => {
    const outcome = validateImage(file);
    if (!outcome.ok) {
      dispatch({ type: "reject", message: outcome.message });
      return;
    }
    dispatch({ type: "select", file });
  }, []);

  const handleClear = useCallback((): void => {
    dispatch({ type: "clear" });
    onClear?.();
  }, [onClear]);

  const handleSubmit = useCallback((): void => {
    if (state.status !== "selected" || !canSubmit(state, busy, crop)) return;
    onSubmit(state.file, crop.trim() || undefined);
  }, [busy, crop, onSubmit, state]);

  const submittable = canSubmit(state, busy, crop);

  return (
    <Card
      as="section"
      data-testid="upload-box"
      data-status={state.status}
      aria-label="Crop photo"
      className={["mx-auto w-full max-w-2xl", className].filter(Boolean).join(" ")}
    >
      <div className="flex flex-col gap-5">

        {/* ── Step 1: Crop selection (required) ──────────────────────── */}
        <div>
          <div className="mb-3 flex items-center gap-2">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-leaf-gradient text-white text-caption font-bold shadow-sm">
              1
            </span>
            <p className="text-small font-heading font-semibold text-ink-700">
              Select your crop <span className="text-clay-600">*</span>
            </p>
          </div>
          <CropSelect value={crop} onChange={setCrop} disabled={busy} />
        </div>

        {/* ── Step 2: Photo upload (locked until crop chosen) ──────── */}
        <div>
          <div className="mb-3 flex items-center gap-2">
            <span
              className={[
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-caption font-bold shadow-sm transition-all duration-200",
                cropSelected
                  ? "bg-leaf-gradient text-white"
                  : "bg-stone-200 text-stone-400",
              ].join(" ")}
            >
              2
            </span>
            <p className={`text-small font-heading font-semibold transition-colors duration-200 ${cropSelected ? "text-ink-700" : "text-ink-400"}`}>
              Share a leaf photo
              {!cropSelected && (
                <span className="ml-2 text-caption font-normal text-ink-400">
                  — select a crop first
                </span>
              )}
            </p>
          </div>

          {/* Photo zone — locked overlay when no crop */}
          <div className="relative">
            {state.status === "selected" ? (
              <ImagePreview file={state.file} onClear={handleClear} busy={busy} />
            ) : (
              <DropZone onFileSelected={handleFile} disabled={busy || !cropSelected}>
                <CameraCapture onCapture={handleFile} disabled={busy || !cropSelected} />
              </DropZone>
            )}

            {/* Lock overlay when no crop selected */}
            {!cropSelected && state.status !== "selected" ? (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl bg-white/75 backdrop-blur-[2px] border-2 border-dashed border-stone-200">
                <span
                  aria-hidden="true"
                  className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-stone-100 text-stone-400 mb-3"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
                <p className="text-small font-semibold text-ink-500 font-heading">Select a crop above first</p>
                <p className="mt-1 text-caption text-ink-400">Photo upload will unlock after you choose</p>
              </div>
            ) : null}
          </div>
        </div>

        {/* Rejection notice */}
        {state.rejection === null ? null : (
          <ErrorNotice title={REJECTION_TITLE} message={state.rejection} announce>
            {state.status === "selected"
              ? "The photo above is still selected, so you can submit that one instead."
              : "Choose another photo, or retake it at a smaller size."}
          </ErrorNotice>
        )}

        {/* Submit */}
        <Button
          size="lg"
          fullWidth
          disabled={!submittable}
          loading={busy}
          onClick={handleSubmit}
        >
          {busy ? "Analysing…" : submitLabel}
        </Button>

      </div>
    </Card>
  );
}

export default UploadBox;
