import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts", "viewer/test/**/*.test.ts"] } });
