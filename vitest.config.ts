/// <reference types="vitest" />
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true
      }
    },
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"]
  }
})
