#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const runtimeRoot = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: node scripts/normalize-mte-workspace-exports.mjs <server-runtime-root>");
}

const scopeRoot = path.join(runtimeRoot, "node_modules/@paperclipai");

function productionExport(value) {
  if (typeof value === "string" && value.startsWith("./src/") && value.endsWith(".ts")) {
    return `./dist/${value.slice("./src/".length, -".ts".length)}.js`;
  }
  if (Array.isArray(value)) return value.map(productionExport);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, productionExport(child)]));
  }
  return value;
}

function productionManifest(manifest) {
  const normalized = { ...manifest };
  normalized.exports = manifest.publishConfig?.exports ?? productionExport(manifest.exports);
  for (const field of ["main", "types"]) {
    if (manifest.publishConfig?.[field]) normalized[field] = manifest.publishConfig[field];
  }
  return normalized;
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

async function packageDirectories() {
  const entries = await readdir(scopeRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => path.join(scopeRoot, entry.name));
}

const packages = await packageDirectories();
assert.ok(packages.length > 0, "deployed server has no @paperclipai workspace packages");
const internalEdges = [];

for (const packageDirectory of packages) {
  const manifestPath = path.join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.name?.startsWith("@paperclipai/")) continue;
  for (const dependency of Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@paperclipai/"))) {
    internalEdges.push({ from: manifest.name, dependency });
  }
  const normalized = productionManifest(manifest);
  if (JSON.stringify(normalized) !== JSON.stringify(manifest)) {
    await writeFile(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`);
  }
  for (const target of exportTargets(normalized.exports).filter((item) => item.startsWith("./dist/"))) {
    const targetPath = path.join(packageDirectory, target);
    const targetStat = target.includes("*")
      ? await stat(path.dirname(targetPath)).catch(() => null)
      : await stat(targetPath).catch(() => null);
    assert.ok(
      target.includes("*") ? targetStat?.isDirectory() : targetStat?.isFile(),
      `${manifest.name} production export is missing: ${target}`,
    );
  }
}

const serverManifest = JSON.parse(await readFile(path.join(runtimeRoot, "package.json"), "utf8"));
const internalDependencies = Object.keys(serverManifest.dependencies ?? {}).filter((name) => name.startsWith("@paperclipai/"));
for (const dependency of internalDependencies) {
  internalEdges.push({ from: serverManifest.name, dependency });
}
const closureRealPath = await realpath(runtimeRoot);
for (const { from, dependency } of internalEdges) {
  const dependencyDirectory = path.join(scopeRoot, dependency.slice("@paperclipai/".length));
  const resolved = await realpath(dependencyDirectory).catch(() => null);
  assert.ok(resolved, `${from} internal dependency is missing: ${dependency}`);
  const relative = path.relative(closureRealPath, resolved);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${from} dependency ${dependency} resolves outside the deployed server closure`,
  );
  const dependencyManifest = JSON.parse(await readFile(path.join(resolved, "package.json"), "utf8"));
  assert.equal(dependencyManifest.name, dependency, `${from} dependency identity does not match ${dependency}`);
}

console.log(
  JSON.stringify({ ok: true, internalDependencies: [...new Set(internalEdges.map(({ dependency }) => dependency))].sort() }),
);
