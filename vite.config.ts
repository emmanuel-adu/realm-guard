import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";

// The build forbids every network request, so "your files never leave this page" is enforced
// by the browser rather than promised. Only the production build gets it: the dev server
// needs websockets and module requests.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  name: "realm-guard-csp",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

// The production build is one self-contained HTML file. Workflows are scanned in the
// browser, so the page needs no server and can run offline or inside a sandboxed preview.
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), contentSecurityPolicy()],
  build: {
    target: "es2022",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
