import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const pruneScript = path.join(repoRoot, "scripts/prune-mte-runtime.mjs");
const verifyScript = path.join(repoRoot, "scripts/verify-mte-runtime.mjs");

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeFixture() {
  const parent = await mkdtemp(path.join(tmpdir(), "paperclip-mte-closure-"));
  const root = path.join(parent, "server");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "ui-dist"), { recursive: true });
  await writeFile(path.join(root, "dist/index.js"), "export {};\n");
  await writeFile(path.join(root, "ui-dist/index.html"), "<!doctype html>\n");
  await writeJson(path.join(root, "package.json"), {
    name: "@paperclipai/server",
    dependencies: {
      "@paperclipai/shared": "1.0.0",
      "@paperclipai/db": "1.0.0",
      "mystery-harness-platform": "1.0.0",
      "@embedded-postgres/linux-x64": "18.1.0",
    },
  });
  await writeJson(path.join(root, "node_modules/@paperclipai/shared/package.json"), {
    name: "@paperclipai/shared",
  });
  await writeJson(path.join(root, "node_modules/@paperclipai/db/package.json"), {
    name: "@paperclipai/db",
  });

  const harnessDir = path.join(root, "node_modules/mystery-harness-platform");
  await writeJson(path.join(harnessDir, "package.json"), {
    name: "mystery-harness-platform",
    bin: { mystery: "bin/mystery" },
  });
  await mkdir(path.join(harnessDir, "bin"), { recursive: true });
  await writeFile(path.join(harnessDir, "bin/mystery"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(harnessDir, "bin/mystery"), 0o755);
  await writeFile(path.join(harnessDir, "unlisted-helper"), "binary fixture\n");
  await chmod(path.join(harnessDir, "unlisted-helper"), 0o755);
  await mkdir(path.join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(path.join(root, "node_modules/.bin/mystery"), "shim\n");

  const postgresDir = path.join(root, "node_modules/@embedded-postgres/linux-x64");
  await writeJson(path.join(postgresDir, "package.json"), {
    name: "@embedded-postgres/linux-x64",
  });
  await mkdir(path.join(postgresDir, "bin"), { recursive: true });
  await writeFile(path.join(postgresDir, "bin/postgres"), "postgres fixture\n");
  await chmod(path.join(postgresDir, "bin/postgres"), 0o755);
  return { parent, root, harnessDir, postgresDir };
}

function run(script, root) {
  return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

test("pruner neutralizes unknown transitive executable packages and keeps only the runtime exemption", async () => {
  const fixture = await makeFixture();
  try {
    assert.notEqual(run(verifyScript, fixture.root).status, 0, "unsafe fixture must fail verification");
    const pruned = run(pruneScript, fixture.root);
    assert.equal(pruned.status, 0, pruned.stderr);
    const verified = run(verifyScript, fixture.root);
    assert.equal(verified.status, 0, verified.stderr);
    await assert.rejects(() => stat(path.join(fixture.harnessDir, "bin/mystery")));
    assert.equal((await stat(path.join(fixture.harnessDir, "unlisted-helper"))).mode & 0o111, 0);
    assert.notEqual((await stat(path.join(fixture.postgresDir, "bin/postgres"))).mode & 0o111, 0);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("pruner follows symlinks that stay inside the deployed closure", async () => {
  const fixture = await makeFixture();
  try {
    await symlink("@paperclipai/shared", path.join(fixture.root, "node_modules/shared-runtime-link"));
    const pruned = run(pruneScript, fixture.root);
    assert.equal(pruned.status, 0, pruned.stderr);
    const verified = run(verifyScript, fixture.root);
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("pruner removes symlinks that escape the deployed closure", async () => {
  const fixture = await makeFixture();
  try {
    const outside = path.join(fixture.parent, "source-workspace-package");
    await writeFile(outside, "source fixture\n");
    const escapingLink = path.join(fixture.root, "node_modules/source-workspace-link");
    await symlink(outside, escapingLink);
    const pruned = run(pruneScript, fixture.root);
    assert.equal(pruned.status, 0, pruned.stderr);
    await assert.rejects(() => stat(escapingLink));
    const verified = run(verifyScript, fixture.root);
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("verifier rejects an executable transitive file even without a manifest bin field", async () => {
  const fixture = await makeFixture();
  try {
    await writeJson(path.join(fixture.harnessDir, "package.json"), { name: "mystery-harness-platform" });
    await rm(path.join(fixture.harnessDir, "bin"), { recursive: true, force: true });
    await rm(path.join(fixture.root, "node_modules/.bin"), { recursive: true, force: true });
    const result = run(verifyScript, fixture.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /executable file outside the runtime allowlist/);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("verifier rejects a broken symlink anywhere in the deployed closure", async () => {
  const fixture = await makeFixture();
  try {
    assert.equal(run(pruneScript, fixture.root).status, 0);
    await symlink("missing-target", path.join(fixture.root, "node_modules/broken-runtime-link"));
    const result = run(verifyScript, fixture.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /broken runtime symlink/);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("verifier rejects a symlink that escapes the deployed closure", async () => {
  const fixture = await makeFixture();
  try {
    assert.equal(run(pruneScript, fixture.root).status, 0);
    const outside = path.join(fixture.parent, "outside-runtime-file");
    await writeFile(outside, "outside fixture\n");
    await symlink(outside, path.join(fixture.root, "node_modules/escaping-runtime-link"));
    const result = run(verifyScript, fixture.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime symlink escapes deployed root/);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("verifier scans sibling plugin content when passed the image closure root", async () => {
  const fixture = await makeFixture();
  try {
    assert.equal(run(pruneScript, fixture.root).status, 0);
    const closureRoot = fixture.parent;
    const pluginDir = path.join(closureRoot, "plugins/daytona");
    await writeJson(path.join(pluginDir, "package.json"), { name: "@paperclipai/plugin-daytona" });
    await writeFile(path.join(pluginDir, "unexpected-executable"), "fixture\n");
    await chmod(path.join(pluginDir, "unexpected-executable"), 0o755);
    const result = run(verifyScript, closureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /executable file outside the runtime allowlist/);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
