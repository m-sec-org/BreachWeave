import type { ExtensionAPI, ToolInfo } from "@mariozechner/pi-coding-agent";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import { Type } from "@sinclair/typebox";
import { showStatus, showTools, reconnectServers, authenticateServer, openMcpPanel } from "./commands.js";
import { loadMcpConfig } from "./config.js";
import { buildProxyDescription, createDirectToolExecutor, resolveDirectTools } from "./direct-tools.js";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.js";
import { loadMetadataCache } from "./metadata-cache.js";
import { executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus, executeUiMessages } from "./proxy-modes.js";
import { getToolNamePrefix } from "./types.js";
import { resolveMcpConfigPath, truncateAtWord } from "./utils.js";

export interface McpAdapterOptions {
  configPath?: string;
  enabledServers?: string[];
  enabledTools?: string[];
}

const EMPTY_TOOL_PARAMETERS = Type.Unsafe<Record<string, unknown>>({
  type: "object",
  properties: {},
}) as ToolDefinition["parameters"];

const MCP_PROXY_PARAMETERS = Type.Object({
  tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
  args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
  connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
  describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
  search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
  regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
  includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
  server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
  action: Type.Optional(Type.String({ description: "Action: 'ui-messages' to retrieve prompts/intents from UI sessions" })),
}) as ToolDefinition["parameters"];

interface PromptToolPolicy {
  enabledServers: Set<string>;
  restrictedToolsByServer: Map<string, Set<string>>;
}

function buildPrefixByServer(config: ReturnType<typeof loadMcpConfig>): Map<string, string> {
  const prefixMode = config.settings?.toolPrefix ?? "server";
  return new Map(Object.keys(config.mcpServers).map((serverName) => [serverName, getToolNamePrefix(serverName, prefixMode)]));
}

function inferServerForToolName(toolName: string, prefixByServer: Map<string, string>): string | undefined {
  const prefixes = [...prefixByServer.entries()].filter(([, prefix]) => prefix.length > 0).sort((a, b) => b[1].length - a[1].length);
  for (const [serverName, prefix] of prefixes) {
    if (toolName.startsWith(prefix)) return serverName;
  }
  return undefined;
}

function buildPromptToolPolicy(config: ReturnType<typeof loadMcpConfig>, options: McpAdapterOptions): PromptToolPolicy {
  if (!options.enabledServers) {
    return {
      enabledServers: new Set(Object.keys(config.mcpServers)),
      restrictedToolsByServer: new Map<string, Set<string>>(),
    };
  }

  const configuredServers = new Set(Object.keys(config.mcpServers));
  const enabledServers = new Set((options.enabledServers ?? []).filter((name) => configuredServers.has(name)));
  const prefixByServer = buildPrefixByServer(config);
  const restrictedToolsByServer = new Map<string, Set<string>>();
  const enabledMcpToolNames = (options.enabledTools ?? []).filter((toolName) => inferServerForToolName(toolName, prefixByServer));

  for (const toolName of enabledMcpToolNames) {
    const serverName = inferServerForToolName(toolName, prefixByServer);
    if (!serverName || !enabledServers.has(serverName)) continue;
    const current = restrictedToolsByServer.get(serverName) ?? new Set<string>();
    current.add(toolName);
    restrictedToolsByServer.set(serverName, current);
  }

  return { enabledServers, restrictedToolsByServer };
}

function isPromptToolAllowed(policy: PromptToolPolicy, serverName: string, toolName: string): boolean {
  if (!policy.enabledServers.has(serverName)) return false;
  const restrictedTools = policy.restrictedToolsByServer.get(serverName);
  if (!restrictedTools) return true;
  return restrictedTools.has(toolName);
}

function buildPromptMcpDisabledResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: "not_available" },
  };
}

export function createMcpAdapter(options: McpAdapterOptions = {}) {
  return function mcpAdapter(pi: ExtensionAPI) {
    let state: McpExtensionState | null = null;
    let initPromise: Promise<McpExtensionState> | null = null;
    let lifecycleGeneration = 0;

    async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
      if (!currentState) return;

      if (currentState.uiServer) {
        currentState.uiServer.close(reason);
        currentState.uiServer = null;
      }

      let flushError: unknown;
      try {
        flushMetadataCache(currentState, options.configPath);
      } catch (error) {
        flushError = error;
      }

      try {
        await currentState.lifecycle.gracefulShutdown();
      } catch (error) {
        if (flushError) {
          console.error("MCP: graceful shutdown failed after metadata flush error", error);
        } else {
          throw error;
        }
      }

      if (flushError) {
        throw flushError;
      }
    }

    const earlyConfigPath = resolveMcpConfigPath(options.configPath);
    const earlyConfig = loadMcpConfig(earlyConfigPath);
    const earlyCache = loadMetadataCache(earlyConfigPath);
    const prefix = earlyConfig.settings?.toolPrefix ?? "server";
    const prefixByServer = buildPrefixByServer(earlyConfig);
    const hasPromptRestrictions = !!options.enabledServers;
    const promptToolPolicy = buildPromptToolPolicy(earlyConfig, options);
    const visibleToolNames = new Set<string>((options.enabledTools ?? []).filter((toolName) => inferServerForToolName(toolName, prefixByServer)));
    const visibilityPolicy = {
      visibleServers: promptToolPolicy.enabledServers,
      visibleToolNames: visibleToolNames.size > 0 ? visibleToolNames : undefined,
    };

    const envRaw = process.env.MCP_DIRECT_TOOLS;
    const directSpecs = envRaw === "__none__"
      ? []
      : resolveDirectTools(
          earlyConfig,
          earlyCache,
          prefix,
          envRaw?.split(",").map(s => s.trim()).filter(Boolean),
        );

    for (const spec of directSpecs) {
      if (!isPromptToolAllowed(promptToolPolicy, spec.serverName, spec.prefixedName)) continue;
      pi.registerTool({
        name: spec.prefixedName,
        label: `MCP: ${spec.originalName}`,
        description: spec.description || "(no description)",
        promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
        parameters: (spec.inputSchema ? Type.Unsafe<Record<string, unknown>>(spec.inputSchema) : EMPTY_TOOL_PARAMETERS) as ToolDefinition["parameters"],
        execute: createDirectToolExecutor(() => state, () => initPromise, spec),
      });
    }

    const getPiTools = (): ToolInfo[] => pi.getAllTools();

    pi.registerFlag("mcp-config", {
      description: "Path to MCP config file",
      type: "string",
    });

    pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;

    try {
      await shutdownState(previousState, "session_restart");
    } catch (error) {
      console.error("MCP: failed to shut down previous session state", error);
    }

    if (generation !== lifecycleGeneration) {
      return;
    }

    const promise = initializeMcp(pi, ctx, options.configPath);
    initPromise = promise;

    promise.then(async (nextState) => {
      if (generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error("MCP: failed to clean stale session state", error);
        }
        return;
      }

      state = nextState;
      updateStatusBar(nextState);
      initPromise = null;
    }).catch(err => {
      if (generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      console.error("MCP initialization failed:", err);
      initPromise = null;
    });
    });

    pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    state = null;
    initPromise = null;

    try {
      await shutdownState(currentState, "session_shutdown");
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
    });

    pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx, visibilityPolicy);
          break;
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            await openMcpPanel(state, pi, ctx, earlyConfigPath);
          } else {
            await showStatus(state, ctx, visibilityPolicy);
          }
          break;
      }
    },
    });

    pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-auth <server-name>", "error");
        return;
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      await authenticateServer(serverName, state.config, ctx);
    },
    });

    pi.registerTool({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(
        earlyConfig,
        earlyCache,
        directSpecs.filter((spec) => isPromptToolAllowed(promptToolPolicy, spec.serverName, spec.prefixedName)),
        visibilityPolicy.visibleToolNames,
        visibilityPolicy.visibleServers,
      ),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
    parameters: MCP_PROXY_PARAMETERS,
    async execute(_toolCallId, params: {
      tool?: string;
      args?: string;
      connect?: string;
      describe?: string;
      search?: string;
      regex?: boolean;
      includeSchemas?: boolean;
      server?: string;
      action?: string;
    }, _signal, _onUpdate, _ctx) {
      let parsedArgs: Record<string, unknown> | undefined;
      if (params.args) {
        try {
          parsedArgs = JSON.parse(params.args);
          if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
            const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
            throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
          }
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
          }
          throw error;
        }
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
            details: { error: "init_failed", message },
          };
        }
      }
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }

      if (params.action === "ui-messages") {
        return executeUiMessages(state);
      }
      if (hasPromptRestrictions && params.connect && !promptToolPolicy.enabledServers.has(params.connect)) {
        return buildPromptMcpDisabledResult(`MCP server "${params.connect}" is not enabled in the current prompt`);
      }
      if (hasPromptRestrictions && params.server && !promptToolPolicy.enabledServers.has(params.server)) {
        return buildPromptMcpDisabledResult(`MCP server "${params.server}" is not enabled in the current prompt`);
      }
      const resolvedServerName =
        params.server ??
        (params.tool ? inferServerForToolName(params.tool, prefixByServer) : undefined) ??
        (params.describe ? inferServerForToolName(params.describe, prefixByServer) : undefined);
      const targetToolName = params.tool ?? params.describe;
      if (hasPromptRestrictions && targetToolName) {
        if (!resolvedServerName) {
          return buildPromptMcpDisabledResult(`MCP tool "${targetToolName}" is not available in the current prompt`);
        }
        if (!isPromptToolAllowed(promptToolPolicy, resolvedServerName, targetToolName)) {
          return buildPromptMcpDisabledResult(`MCP tool "${targetToolName}" is not enabled in the current prompt`);
        }
      }
      if (hasPromptRestrictions && params.search && !params.server && promptToolPolicy.enabledServers.size !== Object.keys(earlyConfig.mcpServers).length) {
        return buildPromptMcpDisabledResult(
          `MCP search must specify one of the enabled servers: ${[...promptToolPolicy.enabledServers].join(", ")}`,
        );
      }
      if (hasPromptRestrictions && !params.tool && !params.connect && !params.describe && !params.search && !params.server && !params.action) {
        return buildPromptMcpDisabledResult(`Enabled MCP servers: ${[...promptToolPolicy.enabledServers].join(", ")}`);
      }
      if (params.tool) {
        return executeCall(state, params.tool, parsedArgs, params.server);
      }
      if (params.connect) {
        return executeConnect(state, params.connect, visibilityPolicy);
      }
      if (params.describe) {
        return executeDescribe(state, params.describe, visibilityPolicy);
      }
      if (params.search) {
        return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas, getPiTools, visibilityPolicy);
      }
      if (params.server) {
        return executeList(state, params.server, visibilityPolicy);
      }
      return executeStatus(state, visibilityPolicy);
    },
    });
  };
}

const defaultMcpAdapter = createMcpAdapter();

export default defaultMcpAdapter;
