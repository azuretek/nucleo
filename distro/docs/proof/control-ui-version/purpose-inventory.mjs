import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = pathToFileURL(process.cwd() + "/");
const { makeEmptyPluginMetadataOwners } = await import(
  new URL("src/plugins/current-plugin-metadata.test-support.ts", root)
);
const { resolveProviderRequestPolicy } = await import(
  new URL("src/agents/provider-attribution.ts", root)
);
const policy = resolveProviderRequestPolicy(
  { provider: "openai", providerMetadataOwners: makeEmptyPluginMetadataOwners() },
  { OPENCLAW_VERSION: "2026.9.8", NUCLEO_VERSION: "0.0.1-dev.104" },
).policy;
assert.equal(policy.version, "2026.9.8");
assert.equal(policy.headers.version, "2026.9.8");
console.log(
  JSON.stringify({
    case: "current dual-version attribution",
    version: policy.version,
    headers: policy.headers,
  }),
);
const { resolveGatewayShutdownDrainBudget } = await import(
  new URL("src/cli/gateway-cli/run-loop-shutdown-budget.ts", root)
);
const budget = resolveGatewayShutdownDrainBudget({
  budget: { nativeStopBudget: true, timeoutMs: 330000, reserveMs: 10000 },
  action: "stop",
  forceRestart: false,
  restartWithoutSupervisor: false,
  acceptedAtMs: 0,
});
console.log(
  JSON.stringify({
    case: "stop budget",
    drainTimeoutMs: budget.drainTimeoutMs,
    forceExitMs: budget.forceExitMs,
  }),
);
