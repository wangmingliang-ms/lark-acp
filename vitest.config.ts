import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Colocated unit tests (`<module>.test.ts`) plus black-box tests under
    // `tests/`. See CLAUDE.md §10–11.
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
