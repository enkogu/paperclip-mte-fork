import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const verifier = path.join(repoRoot, "scripts/verify-mte-image-abi.mjs");
const abiSource = path.join(repoRoot, "scripts/mte-image-abi.json");

async function writePackage(root, relative, manifest, outputs = []) {
  const directory = path.join(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
  for (const output of outputs) {
    const target = path.join(directory, output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "export {};\n");
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-mte-abi-"));
  await mkdir(path.join(root, "image-abi"), { recursive: true });
  await writeFile(path.join(root, "image-abi/manifest.json"), await readFile(abiSource));
  await writePackage(root, "plugins/daytona", {
    name: "@paperclipai/plugin-daytona",
    dependencies: { "@daytonaio/sdk": "0.175.0", "@paperclipai/plugin-sdk": "file:./local/plugin-sdk" },
  }, ["dist/manifest.js", "dist/worker.js"]);
  await writePackage(root, "plugins/daytona/node_modules/@daytonaio/sdk", { name: "@daytonaio/sdk" });
  await writePackage(root, "plugins/daytona/node_modules/@paperclipai/plugin-sdk", {
    name: "@paperclipai/plugin-sdk",
    version: "1.0.0",
    dependencies: { "@paperclipai/shared": "file:../shared" },
  });
  await writePackage(root, "plugins/daytona/local/plugin-sdk/node_modules/@paperclipai/shared", {
    name: "@paperclipai/shared",
  });
  await writePackage(root, "server/node_modules/@paperclipai/adapter-pi-local", { name: "@paperclipai/adapter-pi-local" });
  await writePackage(root, "server/node_modules/@aws-sdk/client-s3", { name: "@aws-sdk/client-s3" });
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [verifier, root], {
    encoding: "utf8",
    env: { ...process.env, MTE_IMAGE_ABI_MANIFEST: path.join(root, "image-abi/manifest.json") },
  });
}

test("image ABI verifier accepts the exact control-plane package closure", async () => {
  const root = await fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image ABI verifier fails when a discoverable package path is absent", async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, "plugins/daytona/node_modules/@daytonaio/sdk"), { recursive: true, force: true });
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ABI package manifest is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image ABI verifier rejects a floating Daytona SDK dependency", async () => {
  const root = await fixture();
  try {
    await writePackage(root, "plugins/daytona", {
      name: "@paperclipai/plugin-daytona",
      dependencies: { "@daytonaio/sdk": "^0.175.0", "@paperclipai/plugin-sdk": "file:./local/plugin-sdk" },
    }, ["dist/manifest.js", "dist/worker.js"]);
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Daytona SDK must be exactly pinned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
