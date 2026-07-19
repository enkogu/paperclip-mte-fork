# Paperclip MTE Fork Notice

This repository is a non-official fork of Paperclip, based on upstream release
`v2026.707.0` at commit `390627b46eb333309d357004384b220ecf8a65af`.

The fork exists to carry a narrowly scoped immutable-runtime patch set for the
MTE deployment while the changes are evaluated for upstreaming. It is not
produced, endorsed, or supported by the upstream Paperclip maintainers.

Upstream copyright and license terms remain in force. See `LICENSE` and the
upstream repository history for attribution. Fork-specific changes are
identified by Git history and the `codex/mte-immutable-runtime` branch.

The custom container intentionally excludes bundled agent-harness CLIs. Agent
execution is delegated to the configured remote execution provider.
