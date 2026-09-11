import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  Badge,
  Button,
  Card,
  ConfidenceMeter,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  LiveRegion,
  SectionHeading,
  Spinner,
} from "./index";

describe("Button", () => {
  it("defaults to a non-submitting button carrying the focus ring (Req 12.4)", () => {
    render(<Button>Analyse photo</Button>);

    const button = screen.getByRole("button", { name: "Analyse photo" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("focus-ring");
    expect(button).toBeEnabled();
  });

  it("pairs each variant with the palette colours from the contrast table", () => {
    render(
      <>
        <Button variant="primary">Primary</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="secondary">Secondary</Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "Primary" })).toHaveClass(
      "bg-leaf-600",
      "text-white",
      "hover:bg-leaf-700",
    );
    expect(screen.getByRole("button", { name: "Destructive" })).toHaveClass(
      "bg-clay-600",
      "text-white",
    );
    expect(screen.getByRole("button", { name: "Secondary" })).toHaveClass(
      "bg-white",
      "text-ink-700",
    );
  });

  it("blocks a second press while loading (Req 3.8)", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button loading onClick={onClick}>
        Analyse photo
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Analyse photo" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps its own label when a spinner is shown", () => {
    render(<Button loading>Analyse photo</Button>);

    // The spinner contributes no text, so the accessible name is unchanged.
    expect(screen.getByRole("button", { name: "Analyse photo" })).toBeInTheDocument();
  });
});

describe("Spinner", () => {
  it("hides the ring from assistive technology and exposes the label as text", () => {
    render(<Spinner label="Analysing photo…" />);

    expect(screen.getByTestId("spinner-ring")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Analysing photo…")).toHaveClass("sr-only");
  });

  it("is not a live region unless asked (one live region per page, Req 12.6)", () => {
    const { rerender } = render(<Spinner />);
    expect(screen.getByTestId("spinner")).not.toHaveAttribute("aria-live");

    rerender(<Spinner announce />);
    expect(screen.getByTestId("spinner")).toHaveAttribute("aria-live", "polite");
  });
});

describe("Card, Badge, SectionHeading, EmptyState", () => {
  it("renders the requested element for a card", () => {
    render(
      <ul>
        <Card as="li">entry</Card>
      </ul>,
    );

    expect(screen.getByRole("listitem")).toHaveClass("rounded-xl", "border-stone-200", "bg-white");
  });

  it("pairs each badge tone with its own text colour", () => {
    render(
      <>
        <Badge tone="sun">Uncertain</Badge>
        <Badge tone="leaf">No disease detected</Badge>
      </>,
    );

    expect(screen.getByText("Uncertain")).toHaveClass("bg-sun-100", "text-sun-700");
    expect(screen.getByText("No disease detected")).toHaveClass("bg-leaf-100", "text-leaf-700");
  });

  it("maps the heading level to the heading rank and keeps the id referenceable", () => {
    render(
      <SectionHeading level={3} id="symptoms-heading" description="What to look for">
        Symptoms
      </SectionHeading>,
    );

    const heading = screen.getByRole("heading", { level: 3, name: "Symptoms" });
    expect(heading).toHaveAttribute("id", "symptoms-heading");
    expect(screen.getByText("What to look for")).toBeInTheDocument();
  });

  it("shows the route out of an empty state (Req 9.8)", () => {
    render(
      <EmptyState
        title="No scans yet"
        description="Diagnose a photo and it will appear here."
        action={<a href="/diagnosis">Go to Diagnosis</a>}
      />,
    );

    const panel = screen.getByTestId("empty-state");
    expect(within(panel).getByRole("heading", { name: "No scans yet" })).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Go to Diagnosis" })).toBeInTheDocument();
  });
});

describe("ErrorNotice", () => {
  it("renders the backend message verbatim beside a retry control (Req 10.7)", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const message = "The diagnosis service is unavailable. No model is loaded.";
    render(<ErrorNotice message={message} onRetry={onRetry} />);

    expect(screen.getByText(message)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry control when retrying cannot help", () => {
    render(<ErrorNotice message="Only JPEG, PNG, and WebP images are accepted." />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("uses the error palette pairing and names itself from its heading", () => {
    render(<ErrorNotice message="The server is unreachable." />);

    const panel = screen.getByTestId("error-notice");
    expect(panel).toHaveClass("bg-clay-100");
    expect(panel).toHaveAccessibleName("Something went wrong");
  });
});

describe("LiveRegion", () => {
  it("is a polite atomic region present before the message arrives (Req 12.6)", () => {
    const { rerender } = render(<LiveRegion />);

    const region = screen.getByTestId("live-region");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toHaveTextContent("");
    expect(region).toHaveClass("sr-only");

    rerender(<LiveRegion message="Late blight on Potato, 93.1% confidence" />);
    expect(screen.getByTestId("live-region")).toHaveTextContent(
      "Late blight on Potato, 93.1% confidence",
    );
  });
});

describe("ConfidenceMeter", () => {
  it("labels the percentage and matches aria-valuenow to the visible number (Req 11.7)", () => {
    render(<ConfidenceMeter percent={93.1} />);

    expect(screen.getByTestId("confidence-value")).toHaveTextContent("93.1%");

    const meter = screen.getByRole("progressbar");
    expect(meter).toHaveAttribute("aria-valuenow", "93.1");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(meter).toHaveAccessibleName("Confidence");
    expect(meter).toHaveAttribute("aria-valuetext", "93.1% confidence");
  });

  it("always shows one decimal, so a whole number does not read as an integer", () => {
    render(<ConfidenceMeter percent={100} />);

    expect(screen.getByTestId("confidence-value")).toHaveTextContent("100.0%");
    expect(screen.getByTestId("confidence-fill")).toHaveStyle({ width: "100%" });
  });

  it("clamps out-of-range and non-finite values to the 0–100 track", () => {
    const cases: ReadonlyArray<readonly [number, string, string]> = [
      [140, "100.0%", "100%"],
      [-12, "0.0%", "0%"],
      [Number.NaN, "0.0%", "0%"],
    ];

    for (const [percent, text, width] of cases) {
      const { unmount } = render(<ConfidenceMeter percent={percent} />);

      expect(screen.getByTestId("confidence-value")).toHaveTextContent(text);
      expect(screen.getByTestId("confidence-fill")).toHaveStyle({ width });
      const now = screen.getByRole("progressbar").getAttribute("aria-valuenow");
      expect(Number(now)).toBeGreaterThanOrEqual(0);
      expect(Number(now)).toBeLessThanOrEqual(100);

      unmount();
    }
  });

  it("fills proportionally to the value it was given", () => {
    render(<ConfidenceMeter percent={42.5} />);

    expect(screen.getByTestId("confidence-fill")).toHaveStyle({ width: "42.5%" });
  });
});

/** A trigger plus the dialog, so focus restore has somewhere real to return to. */
function DeleteFlow({ onConfirm }: { onConfirm?: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Delete scan
      </button>
      <ConfirmDialog
        open={open}
        title="Delete this scan?"
        description="The photo and its diagnosis are removed permanently."
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          onConfirm?.();
          setOpen(false);
        }}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("is a modal dialog named by its visible title (Req 9.5)", () => {
    render(
      <ConfirmDialog
        open
        title="Delete this scan?"
        description="The photo and its diagnosis are removed permanently."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Delete this scan?");
    expect(dialog).toHaveAccessibleDescription(
      "The photo and its diagnosis are removed permanently.",
    );
  });

  it("renders nothing while closed", () => {
    render(<ConfirmDialog open={false} title="Delete this scan?" onCancel={vi.fn()} onConfirm={vi.fn()} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves focus to Cancel on open and back to the trigger on close", async () => {
    const user = userEvent.setup();
    render(<DeleteFlow />);

    const trigger = screen.getByRole("button", { name: "Delete scan" });
    await user.click(trigger);

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("cancels on Escape without confirming", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<DeleteFlow onConfirm={onConfirm} />);

    const trigger = screen.getByRole("button", { name: "Delete scan" });
    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("traps Tab inside the dialog in both directions", async () => {
    const user = userEvent.setup();
    render(<DeleteFlow />);

    await user.click(screen.getByRole("button", { name: "Delete scan" }));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Delete" });

    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    // Last stop wraps to the first rather than leaving for the page behind.
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it("calls the confirm handler only when the user confirms", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<DeleteFlow onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Delete scan" }));
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("gives every interactive control the focus ring (Req 12.4)", async () => {
    const user = userEvent.setup();
    render(<DeleteFlow />);

    await user.click(screen.getByRole("button", { name: "Delete scan" }));

    for (const name of ["Cancel", "Delete"] as const) {
      expect(screen.getByRole("button", { name })).toHaveClass("focus-ring");
    }
  });
});
