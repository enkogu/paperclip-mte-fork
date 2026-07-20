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
with_shared_link = before.replace(copy_line, copy_line + shared_link, 1)
after = with_shared_link.replace(shared_link, shared_link + server_resolver_link, 1)
if with_shared_link == before or after == with_shared_link:
    raise SystemExit("MTE image ABI patch definition is invalid")

if after in source:
    print("Dockerfile.mte isolated Daytona image-build and server resolver patch already applied")
elif with_shared_link in source:
    dockerfile.write_text(source.replace(with_shared_link, after, 1))
    print("Applied Daytona server resolver link to Dockerfile.mte")
elif before in source:
    dockerfile.write_text(source.replace(before, after, 1))
    print("Applied Dockerfile.mte isolated Daytona image-build and server resolver patch")
elif legacy in source:
    dockerfile.write_text(source.replace(legacy, after, 1))
    print("Applied Dockerfile.mte isolated Daytona image-build and server resolver patch from legacy preimage")
else:
    raise SystemExit("Dockerfile.mte does not match the reviewed image ABI preimage")
