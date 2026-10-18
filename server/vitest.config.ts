import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // ponytail: fsModuleCache races with the workerd pool's module reads here, surfacing as
  // ENOENT "readAll" on node_modules/.vitest-cache/<hash>; disable until upstream fixes it.
  test: {
    fsModuleCache: false,
    // Istanbul, not V8: tests run inside workerd, where V8 coverage isn't available.
    coverage: { provider: "istanbul", include: ["src/**"], reporter: ["lcov", "text-summary"], reportsDirectory: "coverage" },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { DEV_SKIP_AUTH: "1" } },
    }),
  ],
});
