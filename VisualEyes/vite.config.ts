/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so Electron can load dist/index.html over file://
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": `http://localhost:${process.env.LLM_PORT ?? 8787}` },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
