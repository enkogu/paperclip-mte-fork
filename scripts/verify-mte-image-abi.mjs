import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const imageRoot = path.resolve(process.argv[2] ?? path.dirname(scriptDirectory));
const abiPath = process.env.MTE_IMAGE_ABI_MANIFEST ?? path.join(scriptDirectory, "manifest.json");
const abi = JSON.parse(await readFile(abiPath, "utf8"));

assert.equal(abi.schemaVersion, 1, "unsupported MTE image ABI schema");
assert.deepEqual(abi.verifyCommand, ["node", "/app/image-abi/verify.mjs"]);

const expectedPackages = new Map([
  ["daytonaPlugin", "@paperclipai/plugin-daytona"],
  ["daytonaSdk", "@daytonaio/sdk"],
  ["pluginSdk", "@paperclipai/plugin-sdk"],
  ["pluginShared", "@paperclipai/shared"],
  ["piControlPlaneAdapter", "@paperclipai/adapter-pi-local"],
  ["s3ControlPlaneClient", "@aws-sdk/client-s3"],
]);

for (const [key, packageName] of expectedPackages) {
  const absoluteAbiPath = abi.packages?.[key];
  assert.equal(typeof absoluteAbiPath, "string", `missing ABI package path: ${key}`);
  assert.ok(absoluteAbiPath.startsWith("/app/"), `ABI package path must be image-absolute: ${key}`);
  const packageDirectory = path.join(imageRoot, path.relative("/app", absoluteAbiPath));
  const manifestPath = path.join(packageDirectory, "package.json");
  const manifestStat = await stat(manifestPath).catch(() => null);
  assert.ok(manifestStat?.isFile(), `ABI package manifest is missing: ${absoluteAbiPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, packageName, `unexpected package at ABI path: ${absoluteAbiPath}`);
}

const pluginManifest = JSON.parse(await readFile(path.join(imageRoot, "plugins/daytona/package.json"), "utf8"));
assert.equal(pluginManifest.dependencies?.["@daytonaio/sdk"], "0.175.0", "Daytona SDK must be exactly pinned");
assert.equal(
  pluginManifest.dependencies?.["@paperclipai/plugin-sdk"],
  "file:./local/plugin-sdk",
  "plugin SDK must resolve from the image-local package closure",
);
const pluginSdkManifest = JSON.parse(
  await readFile(path.join(imageRoot, "plugins/daytona/node_modules/@paperclipai/plugin-sdk/package.json"), "utf8"),
);
assert.equal(pluginSdkManifest.version, "1.0.0", "unexpected local plugin SDK version");
assert.equal(
  pluginSdkManifest.dependencies?.["@paperclipai/shared"],
  "file:../shared",
  "plugin SDK shared dependency must resolve from the image-local package closure",
);
assert.ok(
  (await stat(path.join(imageRoot, "plugins/daytona/dist/manifest.js")).catch(() => null))?.isFile(),
  "Daytona plugin manifest build output is missing",
);
assert.ok(
  (await stat(path.join(imageRoot, "plugins/daytona/dist/worker.js")).catch(() => null))?.isFile(),
  "Daytona plugin worker build output is missing",
);

console.log(JSON.stringify({ ok: true, schemaVersion: abi.schemaVersion, packages: abi.packages }));
