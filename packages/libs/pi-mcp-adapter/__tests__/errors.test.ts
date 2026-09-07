import { describe, it, expect } from "vitest";
import {
  McpUiError,
  ResourceFetchError,
  ResourceParseError,
  BridgeConnectionError,
  ConsentError,
  SessionError,
  ServerError,
  McpServerError,
  wrapError,
  isErrorCode,
} from "../errors.js";

describe("McpUiError", () => {
  it("creates error with required fields", () => {
    const error = new McpUiError("test message", { code: "TEST_ERROR" });

    expect(error.message).toBe("test message");
    expect(error.code).toBe("TEST_ERROR");
    expect(error.name).toBe("McpUiError");
    expect(error.context).toEqual({});
  });

  it("includes optional fields", () => {
    const cause = new Error("root cause");
    const error = new McpUiError("test", {
      code: "TEST",
      context: { server: "test-server" },
      recoveryHint: "Try again",
      cause,
    });

    expect(error.context.server).toBe("test-server");
    expect(error.recoveryHint).toBe("Try again");
    expect(error.cause).toBe(cause);
  });

  it("serializes to JSON", () => {
    const error = new McpUiError("test", {
      code: "TEST",
      context: { server: "s1" },
      recoveryHint: "hint",
    });

    const json = error.toJSON();
    expect(json.name).toBe("McpUiError");
    expect(json.code).toBe("TEST");
    expect(json.message).toBe("test");
    expect(json.context).toEqual({ server: "s1" });
    expect(json.recoveryHint).toBe("hint");
    expect(json.stack).toBeDefined();
  });
});

describe("ResourceFetchError", () => {
  it("formats message correctly", () => {
    const error = new ResourceFetchError("ui://test/resource", "not found", {
      server: "test-server",
    });

    expect(error.message).toBe(
      'Failed to fetch UI resource "ui://test/resource": not found'
    );
    expect(error.code).toBe("RESOURCE_FETCH_ERROR");
    expect(error.context.uri).toBe("ui://test/resource");
    expect(error.context.server).toBe("test-server");
    expect(error.recoveryHint).toContain("Check that the MCP server");
  });

  it("includes cause", () => {
    const cause = new Error("network error");
    const error = new ResourceFetchError("ui://test", "failed", { cause });

    expect(error.cause).toBe(cause);
  });
});

describe("ResourceParseError", () => {
  it("formats message correctly", () => {
    const error = new ResourceParseError("ui://test", "invalid HTML", {
      server: "test-server",
      mimeType: "text/plain",
    });

    expect(error.message).toBe('Invalid UI resource "ui://test": invalid HTML');
    expect(error.code).toBe("RESOURCE_PARSE_ERROR");
    expect(error.context.mimeType).toBe("text/plain");
  });
});

describe("BridgeConnectionError", () => {
  it("formats message correctly", () => {
    const error = new BridgeConnectionError("timeout", { session: "abc123" });

    expect(error.message).toBe("AppBridge connection failed: timeout");
    expect(error.code).toBe("BRIDGE_CONNECTION_ERROR");
    expect(error.context.session).toBe("abc123");
    expect(error.recoveryHint).toContain("browser console");
  });
});

describe("ConsentError", () => {
  it("creates denial error", () => {
    const error = new ConsentError("test-server", { denied: true });

    expect(error.message).toBe(
      'Tool calls for "test-server" were denied for this session'
    );
    expect(error.code).toBe("CONSENT_DENIED");
    expect(error.denied).toBe(true);
    expect(error.recoveryHint).toContain("Start a new session");
  });

  it("creates requires approval error", () => {
    const error = new ConsentError("test-server", { requiresApproval: true });

    expect(error.message).toBe('Tool call approval required for "test-server"');
    expect(error.code).toBe("CONSENT_REQUIRED");
    expect(error.denied).toBe(false);
    expect(error.recoveryHint).toContain("Prompt the user");
  });
});

describe("SessionError", () => {
  it("formats message correctly", () => {
    const error = new SessionError("expired", { session: "xyz789" });

    expect(error.message).toBe("Session error: expired");
    expect(error.code).toBe("SESSION_ERROR");
    expect(error.context.session).toBe("xyz789");
  });
});

describe("ServerError", () => {
  it("formats message correctly", () => {
    const error = new ServerError("port in use", { port: 3000 });

    expect(error.message).toBe("UI server error: port in use");
    expect(error.code).toBe("SERVER_ERROR");
    expect(error.context.port).toBe(3000);
    expect(error.recoveryHint).toContain("port is available");
  });
});

describe("McpServerError", () => {
  it("formats message correctly", () => {
    const error = new McpServerError("my-server", "connection lost", {
      tool: "test-tool",
    });

    expect(error.message).toBe('MCP server "my-server" error: connection lost');
    expect(error.code).toBe("MCP_SERVER_ERROR");
    expect(error.context.server).toBe("my-server");
    expect(error.context.tool).toBe("test-tool");
  });
});

describe("wrapError", () => {
  it("passes through McpUiError with merged context", () => {
    const original = new McpUiError("original", {
      code: "ORIGINAL",
      context: { server: "s1" },
    });

    const wrapped = wrapError(original, { tool: "t1" });

    expect(wrapped.code).toBe("ORIGINAL");
    expect(wrapped.context.server).toBe("s1");
    expect(wrapped.context.tool).toBe("t1");
  });

  it("wraps standard Error", () => {
    const original = new Error("standard error");
    const wrapped = wrapError(original, { server: "test" });

    expect(wrapped.code).toBe("UNKNOWN_ERROR");
    expect(wrapped.message).toBe("standard error");
    expect(wrapped.cause).toBe(original);
    expect(wrapped.context.server).toBe("test");
  });

  it("wraps string error", () => {
    const wrapped = wrapError("string error");

    expect(wrapped.code).toBe("UNKNOWN_ERROR");
    expect(wrapped.message).toBe("string error");
  });

  it("wraps unknown value", () => {
    const wrapped = wrapError(42);

    expect(wrapped.code).toBe("UNKNOWN_ERROR");
    expect(wrapped.message).toBe("42");
  });
});

describe("isErrorCode", () => {
  it("returns true for matching code", () => {
    const error = new McpUiError("test", { code: "MY_CODE" });
    expect(isErrorCode(error, "MY_CODE")).toBe(true);
  });

  it("returns false for non-matching code", () => {
    const error = new McpUiError("test", { code: "MY_CODE" });
    expect(isErrorCode(error, "OTHER_CODE")).toBe(false);
  });

  it("returns false for non-McpUiError", () => {
    const error = new Error("regular error");
    expect(isErrorCode(error, "ANY_CODE")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isErrorCode(null, "ANY_CODE")).toBe(false);
    expect(isErrorCode(undefined, "ANY_CODE")).toBe(false);
  });
});
