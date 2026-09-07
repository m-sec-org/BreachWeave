import { describe, expect, it } from "vitest";
import { buildProxyDescription } from "../direct-tools.js";
import type { MetadataCache } from "../metadata-cache.js";
import type { McpConfig } from "../types.js";

describe("buildProxyDescription", () => {
  it("documents the ui-messages action", () => {
    const config: McpConfig = {
      mcpServers: {
        demo: {
          command: "npx",
          args: ["-y", "demo-server"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        demo: {
          configHash: "hash",
          cachedAt: Date.now(),
          tools: [
            {
              name: "launch_app",
              description: "Launch the demo app",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          resources: [],
        },
      },
    };

    const description = buildProxyDescription(config, cache, []);

    expect(description).toContain('mcp({ action: "ui-messages" })');
    expect(description).toContain("Retrieve accumulated messages from completed UI sessions");
  });
});
