#!/usr/bin/env node
// Live status of the Núcleo chain, read from the events both hosts write as they happen.
//
//   node distro/scripts/chain-status.mjs                        one snapshot
//   node distro/scripts/chain-status.mjs --watch                stream events, exit at the chain end
//   node distro/scripts/chain-status.mjs --watch --until=change exit at the next event of any kind
//
// ★ No polling loop. tail -F follows each events file as it is written, and tail --pid ends the
// local follower when the driver process dies, so a driver killed without a terminal event is
// reported the moment it happens rather than waited on.
//
// Exit codes: 0 green or already covered, 1 red, 2 nothing running, 3 driver died without a result.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLING = join(HERE, "..");
const MANIFEST = JSON.parse(readFileSync(join(TOOLING, "nucleo.json"), "utf8"));
const LOCAL = join(TOOLING, "nucleo.local.json");
if (existsSync(LOCAL)) {
  const local = JSON.parse(readFileSync(LOCAL, "utf8"));
  Object.assign(MANIFEST, { ...local, machine: { ...MANIFEST.machine, ...local.machine } });
}
const LOG_DIR = MANIFEST.logs;
const EVENTS = join(LOG_DIR, "events.log");
const LOCK = join(LOG_DIR, "pin-and-build.lock");
const MACHINE = MANIFEST.machine?.ssh || "";
const MACHINE_LOGS = MANIFEST.machine?.logs || "";
if ([LOG_DIR, MACHINE, MACHINE_LOGS].some((v) => !v || /USER|HOST/.test(v))) {
  console.error("set logs, machine.ssh and machine.logs in nucleo.local.json for this host");
  process.exit(2);
}

const ARGS = process.argv.slice(2);
const WATCH = ARGS.includes("--watch");
const UNTIL = (ARGS.find((a) => a.startsWith("--until=")) || "--until=terminal").slice(8);
const SSH = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=30",
  MACHINE,
];

function lockHolder() {
  if (!existsSync(LOCK)) return null;
  const [pid, ms] = readFileSync(LOCK, "utf8").trim().split(" ");
  let alive = false;
  try {
    process.kill(Number(pid), 0);
    alive = true;
  } catch (e) {
    alive = e.code === "EPERM";
  }
  return { pid: Number(pid), since: new Date(Number(ms)).toISOString(), alive };
}

const remote = (cmd) => spawnSync("ssh", [...SSH, cmd], { encoding: "utf8", timeout: 30000 });
const localTail = (file, n) =>
  existsSync(file) ? spawnSync("tail", ["-n", String(n), file], { encoding: "utf8" }).stdout : "";

function snapshot() {
  const holder = lockHolder();
  console.log(
    holder
      ? "driver pid " +
          holder.pid +
          " since " +
          holder.since +
          (holder.alive ? " (running)" : " (DEAD, stale lock)")
      : "driver: not running",
  );
  console.log("--- pool events");
  process.stdout.write(localTail(EVENTS, 8) || "(none)\n");
  const m = remote("tail -n 8 " + MACHINE_LOGS + "/events.log 2>/dev/null");
  console.log("--- machine events");
  process.stdout.write(m.stdout || "(none)\n");
  // The step that has started and not yet ended is the live one; show the tail of its own log.
  const lines = (m.stdout || "").trim().split("\n");
  const last = lines[lines.length - 1] || "";
  const live = last.match(/gate step (\S+) start log=(\S+)/);
  if (live) {
    console.log("--- live step " + live[1]);
    process.stdout.write(remote("tail -n 12 " + live[2]).stdout || "");
  }
  return holder;
}

function watch() {
  const holder = lockHolder();
  if (!holder || !holder.alive) {
    snapshot();
    console.log("nothing running to watch");
    process.exit(2);
  }
  console.log("watching driver pid " + holder.pid + " until " + UNTIL);
  const children = [];
  let done = false;
  const finish = (code, why) => {
    if (done) return;
    done = true;
    if (why) console.log(why);
    for (const c of children) c.kill();
    process.exit(code);
  };
  const follow = (label, child) => {
    children.push(child);
    createInterface({ input: child.stdout }).on("line", (line) => {
      console.log("[" + label + "] " + line);
      if (UNTIL === "change") finish(0);
      const end = line.match(/chain (GREEN|RED|COVERED)/);
      if (end) finish(end[1] === "RED" ? 1 : 0);
    });
  };
  const pool = spawn("tail", ["-n0", "-F", "--pid=" + holder.pid, EVENTS], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  follow("pool", pool);
  pool.on("close", () => {
    snapshot();
    finish(3, "the driver exited without a terminal event");
  });
  let restarts = 0;
  const machine = () => {
    const c = spawn("ssh", [...SSH, "tail -n0 -F " + MACHINE_LOGS + "/events.log"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    follow("machine", c);
    // A dropped connection is re-opened when it drops, not on a schedule.
    c.on("close", () => {
      if (!done && restarts++ < 50) machine();
    });
  };
  machine();
}

if (WATCH) watch();
else snapshot();
