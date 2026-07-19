import assert from "node:assert/strict";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && root !== path.parse(root).root, "runtime root argument is required");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const exists = async (file) => Boolean(await lstat(file).catch(() => null));
const directManifest = await lstat(path.join(root, "package.json")).catch(() => null);
const serverRoot = directManifest?.isFile() ? root : path.join(root, "server");
const closureRoot = directManifest?.isFile() ? path.dirname(root) : root;
const rootManifest = await readJson(path.join(serverRoot, "package.json"));
assert.equal(rootManifest.name, "@paperclipai/server", "runtime root must be the deployed server package");
assert.ok(await exists(path.join(serverRoot, "dist/index.js")), "server build output is missing");
assert.ok(await exists(path.join(serverRoot, "ui-dist/index.html")), "static UI output is missing");
assert.equal(await exists(path.join(closureRoot, "cli")), false, "the operator CLI must not be copied into the image");

// PostgreSQL is runtime infrastructure for the server itself, not an agent
// execution harness. No other dependency may expose a package bin or retain an
// executable file, including transitive ACP/harness platform packages whose
// names are intentionally unknown to this verifier.
const executablePackageAllowlist = new Set(["@embedded-postgres/linux-x64"]);
const manifestBinAllowlist = new Set();
const workspacePrefix = "@paperclipai/";
const visitedWorkspacePackages = new Set();
const inspectedManifests = new Set();
let inspectedFiles = 0;
const visitedDirectories = new Set();

async function resolvePackage(packageName, fromDirectory) {
  const segments = packageName.split("/");
  let current = fromDirectory;
  while (true) {
    const candidate = path.join(current, "node_modules", ...segments);
    if (await exists(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function verifyWorkspaceClosure(packageDirectory) {
  const manifest = await readJson(path.join(packageDirectory, "package.json"));
  if (visitedWorkspacePackages.has(manifest.name)) return;
  visitedWorkspacePackages.add(manifest.name);

  for (const dependency of Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith(workspacePrefix))) {
    const resolved = await resolvePackage(dependency, packageDirectory);
    assert.ok(resolved, `workspace runtime dependency is missing: ${manifest.name} -> ${dependency}`);
    await verifyWorkspaceClosure(resolved);
  }
}

async function walk(directory, inheritedPackageName = null) {
  const canonicalDirectory = await realpath(directory);
  if (visitedDirectories.has(canonicalDirectory)) return;
  visitedDirectories.add(canonicalDirectory);
  const manifestPath = path.join(directory, "package.json");
  const manifestStat = await lstat(manifestPath).catch(() => null);
  let packageName = inheritedPackageName;
  if (manifestStat?.isFile()) {
    const manifest = await readJson(manifestPath);
    inspectedManifests.add(manifestPath);
    packageName = typeof manifest.name === "string" ? manifest.name : null;
    assert.ok(
      !Object.hasOwn(manifest, "bin") || manifestBinAllowlist.has(packageName),
      `runtime package exposes a bin entry: ${packageName ?? manifestPath}`,
    );
  }

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(target).catch(() => {
        throw new Error(`broken runtime symlink: ${target}`);
      });
      assert.ok(!target.split(path.sep).includes(".bin"), `executable shim remains: ${target}`);
      const relative = path.relative(root, resolved);
      assert.ok(
        !relative.startsWith("..") && !path.isAbsolute(relative),
        `runtime symlink escapes deployed root: ${target} -> ${resolved}`,
      );
      const resolvedStat = await stat(resolved);
      if (resolvedStat.isDirectory()) {
        await walk(resolved, packageName);
      } else if (resolvedStat.isFile()) {
        inspectedFiles += 1;
        assert.ok(
          (resolvedStat.mode & 0o111) === 0 || executablePackageAllowlist.has(packageName),
          `executable symlink target outside the runtime allowlist: ${target} (package ${packageName ?? "<unknown>"})`,
        );
      }
      continue;
    }
    if (entry.isDirectory()) {
      assert.notEqual(entry.name, ".bin", `executable shim directory remains: ${target}`);
      await walk(target, packageName);
      continue;
    }
    if (!entry.isFile()) continue;
    inspectedFiles += 1;
    const stat = await lstat(target);
    assert.ok(
      (stat.mode & 0o111) === 0 || executablePackageAllowlist.has(packageName),
      `executable file outside the runtime allowlist: ${target} (package ${packageName ?? "<unknown>"})`,
    );
  }
}

await verifyWorkspaceClosure(serverRoot);
await walk(root);
assert.ok(visitedWorkspacePackages.has("@paperclipai/shared"), "workspace closure verification did not reach shared");
assert.ok(visitedWorkspacePackages.has("@paperclipai/db"), "workspace closure verification did not reach db");
assert.ok(inspectedManifests.size > visitedWorkspacePackages.size, "transitive package manifests were not inspected");
assert.ok(inspectedFiles > 0, "runtime file inspection did not execute");
console.log(
  `MTE runtime closure verified (${visitedWorkspacePackages.size} workspace packages, ${inspectedManifests.size} manifests, ${inspectedFiles} files)`,
);
