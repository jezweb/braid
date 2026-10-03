import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "viewer",
  plugins: [react()],
  build: { outDir: "../dist/viewer", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
