# MTE immutable runtime fork

This non-official fork is based on Paperclip `v2026.707.0` at
`390627b46eb333309d357004384b220ecf8a65af`. Its scope is intentionally limited
to the runtime/session race fixes required by the MTE control plane and the
reproducible image used to deploy them.

## Patch inventory

1. Persist task-session state transactionally before the same commit exposes a
   terminal run or completed wakeup to schedulers; a lost terminal race rolls
   the session mutation back.
2. Fingerprint the raw stored task-session parameters, retaining server-owned
   metadata that adapter codecs do not interpret.
3. Exclude volatile issue and project `updatedAt` timestamps from session
   configuration fingerprints.
4. Release environment leases before terminal status and queued-run promotion;
   provider release errors keep the path fail-closed.
5. Use the provider sandbox lease identifier in execution-target identity.
6. Round-trip remote execution identity and task/session provenance through the
   Codex session codec.
7. Convert completed Codex command JSONL records into metadata-only
   `tool.action` events without command text, arguments, or output.
8. Preserve remote Codex rollout sessions only when task, session, working
   directory, provider identity, and non-fresh-session policy all match.

## Image and publication contract

`Dockerfile.mte` is the single source of truth. It pins its frontend and base
image by digest, performs no mutable OS-package install, deploys the server's
verified production workspace closure plus the exact-pinned Daytona provider,
and removes executable shims plus
every transitive package bin and non-allowlisted executable file. Only the
server's `@embedded-postgres/linux-x64` runtime payload retains execute bits;
agent-harness and ACP platform packages receive no name-based exemption. A
read-only workflow builds `linux/amd64`; a
separate `mte-v*`-triggered workflow publishes only the content-addressed image
digest. It deliberately creates no mutable GHCR tag because the registry does
not expose a portable atomic create-if-absent tag operation. BuildKit emits
SBOM/provenance attestations and cosign signs the resulting digest with an exact
GitHub OIDC workflow identity. Immediately before finalization, publication
re-fetches the remote Git tag and requires it to resolve to the triggering
commit. The exact tag, commit, image, and digest metadata is stored atomically in
the GitHub Release body, avoiding partial asset state. A retry accepts an
existing release only when its immutable body and release fields match exactly;
mismatches and lookup/auth/network failures stop the workflow. Consumers deploy the logged
`ghcr.io/<owner>/paperclip-mte@sha256:...` reference.

The image ABI manifest is `/app/image-abi/manifest.json`; its stable validation
command is `node /app/image-abi/verify.mjs`. It publishes exact paths for the
Daytona plugin, Daytona SDK, plugin SDK, Paperclip-side Pi adapter, and the S3 client used by
Daytona control-plane probes. The plugin install path is
`/app/plugins/daytona`. Pi's agent CLI remains outside this control-plane image
and runs only in the selected remote sandbox runtime.

No registry image, GitHub repository, release, or remote fork is created by the
source change itself.
