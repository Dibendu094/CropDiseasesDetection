import react from "@vitejs/plugin-react";
// `vitest/config` re-exports Vite's defineConfig with the `test` block typed.
import { defineConfig } from "vitest/config";

// Dev server runs on 5173, which is what the backend's default CORS allowlist admits.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Component tests assert on classes, not computed styles, so parsing CSS
    // would only cost time.
    css: false,
    restoreMocks: true,
    clearMocks: true,
  },
});
