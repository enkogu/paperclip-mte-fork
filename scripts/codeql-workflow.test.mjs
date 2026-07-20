import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(root, ".github/workflows/codeql.yml");

function assertCodeqlWorkflow(workflow) {
  assert.match(workflow, /^name: CodeQL$/m);
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /schedule:\n\s+- cron: ".+"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+security-events: write/);
  assert.doesNotMatch(workflow, /\b(?:actions|checks|packages|id-token): (?:read|write)/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/);
  for (const action of ["init", "analyze"]) {
    assert.match(
      workflow,
      new RegExp(`github/codeql-action/${action}@bb16b9baa2ec4010b29f5c606d57d01190139edd`),
    );
  }
  assert.match(workflow, /languages: javascript-typescript/);
  assert.match(workflow, /build-mode: none/);
  assert.doesNotMatch(workflow, /(?:pnpm|npm|yarn) (?:install|run|build)|codeql-action\/autobuild/);
}

test("CodeQL workflow is minimal, SHA-pinned, and uploads JavaScript/TypeScript analysis", async () => {
  assertCodeqlWorkflow(await readFile(workflowPath, "utf8"));
});

test("CodeQL workflow guard rejects widened permissions and build wrappers", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  for (const mutated of [
    workflow.replace("  security-events: write", "  security-events: write\n  packages: write"),
    workflow.replace("          build-mode: none", "          build-mode: autobuild"),
    workflow.replace("      - name: Analyze and upload results", "      - run: pnpm install\n\n      - name: Analyze and upload results"),
    workflow.replace("bb16b9baa2ec4010b29f5c606d57d01190139edd", "v4"),
  ]) {
    assert.throws(() => assertCodeqlWorkflow(mutated), assert.AssertionError);
  }
});
