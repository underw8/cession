import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // ponytail: fsModuleCache races with the workerd pool's module reads here, surfacing as
  // ENOENT "readAll" on node_modules/.vitest-cache/<hash>; disable until upstream fixes it.
  test: { fsModuleCache: false },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { DEV_SKIP_AUTH: "1" } },
    }),
  ],
});
