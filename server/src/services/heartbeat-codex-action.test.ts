import { describe, expect, it } from "vitest";
import { parseCodexActionProgressEvent } from "./heartbeat.js";

describe("Codex action progress events", () => {
  it("emits fixed metadata without command text, arguments, or output", () => {
    const secret = "sk-fixture-never-persist";
    const event = parseCodexActionProgressEvent(JSON.stringify({
      type: "item.completed",
      item: {
        id: "item-1",
        type: "command_execution",
        command: `curl -H 'Authorization: Bearer ${secret}'`,
        aggregated_output: `stdout contains ${secret}`,
        status: "completed",
        exit_code: 0,
      },
    }));

    expect(event).toEqual({
      eventType: "tool.action",
      stream: "system",
      level: "info",
      message: "Codex shell action completed",
      payload: { toolName: "shell", status: "completed", exitCode: 0 },
    });
    const persisted = JSON.stringify(event);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("curl");
    expect(persisted).not.toContain("aggregated_output");
  });

  it("ignores malformed, unrelated, and incomplete records", () => {
    expect(parseCodexActionProgressEvent("{not-json")).toBeNull();
    expect(parseCodexActionProgressEvent('{"type":"thread.started"}')).toBeNull();
    expect(parseCodexActionProgressEvent(
      '{"type":"item.completed","item":{"type":"agent_message"}}',
    )).toBeNull();
  });
});
