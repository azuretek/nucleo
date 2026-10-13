#!/usr/bin/env node
// Times the test step on the build machine, alone, so a test speed change can be measured without
// running the whole chain. It runs whatever the machine checkout holds, with the same machine.env the
// gate passes, and records the commit, whether the tree was dirty, the wall time, the memory peak and
// the slowest shards.
//
//   time-tests.mjs                      dry run: what would run, and on which commit
//   time-tests.mjs --apply [-- <path>...]  start a timed run (all tests, or only the given paths)
//   time-tests.mjs --apply --changed    only the tests the checkout's change selects against the pin
//   time-tests.mjs --apply --checkout=<dir> ...  run in another checkout on the machine, such as a
//                                       worktree holding one patch branch
//   time-tests.mjs --status             the latest run's state and summary
//   time-tests.mjs --watch              wait for the latest run to end, then print its summary
//
// One run at a time, and never during a chain: a second test run or a gate on the same machine
// would skew both measurements.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLING = join(HERE, "..");
const MANIFEST = JSON.parse(readFileSync(join(TOOLING, "nucleo.json"), "utf8"));
const LOCAL = join(TOOLING, "nucleo.local.json");
if (existsSync(LOCAL)) Object.assign(MANIFEST, JSON.parse(readFileSync(LOCAL, "utf8")));

const MACHINE = MANIFEST.machine?.ssh || "";
const CHECKOUT_FLAG = process.argv.slice(2).find((a) => a.startsWith("--checkout="));
const CHECKOUT = CHECKOUT_FLAG ? CHECKOUT_FLAG.slice(11) : MANIFEST.machine?.checkout || "";
if (CHECKOUT && !/^\/[A-Za-z0-9._/-]+$/.test(CHECKOUT)) {
  console.error("checkout refused: " + CHECKOUT);
  process.exit(2);
}
// Changed mode diffs the checkout against the pin, so on a patch branch it selects only what that
// patch touches. Upstream's own test:changed diffs against origin/main, which for us is the whole
// assembled distro.
const PIN = String(MANIFEST.pinnedCommit || "");
const MACHINE_LOGS = MANIFEST.machine?.logs || "";
const LOCK = join(MANIFEST.logs || join(TOOLING, "logs"), "pin-and-build.lock");
if ([MACHINE, CHECKOUT, MACHINE_LOGS].some((v) => !v || /USER|HOST/.test(v))) {
  console.error(
    "set machine.ssh, machine.checkout and machine.logs in nucleo.local.json for this host",
  );
  process.exit(2);
}

const ARGS = process.argv.slice(2);
const split = ARGS.indexOf("--");
const FLAGS = split < 0 ? ARGS : ARGS.slice(0, split);
const PATHS = split < 0 ? [] : ARGS.slice(split + 1);
const KNOWN = new Set(["--apply", "--changed", "--status", "--watch", "--help", "-h"]);
const unknown = FLAGS.filter((a) => !KNOWN.has(a) && !a.startsWith("--checkout="));
const CHANGED = FLAGS.includes("--changed");
if (CHANGED && !/^[0-9a-f]{40}$/.test(PIN)) {
  console.error("--changed needs pinnedCommit in nucleo.json");
  process.exit(2);
}
if (FLAGS.includes("--help") || FLAGS.includes("-h") || unknown.length) {
  if (unknown.length) console.error("unknown argument: " + unknown.join(" "));
  console.error(
    "usage: time-tests.mjs [--apply [--changed] [--checkout=<dir>] [-- <path>...]] | --status | --watch",
  );
  process.exit(unknown.length ? 2 : 0);
}
for (const p of PATHS) {
  if (!/^[A-Za-z0-9._/@-]+$/.test(p)) {
    console.error("test path refused: " + p);
    process.exit(2);
  }
}
// The same per-host settings the gate gets, checked the same way, so nothing reaches the remote
// shell unquoted.
const ENV = Object.entries(MANIFEST.machine?.env || {})
  .map(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !/^[A-Za-z0-9._,:/-]+$/.test(String(value))) {
      throw new Error("machine.env entry refused: " + name);
    }
    return "export " + name + "=" + value;
  })
  .join("\n");

const SSH = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=30",
  MACHINE,
];
const LATEST = MACHINE_LOGS + "/test-time-latest";
function ssh(script, timeoutMs) {
  return spawnSync("ssh", [...SSH, "bash -s"], {
    input: script,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
}
function show(script, timeoutMs = 60_000) {
  const r = ssh(script, timeoutMs);
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  return r.status ?? 1;
}
const SUMMARY = `cat "${LATEST}/state" "${LATEST}/info" 2>/dev/null || echo "no timed run yet"`;

if (FLAGS.includes("--status")) process.exit(show(SUMMARY));
if (FLAGS.includes("--watch")) {
  // Waits on the run's own state file, bounded by the longest a test step may take.
  process.exit(
    show(
      `end=$((SECONDS+21600)); while [ "$(cat "${LATEST}/state" 2>/dev/null)" = running ] && [ $SECONDS -lt $end ]; do sleep 20; done; ${SUMMARY}`,
      21_700_000,
    ),
  );
}

function chainRunning() {
  if (!existsSync(LOCK)) return false;
  const pid = Number(readFileSync(LOCK, "utf8").trim().split(" ")[0]);
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const target = (
  (CHANGED ? "(changed since pin " + PIN.slice(0, 12) + ") " : "") +
  (PATHS.length ? PATHS.join(" ") : CHANGED ? "" : "(all tests)")
).trim();
const TEST_COMMAND = CHANGED
  ? "node --import ./scripts/tsx.mjs scripts/test-projects.mts --changed " + PIN
  : "pnpm test";
// The bound ships with the run from this checkout: the checkout under test may be a patch worktree
// on the pin, which has no distro/ tree, or an older one without this script.
const COMPILE_CACHE_B64 = readFileSync(new URL("./compile-cache.mjs", import.meta.url)).toString(
  "base64",
);
const remote = `#!/usr/bin/env bash
set -u; umask 022
D=${MACHINE_LOGS}/test-time-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$D"; ln -sfn "$D" ${LATEST}
echo running > "$D/state"
cd ${CHECKOUT} || { echo "failed: checkout" > "$D/state"; exit 1; }
${ENV}
dirty=$(git status --porcelain --untracked-files=no | wc -l)
echo "commit $(git rev-parse --short HEAD) dirty_files=$dirty target=${target}" > "$D/info"
echo ${COMPILE_CACHE_B64} | base64 -d > "$D/compile-cache.mjs"
node "$D/compile-cache.mjs" >> "$D/info" 2>&1 || { echo "failed: compile cache bound" > "$D/state"; exit 1; }
env | grep -E '^(OPENCLAW_(TEST|VITEST|OXLINT)|NODE_COMPILE_CACHE)' | sort | tr '\\n' ' ' >> "$D/info"; echo >> "$D/info"
( while [ "$(cat "$D/state")" = running ]; do echo "$(date +%T) $(free -m | awk '/Mem:/{print $2, $3}') $(free -m | awk '/Swap:/{print $3}') $(pgrep -fc 'vitest.mjs run')"; sleep 30; done ) > "$D/mem.tsv" &
s=$(date +%s)
timeout 21600 ${TEST_COMMAND} ${PATHS.join(" ")} > "$D/test.log" 2>&1
rc=$?
echo "rc=$rc wall=$(( $(date +%s) - s ))s" >> "$D/info"
awk '{if($3>u)u=$3; if($2>t)t=$2; if($4>s)s=$4; if($5>c)c=$5} END{print "peak used MB " u ", peak total MB " t ", peak swap MB " s ", peak concurrent shards " c}' "$D/mem.tsv" >> "$D/info"
sed "s/\\x1b\\[[0-9;]*m//g" "$D/test.log" | grep -aE "Vitest shards|\\[test\\] (passed|FAILED|failed)" | tail -3 >> "$D/info"
sed "s/\\x1b\\[[0-9;]*m//g" "$D/test.log" | grep -aE "^ *FAIL " | sed -E "s/ [0-9]+ms$//" | sort -u | head -20 >> "$D/info"
if [ $rc = 0 ]; then echo done > "$D/state"; else echo "failed: rc=$rc" > "$D/state"; fi
`;

if (!FLAGS.includes("--apply")) {
  console.log("would time " + target + " on " + MACHINE + " in " + CHECKOUT + ", with:");
  console.log(ENV || "(no machine.env)");
  console.log("dry run: pass --apply to start it");
  process.exit(0);
}
if (chainRunning()) {
  console.error("a chain is running; a timed test run now would skew both");
  process.exit(1);
}
const busy = ssh(
  `[ "$(cat "${LATEST}/state" 2>/dev/null)" = running ] && echo busy; pgrep -f "nucleo.mjs gate" >/dev/null && echo gate; true`,
  60_000,
);
if (/busy|gate/.test(busy.stdout || "")) {
  console.error("the build machine is already running a timed test run or a gate");
  process.exit(1);
}
const start = ssh(
  `f=${MACHINE_LOGS}/test-time.sh; cat > "$f" <<'NUCLEO_EOF'\n${remote}NUCLEO_EOF\nchmod +x "$f"; setsid nohup "$f" >/dev/null 2>&1 < /dev/null & sleep 3; cat "${LATEST}/state" "${LATEST}/info"`,
  60_000,
);
process.stdout.write(start.stdout || "");
process.stderr.write(start.stderr || "");
console.log("follow it with: node scripts/time-tests.mjs --watch");
process.exit(start.status ?? 1);
