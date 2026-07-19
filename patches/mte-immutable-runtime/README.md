# MTE immutable runtime image patch

## Why this patch exists

Upstream `v2026.707.0` installs mutable `@latest` agent-harness CLIs in its
production image. That conflicts with the MTE deployment contract: Paperclip is
the control plane, while agent execution occurs in remote Daytona sandboxes.
The mutable global installs also prevent a source commit from uniquely
describing the resulting runtime.

## Smallest alternative

`Dockerfile.mte` is maintained directly so there is one source of truth. It
pins both its Dockerfile frontend and Node base image by digest, resolves the
complete pnpm workspace graph, and deploys only the server's production
dependency closure. A build-time verifier rejects missing workspace runtime
dependencies and broken links. It inspects every transitive manifest and file,
removes all package bins and shims, and rejects executable content outside the
single explicit `@embedded-postgres/linux-x64` server-runtime exemption. Agent
harness and ACP platform packages receive no name-based exemption.

## Maintenance cost and removal

The fork owns one additional Dockerfile, two small runtime verification scripts,
and separate read-only build and digest-only publish workflows. It must
periodically refresh pinned digests and action SHAs. Remove these files after
upstream offers a digest-pinned, harness-free production closure.
