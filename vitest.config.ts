import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgres://avand:avand_local@localhost:55439/avand_test",
    },
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
