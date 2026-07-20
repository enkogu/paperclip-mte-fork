import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/adapter-plugin-store.js", () => ({
  listAdapterPlugins: vi.fn(() => []),
  getAdapterPluginsDir: vi.fn(() => ""),
  getAdapterPluginByType: vi.fn(() => undefined),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { isValidAdapterPackageName, loadExternalAdapterPackage } from "./plugin-loader.js";

const temporaryDirectories: string[] = [];

function createPackage(manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-adapter-loader-"));
  temporaryDirectories.push(packageDir);
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(manifest), "utf8");
  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(packageDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
  }
  return packageDir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("external adapter package containment", () => {
  it.each([
    ["adapter", true],
    ["@paperclip/adapter", true],
    ["../adapter", false],
    ["adapter/child", false],
    ["@paperclip/../adapter", false],
    ["adapter@latest", false],
  ])("validates npm package name %s", (packageName, valid) => {
    expect(isValidAdapterPackageName(packageName)).toBe(valid);
  });

  it("rejects an adapter entry point that escapes its package", async () => {
    const packageDir = createPackage({ main: "../outside.mjs" });

    await expect(loadExternalAdapterPackage("test-adapter", packageDir))
      .rejects.toThrow("escapes the adapter package root");
  });

  it("loads a module only when its resolved entry point stays inside the package", async () => {
    const packageDir = createPackage(
      { type: "module", main: "./dist/index.mjs" },
      {
        "dist/index.mjs": "export function createServerAdapter() { return { type: 'contained-test-adapter' }; }\n",
      },
    );

    await expect(loadExternalAdapterPackage("test-adapter", packageDir))
      .resolves.toMatchObject({ type: "contained-test-adapter" });
  });
});
