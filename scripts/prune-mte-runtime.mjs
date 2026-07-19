import { chmod, lstat, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || root === path.parse(root).root) {
  throw new Error("usage: node scripts/prune-mte-runtime.mjs <deployed-runtime-root>");
}

// The server can use the bundled PostgreSQL distribution for its own database.
// It is the only production dependency allowed to retain executable files.
// Agent harnesses, ACP bridges, package-manager CLIs, and their platform helper
// packages receive no name-based exemption.
const executablePackageAllowlist = new Set(["@embedded-postgres/linux-x64"]);
const manifestBinAllowlist = new Set();
const visitedDirectories = new Set();

async function readManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid runtime package manifest ${manifestPath}`, { cause: error });
  }
}

async function pruneManifest(packageDirectory, manifestPath, manifest) {
  if (!Object.hasOwn(manifest, "bin") || manifestBinAllowlist.has(manifest.name)) return;

  const targets = typeof manifest.bin === "string"
    ? [manifest.bin]
    : manifest.bin && typeof manifest.bin === "object"
      ? Object.values(manifest.bin)
      : [];
  for (const relativeTarget of targets) {
    if (typeof relativeTarget !== "string") continue;
    const target = path.resolve(packageDirectory, relativeTarget);
    const relative = path.relative(packageDirectory, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to prune bin outside ${packageDirectory}: ${relativeTarget}`);
    }
    await rm(target, { recursive: true, force: true });
  }

  delete manifest.bin;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function walk(directory, inheritedPackageName = null) {
  const canonicalDirectory = await realpath(directory);
  if (visitedDirectories.has(canonicalDirectory)) return;
  visitedDirectories.add(canonicalDirectory);
  const manifestPath = path.join(directory, "package.json");
  const manifestStat = await lstat(manifestPath).catch(() => null);
  let packageName = inheritedPackageName;
  if (manifestStat?.isFile()) {
    const manifest = await readManifest(manifestPath);
    packageName = typeof manifest.name === "string" ? manifest.name : null;
    await pruneManifest(directory, manifestPath, manifest);
    const currentManifestStat = await lstat(manifestPath);
    if ((currentManifestStat.mode & 0o111) !== 0 && !executablePackageAllowlist.has(packageName)) {
      await chmod(manifestPath, currentManifestStat.mode & ~0o111);
    }
  }

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.name === ".bin") {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    if (entry.isSymbolicLink()) {
      const resolved = await realpath(target);
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`runtime symlink escapes deployed root: ${target} -> ${resolved}`);
      }
      const resolvedStat = await stat(resolved);
      if (resolvedStat.isDirectory()) {
        await walk(resolved, packageName);
      } else if (resolvedStat.isFile() && (resolvedStat.mode & 0o111) !== 0 && !executablePackageAllowlist.has(packageName)) {
        await chmod(resolved, resolvedStat.mode & ~0o111);
      }
      continue;
    }
    if (entry.isDirectory()) {
      await walk(target, packageName);
      continue;
    }
    if (!entry.isFile() || entry.name === "package.json") continue;

    const stat = await lstat(target);
    if ((stat.mode & 0o111) !== 0 && !executablePackageAllowlist.has(packageName)) {
      await chmod(target, stat.mode & ~0o111);
    }
  }
}

await walk(root);
