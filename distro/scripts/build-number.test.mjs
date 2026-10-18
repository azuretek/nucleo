import assert from "node:assert/strict";
import { test } from "node:test";
import { nextDevBuildNumber, tagNamesFromLsRemote } from "./build-number.mjs";

const version = "0.0.1";

test("a rebuilt branch with the same commit count still gets a higher number", () => {
  // Both builds of 2026-10-18 counted 102 commits from the pin.
  const tags = ["v0.0.1-dev.102.d7a3d68f43"];
  assert.equal(nextDevBuildNumber({ tags, version, sha: "2b17edcb88", fallback: 102 }), 103);
});

test("a commit that already has a dev tag keeps its number", () => {
  const tags = ["v0.0.1-dev.102.d7a3d68f43", "v0.0.1-dev.103.2b17edcb88"];
  assert.equal(nextDevBuildNumber({ tags, version, sha: "2b17edcb88", fallback: 102 }), 103);
  assert.equal(
    nextDevBuildNumber({ tags, version, sha: "2b17edcb881f047de64f", fallback: 1 }),
    103,
  );
});

test("the highest number wins, whatever order the tags come in", () => {
  const tags = [
    "v0.0.1-dev.110.aaaaaaaaaa",
    "v0.0.1-dev.99.bbbbbbbbbb",
    "v0.0.1-dev.104.cccccccccc",
  ];
  assert.equal(nextDevBuildNumber({ tags, version, sha: "dddddddddd", fallback: 1 }), 111);
});

test("other versions, full releases and unrelated tags do not count", () => {
  const tags = [
    "v0.0.2-dev.500.aaaaaaaaaa",
    "v0.0.1",
    "v2026.9.8",
    "v0.0.1-dev.x.bbbbbbbbbb",
    "v0x0x1-dev.700.cccccccccc",
  ];
  assert.equal(nextDevBuildNumber({ tags, version, sha: "dddddddddd", fallback: 7 }), 7);
});

test("ls-remote output becomes tag names without peeled entries", () => {
  const out =
    "abc\trefs/tags/v0.0.1-dev.102.d7a3d68f43\ndef\trefs/tags/v0.0.1-dev.102.d7a3d68f43^{}\n";
  assert.deepEqual(tagNamesFromLsRemote(out), ["v0.0.1-dev.102.d7a3d68f43"]);
});
