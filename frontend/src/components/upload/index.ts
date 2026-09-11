/**
 * The image-intake components, re-exported from one place so `UploadBox` and the `DiagnosisPage`
 * import `{ CameraCapture, DropZone, ImagePreview }` from `components/upload` rather than reaching
 * into individual files — the same arrangement as `components/ui`.
 *
 * `CropSelect`'s strings and its `AUTO_CROP_VALUE` are exported for the same reason the capture-side
 * strings are: `UploadBox` compares the submitted crop against that empty-string sentinel, and a
 * test asserting the picker's copy should assert the real copy rather than a second transcription of
 * it.
 *
 * The two capture-side strings are exported alongside the components because a caller assembling
 * the intake paths may want to compare against them (a live-region announcement, a test assertion)
 * without duplicating the copy. The camera *access* messages live with the hook that produces them,
 * in `hooks/useCamera.ts`.
 *
 * `UploadBox`'s reducer, its initial state, and `canSubmit` are exported for the same reason: the
 * state-machine properties are asserted against the real transition function rather than a copy of
 * it, with no DOM in the way.
 *
 * Each component also has a default export in its own module, matching the rest of the codebase.
 */

export { CAPTURE_FAILED_MESSAGE, CameraCapture, type CameraCaptureProps } from "./CameraCapture";
export {
  AUTO_CROP_VALUE,
  NO_CROP_VALUE,
  CROP_HELPER_TEXT,
  CROP_LOADING_LABEL,
  CROP_UNAVAILABLE_HINT,
  CROP_UNAVAILABLE_LABEL,
  CropSelect,
  type CropSelectProps,
} from "./CropSelect";

export { DropZone, type DropZoneProps } from "./DropZone";
export {
  PREVIEW_ALT_PREFIX,
  ImagePreview,
  previewAltText,
  type ImagePreviewProps,
} from "./ImagePreview";
export {
  INITIAL_UPLOAD_STATE,
  REJECTION_TITLE,
  UploadBox,
  canSubmit,
  uploadBoxReducer,
  type UploadBoxAction,
  type UploadBoxProps,
  type UploadBoxState,
} from "./UploadBox";
