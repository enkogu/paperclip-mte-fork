# MTE immutable runtime image patch

## Why this patch exists

Upstream `v2026.707.0` installs mutable `@latest` agent-harness CLIs in its
production image. That conflicts with the MTE deployment contract: Paperclip is
the control plane, while agent execution occurs in remote Daytona sandboxes.
The mutable global installs also prevent a source commit from uniquely
describing the resulting runtime.

## Smallest alternative

`apply.py` adds a separate `Dockerfile.mte`; it does not modify the upstream
`Dockerfile`. The image pins its base by digest, builds the Paperclip server,
CLI, plugin SDK, and Daytona provider from this checkout, and installs no
Codex, Claude Code, OpenCode, Gemini, or similar agent-harness CLI.

Apply from the repository root:

```sh
python3 patches/mte-immutable-runtime/apply.py
```

The script first runs `git apply --check`, then applies an embedded unified
diff. It refuses to overwrite an existing target.

## Maintenance cost and removal

The fork owns one additional Dockerfile and must periodically refresh its
digest-pinned base and keep build steps aligned with upstream. Remove the
custom image by deleting `Dockerfile.mte`, this patch directory, and the MTE
image workflow after upstream offers a digest-pinned, harness-free image mode.
