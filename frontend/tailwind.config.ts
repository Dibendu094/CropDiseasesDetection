import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#FFFFFF",
        stone:  { 50: "#F8FAF8", 100: "#EFF3F0", 200: "#E3EAE5", 300: "#C8D8CC" },
        ink:    { 400: "#6B8475", 500: "#56715F", 700: "#2F4739", 900: "#14281D" },
        leaf:   {
          50:  "#F0FAF4",
          100: "#D2EFDC",
          200: "#A8DDB8",
          300: "#72C48E",
          400: "#48A96A",
          500: "#2E8F52",
          600: "#1E7340",
          700: "#175D34",
          800: "#124A29",
          900: "#0C3319",
        },
        sun:    { 50: "#FFF8EC", 100: "#FBEBD2", 400: "#E8951A", 500: "#C97A10", 600: "#A9640A", 700: "#8A5206" },
        clay:   { 50: "#FFF4F3", 100: "#FBE3E0", 200: "#F5C4BF", 600: "#B4362B", 700: "#9B2C24" },
        forest: { 900: "#0A1F12", 950: "#060E09" },
      },
      fontFamily: {
        heading: ['"Plus Jakarta Sans Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        sans:    ['"Inter Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontSize: {
        display:   ["2.5rem",   { lineHeight: "1.15", letterSpacing: "-0.02em",  fontWeight: "700" }],
        "display-lg": ["3.5rem", { lineHeight: "1.1", letterSpacing: "-0.025em", fontWeight: "800" }],
        h1:        ["2rem",     { lineHeight: "1.2",  letterSpacing: "-0.015em", fontWeight: "700" }],
        h2:        ["1.5rem",   { lineHeight: "1.3",  letterSpacing: "-0.01em",  fontWeight: "600" }],
        h3:        ["1.25rem",  { lineHeight: "1.4",  fontWeight: "600" }],
        "body-lg": ["1.125rem", { lineHeight: "1.6" }],
        body:      ["1rem",     { lineHeight: "1.65" }],
        small:     ["0.875rem", { lineHeight: "1.5" }],
        caption:   ["0.75rem",  { lineHeight: "1.45", letterSpacing: "0.01em" }],
      },
      transitionDuration: { fast: "150ms", DEFAULT: "200ms", slow: "300ms", slower: "400ms" },
      keyframes: {
        /* Existing animations — preserved */
        "fade-in":    { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-in-up": { from: { opacity: "0", transform: "translateY(16px)" },
                        to:   { opacity: "1", transform: "translateY(0)" } },
        "meter-fill": { from: { transform: "scaleX(0)" }, to: { transform: "scaleX(1)" } },
        /* New animations */
        "float": {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%":      { transform: "translateY(-8px)" },
        },
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 0 0 rgb(46 143 82 / 0.4)" },
          "50%":      { boxShadow: "0 0 0 12px rgb(46 143 82 / 0)" },
        },
        "shimmer": {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.94)" },
          to:   { opacity: "1", transform: "scale(1)" },
        },
        "slide-down": {
          from: { opacity: "0", transform: "translateY(-8px)" },
          to:   { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-16px)" },
          to:   { opacity: "1", transform: "translateX(0)" },
        },
        "spin-slow": {
          from: { transform: "rotate(0deg)" },
          to:   { transform: "rotate(360deg)" },
        },
        "dash-march": {
          from: { strokeDashoffset: "0" },
          to:   { strokeDashoffset: "-40" },
        },
        "count-up": {
          from: { opacity: "0", transform: "translateY(12px) scale(0.9)" },
          to:   { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "word-reveal": {
          "0%":   { opacity: "0", transform: "translateY(20px) rotateX(-15deg)", filter: "blur(4px)" },
          "100%": { opacity: "1", transform: "translateY(0) rotateX(0deg)", filter: "blur(0px)" },
        },
        "hero-glow": {
          "0%, 100%": { opacity: "0.4", transform: "scale(1)" },
          "50%":      { opacity: "0.7", transform: "scale(1.05)" },
        },
        "border-spin": {
          "0%":   { backgroundPosition: "0% 50%" },
          "50%":  { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "0% 50%" },
        },
      },
      animation: {
        /* Existing */
        "fade-in":      "fade-in 300ms ease-out both",
        "fade-in-up":   "fade-in-up 500ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "meter-fill":   "meter-fill 600ms cubic-bezier(0.22, 1, 0.36, 1) both",
        /* New */
        "float":        "float 3s ease-in-out infinite",
        "pulse-glow":   "pulse-glow 2s ease-in-out infinite",
        "shimmer":      "shimmer 2s linear infinite",
        "scale-in":     "scale-in 350ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "slide-down":   "slide-down 300ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "slide-in-left":"slide-in-left 400ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "spin-slow":    "spin-slow 3s linear infinite",
        "count-up":     "count-up 500ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "word-reveal":  "word-reveal 600ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "hero-glow":    "hero-glow 4s ease-in-out infinite",
        "border-spin":  "border-spin 6s ease infinite",
      },
      boxShadow: {
        sm:    "0 1px 3px 0 rgb(20 40 29 / 0.06), 0 1px 2px -1px rgb(20 40 29 / 0.06)",
        md:    "0 4px 16px -2px rgb(20 40 29 / 0.12), 0 2px 6px -2px rgb(20 40 29 / 0.08)",
        lg:    "0 10px 32px -4px rgb(20 40 29 / 0.16), 0 4px 12px -4px rgb(20 40 29 / 0.10)",
        xl:    "0 20px 48px -8px rgb(20 40 29 / 0.20), 0 8px 20px -6px rgb(20 40 29 / 0.12)",
        glow:  "0 0 0 3px rgb(46 143 82 / 0.25), 0 0 20px rgb(46 143 82 / 0.15)",
        "glow-sm": "0 0 0 2px rgb(46 143 82 / 0.20), 0 0 12px rgb(46 143 82 / 0.10)",
        clay:  "0 4px 16px -2px rgb(155 44 36 / 0.20)",
      },
      backgroundImage: {
        "leaf-gradient":  "linear-gradient(135deg, #1E7340 0%, #2E8F52 50%, #48A96A 100%)",
        "leaf-gradient-r":"linear-gradient(135deg, #48A96A 0%, #2E8F52 50%, #1E7340 100%)",
        "hero-gradient":  "radial-gradient(ellipse 120% 80% at 60% 40%, #0C3319 0%, #0A1F12 50%, #060E09 100%)",
        "hero-mesh":      "radial-gradient(ellipse at 20% 50%, rgb(46 143 82 / 0.15) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgb(72 169 106 / 0.10) 0%, transparent 50%), radial-gradient(ellipse at 50% 100%, rgb(30 115 64 / 0.12) 0%, transparent 50%)",
        "card-gradient":  "linear-gradient(145deg, #FFFFFF 0%, #F0FAF4 100%)",
        "shimmer-gradient": "linear-gradient(90deg, transparent 0%, rgb(255 255 255 / 0.08) 50%, transparent 100%)",
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
      },
      backdropBlur: {
        xs: "2px",
      },
      screens: { xs: "360px" },
    },
  },
  plugins: [],
} satisfies Config;
