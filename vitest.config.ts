import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Colocated unit tests (`<module>.test.ts`) plus black-box tests under
    // `tests/`. See CLAUDE.md §10–11. `bin/` holds the CLI's own unit tests.
    include: ["src/**/*.test.ts", "bin/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
