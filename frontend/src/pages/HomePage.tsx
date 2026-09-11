import { useEffect, useId, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";

import { Badge, Card, ErrorNotice, SectionHeading, Spinner } from "../components/ui";
import { useMetadata } from "../hooks/useMetadata";
import { ACCEPTED_FORMATS_LABEL, MAX_UPLOAD_MB } from "../lib/constants";

/* ─── Word-by-word animated heading ────────────────────────────────────────── */
interface AnimatedWordsProps {
  text: string;
  interval?: number;
  startDelay?: number;
  className?: string;
  highlightWords?: string[];
}

function AnimatedWords({
  text,
  interval = 110,
  startDelay = 200,
  className = "",
  highlightWords = [],
}: AnimatedWordsProps): JSX.Element {
  const words = text.split(" ");
  const [visible, setVisible] = useState(0);

  useEffect(() => {
    setVisible(0);
    const timer = setTimeout(() => {
      let count = 0;
      const id = setInterval(() => {
        count += 1;
        setVisible(count);
        if (count >= words.length) clearInterval(id);
      }, interval);
      return () => clearInterval(id);
    }, startDelay);
    return () => clearTimeout(timer);
  }, [text, interval, startDelay, words.length]);

  return (
    <span className={className} style={{ perspective: "800px" }}>
      {words.map((word, i) => {
        const isHighlight = highlightWords.includes(word);
        return (
          <span
            key={`${word}-${i}`}
            style={
              {
                display: "inline-block",
                marginRight: "0.3em",
                opacity: i < visible ? 1 : 0,
                transform: i < visible
                  ? "translateY(0) rotateX(0deg)"
                  : "translateY(24px) rotateX(-20deg)",
                filter: i < visible ? "blur(0)" : "blur(6px)",
                transition: "opacity 550ms cubic-bezier(0.22,1,0.36,1), transform 550ms cubic-bezier(0.22,1,0.36,1), filter 450ms ease",
                transitionDelay: `${i * 15}ms`,
              } as CSSProperties
            }
          >
            {isHighlight ? (
              <span className="gradient-text">{word}</span>
            ) : word}
          </span>
        );
      })}
    </span>
  );
}

/* ─── Cycling tagline ───────────────────────────────────────────────────────── */
const TAGLINES = [
  "Identify diseases before they spread.",
  "Get treatment guidance in seconds.",
  "Protect your harvest with AI.",
  "Upload a leaf. Know the answer.",
];

function CyclingTagline(): JSX.Element {
  const [index, setIndex] = useState(0);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        setIndex((i) => (i + 1) % TAGLINES.length);
        setFading(false);
      }, 350);
    }, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      style={{
        display: "inline-block",
        opacity: fading ? 0 : 1,
        transform: fading ? "translateY(-8px)" : "translateY(0)",
        transition: "opacity 350ms ease, transform 350ms ease",
      }}
    >
      {TAGLINES[index]}
    </span>
  );
}

/* ─── Floating leaf decoration ──────────────────────────────────────────────── */
function FloatingLeaf({
  className,
  size = 32,
}: {
  className: string;
  size?: number;
}): JSX.Element {
  return (
    <span aria-hidden="true" className={`absolute pointer-events-none select-none ${className}`}>
      <svg viewBox="0 0 32 32" width={size} height={size} fill="currentColor" focusable="false">
        <path d="M16 2.6c-4.6 4.4-5.6 9.6-2.1 13.4h4.2c3.5-3.8 2.5-9-2.1-13.4Z" />
        <path d="M4.4 8.6c-1 6.2 1.9 10.6 7.1 11.1l2.6-3.3C12.1 11.3 8.8 8.6 4.4 8.6Z" />
        <path d="M27.6 8.6c1 6.2-1.9 10.6-7.1 11.1l-2.6-3.3c2-5.1 5.3-7.8 9.7-7.8Z" />
        <path d="M16 16.4v12.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      </svg>
    </span>
  );
}

/* ─── Coverage figure card ──────────────────────────────────────────────────── */
function Figure({ label, value, testId }: { label: string; value: number; testId: string }): JSX.Element {
  return (
    <Card gradient className="text-center animate-count-up hover:shadow-glow-sm transition-shadow duration-300">
      <dt className="text-caption font-semibold uppercase tracking-widest text-ink-400 mb-1">{label}</dt>
      <dd data-numeric data-testid={testId} className="numeric font-heading text-display font-black gradient-text">
        {value}
      </dd>
    </Card>
  );
}

/* ─── CTA link ───────────────────────────────────────────────────────────────── */
const CTA_LINK_CLASSES = [
  "focus-ring btn-primary-gradient inline-flex min-h-14 items-center justify-center gap-2.5",
  "rounded-2xl px-8 py-3.5",
  "font-heading text-body-lg font-semibold text-white tracking-wide",
].join(" ");

/* ─── Steps ──────────────────────────────────────────────────────────────────── */
const STEPS = [
  {
    title: "Capture or upload an image",
    detail: `Photograph the affected leaf, or pick a file you already have. ${ACCEPTED_FORMATS_LABEL} accepted, up to ${String(MAX_UPLOAD_MB)} MB.`,
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    ),
  },
  {
    title: "Receive the diagnosis",
    detail: "The crop and disease are named with a confidence figure, alongside the next most likely alternatives.",
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
      </svg>
    ),
  },
  {
    title: "Review the treatment guidance",
    detail: "Organic and chemical options, dosages, spray timing, prevention, and the safety notes that go with them.",
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
] as const;

/* ─── Trust stats ────────────────────────────────────────────────────────────── */
const TRUST_STATS = [
  { value: "32", label: "Crops" },
  { value: "133", label: "Diseases" },
  { value: "< 5s", label: "Avg. time" },
  { value: "100%", label: "Offline report" },
];

/* ═══════════════════════════════════════════════════════════════════════════════
   HomePage
══════════════════════════════════════════════════════════════════════════════ */
export function HomePage(): JSX.Element {
  const { data, error, loading, reload } = useMetadata();
  const headingId = useId();

  return (
    <div className="bg-white">

      {/* ══ HERO — White with animated decorations ═══════════════════════ */}
      <section
        aria-labelledby={headingId}
        className="relative overflow-hidden border-b border-stone-100"
        style={{ minHeight: "88vh", display: "flex", flexDirection: "column", justifyContent: "center" }}
      >
        {/* Soft radial glow blobs */}
        <div
          aria-hidden="true"
          className="absolute -left-40 -top-40 h-[600px] w-[600px] rounded-full bg-leaf-100/60 blur-3xl animate-hero-glow pointer-events-none"
        />
        <div
          aria-hidden="true"
          className="absolute -right-32 top-1/3 h-[400px] w-[400px] rounded-full bg-leaf-50 blur-3xl animate-hero-glow pointer-events-none"
          style={{ animationDelay: "2s" }}
        />
        <div
          aria-hidden="true"
          className="absolute bottom-0 left-1/2 -translate-x-1/2 h-[300px] w-[700px] rounded-full bg-stone-100/80 blur-3xl pointer-events-none"
        />

        {/* Floating leaf decorations */}
        <FloatingLeaf className="top-[10%] left-[5%] text-leaf-300/50 animate-float" size={48} />
        <FloatingLeaf className="top-[20%] right-[7%] text-leaf-200/60 animate-float [animation-delay:1.2s]" size={32} />
        <FloatingLeaf className="bottom-[22%] left-[15%] text-leaf-300/40 animate-float [animation-delay:2s]" size={24} />
        <FloatingLeaf className="bottom-[10%] right-[4%] text-leaf-200/40 animate-float [animation-delay:0.6s]" size={56} />

        {/* Subtle dot grid */}
        <div
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: "radial-gradient(circle, rgb(46 143 82 / 0.08) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />

        {/* Hero content */}
        <div className="relative mx-auto w-full max-w-5xl px-4 sm:px-6 py-24 sm:py-32">

          {/* Eyebrow — animated words */}
          <p
            className="mb-5 text-caption font-semibold uppercase tracking-[0.18em] text-leaf-600 font-heading"
            style={{ minHeight: "1.2em" }}
          >
            <AnimatedWords
              text="Field diagnosis for growing crops"
              interval={90}
              startDelay={300}
            />
          </p>

          {/* Main heading — word by word */}
          <h1
            id={headingId}
            className="font-heading font-black text-ink-900"
            style={{ fontSize: "clamp(2.6rem, 6vw, 4.5rem)", lineHeight: 1.07, letterSpacing: "-0.03em" }}
          >
            <AnimatedWords
              text="Identify Crop Diseases"
              interval={110}
              startDelay={600}
            />
            <br />
            <AnimatedWords
              text="Instantly"
              interval={110}
              startDelay={1050}
              highlightWords={["Instantly"]}
            />
          </h1>

          {/* Cycling tagline */}
          <p className="mt-5 text-body-lg font-medium text-ink-400">
            <CyclingTagline />
          </p>

          {/* Descriptor */}
          <p
            className="mt-3 max-w-xl wrap-anywhere text-body text-ink-500 leading-relaxed animate-fade-in"
            style={{ animationDelay: "900ms" }}
          >
            Upload a photo of an affected leaf and get the likely disease, how confident the model is, and the treatment guidance that goes with it.
          </p>

          {/* CTAs */}
          <div className="mt-10 flex flex-wrap items-center gap-4 animate-fade-in-up" style={{ animationDelay: "1100ms" }}>
            <Link to="/diagnosis" id="hero-cta" className={CTA_LINK_CLASSES}>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Start a diagnosis
            </Link>
            <Link
              to="/history"
              className="focus-ring inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl border border-stone-200 bg-white px-7 py-3.5 font-heading text-body-lg font-semibold text-ink-700 shadow-sm transition-all duration-200 hover:border-leaf-200 hover:text-leaf-700 hover:shadow-glow-sm"
            >
              View history
            </Link>
          </div>

          {/* Trust stat pills */}
          <div
            className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-4 animate-fade-in"
            style={{ animationDelay: "1300ms" }}
          >
            {TRUST_STATS.map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl border border-stone-100 bg-stone-50/80 px-4 py-4 text-center hover:border-leaf-100 hover:bg-leaf-50/60 transition-colors duration-200"
              >
                <div className="numeric font-heading text-h2 font-black gradient-text">{stat.value}</div>
                <div className="mt-0.5 text-caption font-semibold uppercase tracking-wider text-ink-400">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ CONTENT SECTIONS ══════════════════════════════════════════════ */}
      <div className="mx-auto w-full max-w-5xl space-y-20 px-4 py-20 sm:space-y-28 sm:px-6 sm:py-28">

        {/* Coverage */}
        <section aria-labelledby="coverage-heading">
          <SectionHeading id="coverage-heading" description="Reported by the server for the label set in use.">
            What this app covers
          </SectionHeading>
          {loading ? (
            <Card className="mt-8 flex items-center justify-center py-14">
              <Spinner size="lg" label="Loading coverage figures…" showLabel />
            </Card>
          ) : error !== null ? (
            <ErrorNotice className="mt-8" title="Coverage figures unavailable" message={error} onRetry={reload} retryLabel="Retry">
              Start the backend, then retry to fill in the crop and class counts.
            </ErrorNotice>
          ) : data === null ? null : (
            <div className="mt-8 space-y-8">
              <dl className="grid gap-5 sm:grid-cols-2">
                <Figure label="Crops covered" value={data.crop_count} testId="coverage-crop-count" />
                <Figure label="Disease classes" value={data.class_count} testId="coverage-class-count" />
              </dl>
              <div>
                <h3 className="text-h3 text-ink-900 mb-4">Crops in the label set</h3>
                <ul className="flex flex-wrap gap-2" data-testid="coverage-crops">
                  {data.crops.map((crop) => (
                    <li key={crop}><Badge tone="leaf">{crop}</Badge></li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>

        {/* How it works */}
        <section aria-labelledby="how-it-works-heading">
          <SectionHeading id="how-it-works-heading" description="Three steps, one photo at a time.">
            How it works
          </SectionHeading>
          <ol className="mt-8 grid gap-5 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <Card
                as="li"
                key={step.title}
                gradient
                interactive
                className="animate-fade-in-up"
                style={{ animationDelay: `${index * 80}ms` } as CSSProperties}
              >
                <div className="flex items-center gap-3 mb-5">
                  <span data-numeric className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-gradient text-white font-heading text-body font-bold shadow-md">
                    {index + 1}
                  </span>
                  <span className="text-leaf-600">{step.icon}</span>
                </div>
                <h3 className="text-h3 text-ink-900">{step.title}</h3>
                <p className="mt-2 wrap-anywhere text-body text-ink-500">{step.detail}</p>
              </Card>
            ))}
          </ol>
        </section>

        {/* Advisory */}
        <section aria-labelledby="advisory-heading">
          <div className="rounded-2xl border border-sun-100 bg-sun-50 p-6 sm:p-8 flex gap-4">
            <span aria-hidden="true" className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sun-100 text-sun-600">
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
              </svg>
            </span>
            <div>
              <h2 id="advisory-heading" className="text-h3 text-sun-700">Read this before you spray</h2>
              <p className="mt-2 wrap-anywhere text-body text-sun-700">
                A diagnosis here is a decision-support aid, not a prescription. Have a local agricultural expert confirm the finding and the dosage before any chemical application.
              </p>
              <p className="mt-3 wrap-anywhere text-small text-sun-700/80">
                This deployment is intended for trusted local or single-operator use: there is no account system, and anyone who can reach the app can read and clear its scan history.
              </p>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}

export default HomePage;
