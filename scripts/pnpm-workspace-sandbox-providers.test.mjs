import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const providersRoot = path.join(root, "packages/plugins/sandbox-providers");

async function providerManifests(directory = providersRoot) {
  const manifests = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "image-build") manifests.push(...await providerManifests(target));
    else if (entry.isFile() && entry.name === "package.json") manifests.push(target);
  }
  return manifests.sort();
}

function selectWorkspaceImporter(packageName) {
  return spawnSync(
    "pnpm",
    ["--filter", packageName, "exec", "node", "-p", "process.cwd()"],
    { cwd: root, encoding: "utf8" },
  );
}

test("root pnpm workspace excludes every sandbox provider", async () => {
  const manifests = await providerManifests();
  const packageNames = await Promise.all(manifests.map(async (manifest) => {
    const value = JSON.parse(await readFile(manifest, "utf8"));
    return value.name;
  }));

  assert.ok(packageNames.includes("@paperclipai/plugin-daytona"), "Daytona provider manifest is missing");

  for (const packageName of packageNames) {
    const result = selectWorkspaceImporter(packageName);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.error, undefined, `pnpm could not run for ${packageName}`);
    assert.equal(result.status, 0, output);
    assert.match(output, /No projects matched the filters/, `${packageName} must remain excluded`);
  }
});

test("Daytona image build owns one isolated frozen-lock importer", async () => {
  const buildRoot = path.join(providersRoot, "daytona/image-build");
  const npmrc = await readFile(path.join(buildRoot, ".npmrc"), "utf8");
  const workspace = await readFile(path.join(buildRoot, "pnpm-workspace.yaml"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(buildRoot, "package.json"), "utf8"));
  const lock = await readFile(path.join(buildRoot, "pnpm-lock.yaml"), "utf8");

  assert.equal(npmrc.trim(), "shared-workspace-lockfile=false");
  assert.match(workspace, /^packages:\n  - \.\n$/);
  assert.equal(manifest.name, "@paperclipai/plugin-daytona");
  assert.equal(manifest.dependencies["@daytonaio/sdk"], "0.171.0");
  assert.equal(manifest.dependencies["@paperclipai/plugin-sdk"], "file:./local/plugin-sdk");
  assert.match(lock, /specifier: 0\.171\.0\n\s+version: 0\.171\.0\(ws@/);
  assert.match(lock, /specifier: file:\.\/local\/plugin-sdk\n\s+version: file:local\/plugin-sdk/);
  assert.match(lock, /'@paperclipai\/shared': file:local\/shared/);
  assert.equal([...lock.matchAll(/^  \.:$/gm)].length, 1, "isolated lock must contain exactly one importer");
});
