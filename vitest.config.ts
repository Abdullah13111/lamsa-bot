import { defineConfig } from "vitest/config";

// Wrangler bundles *.md as text (see wrangler.jsonc); do the same in tests.
export default defineConfig({
  plugins: [
    {
      name: "md-as-text",
      transform(code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
