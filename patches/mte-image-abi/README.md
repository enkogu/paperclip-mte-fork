# MTE image ABI closure

## Scope and blocker

The supported upstream image does not provide the fork's required local Daytona
plugin package path or a machine-readable way to prove the control-plane runtime
closure. The smallest fork-only alternative is to build Daytona from its
dedicated `image-build` workspace and deploy that isolated production closure
beside the server. Its lock pins `@daytonaio/sdk` at `0.175.0` and resolves the
locally built plugin SDK and shared packages through `file:` dependencies. The
root workspace lock and peer policy remain outside this dependency domain.
The deployed server receives closure-internal package links at
`/app/server/node_modules/@paperclipai/plugin-daytona`, pointing to the same
verified `/app/plugins/daytona` package, and at
`/app/server/node_modules/@daytonaio/sdk`, pointing to the SDK already present
inside that plugin's production closure. These exact named links make normal
Node package resolution, the Paperclip plugin loader, and server-root ABI
probes agree on one immutable copy of each package. No whole `node_modules`
tree is shared or duplicated; the runtime verifier rejects links that escape
the image closure.

The image continues to exclude the operator CLI and agent-harness/ACP
executables. Pi is represented only by Paperclip's server-side
`@paperclipai/adapter-pi-local`; the Pi coding-agent CLI remains a remote-sandbox
concern.

Apply from the repository root:

```sh
python3 patches/mte-image-abi/apply.py
```

The applicator is exact and idempotent: it accepts only the reviewed preimage or
the already-applied result. Docker copies source plus locally built package
outputs into a temporary workspace, performs a frozen script-disabled install,
compiles Daytona, prunes dev dependencies, and copies only that closure into the
runtime. It also recreates the plugin SDK's internal `@paperclipai/shared`
resolution link to the copied local package; the link cannot escape the deployed
runtime root and is checked by both the closure verifier and the image ABI test.
The ABI verifier also loads the real Daytona ESM entrypoint and resolves both
the plugin and Daytona SDK from the server context, so a missing transitive SDK
or broken resolver link fails the image build.
Remove this package and the ABI copy/deploy steps when the official
Paperclip image exposes equivalent pinned package paths.
