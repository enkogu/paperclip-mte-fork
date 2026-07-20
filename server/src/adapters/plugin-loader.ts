/**
 * External adapter plugin loader.
 *
 * Loads external adapter packages from the adapter-plugin-store and returns
 * their ServerAdapterModule instances. The caller (registry.ts) is
 * responsible for registering them.
 *
 * This avoids circular initialization: plugin-loader imports only
 * adapter-utils, never registry.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerAdapterModule } from "./types.js";
import { logger } from "../middleware/logger.js";

import {
  listAdapterPlugins,
  getAdapterPluginsDir,
  getAdapterPluginByType,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";

// ---------------------------------------------------------------------------
// In-memory UI parser cache
// ---------------------------------------------------------------------------

const uiParserCache = new Map<string, string>();

export function getUiParserSource(adapterType: string): string | undefined {
  return uiParserCache.get(adapterType);
}

/**
 * On cache miss, attempt on-demand extraction from the plugin store.
 * Makes the ui-parser.js endpoint self-healing.
 */
export function getOrExtractUiParserSource(adapterType: string): string | undefined {
  const cached = uiParserCache.get(adapterType);
  if (cached) return cached;

  const record = getAdapterPluginByType(adapterType);
  if (!record) return undefined;

  const packageDir = resolvePackageDir(record);
  const pkg = readAdapterPackage(packageDir);
  const source = extractUiParserSource(pkg, record.packageName);
  if (source) {
    uiParserCache.set(adapterType, source);
    logger.info(
      { type: adapterType, packageName: record.packageName, origin: "lazy" },
      "UI parser extracted on-demand (cache miss)",
    );
  }
  return source;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function isValidAdapterPackageName(packageName: string): boolean {
  return packageName.length > 0
    && packageName.length <= 214
    && NPM_PACKAGE_NAME_PATTERN.test(packageName);
}

function resolvePackageDir(record: Pick<AdapterPluginRecord, "localPath" | "packageName">): string {
  if (record.localPath) return path.resolve(record.localPath);
  if (!isValidAdapterPackageName(record.packageName)) {
    throw new Error(`Invalid adapter npm package name: "${record.packageName}".`);
  }
  return path.resolve(getAdapterPluginsDir(), "node_modules", record.packageName);
}

interface AdapterPackageManifest {
  main?: unknown;
  exports?: unknown;
  paperclip?: { adapterUiParser?: unknown };
}

interface AdapterPackage {
  root: string;
  manifest: AdapterPackageManifest;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readAdapterPackage(packageDir: string): AdapterPackage {
  const root = fs.realpathSync(packageDir);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Adapter package root is not a directory: "${packageDir}".`);
  }

  const packageJsonPath = fs.realpathSync(path.join(root, "package.json"));
  if (!isContainedPath(root, packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) {
    throw new Error("Adapter package.json must be a file inside the package root.");
  }

  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Adapter package.json must contain a JSON object.");
  }
  return { root, manifest: parsed as AdapterPackageManifest };
}

function resolveExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const conditions = value as Record<string, unknown>;
  return resolveExportTarget(conditions.import)
    ?? resolveExportTarget(conditions.node)
    ?? resolveExportTarget(conditions.default);
}

function resolveContainedPackageFile(packageRoot: string, target: string, label: string): string {
  if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new Error(`${label} must be a relative path inside the adapter package.`);
  }

  const unresolvedPath = path.resolve(packageRoot, target);
  if (!isContainedPath(packageRoot, unresolvedPath)) {
    throw new Error(`${label} escapes the adapter package root.`);
  }

  const realPath = fs.realpathSync(unresolvedPath);
  if (!isContainedPath(packageRoot, realPath) || !fs.statSync(realPath).isFile()) {
    throw new Error(`${label} must resolve to a file inside the adapter package root.`);
  }
  return realPath;
}

function resolvePackageEntryPoint(pkg: AdapterPackage): string {
  const exportsField = pkg.manifest.exports;
  const rootExport = exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)
    ? (exportsField as Record<string, unknown>)["."]
    : undefined;
  const entryPoint = resolveExportTarget(rootExport)
    ?? (typeof pkg.manifest.main === "string" ? pkg.manifest.main : undefined);

  if (!entryPoint) {
    throw new Error("Adapter package.json must declare a main entry or exports['.'] target.");
  }
  return resolveContainedPackageFile(pkg.root, entryPoint, "Adapter package entry point");
}

// ---------------------------------------------------------------------------
// UI parser extraction
// ---------------------------------------------------------------------------

const SUPPORTED_PARSER_CONTRACT = "1";

function extractUiParserSource(
  pkg: AdapterPackage,
  packageName: string,
): string | undefined {
  const exportsField = pkg.manifest.exports;
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return undefined;
  }
  const uiParserExp = (exportsField as Record<string, unknown>)["./ui-parser"];
  if (uiParserExp === undefined) return undefined;

  const contractVersion = pkg.manifest.paperclip?.adapterUiParser;
  if (typeof contractVersion === "string" && contractVersion) {
    const major = contractVersion.split(".")[0];
    if (major !== SUPPORTED_PARSER_CONTRACT) {
      logger.warn(
        { packageName, contractVersion, supported: `${SUPPORTED_PARSER_CONTRACT}.x` },
        "Adapter declares unsupported UI parser contract version — skipping UI parser",
      );
      return undefined;
    }
  } else {
    logger.info(
      { packageName },
      "Adapter has ./ui-parser export but no paperclip.adapterUiParser version — loading anyway (future versions may require it)",
    );
  }

  const uiParserFile = resolveExportTarget(uiParserExp);
  if (!uiParserFile) {
    throw new Error("Adapter exports['./ui-parser'] must declare an import, node, or default file target.");
  }
  const uiParserPath = resolveContainedPackageFile(pkg.root, uiParserFile, "Adapter UI parser export");

  try {
    const source = fs.readFileSync(uiParserPath, "utf-8");
    logger.info(
      { packageName, uiParserFile, size: source.length },
      `Loaded UI parser from adapter package${contractVersion ? "" : " (no version declared)"}`,
    );
    return source;
  } catch (err) {
    logger.warn({ err, packageName, uiParserFile }, "Failed to read UI parser from adapter package");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Load / reload
// ---------------------------------------------------------------------------

function validateAdapterModule(mod: unknown, packageName: string): ServerAdapterModule {
  const m = mod as Record<string, unknown>;
  const createServerAdapter = m.createServerAdapter;
  if (typeof createServerAdapter !== "function") {
    throw new Error(
      `Package "${packageName}" does not export createServerAdapter(). ` +
      `Ensure the package's main entry exports a createServerAdapter function.`,
    );
  }

  const adapterModule = createServerAdapter() as ServerAdapterModule;
  if (!adapterModule || !adapterModule.type) {
    throw new Error(
      `createServerAdapter() from "${packageName}" returned an invalid module (missing "type").`,
    );
  }
  return adapterModule;
}

export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
): Promise<ServerAdapterModule> {
  if (!localPath && !isValidAdapterPackageName(packageName)) {
    throw new Error(`Invalid adapter npm package name: "${packageName}".`);
  }
  const packageDir = localPath
    ? path.resolve(localPath)
    : path.resolve(getAdapterPluginsDir(), "node_modules", packageName);

  const pkg = readAdapterPackage(packageDir);
  const modulePath = resolvePackageEntryPoint(pkg);
  const uiParserSource = extractUiParserSource(pkg, packageName);

  logger.info({ packageName, packageDir: pkg.root, modulePath, hasUiParser: !!uiParserSource }, "Loading external adapter package");

  const mod = await import(pathToFileURL(modulePath).href);
  const adapterModule = validateAdapterModule(mod, packageName);

  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  return adapterModule;
}

async function loadFromRecord(record: AdapterPluginRecord): Promise<ServerAdapterModule | null> {
  try {
    return await loadExternalAdapterPackage(record.packageName, record.localPath);
  } catch (err) {
    logger.warn(
      { err, packageName: record.packageName, type: record.type },
      "Failed to dynamically load external adapter; skipping",
    );
    return null;
  }
}

/**
 * Reload an external adapter at runtime (dev iteration without server restart).
 * Busts the ESM module cache via a cache-busting query string.
 */
export async function reloadExternalAdapter(
  type: string,
): Promise<ServerAdapterModule | null> {
  const record = getAdapterPluginByType(type);
  if (!record) return null;

  const packageDir = resolvePackageDir(record);
  const pkg = readAdapterPackage(packageDir);
  const modulePath = resolvePackageEntryPoint(pkg);
  const fileUrl = pathToFileURL(modulePath).href;

  // Bust ESM module cache so re-import loads fresh code from disk.
  // Query-string trick (?t=...) works in Node; Bun may need the file:// URL
  // to be evicted from its internal registry first.
  try {
    // @ts-expect-error -- Bun internal module cache
    const bunCache = globalThis.Bun?.__moduleCache as Map<string, unknown> | undefined;
    if (bunCache) {
      bunCache.delete(fileUrl);
      bunCache.delete(modulePath);
    }
  } catch {
    // Ignore — query-string fallback still works in Node
  }

  const cacheBustUrl = `${fileUrl}?t=${Date.now()}`;

  logger.info(
    { type, packageName: record.packageName, modulePath, cacheBustUrl },
    "Reloading external adapter (cache bust)",
  );

  const mod = await import(cacheBustUrl);
  const adapterModule = validateAdapterModule(mod, record.packageName);

  uiParserCache.delete(type);
  const uiParserSource = extractUiParserSource(pkg, record.packageName);
  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  logger.info(
    { type, packageName: record.packageName, hasUiParser: !!uiParserSource },
    "Successfully reloaded external adapter",
  );

  return adapterModule;
}

/**
 * Build all external adapter modules from the plugin store.
 */
export async function buildExternalAdapters(): Promise<ServerAdapterModule[]> {
  const results: ServerAdapterModule[] = [];

  const storeRecords = listAdapterPlugins();
  for (const record of storeRecords) {
    const adapter = await loadFromRecord(record);
    if (adapter) {
      results.push(adapter);
    }
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, adapters: results.map((a) => a.type) },
      "Loaded external adapters from plugin store",
    );
  }

  return results;
}
