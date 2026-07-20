#!/usr/bin/env python3
from pathlib import Path

dockerfile = Path(__file__).resolve().parents[2] / "Dockerfile.mte"
source = dockerfile.read_text()

legacy = """  && PAPERCLIP_RELEASE_REUSE_UI_DIST=1 pnpm --filter @paperclipai/server prepack \\
  && pnpm --filter @paperclipai/server... build \\
  && pnpm --filter @paperclipai/plugin-daytona... build \\
  && pnpm --filter @paperclipai/server deploy --prod /opt/runtime/server \\
  && pnpm --filter @paperclipai/plugin-daytona deploy --prod /opt/runtime/plugins/daytona \\
  && mkdir -p /opt/runtime/image-abi \\
  && cp scripts/verify-mte-image-abi.mjs /opt/runtime/image-abi/verify.mjs \\
  && cp scripts/mte-image-abi.json /opt/runtime/image-abi/manifest.json \\
  && node scripts/prune-mte-runtime.mjs /opt/runtime \\
  && node scripts/verify-mte-runtime.mjs /opt/runtime \\
  && node /opt/runtime/image-abi/verify.mjs /opt/runtime
"""

before = """  && PAPERCLIP_RELEASE_REUSE_UI_DIST=1 pnpm --filter @paperclipai/server prepack \\
  && pnpm --filter @paperclipai/server... build \\
  && rm -rf /tmp/mte-daytona-build \\
  && cp -R packages/plugins/sandbox-providers/daytona/image-build /tmp/mte-daytona-build \\
  && cp -R packages/plugins/sandbox-providers/daytona/src /tmp/mte-daytona-build/src \\
  && cp -R packages/plugins/sdk/dist /tmp/mte-daytona-build/local/plugin-sdk/dist \\
  && cp -R packages/shared/dist /tmp/mte-daytona-build/local/shared/dist \\
  && pnpm -C /tmp/mte-daytona-build install --frozen-lockfile --ignore-scripts \\
  && pnpm -C /tmp/mte-daytona-build run build \\
  && pnpm -C /tmp/mte-daytona-build prune --prod --ignore-scripts \\
  && pnpm --filter @paperclipai/server deploy --prod /opt/runtime/server \\
  && mkdir -p /opt/runtime/plugins/daytona \\
  && cp -R /tmp/mte-daytona-build/package.json /tmp/mte-daytona-build/dist /tmp/mte-daytona-build/node_modules /tmp/mte-daytona-build/local /opt/runtime/plugins/daytona/ \\
  && mkdir -p /opt/runtime/image-abi \\
  && cp scripts/verify-mte-image-abi.mjs /opt/runtime/image-abi/verify.mjs \\
  && cp scripts/mte-image-abi.json /opt/runtime/image-abi/manifest.json \\
  && node scripts/prune-mte-runtime.mjs /opt/runtime \\
  && node scripts/verify-mte-runtime.mjs /opt/runtime \\
  && node /opt/runtime/image-abi/verify.mjs /opt/runtime
"""

copy_line = "  && cp -R /tmp/mte-daytona-build/package.json /tmp/mte-daytona-build/dist /tmp/mte-daytona-build/node_modules /tmp/mte-daytona-build/local /opt/runtime/plugins/daytona/ \\\n"
shared_link = """  && mkdir -p /opt/runtime/plugins/daytona/local/plugin-sdk/node_modules/@paperclipai \\
  && ln -s ../../../shared /opt/runtime/plugins/daytona/local/plugin-sdk/node_modules/@paperclipai/shared \\
"""
server_resolver_link = """  && mkdir -p /opt/runtime/server/node_modules/@paperclipai \\
  && ln -s ../../../plugins/daytona /opt/runtime/server/node_modules/@paperclipai/plugin-daytona \\
"""
server_sdk_resolver_link = """  && mkdir -p /opt/runtime/server/node_modules/@daytonaio \\
  && ln -s ../../../plugins/daytona/node_modules/@daytonaio/sdk /opt/runtime/server/node_modules/@daytonaio/sdk \\
"""
with_shared_link = before.replace(copy_line, copy_line + shared_link, 1)
with_server_resolver = with_shared_link.replace(shared_link, shared_link + server_resolver_link, 1)
after = with_server_resolver.replace(server_resolver_link, server_resolver_link + server_sdk_resolver_link, 1)
server_deploy_line = "  && pnpm --filter @paperclipai/server deploy --prod /opt/runtime/server \\\n"
normalize_workspace_line = "  && node scripts/normalize-mte-workspace-exports.mjs /opt/runtime/server \\\n"
abi_manifest_line = "  && cp scripts/mte-image-abi.json /opt/runtime/image-abi/manifest.json \\\n"
smoke_copy_line = "  && cp scripts/smoke-mte-server-runtime.mjs /opt/runtime/image-abi/smoke-server.mjs \\\n"
desired_after = after.replace(
    server_deploy_line,
    server_deploy_line + normalize_workspace_line,
    1,
).replace(abi_manifest_line, abi_manifest_line + smoke_copy_line, 1)
if (
    with_shared_link == before
    or with_server_resolver == with_shared_link
    or after == with_server_resolver
    or desired_after == after
):
    raise SystemExit("MTE image ABI patch definition is invalid")

if desired_after in source:
    print("Dockerfile.mte production workspace and Daytona closure patch already applied")
elif after in source:
    dockerfile.write_text(source.replace(after, desired_after, 1))
    print("Applied server production workspace closure to Dockerfile.mte")
elif with_server_resolver in source:
    dockerfile.write_text(source.replace(with_server_resolver, desired_after, 1))
    print("Applied Daytona SDK server resolver link to Dockerfile.mte")
elif with_shared_link in source:
    dockerfile.write_text(source.replace(with_shared_link, desired_after, 1))
    print("Applied Daytona server resolver closure links to Dockerfile.mte")
elif before in source:
    dockerfile.write_text(source.replace(before, desired_after, 1))
    print("Applied Dockerfile.mte isolated Daytona image-build and server resolver closure patch")
elif legacy in source:
    dockerfile.write_text(source.replace(legacy, desired_after, 1))
    print("Applied Dockerfile.mte isolated Daytona image-build and server resolver closure patch from legacy preimage")
else:
    raise SystemExit("Dockerfile.mte does not match the reviewed image ABI preimage")

source = dockerfile.read_text()
production_anchor = "  PAPERCLIP_DEPLOYMENT_EXPOSURE=private\n\nUSER node\n"
production_smoke = (
    "  PAPERCLIP_DEPLOYMENT_EXPOSURE=private\n\n"
    "USER node\n\n"
    "RUN node /app/image-abi/smoke-server.mjs /app/server\n"
)
production_smoke_as_root = (
    "  PAPERCLIP_DEPLOYMENT_EXPOSURE=private\n\n"
    "RUN node /app/image-abi/smoke-server.mjs /app/server\n\n"
    "USER node\n"
)
if production_smoke in source:
    print("Dockerfile.mte final-image server runtime smoke already applied")
elif production_smoke_as_root in source:
    dockerfile.write_text(source.replace(production_smoke_as_root, production_smoke, 1))
    print("Moved final-image server runtime smoke to the production node identity")
elif production_anchor in source:
    dockerfile.write_text(source.replace(production_anchor, production_smoke, 1))
    print("Applied final-image server runtime smoke to Dockerfile.mte")
else:
    raise SystemExit("Dockerfile.mte production smoke anchor does not match the reviewed preimage")

workflow = dockerfile.parent / ".github/workflows/mte-image-build.yml"
workflow_source = workflow.read_text()
workflow_anchor = """      - name: Guard the CodeQL workflow contract
        run: node --test scripts/codeql-workflow.test.mjs
"""
workflow_after = workflow_anchor + """      - name: Verify MTE server runtime closure source contracts
        run: node --test scripts/mte-server-runtime-closure.test.mjs
"""
if workflow_after in workflow_source:
    print("MTE image build runtime closure source test already applied")
elif workflow_anchor in workflow_source:
    workflow.write_text(workflow_source.replace(workflow_anchor, workflow_after, 1))
    print("Applied MTE image build runtime closure source test")
else:
    raise SystemExit("MTE image build workflow does not match the reviewed preimage")
