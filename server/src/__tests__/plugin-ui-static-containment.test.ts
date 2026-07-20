import express from "express";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import {
  pluginUiStaticRoutes,
  resolveContainedPluginUiFile,
  resolvePluginUiDir,
} from "../routes/plugin-ui-static.js";

describe("plugin UI static containment", () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getConfig.mockResolvedValue(null);
  });

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeFixture() {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-ui-"));
    tempRoots.push(tempRoot);
    const packageRoot = path.join(tempRoot, "plugin");
    const uiDir = path.join(packageRoot, "dist", "ui");
    const siblingDir = path.join(tempRoot, "plugin-sibling");
    await fs.mkdir(uiDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(uiDir, "index.js"), "export const ok = true;", "utf8");
    await fs.writeFile(path.join(uiDir, "chunk-a1b2c3d4.js"), "hashed", "utf8");
    await fs.writeFile(path.join(siblingDir, "secret.js"), "secret", "utf8");
    await fs.symlink(path.join(siblingDir, "secret.js"), path.join(uiDir, "escape.js"));
    return { tempRoot, packageRoot, uiDir, siblingDir };
  }

  it("uniformly denies raw, encoded, double-encoded, sibling, and symlink escapes", async () => {
    const { uiDir, siblingDir } = await makeFixture();
    const attacks = [
      "../plugin-sibling/secret.js",
      "%2e%2e%2fplugin-sibling%2fsecret.js",
      "%252e%252e%252fplugin-sibling%252fsecret.js",
      path.relative(uiDir, path.join(siblingDir, "secret.js")),
      "escape.js",
    ];

    for (const attack of attacks) {
      expect(resolveContainedPluginUiFile(uiDir, attack)).toEqual({
        ok: false,
        reason: "denied",
      });
    }
  });

  it("requires the manifest UI entrypoint realpath to remain under the package root", async () => {
    const { tempRoot, packageRoot, uiDir, siblingDir } = await makeFixture();
    await fs.symlink(siblingDir, path.join(packageRoot, "linked-ui"));

    expect(resolvePluginUiDir(tempRoot, "unused", "./dist/ui", packageRoot)).toBe(
      await fs.realpath(uiDir),
    );
    expect(resolvePluginUiDir(tempRoot, "unused", "../plugin-sibling", packageRoot)).toBeNull();
    expect(resolvePluginUiDir(tempRoot, "unused", "./linked-ui", packageRoot)).toBeNull();
  });

  it("preserves valid file, range, ETag, and immutable-cache responses", async () => {
    const { tempRoot, packageRoot } = await makeFixture();
    mockRegistry.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      pluginKey: "paperclip.test",
      packageName: "paperclip-test",
      packagePath: packageRoot,
      status: "ready",
      manifestJson: { entrypoints: { ui: "./dist/ui" } },
    });

    const app = express();
    app.use(pluginUiStaticRoutes({} as never, { localPluginDir: tempRoot }));

    const ranged = await request(app)
      .get("/_plugins/11111111-1111-4111-8111-111111111111/ui/index.js")
      .set("Range", "bytes=0-5");
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-range"]).toMatch(/^bytes 0-5\//);
    expect(ranged.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(ranged.headers.etag).toMatch(/^"[a-f0-9]{16}"$/);

    const hashed = await request(app)
      .get("/_plugins/11111111-1111-4111-8111-111111111111/ui/chunk-a1b2c3d4.js");
    expect(hashed.status).toBe(200);
    expect(hashed.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});
