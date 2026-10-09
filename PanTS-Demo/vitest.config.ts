import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dates in these tests are zone-sensitive (the server sends UTC with no offset),
// so the run is pinned away from UTC. Set here so every worker inherits it.
process.env.TZ = "America/Los_Angeles";

// Test-only config. Kept separate from vite.config.ts so the production build
// (tailwind/wasm plugins, dev proxy) is untouched. Heavy native modules
// (cornerstone, niivue) are mocked per-test rather than loaded here.
export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		environmentOptions: {
			// A non-opaque origin gives jsdom a real localStorage implementation.
			// Node 24 no longer supplies the accidental global fallback older runs used.
			jsdom: { url: "http://localhost/" },
		},
		globals: false,
		setupFiles: ["./src/test/setup.ts"],
		include: ["src/**/*.{test,spec}.{ts,tsx}"],
		css: false,
	},
});
