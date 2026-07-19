import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [dockerfile, applyScript, notice, workflow] = await Promise.all([
  read("Dockerfile.mte"),
  read("patches/mte-immutable-runtime/apply.py"),
  read("NOTICE-MTE.md"),
  read(".github/workflows/mte-immutable-image.yml"),
]);

assert.match(
  dockerfile,
  /^FROM node:[^ ]+@sha256:[0-9a-f]{64} AS base$/m,
  "Dockerfile.mte must pin its base image by digest",
);
assert.doesNotMatch(
  dockerfile,
  /npm install[^\n]*(?:@openai\/codex|@anthropic-ai\/claude-code|opencode-ai|@google\/gemini-cli)/,
  "Dockerfile.mte must not install an agent-harness CLI",
);
assert.match(notice, /non-official fork/i);
assert.match(notice, /390627b46eb333309d357004384b220ecf8a65af/);
assert.match(workflow, /platforms: linux\/amd64/);
assert.match(workflow, /provenance: mode=max/);
assert.match(workflow, /sbom: true/);
assert.match(workflow, /cosign sign --yes "\$IMAGE@\$DIGEST"/);

const patchBody = applyScript.split("PATCH = r'''", 2)[1]?.split("'''", 1)[0];
assert.ok(patchBody, "apply.py must contain the Dockerfile patch");
const generatedDockerfile = patchBody
  .split("\n")
  .slice(6)
  .filter((line) => line.startsWith("+"))
  .map((line) => line.slice(1))
  .join("\n");
assert.equal(`${generatedDockerfile}\n`, dockerfile, "Dockerfile.mte must match its patch payload");

const patchFiles = (await readdir(new URL("patches/mte-immutable-runtime/", root))).sort();
assert.deepEqual(patchFiles, ["README.md", "apply.py"]);

console.log("MTE fork static contracts verified");
