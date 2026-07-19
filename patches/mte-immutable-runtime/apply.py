#!/usr/bin/env python3
"""Add the MTE immutable-runtime Dockerfile using a checkable unified diff."""

from __future__ import annotations

import subprocess
import sys


PATCH = r'''diff --git a/Dockerfile.mte b/Dockerfile.mte
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/Dockerfile.mte
@@ -0,0 +1,96 @@
+# syntax=docker/dockerfile:1.20
+# Non-official MTE fork image. Agent execution belongs in remote sandboxes.
+FROM node:22-bookworm@sha256:175215a1f306ed5df592434b99cc2019f70624373fe49cb659240a618a846aed AS base
+ARG USER_UID=1000
+ARG USER_GID=1000
+RUN apt-get update \
+  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 openssh-client jq \
+  && rm -rf /var/lib/apt/lists/* \
+  && corepack enable
+
+RUN usermod -u "$USER_UID" --non-unique node \
+  && groupmod -g "$USER_GID" --non-unique node \
+  && usermod -g "$USER_GID" -d /paperclip node
+
+FROM base AS deps
+WORKDIR /app
+COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
+COPY cli/package.json cli/
+COPY server/package.json server/
+COPY ui/package.json ui/
+COPY packages/shared/package.json packages/shared/
+COPY packages/db/package.json packages/db/
+COPY packages/adapter-utils/package.json packages/adapter-utils/
+COPY packages/mcp-server/package.json packages/mcp-server/
+COPY packages/skills-catalog/package.json packages/skills-catalog/
+COPY packages/teams-catalog/package.json packages/teams-catalog/
+COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
+COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
+COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
+COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
+COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
+COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
+COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
+COPY packages/adapters/hermes/package.json packages/adapters/hermes/
+COPY packages/adapters/hermes-gateway/package.json packages/adapters/hermes-gateway/
+COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
+COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
+COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
+COPY packages/plugins/sdk/package.json packages/plugins/sdk/
+COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
+COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
+COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
+COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
+COPY patches/ patches/
+COPY scripts/link-plugin-dev-sdk.mjs scripts/
+RUN pnpm install --frozen-lockfile
+
+FROM base AS build
+WORKDIR /app
+COPY --from=deps /app /app
+COPY . .
+RUN pnpm --filter @paperclipai/ui build \
+  && pnpm --filter @paperclipai/plugin-sdk build \
+  && pnpm --filter @paperclipai/plugin-daytona build \
+  && pnpm --filter @paperclipai/server build \
+  && pnpm --filter paperclipai build \
+  && test -f server/dist/index.js \
+  && test -x cli/dist/index.js
+
+FROM base AS production
+ARG USER_UID=1000
+ARG USER_GID=1000
+ARG VCS_REF=unknown
+ARG SOURCE_REPOSITORY=https://github.com/paperclipai/paperclip
+LABEL org.opencontainers.image.title="Paperclip MTE (non-official)" \
+  org.opencontainers.image.description="Immutable MTE control-plane fork without bundled agent-harness CLIs" \
+  org.opencontainers.image.source="$SOURCE_REPOSITORY" \
+  org.opencontainers.image.revision="$VCS_REF" \
+  org.opencontainers.image.version="v2026.707.0-mte" \
+  org.opencontainers.image.licenses="MIT"
+WORKDIR /app
+COPY --chown=node:node --from=build /app /app
+COPY LICENSE NOTICE-MTE.md /usr/share/doc/paperclip-mte/
+RUN mkdir -p /paperclip \
+  && chown node:node /paperclip \
+  && ln -s /app/cli/dist/index.js /usr/local/bin/paperclipai
+
+COPY scripts/docker-entrypoint.sh /usr/local/bin/
+RUN chmod +x /usr/local/bin/docker-entrypoint.sh
+
+ENV NODE_ENV=production \
+  HOME=/paperclip \
+  HOST=0.0.0.0 \
+  PORT=3100 \
+  SERVE_UI=true \
+  PAPERCLIP_HOME=/paperclip \
+  PAPERCLIP_INSTANCE_ID=default \
+  USER_UID=${USER_UID} \
+  USER_GID=${USER_GID} \
+  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
+  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
+  PAPERCLIP_DEPLOYMENT_EXPOSURE=private
+
+EXPOSE 3100
+ENTRYPOINT ["docker-entrypoint.sh"]
+CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
'''


def run(*args: str) -> None:
    subprocess.run(args, input=PATCH, text=True, check=True)


if __name__ == "__main__":
    try:
        run("git", "apply", "--check", "-")
        run("git", "apply", "-")
    except subprocess.CalledProcessError as error:
        print("MTE Docker patch was not applied.", file=sys.stderr)
        raise SystemExit(error.returncode) from error
