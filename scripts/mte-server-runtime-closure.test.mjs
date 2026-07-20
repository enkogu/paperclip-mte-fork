import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const normalizer = path.join(repoRoot, "scripts/normalize-mte-workspace-exports.mjs");
const smoke = path.join(repoRoot, "scripts/smoke-mte-server-runtime.mjs");

async function writePackage(root, relative, manifest, files = {}) {
  const directory = path.join(root, relative);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function closureFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mte-server-closure-"));
  await writePackage(root, ".", {
    name: "@paperclipai/server",
    dependencies: { "@paperclipai/db": "workspace:*", "@paperclipai/shared": "workspace:*" },
  });
  await writePackage(root, "node_modules/@paperclipai/db", {
    name: "@paperclipai/db",
    type: "module",
    exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    publishConfig: {
      exports: {
        ".": { types: "./dist/src/index.d.ts", import: "./dist/src/index.js" },
        "./*": { types: "./dist/src/*.d.ts", import: "./dist/src/*.js" },
      },
      main: "./dist/src/index.js",
      types: "./dist/src/index.d.ts",
    },
    dependencies: { "@paperclipai/shared": "workspace:*" },
  }, { "dist/src/index.js": "export {};\n", "dist/src/index.d.ts": "export {};\n" });
  await writePackage(root, "node_modules/@paperclipai/shared", {
    name: "@paperclipai/shared",
    type: "module",
    exports: { ".": "./src/index.ts" },
  }, { "dist/index.js": "export {};\n" });
  return root;
}

function run(script, root) {
  return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

test("normalizer makes the complete internal server workspace graph production-resolvable", async () => {
  const root = await closureFixture();
  try {
    const result = run(normalizer, root);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(receipt.internalDependencies, ["@paperclipai/db", "@paperclipai/shared"]);
    const db = JSON.parse(
      await readFile(path.join(root, "node_modules/@paperclipai/db/package.json"), "utf8"),
    );
    assert.deepEqual(db.exports["."], {
      types: "./dist/src/index.d.ts",
      import: "./dist/src/index.js",
    });
    assert.deepEqual(db.exports["./*"], {
      types: "./dist/src/*.d.ts",
      import: "./dist/src/*.js",
    });
    assert.equal(db.main, "./dist/src/index.js");
    assert.equal(db.types, "./dist/src/index.d.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizer rejects a workspace export whose production build output is absent", async () => {
  const root = await closureFixture();
  try {
    await rm(path.join(root, "node_modules/@paperclipai/db/dist/src/index.js"));
    const result = run(normalizer, root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /production export is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizer rejects a missing internal server workspace dependency", async () => {
  const root = await closureFixture();
  try {
    await rm(path.join(root, "node_modules/@paperclipai/db"), { recursive: true });
    const result = run(normalizer, root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /internal dependency is missing: @paperclipai\/db/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server runtime smoke requires the actual entrypoint health boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mte-server-smoke-pass-"));
  try {
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist/index.js"), `
      import http from "node:http";
      const server = http.createServer((request, response) => {
        response.statusCode = request.url === "/api/health" ? 200 : 404;
        response.end("ok");
      });
      server.listen(Number(process.env.PORT), process.env.HOST);
    `);
    const result = run(smoke, root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server runtime smoke rejects a missing module in the built entrypoint graph", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mte-server-smoke-fail-"));
  try {
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist/index.js"), 'import "@paperclipai/missing-runtime";\n');
    const result = run(smoke, root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /server runtime smoke failed before health/);
    assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
