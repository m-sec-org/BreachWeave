import { describe, expect, it } from "vitest";
import { executeUiMessages } from "../proxy-modes.js";
import type { McpExtensionState } from "../state.js";

function createState(prompts: string[]): McpExtensionState {
  return {
    completedUiSessions: [
      {
        serverName: "interactive-visualizer",
        toolName: "show_visualization",
        completedAt: new Date("2026-03-12T16:00:00Z"),
        reason: "done",
        messages: {
          prompts,
          notifications: [],
          intents: [],
        },
      },
    ],
  } as McpExtensionState;
}

describe("executeUiMessages", () => {
  it("normalizes canonical handoff prompts into structured intents", () => {
    const state = createState([
      'visualization_annotations_submitted\n{"visualizationId":"flow","annotations":[{"id":"a1","kind":"pin","text":"Check this"}]}',
    ]);

    const result = executeUiMessages(state);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("visualization_annotations_submitted"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.not.stringContaining("### Prompts:\n- visualization_annotations_submitted"),
    });
    expect(result.details).toMatchObject({
      intents: [
        {
          intent: "visualization_annotations_submitted",
          params: {
            visualizationId: "flow",
            annotations: [{ id: "a1", kind: "pin", text: "Check this" }],
          },
        },
      ],
      handoffs: [
        {
          intent: "visualization_annotations_submitted",
          params: {
            visualizationId: "flow",
            annotations: [{ id: "a1", kind: "pin", text: "Check this" }],
          },
        },
      ],
      cleared: true,
    });
    expect(state.completedUiSessions).toEqual([]);
  });

  it("preserves ordinary prompts as prompts", () => {
    const state = createState(["Please analyze this flow"]);
    const result = executeUiMessages(state);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("### Prompts:\n- Please analyze this flow"),
    });
    expect(result.details).toMatchObject({
      prompts: ["Please analyze this flow"],
      intents: [],
    });
  });
});
