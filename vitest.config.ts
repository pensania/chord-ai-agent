import { defineConfig } from "vitest/config";

// The Postgres tests make a schema each, which can take over vitest's 5 seconds on a busy machine.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000 } });
