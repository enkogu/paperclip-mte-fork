import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveContainedDevServerFile,
  startPluginDevServer,
  type PluginDevServer,
} from "../src/dev-server.js";

describe("plugin SDK dev server containment", () => {
  const tempRoots: string[] = [];
  const servers: PluginDevServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeFixture() {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sdk-dev-server-"));
    tempRoots.push(tempRoot);
    const rootDir = path.join(tempRoot, "plugin");
    const uiDir = path.join(rootDir, "dist", "ui");
    const siblingDir = path.join(tempRoot, "plugin-sibling");
    await fs.mkdir(uiDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(uiDir, "index.js"), "export const ok = true;", "utf8");
    await fs.writeFile(path.join(siblingDir, "secret.js"), "secret", "utf8");
    await fs.symlink(path.join(siblingDir, "secret.js"), path.join(uiDir, "escape.js"));
    return { tempRoot, rootDir, uiDir, siblingDir };
  }

  it("uniformly denies raw, encoded, double-encoded, sibling, and symlink escapes", async () => {
    const { uiDir, siblingDir } = await makeFixture();
    const realUiDir = await fs.realpath(uiDir);
    const attacks = [
      "../plugin-sibling/secret.js",
      "/%2e%2e%2fplugin-sibling%2fsecret.js",
      "/%252e%252e%252fplugin-sibling%252fsecret.js",
      path.relative(uiDir, path.join(siblingDir, "secret.js")),
      "/escape.js",
    ];

    for (const attack of attacks) {
      expect(resolveContainedDevServerFile(realUiDir, attack)).toEqual({
        ok: false,
        reason: "denied",
      });
    }
  });

  it("serves valid root and query-string requests", async () => {
    const { rootDir } = await makeFixture();
    const server = await startPluginDevServer({ rootDir, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/?cache-bust=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    await expect(response.text()).resolves.toBe("export const ok = true;");
  });

  it("rejects configured UI directories outside the real plugin root", async () => {
    const { rootDir, siblingDir } = await makeFixture();
    await fs.symlink(siblingDir, path.join(rootDir, "linked-ui"));

    await expect(startPluginDevServer({ rootDir, uiDir: "../plugin-sibling", port: 0 }))
      .rejects.toThrow("UI directory must stay within the plugin root");
    await expect(startPluginDevServer({ rootDir, uiDir: "linked-ui", port: 0 }))
      .rejects.toThrow("UI directory must stay within the plugin root");
    await expect(startPluginDevServer({ rootDir, uiDir: "linked-ui/new-ui", port: 0 }))
      .rejects.toThrow("UI directory must stay within the plugin root");
    await expect(fs.stat(path.join(siblingDir, "new-ui"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
