import { afterEach, describe, expect, it } from "vitest";
import {
  buildFullSuiteVitestRunPlans,
  resolveConsolidatedFullSuiteConfigs,
} from "../../scripts/test-projects.test-support.mts";

const TOOLING = "test/vitest/vitest.tooling.config.ts";
const INFRA = "test/vitest/vitest.infra.config.ts";
const KEYS = ["OPENCLAW_TEST_CONSOLIDATE_CONFIGS", "OPENCLAW_TEST_PROJECTS_LEAF_SHARDS"] as const;
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous[key];
    }
  }
});

function plansFor(consolidate: string | undefined) {
  process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = "1";
  if (consolidate === undefined) {
    delete process.env.OPENCLAW_TEST_CONSOLIDATE_CONFIGS;
  } else {
    process.env.OPENCLAW_TEST_CONSOLIDATE_CONFIGS = consolidate;
  }
  return buildFullSuiteVitestRunPlans([], process.cwd());
}

const configsOf = (plans: { config: string }[]) =>
  [...new Set(plans.map((plan) => plan.config))].toSorted();

describe("consolidated full-suite configs", () => {
  it("parses all, names and exclusions", () => {
    expect(resolveConsolidatedFullSuiteConfigs({}).has(TOOLING)).toBe(false);
    const named = resolveConsolidatedFullSuiteConfigs({
      OPENCLAW_TEST_CONSOLIDATE_CONFIGS: TOOLING,
    });
    expect(named.has(TOOLING)).toBe(true);
    expect(named.has(INFRA)).toBe(false);
    const allBut = resolveConsolidatedFullSuiteConfigs({
      OPENCLAW_TEST_CONSOLIDATE_CONFIGS: "all, -" + TOOLING,
    });
    expect(allBut.has(TOOLING)).toBe(false);
    expect(allBut.has(INFRA)).toBe(true);
  });

  it("runs a consolidated config as one process and keeps every config", () => {
    const chunked = plansFor(undefined);
    const merged = plansFor("all");
    expect(configsOf(merged)).toEqual(configsOf(chunked));
    expect(chunked.filter((plan) => plan.config === TOOLING).length).toBeGreaterThan(1);
    expect(merged.filter((plan) => plan.config === TOOLING)).toEqual([
      expect.objectContaining({ config: TOOLING, includePatterns: null }),
    ]);
    expect(merged.length).toBe(configsOf(merged).length);
  });

  it("leaves an excluded config chunked", () => {
    const plans = plansFor("all,-" + TOOLING);
    expect(plans.filter((plan) => plan.config === TOOLING).length).toBeGreaterThan(1);
    expect(plans.filter((plan) => plan.config === INFRA)).toHaveLength(1);
  });
});
