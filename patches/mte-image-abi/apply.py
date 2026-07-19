#!/usr/bin/env python3
from pathlib import Path

dockerfile = Path(__file__).resolve().parents[2] / "Dockerfile.mte"
source = dockerfile.read_text()

before = """  && PAPERCLIP_RELEASE_REUSE_UI_DIST=1 pnpm --filter @paperclipai/server prepack \\
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

after = """  && PAPERCLIP_RELEASE_REUSE_UI_DIST=1 pnpm --filter @paperclipai/server prepack \\
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

if after in source:
    print("Dockerfile.mte isolated Daytona image-build patch already applied")
elif before in source:
    dockerfile.write_text(source.replace(before, after, 1))
    print("Applied Dockerfile.mte isolated Daytona image-build patch")
else:
    raise SystemExit("Dockerfile.mte does not match the reviewed image ABI preimage")
