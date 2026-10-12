import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTestSelectorSourceFacts } from "../../scripts/lib/test-selector-source-facts.mts";

const roots: string[] = [];
const previous = process.env.OPENCLAW_TEST_SELECTOR_FACTS_CACHE;
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (previous === undefined) {
    delete process.env.OPENCLAW_TEST_SELECTOR_FACTS_CACHE;
  } else {
    process.env.OPENCLAW_TEST_SELECTOR_FACTS_CACHE = previous;
  }
});

const SOURCE = 'import "./dep.js";\n';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selector-facts-cache-"));
  roots.push(root);
  const cache = path.join(root, "cache", "facts.json");
  process.env.OPENCLAW_TEST_SELECTOR_FACTS_CACHE = cache;
  fs.writeFileSync(path.join(root, "value.ts"), SOURCE);
  const read = () =>
    readTestSelectorSourceFacts(root, [{ file: "value.ts", parseImports: true }], [], 1 << 20)[0]
      ?.imports;
  const key = (source: string) => createHash("sha1").update(source).digest("base64url");
  return { root, cache, read, key };
}

describe("test selector source facts cache", () => {
  it("caches import facts by content and reuses them", () => {
    const { cache, read, key } = setup();
    expect(read()).toEqual(["./dep.js"]);
    const stored = JSON.parse(fs.readFileSync(cache, "utf8"));
    expect(stored[key(SOURCE)]).toEqual([["./dep.js"], []]);
    // A planted entry proves the next scan reads the cache instead of parsing.
    stored[key(SOURCE)] = [["./planted.js"], []];
    fs.writeFileSync(cache, JSON.stringify(stored));
    expect(read()).toEqual(["./planted.js"]);
  });

  it("parses a changed file again", () => {
    const { root, read } = setup();
    expect(read()).toEqual(["./dep.js"]);
    fs.writeFileSync(path.join(root, "value.ts"), 'import "./other.js";\n');
    expect(read()).toEqual(["./other.js"]);
  });

  it("ignores a corrupt cache and turns off on request", () => {
    const { cache, read } = setup();
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, "{not json");
    expect(read()).toEqual(["./dep.js"]);
    expect(JSON.parse(fs.readFileSync(cache, "utf8"))).toBeTypeOf("object");
    process.env.OPENCLAW_TEST_SELECTOR_FACTS_CACHE = "0";
    fs.rmSync(cache);
    expect(read()).toEqual(["./dep.js"]);
    expect(fs.existsSync(cache)).toBe(false);
  });
});
