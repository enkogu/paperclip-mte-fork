import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

function assertUniqueYamlMappingKeys(source) {
  const contexts = [{ indent: -1, keys: new Set() }];
  for (const line of source.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const content = line.slice(indent);
    const listItem = content.startsWith("- ");
    const mapping = (listItem ? content.slice(2) : content).match(/^([A-Za-z][A-Za-z0-9_-]*):(.*)$/);
    if (!mapping) continue;

    while (contexts.length > 1 && contexts.at(-1).indent >= indent) contexts.pop();
    if (listItem) contexts.push({ indent, keys: new Set() });

    const context = contexts.at(-1);
    const key = mapping[1];
    assert.ok(!context.keys.has(key), `duplicate YAML key "${key}" at indentation ${indent}`);
    context.keys.add(key);

    if (!mapping[2].trim()) contexts.push({ indent, keys: new Set() });
  }
}

function dependabotEntries(source) {
  const entries = [];
  let current = null;
  for (const line of source.split("\n")) {
    if (/^  - package-ecosystem:/.test(line)) {
      if (current) entries.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) entries.push(current.join("\n"));
  return entries;
}

function isolatedDaytonaDependabotEntry(source) {
  assertUniqueYamlMappingKeys(source);
  const matches = dependabotEntries(source).filter((entry) =>
    /^  - package-ecosystem: npm$/m.test(entry) &&
    /^    directory: "\/packages\/plugins\/sandbox-providers\/daytona\/image-build"$/m.test(entry),
  );
  assert.equal(matches.length, 1, "Daytona image-build must have exactly one npm Dependabot entry");
  return matches[0];
}

function nestedBlock(entry, key) {
  const lines = entry.split("\n");
  const start = lines.findIndex((line) => line === `    ${key}:`);
  assert.notEqual(start, -1, `missing ${key} block`);

  const contents = [];
  for (const line of lines.slice(start + 1)) {
    if (/^    \S/.test(line)) break;
    contents.push(line);
  }
  return contents.join("\n");
}

function normalizedYamlBlock(value) {
  const lines = value.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  const indentation = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  return lines.map((line) => line.slice(indentation)).join("\n");
}

function assertDaytonaDependabotEntrySemantics(entry) {
  assert.match(entry, /^  - package-ecosystem: npm$/m);
  assert.match(entry, /^    directory: "\/packages\/plugins\/sandbox-providers\/daytona\/image-build"$/m);
  assert.match(entry, /^    open-pull-requests-limit: 10$/m);

  assert.equal(
    normalizedYamlBlock(nestedBlock(entry, "schedule")),
    'interval: weekly\nday: monday\ntime: "06:00"',
    "Daytona schedule must have no extra keys",
  );
  assert.equal(
    normalizedYamlBlock(nestedBlock(entry, "labels")),
    '- "dependencies"',
    "Daytona labels must be exactly the dependencies label",
  );
  assert.equal(
    normalizedYamlBlock(nestedBlock(entry, "groups")),
    'daytona-image-build:\n  patterns:\n    - "*"',
    "Daytona groups must have exactly one all-dependencies group",
  );
  assert.equal(
    normalizedYamlBlock(nestedBlock(entry, "ignore")),
    '- dependency-name: "*"\n  update-types: ["version-update:semver-major"]',
    "Daytona ignore rules must contain exactly the major-version policy",
  );
}

function assertIsolatedDaytonaDependabotConfig(source) {
  const entry = isolatedDaytonaDependabotEntry(source);
  assertDaytonaDependabotEntrySemantics(entry);
  return entry;
}

test("MTE build workflow runs for the public default branch", async () => {
  const workflow = await read(".github/workflows/mte-image-build.yml");
  assert.match(workflow, /push:\n\s+branches: \[main, codex\/mte-immutable-runtime\]/);
});

function workflowStep(workflow, name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf("\n      - ", start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function assertMteDaytonaPluginLane(workflow) {
  const pnpmSetup = workflowStep(workflow, "Set up pnpm for the isolated Daytona plugin test");
  const nodeSetup = workflowStep(workflow, "Set up Node.js for the isolated Daytona plugin test");
  const install = workflowStep(workflow, "Install frozen Daytona plugin test dependencies");
  const testLane = workflowStep(workflow, "Run isolated Daytona plugin test lane");
  const installIndex = workflow.indexOf(install);
  const testIndex = workflow.indexOf(testLane);
  const buildxIndex = workflow.indexOf("docker/setup-buildx-action@");
  const buildIndex = workflow.indexOf("docker/build-push-action@");

  assert.match(pnpmSetup, /uses: pnpm\/action-setup@b0f76dfb45f55f8421693e4803ac7bb65143bd34/);
  assert.match(pnpmSetup, /version: 9\.15\.4/);
  assert.match(pnpmSetup, /run_install: false/);
  assert.match(nodeSetup, /uses: actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/);
  assert.match(
    nodeSetup,
    /node-version: 24\n\s+cache: pnpm\n\s+cache-dependency-path: \|\n\s+pnpm-lock\.yaml\n\s+packages\/plugins\/sandbox-providers\/daytona\/image-build\/pnpm-lock\.yaml/,
  );
  assert.match(install, /^        run: \|\n\s+pnpm install --frozen-lockfile/m);
  assert.match(
    install,
    /pnpm -C packages\/plugins\/sandbox-providers\/daytona\/image-build install --frozen-lockfile --ignore-scripts/,
  );
  assert.match(
    install,
    /mkdir -p packages\/plugins\/sandbox-providers\/daytona\/node_modules\n\s+ln -s \.\.\/image-build\/node_modules\/@daytonaio packages\/plugins\/sandbox-providers\/daytona\/node_modules\/@daytonaio\n\s+test -L packages\/plugins\/sandbox-providers\/daytona\/node_modules\/@paperclipai\/plugin-sdk\n\s+test -L packages\/plugins\/sdk\/node_modules\/@paperclipai\/shared/,
  );
  assert.match(
    testLane,
    /run: node scripts\/run-vitest-stable\.mjs --mode general --group general-daytona-plugin/,
  );
  assert.doesNotMatch(install, /continue-on-error:\s*true/);
  assert.doesNotMatch(testLane, /continue-on-error:\s*true/);
  assert.ok(installIndex >= 0 && testIndex > installIndex && buildxIndex > testIndex && buildIndex > buildxIndex);
}

test("MTE image build fails closed on the isolated Daytona plugin lane", async () => {
  const workflow = await read(".github/workflows/mte-image-build.yml");
  assertMteDaytonaPluginLane(workflow);
});

test("MTE image build rejects Daytona lane cache, link, and failure bypasses", async () => {
  const workflow = await read(".github/workflows/mte-image-build.yml");
  for (const mutated of [
    workflow.replace("            packages/plugins/sandbox-providers/daytona/image-build/pnpm-lock.yaml\n", ""),
    workflow.replace("          test -L packages/plugins/sdk/node_modules/@paperclipai/shared\n", ""),
    workflow.replace(
      "      - name: Run isolated Daytona plugin test lane\n        run:",
      "      - name: Run isolated Daytona plugin test lane\n        continue-on-error: true\n        run:",
    ),
  ]) {
    assert.throws(() => assertMteDaytonaPluginLane(mutated), assert.AssertionError);
  }
});

test("Dependabot tracks the isolated Daytona image-build lock", async () => {
  const config = await read(".github/dependabot.yml");
  assertIsolatedDaytonaDependabotConfig(config);
});

test("Dependabot config rejects duplicate YAML mapping keys and Daytona entries", async () => {
  const config = await read(".github/dependabot.yml");
  const entry = assertIsolatedDaytonaDependabotConfig(config);

  assert.throws(
    () => assertUniqueYamlMappingKeys(`version: 2\nversion: 2\nupdates: []\n`),
    /duplicate YAML key "version" at indentation 0/,
  );
  assert.throws(
    () => assertIsolatedDaytonaDependabotConfig(config.replace('time: "06:00"', 'time: "06:00"\n      time: "07:00"')),
    /duplicate YAML key "time" at indentation 6/,
  );
  assert.throws(
    () => assertIsolatedDaytonaDependabotConfig(config.replace(
      'daytona-image-build:\n        patterns:\n          - "*"',
      'daytona-image-build:\n        patterns:\n          - "*"\n      daytona-image-build:\n        patterns:\n          - "*"',
    )),
    /duplicate YAML key "daytona-image-build" at indentation 6/,
  );
  assert.throws(
    () => assertIsolatedDaytonaDependabotConfig(config.replace(
      entry,
      entry.replace(
        'update-types: ["version-update:semver-major"]',
        'update-types: ["version-update:semver-major"]\n        update-types: ["version-update:semver-major"]',
      ),
    )),
    /duplicate YAML key "update-types" at indentation 8/,
  );
  assert.throws(
    () => assertIsolatedDaytonaDependabotConfig(config.replace(
      entry,
      entry.replace('- "dependencies"', '- "dependencies"\n      - "security"'),
    )),
    /Daytona labels must be exactly the dependencies label/,
  );
  assert.throws(
    () => assertIsolatedDaytonaDependabotConfig(config.replace(
      entry,
      entry.replace('- "*"', '- "*"\n          - "@daytonaio\\/*"'),
    )),
    /Daytona groups must have exactly one all-dependencies group/,
  );
  assert.throws(
    () => assertIsolatedDaytonaDependabotConfig(config.replace(
      entry,
      entry.replace(
        '- dependency-name: "*"\n        update-types: ["version-update:semver-major"]',
        '- dependency-name: "*"\n        update-types: ["version-update:semver-major"]\n      - dependency-name: "@daytonaio/sdk"\n        update-types: ["version-update:semver-minor"]',
      ),
    )),
    /Daytona ignore rules must contain exactly the major-version policy/,
  );
  assert.throws(
    () => isolatedDaytonaDependabotEntry(`${config}\n${entry}`),
    /Daytona image-build must have exactly one npm Dependabot entry/,
  );
});

function assertChecksumPinnedGitleaksCli(workflow, relative) {
  const setup = workflowStep(workflow, "Install checksum-pinned Gitleaks CLI");
  const setupIndex = workflow.indexOf(setup);
  const verifyIndex = workflow.indexOf("node scripts/verify-mte-fork.mjs");

  assert.ok(setupIndex >= 0 && verifyIndex > setupIndex, `${relative} must install gitleaks before verification`);
  assert.match(setup, /GITLEAKS_VERSION: "8\.30\.1"/);
  assert.match(setup, /GITLEAKS_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"/);
  assert.match(
    setup,
    /https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v\$\{GITLEAKS_VERSION\}\/gitleaks_\$\{GITLEAKS_VERSION\}_linux_x64\.tar\.gz/,
  );
  assert.match(setup, /sha256sum --check -/);
  assert.match(setup, /tar --extract --gzip --file "\$archive" --directory "\$RUNNER_TEMP" gitleaks/);
  assert.match(setup, /echo "\$RUNNER_TEMP" >> "\$GITHUB_PATH"/);
  assert.doesNotMatch(workflow, /gitleaks\/gitleaks-action|GITHUB_TOKEN:/);
}

test("MTE workflows install the checksum-pinned license-free Gitleaks CLI before verification", async () => {
  for (const relative of [
    ".github/workflows/mte-image-build.yml",
    ".github/workflows/mte-image-publish.yml",
  ]) {
    const workflow = await read(relative);
    assertChecksumPinnedGitleaksCli(workflow, relative);
  }
});

test("MTE workflow contract rejects mutable or unchecked Gitleaks installation", async () => {
  const workflow = await read(".github/workflows/mte-image-build.yml");
  for (const mutated of [
    workflow.replace("GITLEAKS_VERSION: \"8.30.1\"", "GITLEAKS_VERSION: \"latest\""),
    workflow.replace("551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb", "0".repeat(64)),
    workflow.replace('          echo "${GITLEAKS_SHA256}  ${archive}" | sha256sum --check -\n', ""),
    workflow.replace("      - name: Install checksum-pinned Gitleaks CLI", "      - uses: gitleaks/gitleaks-action@v2"),
  ]) {
    assert.throws(() => assertChecksumPinnedGitleaksCli(mutated, "mutated workflow"), assert.AssertionError);
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
  assert.match(
    dockerfile,
    /ln -s \.\.\/\.\.\/\.\.\/plugins\/daytona \/opt\/runtime\/server\/node_modules\/@paperclipai\/plugin-daytona/,
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
