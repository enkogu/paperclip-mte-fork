import { describe, expect, it } from "vitest";
import {
  PLUGIN_CONFIG_MAX_DEPTH,
  PLUGIN_CONFIG_MAX_NODES,
  validateInstanceConfig,
} from "../services/plugin-config-validator.js";

const acceptingSchema = { type: "object" };

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { value: "ok" };
  for (let index = 0; index < depth; index += 1) {
    value = { value };
  }
  return value;
}

describe("plugin config validation resource limits", () => {
  it("accepts config at the depth limit and rejects one level beyond it", () => {
    expect(validateInstanceConfig(nestedObject(PLUGIN_CONFIG_MAX_DEPTH - 1), acceptingSchema))
      .toEqual({ valid: true });
    expect(validateInstanceConfig(nestedObject(PLUGIN_CONFIG_MAX_DEPTH), acceptingSchema))
      .toEqual({ valid: false, errors: [{
        field: "/",
        message: "Configuration exceeds the maximum supported depth or size.",
      }] });
  });

  it("accepts config at the node limit and rejects one node beyond it", () => {
    const configAtLimit = {
      items: Array.from({ length: PLUGIN_CONFIG_MAX_NODES - 2 }, () => "ok"),
    };
    const configAboveLimit = {
      items: Array.from({ length: PLUGIN_CONFIG_MAX_NODES - 1 }, () => "ok"),
    };

    expect(validateInstanceConfig(configAtLimit, acceptingSchema)).toEqual({ valid: true });
    expect(validateInstanceConfig(configAboveLimit, acceptingSchema)).toEqual({
      valid: false,
      errors: [{
        field: "/",
        message: "Configuration exceeds the maximum supported depth or size.",
      }],
    });
  });

  it("rejects an over-budget schema before Ajv compiles it", () => {
    expect(validateInstanceConfig({ enabled: true }, nestedObject(PLUGIN_CONFIG_MAX_DEPTH) as typeof acceptingSchema))
      .toEqual({
        valid: false,
        errors: [{
          field: "/",
          message: "Configuration exceeds the maximum supported depth or size.",
        }],
      });
  });

  it("returns only the first ordinary validation error", () => {
    const result = validateInstanceConfig(
      { primary: 1, secondary: 2 },
      {
        type: "object",
        required: ["requiredValue"],
        properties: {
          primary: { type: "string" },
          secondary: { type: "string" },
        },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("preserves a 256 KiB valid config within a generous timeout", () => {
    const config = { payload: "x".repeat(256 * 1024) };
    const schema = {
      type: "object",
      required: ["payload"],
      properties: { payload: { type: "string" } },
    };

    expect(validateInstanceConfig(config, schema)).toEqual({ valid: true });
  }, 10_000);
});
