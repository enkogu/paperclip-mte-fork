import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL, models } from "./index.js";
import { sessionCodec } from "./server/index.js";

describe("codex local adapter metadata", () => {
  it("does not advertise the ChatGPT-unsupported gpt-5.3-codex model as a default option", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.5");
    expect(models.map((model) => model.id)).not.toContain("gpt-5.3-codex");
  });
});

describe("codex session codec", () => {
  it("round-trips opaque remote identity and server-issued task provenance", () => {
    const remoteExecution = {
      transport: "sandbox",
      providerKey: "daytona",
      environmentId: "environment-1",
      leaseId: "provider-sandbox-1",
      remoteCwd: "/remote/workspace",
      futureOpaqueField: { preserve: [true, 7] },
    };

    const encoded = sessionCodec.serialize({
      sessionId: "session-123",
      cwd: remoteExecution.remoteCwd,
      remoteExecution,
      paperclipTaskKey: "issue:alpha",
      paperclipBoundSessionId: "session-123",
    });
    const decoded = sessionCodec.deserialize(encoded);

    expect(decoded).toMatchObject({
      sessionId: "session-123",
      remoteExecution,
      paperclipTaskKey: "issue:alpha",
      paperclipBoundSessionId: "session-123",
    });
  });

  it("does not accept arrays as a remote execution identity", () => {
    expect(sessionCodec.deserialize({
      sessionId: "session-123",
      remoteExecution: ["not", "an", "identity"],
    })).toEqual({ sessionId: "session-123" });
  });
});
