import { ResultBox, UNCERTAINTY_ADVICE } from "../components/result";
import { LiveRegion, SectionHeading } from "../components/ui";
import { UploadBox } from "../components/upload";
import { usePrediction, type PredictionState } from "../hooks/usePrediction";
import { formatPercent } from "../lib/format";

/**
 * The Diagnosis page: intake above, result below (Req 3.1, 3.7, 12.6).
 *
 * **The vertical order is the requirement.** `UploadBox` is rendered before `ResultBox` in the
 * document, horizontally centred at `max-w-2xl` inside the page container, and the result panel sits
 * under it — so the sequence a user reads matches the sequence they act in, on every viewport, with
 * no reordering at a breakpoint (Req 3.1).
 *
 * **The page owns the request, the panel owns the photo.** `UploadBox` validates and holds the
 * selection; `usePrediction` sends it and holds the five states. That split is why `busy` is passed
 * down (so submit is dead while a request is in flight, Req 3.8) and why `onClear` resets the hook: a
 * result belongs to the photo that produced it, and leaving it on screen after that photo is gone
 * invites a user to read guidance for an image they are no longer looking at.
 *
 * **One live region, mounted from first render.** A region that appears together with its text is
 * frequently not announced at all, so `LiveRegion` is always in the document and starts empty — the
 * message is derived from the state, and it is the *change* that speaks (Req 12.6). It is the only
 * announcement channel on the page, which is why `ResultBox`, `Spinner`, and `ErrorNotice` are not
 * live regions themselves: they would say the same sentence a second time. The one exception is
 * `UploadBox`'s validation notice, which announces a file that never became a request.
 *
 * **The optional crop passes straight through.** `UploadBox` owns the picker and calls
 * `onSubmit(file, crop?)`; `usePrediction.submit` has that exact shape, so the page hands the hook
 * over as the callback rather than wrapping it in an adapter that could only get the forwarding
 * wrong. The page holds no crop state of its own — one owner, so the crop that was picked is
 * unambiguously the crop that is sent, and the hook's `retry` repeats both together.
 *
 * Retry re-sends the same file and crop from inside the hook, so the failure panel's control works
 * whether or not the upload panel still holds the selection (Req 10.7, 10.8).
 */

/**
 * The announcement for a state: the diagnosis on success, the message on failure, nothing otherwise.
 *
 * Format is `{display_name} on {crop}, {pct}% confidence`, using the backend's own
 * `confidence_percent` rather than re-deriving it from `confidence` — the spoken number and the
 * number on the meter have to be the same one (Req 11.7). The uncertainty advice is appended when
 * `is_uncertain`, because a screen-reader user hears the figure without seeing the banner beside it
 * (Req 5.6).
 *
 * Exported so a test asserts the string this page speaks rather than a copy of the template.
 */
export function announcementFor(state: PredictionState): string {
  switch (state.status) {
    case "idle":
    case "pending":
      return "";

    case "success": {
      const { display_name, label, crop, confidence_percent, is_uncertain } = state.result.diagnosis;
      // Same fallback as the result card: a blank display name reads as the raw label rather than as
      // a gap in the sentence.
      const name = display_name.trim() === "" ? label : display_name;
      const headline = `${name} on ${crop}, ${formatPercent(confidence_percent)} confidence`;
      return is_uncertain
        ? `${headline}. This is a low-confidence match. ${UNCERTAINTY_ADVICE}`
        : `${headline}.`;
    }

    case "error":
    case "unreachable":
      // The backend's own wording, or the client's for an unreachable server (Req 10.7, 10.8).
      return state.message;
  }
}

/**
 * The result panel for a prediction state.
 *
 * A `switch` rather than nested ternaries, because `ResultBox`'s props are a discriminated union and
 * each arm has to be constructed with the fields that arm requires. TypeScript checks both unions
 * against each other here, so a sixth prediction state cannot compile without a panel for it.
 */
function ResultPanel({
  state,
  onRetry,
  file,
}: {
  state: PredictionState;
  onRetry: () => void;
  /** The submitted photo, from `usePrediction`, so the downloadable report can embed it. */
  file: File | null;
}): JSX.Element {
  switch (state.status) {
    case "idle":
      return <ResultBox state="idle" />;

    case "pending":
      return <ResultBox state="pending" />;

    case "success":
      return (
        <ResultBox
          state="success"
          result={state.result}
          {...(file === null ? {} : { file })}
        />
      );

    case "error":
    case "unreachable":
      return <ResultBox state={state.status} message={state.message} onRetry={onRetry} />;
  }
}

export function DiagnosisPage(): JSX.Element {
  const { state, pending, submittedFile, submit, retry, reset } = usePrediction();

  return (
    <div className="animate-fade-in">
      {/* Light gradient header band */}
      <div className="border-b border-stone-100 bg-gradient-to-b from-leaf-50/50 to-white">
        <section
          aria-labelledby="diagnosis-heading"
          className="mx-auto w-full max-w-5xl animate-fade-in-up px-4 pt-12 pb-14 sm:px-6 sm:pt-20 sm:pb-20"
        >
          <SectionHeading
            id="diagnosis-heading"
            level={1}
            description="Select your crop, then add a photo of the affected leaf — drop it, choose a file, or shoot it with your camera."
          >
            Diagnose a photo
          </SectionHeading>

          <LiveRegion message={announcementFor(state)} />

          <UploadBox className="mt-10" onSubmit={submit} busy={pending} onClear={reset} />
        </section>
      </div>

      {/* Result area — separated by the band boundary */}
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
        {/* The photo comes from the hook rather than from `UploadBox`: the hook holds the file the
            request was actually made with, so the report cannot embed a photo the user has since
            swapped in the picker (Req 7.11 support material). */}
        <ResultPanel state={state} onRetry={retry} file={submittedFile} />
      </div>
    </div>
  );
}

export default DiagnosisPage;
