import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignorePath = join(root, ".gitleaksignore");
await assert.rejects(
  access(join(root, ".gitleaks.toml")),
  /ENOENT/,
  "MTE release verification must not use gitleaks rule, path, or regex allowlists",
);
const ignoredFingerprints = (await readFile(ignorePath, "utf8"))
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

assert.equal(ignoredFingerprints.length, 19, ".gitleaksignore must contain exactly 19 reviewed fingerprints");
assert.equal(new Set(ignoredFingerprints).size, ignoredFingerprints.length, ".gitleaksignore fingerprints must be unique");
for (const fingerprint of ignoredFingerprints) {
  assert.match(
    fingerprint,
    /^(?:[^:\s]+\/)*[^:\s]+:[^:\s]+:\d+$/,
    ".gitleaksignore must contain exact scanner fingerprints only",
  );
}

function scan(target) {
  return spawnSync(
    process.env.GITLEAKS_BINARY || "gitleaks",
    [
      "dir",
      target,
      "--no-banner",
      "--no-color",
      "--redact=100",
      "--ignore-gitleaks-allow",
      "--gitleaks-ignore-path",
      ignorePath,
      "--exit-code",
      "1",
    ],
    { cwd: root, encoding: "utf8" },
  );
}

const repositoryScan = scan(".");
assert.equal(repositoryScan.error, undefined, "gitleaks executable is required for MTE release verification");
assert.equal(repositoryScan.status, 0, "the full repository scan must pass through exact reviewed fingerprints only");

const fixtureDir = await mkdtemp(join(tmpdir(), "paperclip-mte-gitleaks-"));
try {
  const fixtureToken = ["aB3", "dE5", "gH7", "iJ9", "kLm", "NoP", "qRs", "TuV", "wXy", "Z12", "34"].join("");
  await writeFile(join(fixtureDir, "non-ignored-fixture.txt"), `api_key=${fixtureToken}\n`);
  const fixtureScan = scan(fixtureDir);
  assert.equal(fixtureScan.error, undefined, "gitleaks synthetic fixture scan could not start");
  assert.equal(fixtureScan.status, 1, "a non-ignored synthetic secret-shaped fixture must fail scanning");
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

console.log("MTE gitleaks exact-fingerprint baseline verified");
