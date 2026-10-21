import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveBoundaryDtsTimeoutMs,
  runNodeStep,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";

test("boundary declaration timeout reaches the managed child lifecycle", async () => {
  assert.equal(resolveBoundaryDtsTimeoutMs({}), 300_000);
  assert.equal(resolveBoundaryDtsTimeoutMs({ OPENCLAW_BOUNDARY_DTS_TIMEOUT_MS: " 25 " }), 25);
  assert.throws(() => resolveBoundaryDtsTimeoutMs({ OPENCLAW_BOUNDARY_DTS_TIMEOUT_MS: "invalid" }));
  await assert.rejects(
    runNodeStep(
      "fixture boundary dts",
      ["--eval", "setInterval(() => {}, 1000)"],
      resolveBoundaryDtsTimeoutMs({ OPENCLAW_BOUNDARY_DTS_TIMEOUT_MS: "25" }),
    ),
    /fixture boundary dts timed out after 25ms/,
  );
  await runNodeStep(
    "fixture boundary dts",
    ["--eval", "process.stdout.write('emitted')"],
    resolveBoundaryDtsTimeoutMs({}),
  );
});
