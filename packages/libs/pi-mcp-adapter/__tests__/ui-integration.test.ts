/**
 * Integration tests for MCP UI flow
 * 
 * These tests exercise the full flow from tool call with UI resource
 * through browser communication back to agent message retrieval.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { startUiServer, type UiServerHandle } from "../ui-server.js";
import { UiResourceHandler } from "../ui-resource-handler.js";
import { ConsentManager } from "../consent-manager.js";
import type { McpServerManager } from "../server-manager.js";
import type { UiResourceContent, UiSessionMessages } from "../types.js";

// Helper to make HTTP requests
async function request(
  url: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? "GET",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// Simulate browser behavior
class BrowserSimulator {
  private serverUrl: string;
  private sessionToken: string;

  constructor(handle: UiServerHandle) {
    this.serverUrl = `http://localhost:${handle.port}`;
    this.sessionToken = handle.sessionToken;
  }

  async loadPage(): Promise<string> {
    const res = await request(`${this.serverUrl}/?session=${this.sessionToken}`);
    if (res.status !== 200) throw new Error(`Page load failed: ${res.status}`);
    return res.body as string;
  }

  async sendPrompt(prompt: string): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/message`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { type: "prompt", prompt },
      },
    });
    if (res.status !== 200) throw new Error(`Send prompt failed: ${res.status}`);
  }

  async sendIntent(intent: string, params?: Record<string, unknown>): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/message`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { type: "intent", intent, params },
      },
    });
    if (res.status !== 200) throw new Error(`Send intent failed: ${res.status}`);
  }

  async sendNotification(message: string): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/message`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { type: "notify", message },
      },
    });
    if (res.status !== 200) throw new Error(`Send notification failed: ${res.status}`);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const res = await request(`${this.serverUrl}/proxy/tools/call`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { name, arguments: args },
      },
    });
    if (res.status !== 200) throw new Error(`Tool call failed: ${res.status}`);
    return (res.body as { result: unknown }).result;
  }

  async grantConsent(): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/consent`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { approved: true },
      },
    });
    if (res.status !== 200) throw new Error(`Consent failed: ${res.status}`);
  }

  async heartbeat(): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/heartbeat`, {
      method: "POST",
      body: { token: this.sessionToken, params: {} },
    });
    if (res.status !== 200) throw new Error(`Heartbeat failed: ${res.status}`);
  }

  async complete(reason = "done"): Promise<void> {
    const res = await request(`${this.serverUrl}/proxy/ui/complete`, {
      method: "POST",
      body: {
        token: this.sessionToken,
        params: { reason },
      },
    });
    if (res.status !== 200) throw new Error(`Complete failed: ${res.status}`);
  }
}

// Mock manager that simulates real MCP server behavior
function createIntegrationManager(): McpServerManager {
  const tools = new Map([
    ["get_data", { result: { data: [1, 2, 3] } }],
    ["save_file", { result: { saved: true, path: "/tmp/file.txt" } }],
    ["slow_operation", { result: { completed: true }, delay: 100 }],
  ]);

  return {
    getConnection: vi.fn().mockReturnValue({
      status: "connected",
      client: {
        callTool: vi.fn().mockImplementation(async ({ name }) => {
          const tool = tools.get(name);
          if (!tool) throw new Error(`Unknown tool: ${name}`);
          if ((tool as { delay?: number }).delay) {
            await new Promise((r) => setTimeout(r, (tool as { delay: number }).delay));
          }
          return { content: [{ type: "text", text: JSON.stringify(tool.result) }] };
        }),
      },
    }),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
    readResource: vi.fn().mockResolvedValue({
      contents: [
        {
          uri: "ui://test/app",
          mimeType: "text/html",
          text: `<!DOCTYPE html>
<html>
<head><title>Test App</title></head>
<body>
  <h1>Test MCP App</h1>
  <button id="getData">Get Data</button>
  <button id="sendPrompt">Ask Agent</button>
</body>
</html>`,
        },
      ],
    }),
  } as unknown as McpServerManager;
}

describe("MCP UI Integration", () => {
  let handle: UiServerHandle | null = null;

  afterEach(() => {
    if (handle) {
      handle.close("test-cleanup");
      handle = null;
    }
  });

  describe("Full UI Session Flow", () => {
    it("completes a full agent → browser → agent cycle", async () => {
      // 1. Agent calls tool with UI
      const manager = createIntegrationManager();
      const consentManager = new ConsentManager("never"); // No consent prompts
      
      const resource: UiResourceContent = {
        uri: "ui://test/app",
        html: "<h1>Test App</h1>",
        mimeType: "text/html",
        meta: { permissions: [] },
      };

      const receivedMessages: UiSessionMessages = { prompts: [], notifications: [], intents: [] };
      const onMessage = vi.fn().mockImplementation((params) => {
        if (params.type === "prompt") receivedMessages.prompts.push(params.prompt);
      });

      handle = await startUiServer({
        serverName: "test-server",
        toolName: "launch_app",
        toolArgs: { mode: "interactive" },
        resource,
        manager,
        consentManager,
        onMessage,
      });

      // 2. Browser loads the page
      const browser = new BrowserSimulator(handle);
      const html = await browser.loadPage();
      expect(html).toContain("test-server");
      expect(html).toContain("launch_app");

      // 3. Browser calls a tool through the proxy
      const toolResult = await browser.callTool("get_data", { query: "test" });
      expect(toolResult).toBeDefined();

      // 4. Browser sends a prompt back to the agent
      await browser.sendPrompt("Please analyze this data and summarize");

      // 5. Agent retrieves the messages
      const messages = handle.getSessionMessages();
      expect(messages.prompts).toContain("Please analyze this data and summarize");

      // 6. Browser completes the session
      await browser.complete("user-done");
    });

    it("handles multiple messages in conversation", async () => {
      const manager = createIntegrationManager();
      const consentManager = new ConsentManager("never");
      
      const resource: UiResourceContent = {
        uri: "ui://test/chat",
        html: "<div id='chat'></div>",
        mimeType: "text/html",
        meta: { permissions: [] },
      };

      handle = await startUiServer({
        serverName: "chat-server",
        toolName: "open_chat",
        toolArgs: {},
        resource,
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Simulate a multi-turn conversation
      await browser.sendPrompt("What is the capital of France?");
      await browser.sendNotification("User is typing...");
      await browser.sendPrompt("And what about Germany?");
      await browser.sendIntent("show_map", { countries: ["France", "Germany"] });

      const messages = handle.getSessionMessages();
      expect(messages.prompts).toHaveLength(2);
      expect(messages.prompts[0]).toBe("What is the capital of France?");
      expect(messages.prompts[1]).toBe("And what about Germany?");
      expect(messages.notifications).toHaveLength(1);
      expect(messages.intents).toHaveLength(1);
      expect(messages.intents[0]).toEqual({
        intent: "show_map",
        params: { countries: ["France", "Germany"] },
      });
    });

    it("handles consent flow for tool calls", async () => {
      const manager = createIntegrationManager();
      const consentManager = new ConsentManager("once-per-server");
      
      const resource: UiResourceContent = {
        uri: "ui://test/app",
        html: "<h1>App</h1>",
        mimeType: "text/html",
        meta: { permissions: [] },
      };

      handle = await startUiServer({
        serverName: "sensitive-server",
        toolName: "admin_tool",
        toolArgs: {},
        resource,
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // First tool call should fail - no consent yet
      await expect(browser.callTool("get_data")).rejects.toThrow();

      // Grant consent
      await browser.grantConsent();

      // Now tool call should succeed
      const result = await browser.callTool("get_data");
      expect(result).toBeDefined();
    });

    it("tracks in-flight requests correctly", async () => {
      const manager = createIntegrationManager();
      const consentManager = new ConsentManager("never");
      
      const resource: UiResourceContent = {
        uri: "ui://test/app",
        html: "<h1>App</h1>",
        mimeType: "text/html",
        meta: { permissions: [] },
      };

      handle = await startUiServer({
        serverName: "test-server",
        toolName: "test_tool",
        toolArgs: {},
        resource,
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Call multiple tools
      await Promise.all([
        browser.callTool("get_data"),
        browser.callTool("save_file"),
      ]);

      // Both should have incremented/decremented
      expect(manager.incrementInFlight).toHaveBeenCalledTimes(2);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(2);
    });
  });

  describe("UiResourceHandler + UiServer Integration", () => {
    it("reads resource and starts server with correct content", async () => {
      const manager = createIntegrationManager();
      const handler = new UiResourceHandler(manager);

      // Read the UI resource
      const resource = await handler.readUiResource("test-server", "ui://test/app");
      expect(resource.html).toContain("Test MCP App");
      expect(resource.mimeType).toBe("text/html");

      // Start server with the resource
      const consentManager = new ConsentManager("never");
      handle = await startUiServer({
        serverName: "test-server",
        toolName: "launch_app",
        toolArgs: {},
        resource,
        manager,
        consentManager,
      });

      // Verify page contains the resource content
      const browser = new BrowserSimulator(handle);
      const html = await browser.loadPage();
      // The host page wraps the resource in an iframe
      expect(html).toContain("iframe");
    });
  });

  describe("Session Lifecycle", () => {
    it("calls onComplete when session ends", async () => {
      const onComplete = vi.fn();
      const manager = createIntegrationManager();
      const consentManager = new ConsentManager("never");
      
      handle = await startUiServer({
        serverName: "test-server",
        toolName: "test_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: [] },
        },
        manager,
        consentManager,
        onComplete,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();
      await browser.complete("user-finished");

      // Wait for callback
      await new Promise((r) => setTimeout(r, 50));
      expect(onComplete).toHaveBeenCalledWith("user-finished");
    });

    it("maintains heartbeat to prevent timeout", async () => {
      const manager = createIntegrationManager();
      const consentManager = new ConsentManager("never");
      
      handle = await startUiServer({
        serverName: "test-server",
        toolName: "test_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: [] },
        },
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Send heartbeats
      await browser.heartbeat();
      await browser.heartbeat();

      // Session should still be active
      const html = await browser.loadPage();
      expect(html).toContain("test-server");
    });
  });

  describe("Error Handling", () => {
    it("handles MCP server errors gracefully", async () => {
      const manager = {
        ...createIntegrationManager(),
        getConnection: vi.fn().mockReturnValue({
          status: "connected",
          client: {
            callTool: vi.fn().mockRejectedValue(new Error("MCP server error")),
          },
        }),
      } as unknown as McpServerManager;

      const consentManager = new ConsentManager("never");
      
      handle = await startUiServer({
        serverName: "error-server",
        toolName: "error_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: [] },
        },
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Tool call should fail but not crash the server
      await expect(browser.callTool("failing_tool")).rejects.toThrow();

      // Server should still be responsive
      await browser.heartbeat();
    });

    it("handles disconnected server", async () => {
      const manager = {
        ...createIntegrationManager(),
        getConnection: vi.fn().mockReturnValue(null),
      } as unknown as McpServerManager;

      const consentManager = new ConsentManager("never");
      
      handle = await startUiServer({
        serverName: "disconnected-server",
        toolName: "test_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: [] },
        },
        manager,
        consentManager,
      });

      const browser = new BrowserSimulator(handle);
      await browser.loadPage();

      // Tool call should fail with 503
      await expect(browser.callTool("any_tool")).rejects.toThrow("503");
    });
  });

  describe("Display Mode Changes", () => {
    it("allows switching display modes", async () => {
      const manager = createIntegrationManager();
      const consentManager = new ConsentManager("never");
      
      handle = await startUiServer({
        serverName: "test-server",
        toolName: "test_tool",
        toolArgs: {},
        resource: {
          uri: "ui://test/app",
          html: "<h1>App</h1>",
          mimeType: "text/html",
          meta: { permissions: [] },
        },
        manager,
        consentManager,
        hostContext: {
          displayMode: "inline",
          availableDisplayModes: ["inline", "fullscreen", "pip"],
        },
      });

      // Request fullscreen
      const res = await request(`http://localhost:${handle.port}/proxy/ui/request-display-mode`, {
        method: "POST",
        body: {
          token: handle.sessionToken,
          params: { mode: "fullscreen" },
        },
      });

      expect(res.status).toBe(200);
      expect((res.body as { result: { mode: string } }).result.mode).toBe("fullscreen");
    });
  });
});
