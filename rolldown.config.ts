import { defineConfig } from "rolldown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  input: "index.ts",
  platform: "node",
  external: (id, _parentId, isResolved) => {
    if (isResolved) return false;
    return !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("node:");
  },
  transform: {
    define: {
      __VERSION__: JSON.stringify(pkg.version),
    },
  },
  output: {
    file: "dist/cli.mjs",
    format: "esm",
    banner: "#!/usr/bin/env node",
  },
});
