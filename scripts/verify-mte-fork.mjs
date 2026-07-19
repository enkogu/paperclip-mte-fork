import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { auditHeartbeatRunUpdates } from "./heartbeat-terminal-writer-audit.mjs";

await import("./verify-mte-gitleaks.mjs");

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const [dockerfile, notice, buildWorkflow, publishWorkflow, legacyRuntimeWorkflow, heartbeat, recovery, terminalFinalizer, environmentRuntime, runtimePruner, runtimeVerifier, imageAbi, imageAbiVerifier, daytonaPackage, rootWorkspace, daytonaBuildNpmrc, daytonaBuildPackage, daytonaBuildLock] = await Promise.all([
  read("Dockerfile.mte"),
  read("NOTICE-MTE.md"),
  read(".github/workflows/mte-image-build.yml"),
  read(".github/workflows/mte-image-publish.yml"),
  read(".github/workflows/agent-runtime-images.yml"),
  read("server/src/services/heartbeat.ts"),
  read("server/src/services/recovery/service.ts"),
  read("server/src/services/terminal-run-finalizer.ts"),
  read("server/src/services/environment-runtime.ts"),
  read("scripts/prune-mte-runtime.mjs"),
  read("scripts/verify-mte-runtime.mjs"),
  read("scripts/mte-image-abi.json"),
  read("scripts/verify-mte-image-abi.mjs"),
  read("packages/plugins/sandbox-providers/daytona/package.json"),
  read("pnpm-workspace.yaml"),
  read("packages/plugins/sandbox-providers/daytona/image-build/.npmrc"),
  read("packages/plugins/sandbox-providers/daytona/image-build/package.json"),
  read("packages/plugins/sandbox-providers/daytona/image-build/pnpm-lock.yaml"),
]);

assert.match(
  dockerfile,
  /^# syntax=docker\/dockerfile:[^@\s]+@sha256:[0-9a-f]{64}$/m,
  "Dockerfile frontend must be pinned by digest",
);
assert.match(
  dockerfile,
  /^FROM node:[^ ]+@sha256:[0-9a-f]{64} AS (?:build|production)$/m,
  "base image must be pinned by digest",
);
assert.doesNotMatch(dockerfile, /apt-get|apk add|dnf install|yum install/, "mutable OS package installs are forbidden");
assert.match(dockerfile, /pnpm --filter @paperclipai\/server deploy --prod \/opt\/runtime\/server/);
assert.match(dockerfile, /pnpm -C \/tmp\/mte-daytona-build install --frozen-lockfile --ignore-scripts/);
assert.match(dockerfile, /pnpm -C \/tmp\/mte-daytona-build prune --prod --ignore-scripts/);
assert.doesNotMatch(dockerfile, /--filter @paperclipai\/plugin-daytona(?:\.\.\.)? (?:build|deploy)/);
assert.match(dockerfile, /node scripts\/verify-mte-runtime\.mjs \/opt\/runtime/);
assert.match(dockerfile, /node \/opt\/runtime\/image-abi\/verify\.mjs \/opt\/runtime/);
assert.doesNotMatch(dockerfile, /COPY --chown=.*--from=build \/src \/app|COPY --from=build \/src \/app/);
assert.doesNotMatch(
  dockerfile,
  /npm install[^\n]*(?:@openai\/codex|@anthropic-ai\/claude-code|opencode-ai|@google\/gemini-cli)/,
  "Dockerfile must not install an agent harness CLI",
);
assert.match(notice, /non-official fork/i);
assert.match(notice, /390627b46eb333309d357004384b220ecf8a65af/);

const mteWorkflows = (await readdir(new URL(".github/workflows/", root)))
  .filter((name) => name.startsWith("mte-"))
  .sort();
assert.deepEqual(mteWorkflows, ["mte-image-build.yml", "mte-image-publish.yml"]);
assert.match(buildWorkflow, /permissions:\n  contents: read/);
assert.doesNotMatch(buildWorkflow, /packages: write|id-token: write|push: true/);
assert.match(publishWorkflow, /permissions:\n  contents: write\n  packages: write\n  id-token: write/);
for (const workflow of [buildWorkflow, publishWorkflow]) {
  const setup = workflow.indexOf("uses: gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7");
  const verify = workflow.indexOf("run: node scripts/verify-mte-fork.mjs");
  assert.ok(setup >= 0 && verify > setup, "checksum-pinned official gitleaks setup must precede MTE verification");
  assert.match(workflow, /GITLEAKS_VERSION: "8\.30\.1"/);
}
assert.match(publishWorkflow, /tags: \[mte-v\*\]/);
assert.doesNotMatch(publishWorkflow, /workflow_dispatch|branches:/);
assert.match(publishWorkflow, /Publish immutable digest/);
assert.match(
  publishWorkflow,
  /outputs: type=image,name=\$\{\{ env\.IMAGE \}\},push-by-digest=true,name-canonical=true,push=true/,
  "publish workflow must push only by content digest",
);
assert.doesNotMatch(
  publishWorkflow,
  /^\s+tags:\s*(?:\||$)|\$IMAGE:\$IMAGE_TAG|\$IMAGE:sha-|imagetools inspect[^\n]*>\/dev\/null/mi,
  "publish workflow must not create mutable registry tags or treat an opaque inspect failure as absence",
);
assert.match(
  publishWorkflow,
  /\[\[ "\$DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\][\s\S]*docker buildx imagetools inspect "\$IMAGE@\$DIGEST"/,
  "the exact pushed digest must be validated and inspected without suppressing registry errors",
);
assert.match(publishWorkflow, /IMAGE_VERSION=\$\{\{ env\.IMAGE_TAG \}\}/);
const attestationGate = publishWorkflow.indexOf("Verify exact-digest SBOM and provenance attestations");
const releaseFinalization = publishWorkflow.indexOf("Finalize exact idempotent release record");
assert.ok(attestationGate >= 0 && releaseFinalization > attestationGate, "release finalization must follow attestation verification");
assert.match(publishWorkflow, /imagetools inspect "\$IMAGE@\$DIGEST" --format '\{\{json \.SBOM\}\}'/);
assert.match(publishWorkflow, /imagetools inspect "\$IMAGE@\$DIGEST" --format '\{\{json \.Provenance\}\}'/);
assert.match(publishWorkflow, /--certificate-identity "/);
assert.match(
  publishWorkflow,
  /Finalize exact idempotent release record[\s\S]*verify_remote_tag[\s\S]*git fetch --no-tags --force origin[\s\S]*\^\{commit\}[\s\S]*GITHUB_SHA/,
  "the remote Git tag must be re-resolved to the triggering commit immediately before finalization",
);
assert.match(publishWorkflow, /immutableRef:[\s\S]*gitTag:[\s\S]*gitRef:[\s\S]*commit:/);
assert.match(publishWorkflow, /jq -cS \. "\$metadata" >> "\$notes"/);
assert.match(publishWorkflow, /verify_exact_existing_release[\s\S]*\.body == \$body/);
assert.match(publishWorkflow, /\.assets \| length/);
assert.match(publishWorkflow, /200\|404[\s\S]*release lookup failed closed with HTTP/);
assert.match(publishWorkflow, /gh release create "\$GITHUB_REF_NAME"[\s\S]*--notes-file "\$notes"/);
assert.doesNotMatch(
  publishWorkflow,
  /gh release (?:edit|upload)|--clobber|\.json#paperclip-mte/,
  "release identity must never be edited, overwritten, or split into an asset upload",
);

for (const source of [runtimePruner, runtimeVerifier]) {
  assert.match(source, /@embedded-postgres\/linux-x64/);
  assert.doesNotMatch(source, /forbiddenExecutablePackages|@openai\/codex|@anthropic-ai\/claude-code|codex-acp/);
}
assert.match(runtimePruner, /delete manifest\.bin/);
assert.match(runtimePruner, /mode & ~0o111/);
assert.match(runtimeVerifier, /runtime package exposes a bin entry/);
assert.match(runtimeVerifier, /executable file outside the runtime allowlist/);
assert.match(runtimeVerifier, /transitive package manifests were not inspected/);

const abi = JSON.parse(imageAbi);
assert.deepEqual(abi.verifyCommand, ["node", "/app/image-abi/verify.mjs"]);
assert.equal(abi.packages.daytonaPlugin, "/app/plugins/daytona");
assert.equal(abi.packages.daytonaSdk, "/app/plugins/daytona/node_modules/@daytonaio/sdk");
assert.equal(abi.packages.pluginSdk, "/app/plugins/daytona/node_modules/@paperclipai/plugin-sdk");
assert.equal(abi.packages.pluginShared, "/app/plugins/daytona/local/plugin-sdk/node_modules/@paperclipai/shared");
assert.equal(abi.packages.piControlPlaneAdapter, "/app/server/node_modules/@paperclipai/adapter-pi-local");
assert.match(imageAbiVerifier, /Daytona SDK must be exactly pinned/);
assert.doesNotMatch(imageAbi, /pi-coding-agent|acpx|agent-harness/i);
assert.equal(JSON.parse(daytonaPackage).dependencies["@daytonaio/sdk"], "0.171.0");
assert.equal(JSON.parse(daytonaPackage).dependencies["@paperclipai/plugin-sdk"], "workspace:*");
assert.match(rootWorkspace, /- "!packages\/plugins\/sandbox-providers\/\*\*"/);
assert.equal(daytonaBuildNpmrc.trim(), "shared-workspace-lockfile=false");
const isolatedDaytonaPackage = JSON.parse(daytonaBuildPackage);
assert.equal(isolatedDaytonaPackage.dependencies["@daytonaio/sdk"], "0.171.0");
assert.equal(isolatedDaytonaPackage.dependencies["@paperclipai/plugin-sdk"], "file:./local/plugin-sdk");
assert.match(daytonaBuildLock, /specifier: 0\.171\.0\n\s+version: 0\.171\.0\(ws@/);
assert.match(daytonaBuildLock, /'@paperclipai\/plugin-sdk@file:local\/plugin-sdk'/);
assert.match(daytonaBuildLock, /'@paperclipai\/shared@file:local\/shared'/);

assert.doesNotMatch(legacyRuntimeWorkflow, /ghcr\.io\/paperclipai/, "public forks must not publish into the upstream registry");
assert.match(legacyRuntimeWorkflow, /REGISTRY=ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}/);
for (const line of legacyRuntimeWorkflow.matchAll(/^\s*- uses: ([^@\s]+)@([^\s#]+)/gm)) {
  assert.match(line[2], /^[0-9a-f]{40}$/, `${line[1]} must use a full commit SHA`);
}

for (const workflow of [buildWorkflow, publishWorkflow]) {
  for (const line of workflow.matchAll(/^\s*- uses: ([^@\s]+)@([^\s#]+)/gm)) {
    assert.match(line[2], /^[0-9a-f]{40}$/, `${line[1]} must use a full commit SHA`);
  }
}

const transactionStart = terminalFinalizer.indexOf("export async function finalizeTerminalRun");
const transactionEnd = terminalFinalizer.length;
assert.ok(transactionStart >= 0 && transactionEnd > transactionStart, "transactional finalizer is missing");
const transactionBody = terminalFinalizer.slice(transactionStart, transactionEnd);
assert.match(transactionBody, /await db\.transaction\(write\)/);
assert.ok(
  transactionBody.indexOf(".update(heartbeatRuns)") < transactionBody.indexOf(".insert(agentTaskSessions)"),
  "terminal CAS must precede task-session side effects",
);
assert.ok(
  transactionBody.indexOf("throw new RunAlreadyFinalizedError") > transactionBody.indexOf(".update(heartbeatRuns)"),
  "a lost finalization race must stop all side effects",
);
assert.match(transactionBody, /eq\(heartbeatRuns\.status, input\.expectedStatus\)/);
assert.match(
  terminalFinalizer,
  /status: TerminalHeartbeatRunStatus;/,
  "terminal finalizer status must use the terminal-only union",
);
assert.match(
  terminalFinalizer,
  /type TerminalRunPatch = Omit<[\s\S]*"id" \| "status" \| "updatedAt"[\s\S]*>;/,
  "runPatch must exclude identity, terminal status, and finalizer timestamp ownership",
);
assert.match(
  terminalFinalizer,
  /\.set\(\{ \.\.\.input\.runPatch, status: input\.status, updatedAt: now \}\)/,
  "finalizer-owned status and timestamp must be merged after runPatch",
);
assert.ok(
    transactionBody.indexOf(".update(heartbeatRuns)") < transactionBody.indexOf(".update(agentWakeupRequests)") &&
    transactionBody.indexOf(".update(heartbeatRuns)") < transactionBody.indexOf(".update(issues)") &&
    transactionBody.indexOf(".update(heartbeatRuns)") < transactionBody.indexOf(".insert(agentTaskSessions)"),
  "run CAS must guard atomic wakeup, issue, and session side effects",
);
assert.ok(
  transactionBody.indexOf(".update(heartbeatRuns)") < transactionBody.indexOf(".insert(heartbeatRunEvents)"),
  "run CAS must guard the atomic terminal lifecycle event",
);

const completionStart = heartbeat.indexOf("// A scheduler must never observe completion");
const completionEnd = heartbeat.indexOf("if (!persistedRunWrite.updated)", completionStart);
const completionBody = heartbeat.slice(completionStart, completionEnd);
assert.ok(
  completionBody.indexOf("await releaseEnvironmentLeasesForRun") <
    completionBody.indexOf("await finalizeRunTerminalIfStatus"),
  "lease release must precede scheduler-visible terminal completion",
);
assert.match(heartbeat, /throw new AggregateError\(/, "lease release errors must fail closed");
for (const [label, startMarker, endMarker, postReleaseMarkers] of [
  [
    "execution-start non-invokable cancellation",
    "if (!runningAgent)",
    "publishLiveEvent({",
    [
      "await finalizeRunTerminalIfStatus",
      "if (!cancelledWrite.updated) return",
      "await releaseIssueExecutionAndPromote(cancelledWrite.run)",
    ],
  ],
  [
    "orphaned active-run failure",
    "async function reapOrphanedRuns",
    "async function resumeQueuedRuns",
    [
      "await finalizeRunTerminalIfStatus",
      "if (!finalizedWrite.updated)",
      "await startNextQueuedRunForAgent(run.agentId)",
    ],
  ],
  [
    "single-run cancellation",
    "async function cancelRunInternal",
    "async function cancelActiveForAgentInternal",
    [
      "await finalizeRunTerminalIfStatus",
      "if (!cancelledWrite.updated) return",
      "await releaseIssueExecutionAndPromote(cancelled)",
      "await startNextQueuedRunForAgent(run.agentId)",
    ],
  ],
  [
    "agent-wide active-run cancellation",
    "async function cancelActiveForAgentInternal",
    "async function cancelPendingWakeupsForAgentsInternal",
    [
      "await finalizeRunTerminalIfStatus",
      "if (!cancelledWrite.updated) continue",
      "await releaseIssueExecutionAndPromote(cancelled)",
    ],
  ],
]) {
  const start = heartbeat.indexOf(startMarker);
  const end = heartbeat.indexOf(endMarker, start);
  const body = heartbeat.slice(start, end);
  assert.ok(start >= 0 && end > start, `${startMarker} is missing`);
  const leaseRelease = body.indexOf("await releaseEnvironmentLeasesForRun");
  assert.ok(leaseRelease >= 0, `${label} must release environment leases`);
  for (const marker of postReleaseMarkers) {
    const markerIndex = body.indexOf(marker);
    assert.ok(markerIndex >= 0, `${label} is missing guarded operation: ${marker}`);
    assert.ok(leaseRelease < markerIndex, `${label} must release leases before: ${marker}`);
  }
}
assert.doesNotMatch(
  heartbeat,
  /setRunStatus\([^\n]+, "(?:succeeded|failed|timed_out|cancelled)"/,
  "terminal heartbeat writes must use a status CAS",
);
async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && [".git", "node_modules", "dist", "build", "coverage"].includes(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(child);
  }
  return files;
}

const terminalHelperPath = new URL("server/src/services/terminal-run-finalizer.ts", root).pathname;
const terminalWriterViolations = [];
for (const file of await sourceFiles(root)) {
  if (
    file.pathname.includes("/__tests__/") ||
    file.pathname.includes("/tests/") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.pathname)
  ) continue;
  const source = await readFile(file, "utf8");
  if (file.pathname === terminalHelperPath) {
    assert.equal(
      [...source.matchAll(/\.update\s*\(\s*heartbeatRuns\s*\)/g)].length,
      1,
      "terminal helper must contain exactly one direct heartbeat status writer",
    );
    continue;
  }
  const findings = auditHeartbeatRunUpdates(source);
  for (const finding of findings) {
    terminalWriterViolations.push(
      `${file.pathname}:${source.slice(0, finding.index).split("\n").length}: ${finding.reason}`,
    );
  }
}
assert.deepEqual(
  terminalWriterViolations,
  [],
  "direct heartbeatRuns status updates outside the terminal helper are forbidden",
);
for (const [label, startMarker, endMarker, expectedFinalizers] of [
  ["scheduled retry gate cancellation", "async function cancelScheduledRetryForGate", "async function promoteScheduledRetryRun", 1],
  ["enqueue wakeup terminal branches", "async function enqueueWakeup", "async function cancelRunInternal", 2],
]) {
  const start = heartbeat.indexOf(startMarker);
  const end = heartbeat.indexOf(endMarker, start);
  const body = heartbeat.slice(start, end);
  assert.ok(start >= 0 && end > start, `${label} audit markers are missing`);
  assert.equal(
    [...body.matchAll(/await finalizeRunTerminalIfStatus\(/g)].length,
    expectedFinalizers,
    `${label} must use the single terminal transaction helper`,
  );
  assert.ok(
    [...body.matchAll(/await releaseEnvironmentLeasesForRun\(/g)].length >= expectedFinalizers,
    `${label} must make lease release a prerequisite for every terminal helper call`,
  );
}
for (const [label, source] of [
  ["literal status", `.update(heartbeatRuns).set({ finishedAt: now, status: "failed" })`],
  ["template interpolation", "const result = `${db.update(heartbeatRuns).set({ status: \"failed\" })}`"],
  ["aliased heartbeatRuns table", `const runs = heartbeatRuns; db.update(runs).set({ status: "cancelled" })`],
  ["import-aliased heartbeatRuns table", `import { heartbeatRuns as runs } from "@paperclipai/db"; db.update(runs).set({ status: "failed" })`],
  ["bracket update access", `db["update"](heartbeatRuns).set({ status: "timed_out" })`],
  ["computed DB operation", `db[operation](heartbeatRuns).set({ finishedAt: now })`],
  ["aliased computed DB operation", `const mutate = db[operation]; mutate(heartbeatRuns).set({ finishedAt: now })`],
  ["computed operation through DB alias", `const writer = db; writer[operation](heartbeatRuns).set({ finishedAt: now })`],
  ["bound update alias", `const mutate = db.update.bind(db); mutate(heartbeatRuns).set({ status: "failed" })`],
  ["update through declared database alias", `const writer = db; writer.update(heartbeatRuns).set({ status: "failed" })`],
  ["global database referenced by parameter default", `function inspect(cache = db) { db.update(heartbeatRuns).set({ status: "failed" }) }`],
  ["destructured property does not shadow global database", `function inspect({ db: cache }) { db.update(heartbeatRuns).set({ status: "failed" }) }`],
  ["bound computed DB operation", `const mutate = db[operation].bind(db); mutate(heartbeatRuns).set({ finishedAt: now })`],
  ["shorthand status", `const status = "failed"; db.update(heartbeatRuns).set({ status, finishedAt: now })`],
  ["quoted property", `.update(heartbeatRuns).set({ "status": outcome, finishedAt: now })`],
  ["status first", `.update(heartbeatRuns).set({status: terminalStatus, ...patch})`],
  ["spread object", `const patch = { status: "cancelled" }; db.update(heartbeatRuns).set({ ...patch })`],
  ["object variable", `const patch = { status: "timed_out" }; db.update(heartbeatRuns).set(patch)`],
  ["unknown spread", `db.update(heartbeatRuns).set({ ...patch })`],
  ["unknown object", `db.update(heartbeatRuns).set(patch)`],
]) {
  assert.equal(auditHeartbeatRunUpdates(source).length, 1, `terminal audit missed ${label}`);
}
assert.equal(
  auditHeartbeatRunUpdates(`.update(heartbeatRuns).set({ resultJson, finishedAt: now })`).length,
  0,
  "terminal audit must not reject non-status heartbeat updates",
);
assert.equal(
  auditHeartbeatRunUpdates(`.update(heartbeatRuns).set({ status: "running", updatedAt: now })`).length,
  0,
  "terminal audit must accept an explicit nonterminal status",
);
for (const [label, source] of [
  ["regex literal", `assert.match(source, /\\.update\\(heartbeatRuns\\)/g)`],
  ["regex character class", `const matcher = /[/.]update\\(heartbeatRuns\\)/`],
  ["line comment", `// .update(heartbeatRuns).set({ status: "failed" })`],
  ["block comment", `/* .update(heartbeatRuns).set({ status: "failed" }) */`],
  ["string literal", `const example = '.update(heartbeatRuns).set({ status: "failed" })'`],
  ["template string", "const example = `.update(heartbeatRuns).set({ status: \"failed\" })`"],
  ["template interpolation string", "const example = `${'.update(heartbeatRuns).set({ status: \"failed\" })'}`"],
  ["template interpolation comment", "const example = `${value /* .update(heartbeatRuns).set({ status: \"failed\" }) */}`"],
  ["template interpolation regex", "const example = `${/\\.update\\(heartbeatRuns\\)/g.test(value)}`"],
  ["benign computed callback", `handlers[operation](heartbeatRuns)`],
  ["unbound non-database update alias", `const mutate = cache.update; mutate(heartbeatRuns).set({ status: "failed" });`],
  ["parameter shadows implicit database alias", `function inspect(db) { db.update(heartbeatRuns).set({ status: "failed" }); }`],
  ["parameter shadow blocks update alias", `function inspect(tx) { const mutate = tx.update; mutate(heartbeatRuns).set({ status: "failed" }); }`],
  ["destructured parameter shadows implicit database alias", `function inspect({ db }) { db.update(heartbeatRuns).set({ status: "failed" }); }`],
  ["destructured local shadows implicit database alias", `function inspect(cache) { const { db } = cache; db.update(heartbeatRuns).set({ status: "failed" }); }`],
  ["local declaration shadows implicit database alias", `function inspect() { let trx; trx.update(heartbeatRuns).set({ status: "failed" }); }`],
  ["block-scoped table alias", `{ const runs = heartbeatRuns; void runs; } db.update(runs).set({ status: "failed" })`],
]) {
  assert.equal(auditHeartbeatRunUpdates(source).length, 0, `terminal audit misread ${label} contents as code`);
}
assert.match(
  recovery,
  /await deps\.releaseEnvironmentLeasesForRun\([\s\S]*await db\.transaction[\s\S]*\.for\("update"\)[\s\S]*finalizeTerminalRun/,
  "recovery must release leases fail-closed, lock/revalidate ownership, and use the shared terminal finalizer",
);
assert.match(
  heartbeat,
  /if \(environmentLeasesReleased && terminalTransitionOwned\) \{\s+await startNextQueuedRunForAgent/,
  "the execute finally path must not queue work after losing terminal CAS ownership",
);
assert.match(
  environmentRuntime,
  /if \(!lease\) \{\s+throw new Error\(`Environment driver did not release active lease/,
  "a driver null release must not be treated as success",
);
assert.match(
  environmentRuntime,
  /if \(lease\.status === "active"\) \{\s+throw new Error\(`Environment driver returned active lease/,
  "a still-active driver result must not be treated as released",
);

const patchFiles = (await readdir(new URL("patches/mte-immutable-runtime/", root))).sort();
assert.deepEqual(patchFiles, ["README.md"], "redundant executable patch applicators are forbidden");
const imageAbiPatchFiles = (await readdir(new URL("patches/mte-image-abi/", root))).sort();
assert.deepEqual(imageAbiPatchFiles, ["README.md", "apply.py"]);
console.log("MTE fork static contracts verified");
