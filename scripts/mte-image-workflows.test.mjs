import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("MTE build workflow runs for the public default branch", async () => {
  const workflow = await read(".github/workflows/mte-image-build.yml");
  assert.match(workflow, /push:\n\s+branches: \[main, codex\/mte-immutable-runtime\]/);
});

test("MTE workflows set up the audited official gitleaks action before verification", async () => {
  for (const relative of [
    ".github/workflows/mte-image-build.yml",
    ".github/workflows/mte-image-publish.yml",
  ]) {
    const workflow = await read(relative);
    const setup = workflow.indexOf("gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7");
    const verify = workflow.indexOf("node scripts/verify-mte-fork.mjs");
    assert.ok(setup >= 0 && verify > setup, `${relative} must set up gitleaks before verification`);
    assert.match(workflow, /GITLEAKS_VERSION: "8\.30\.1"/);
  }
});

test("legacy agent runtime publication targets the current fork namespace", async () => {
  const workflow = await read(".github/workflows/agent-runtime-images.yml");
  assert.doesNotMatch(workflow, /ghcr\.io\/paperclipai/);
  assert.match(workflow, /REGISTRY=ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}/);
  assert.doesNotMatch(workflow, /\$\{\{ env\.REGISTRY \}\}/);
  for (const action of workflow.matchAll(/^\s*- uses: ([^@\s]+)@([^\s#]+)/gm)) {
    assert.match(action[2], /^[0-9a-f]{40}$/, `${action[1]} must be checksum-pinned`);
  }
});

test("Docker closure deploys and verifies the stable image ABI", async () => {
  const dockerfile = await read("Dockerfile.mte");
  assert.match(dockerfile, /pnpm -C \/tmp\/mte-daytona-build install --frozen-lockfile --ignore-scripts/);
  assert.match(dockerfile, /cp -R \/tmp\/mte-daytona-build\/package\.json[\s\S]*\/opt\/runtime\/plugins\/daytona/);
  assert.match(
    dockerfile,
    /ln -s \.\.\/\.\.\/\.\.\/shared \/opt\/runtime\/plugins\/daytona\/local\/plugin-sdk\/node_modules\/@paperclipai\/shared/,
  );
  assert.doesNotMatch(dockerfile, /--filter @paperclipai\/plugin-daytona(?:\.\.\.)? (?:build|deploy)/);
  assert.match(dockerfile, /node scripts\/verify-mte-runtime\.mjs \/opt\/runtime/);
  assert.match(dockerfile, /node \/opt\/runtime\/image-abi\/verify\.mjs \/opt\/runtime/);
  assert.doesNotMatch(dockerfile, /pi-coding-agent|codex-acp|agent-runtime-(?:pi|codex|claude)/i);
});

test("release finalization is gated on exact-digest SBOM and provenance", async () => {
  const workflow = await read(".github/workflows/mte-image-publish.yml");
  const gate = workflow.indexOf("Verify exact-digest SBOM and provenance attestations");
  const finalize = workflow.indexOf("Finalize exact idempotent release record");
  assert.ok(gate >= 0 && finalize > gate, "attestation gate must precede release finalization");
  assert.match(workflow, /imagetools inspect "\$IMAGE@\$DIGEST" --format '\{\{json \.SBOM\}\}'/);
  assert.match(workflow, /imagetools inspect "\$IMAGE@\$DIGEST" --format '\{\{json \.Provenance\}\}'/);
  assert.match(workflow, /jq -e 'type == "object" and length > 0'/);
});
