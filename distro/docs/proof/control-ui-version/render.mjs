import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
if (!process.env.BROWSER_ENGINE_MODULE)
  throw Error("BROWSER_ENGINE_MODULE must name the shared browser loader");
const { loadPlaywright } = await import(pathToFileURL(process.env.BROWSER_ENGINE_MODULE));
const root = process.cwd();
const { createServer } = await import(
  pathToFileURL(path.join(root, "ui/node_modules/vite/dist/node/index.js"))
);
const mode = process.argv[2];
if (!["before", "after"].includes(mode)) throw Error("before or after required");
const out = path.resolve(
  process.env.PROOF_OUT ?? path.join(path.dirname(new URL(import.meta.url).pathname), "rendered"),
);
fs.mkdirSync(out, { recursive: true });
const info = {
  version: "2026.9.8",
  commit: "1234567890abcdef1234567890abcdef12345678",
  branch: "main",
  dirty: false,
  release: true,
  buildId: "fixture-build",
  builtAt: null,
  commitAt: null,
};
const server = await createServer({
  configFile: false,
  plugins: [
    {
      name: "version-proof-page",
      configureServer(s) {
        s.middlewares.use("/version-proof", (_req, res) => {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
        });
      },
    },
  ],
  optimizeDeps: { noDiscovery: true, entries: [] },
  root: path.join(root, "ui"),
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  resolve: {
    alias: [
      {
        find: new RegExp(
          "^@openclaw/(normalization-core|gateway-client|gateway-protocol|model-catalog-core|media-core|net-policy|session-url-contract|workboard-contract|retry)/(.+)$",
        ),
        replacement: path.join(root, "packages/$1/src/$2"),
      },
      {
        find: new RegExp(
          "^@openclaw/(normalization-core|gateway-client|gateway-protocol|model-catalog-core|media-core|net-policy|session-url-contract|workboard-contract|retry)$",
        ),
        replacement: path.join(root, "packages/$1/src/index.ts"),
      },
    ],
  },
  define: { "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(info) },
});
const html =
  '<!doctype html><html data-theme="claw" data-color-scheme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control UI version proof</title></head><body><main style="padding:32px;max-width:900px"><h1>Settings version display</h1><p>Actual Control UI build-chip component; deterministic release metadata and bootstrap display fixture.</p><section id="product"><h2>Product gateway</h2></section><section id="legacy"><h2>Older gateway fallback</h2></section></main><script type="module">import "/src/styles.css"; import "/src/components/sidebar-build-chip.ts"; const product="Núcleo 0.0.1-dev.104 (OpenClaw 2026.9.8)"; for(const id of ["product","legacy"]){const chip=document.createElement("openclaw-sidebar-build-chip");chip.variant="settings";chip.gatewayVersion="2026.9.8";chip.productVersion=id==="product"?product:null;document.getElementById(id).append(chip);await chip.updateComplete;}window.proofReady=true;</script></body></html>';
// The plugin installs the proof route before Vite's SPA fallback.
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const { chromium } = loadPlaywright();
  const cache = path.join(process.env.HOME, ".cache/ms-playwright");
  const rev = fs
    .readdirSync(cache)
    .filter((v) => /^chromium-/.test(v))
    .sort()
    .at(-1);
  browser = await chromium.launch({
    headless: true,
    executablePath: path.join(cache, rev, "chrome-linux64/chrome"),
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:" + port + "/version-proof");
  await page.waitForFunction(() => window.proofReady, undefined, { timeout: 20000 });
  const product = await page.locator("#product .sidebar-footer-build__text").innerText();
  const legacy = await page.locator("#legacy .sidebar-footer-build__text").innerText();
  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: path.join(out, mode + "-" + width + ".png"), fullPage: true });
  }
  const result = {
    mode,
    product,
    legacy,
    errors,
    browser: browser.version(),
    revision: process.env.PROOF_REVISION,
  };
  fs.writeFileSync(path.join(out, mode + ".json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (errors.length) throw Error("browser errors");
  if (mode === "before" && product !== "2026.9.8") throw Error("before mismatch");
  if (mode === "after" && !product.startsWith("Núcleo 0.0.1-dev.104"))
    throw Error("after missing product");
  if (legacy !== "2026.9.8") throw Error("compatibility fallback changed");
} finally {
  await browser?.close();
  await server.close();
}
