import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works from any path on any static host.
  base: "./",
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false },
});
