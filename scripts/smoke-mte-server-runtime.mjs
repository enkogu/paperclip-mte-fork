#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const serverRoot = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("usage: node scripts/smoke-mte-server-runtime.mjs <server-runtime-root>");
}

const stateRoot = await mkdtemp(path.join(tmpdir(), "paperclip-mte-server-smoke-"));
const port = 20_000 + (process.pid % 20_000);
const output = [];
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: serverRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOME: stateRoot,
    HOST: "127.0.0.1",
    PORT: String(port),
    SERVE_UI: "false",
    PAPERCLIP_HOME: stateRoot,
    PAPERCLIP_INSTANCE_ID: "mte-image-smoke",
    PAPERCLIP_CONFIG: path.join(stateRoot, "config.json"),
    PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    PAPERCLIP_MIGRATION_PROMPT: "never",
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
  },
});

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output.push(chunk);
    if (output.join("").length > 16_384) output.shift();
  });
}

let exitResult;
child.once("exit", (code, signal) => {
  exitResult = { code, signal };
});

try {
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline && !exitResult) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(healthy, `server runtime smoke failed before health: ${JSON.stringify(exitResult)}\n${output.join("")}`);
} finally {
  if (!exitResult) child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(stateRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, entrypoint: "node dist/index.js" }));
