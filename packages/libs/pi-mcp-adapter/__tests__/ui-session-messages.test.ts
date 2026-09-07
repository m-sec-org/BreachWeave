import { describe, it, expect } from "vitest";
import { parseUiPromptHandoff, type UiSessionMessages } from "../types.js";

describe("UiSessionMessages", () => {
  describe("type structure", () => {
    it("can create empty session messages", () => {
      const messages: UiSessionMessages = {
        prompts: [],
        notifications: [],
        intents: [],
      };

      expect(messages.prompts).toHaveLength(0);
      expect(messages.notifications).toHaveLength(0);
      expect(messages.intents).toHaveLength(0);
    });

    it("can store prompts", () => {
      const messages: UiSessionMessages = {
        prompts: ["What is the weather?", "Tell me more"],
        notifications: [],
        intents: [],
      };

      expect(messages.prompts).toHaveLength(2);
      expect(messages.prompts[0]).toBe("What is the weather?");
    });

    it("can store notifications", () => {
      const messages: UiSessionMessages = {
        prompts: [],
        notifications: ["Task completed", "Error occurred"],
        intents: [],
      };

      expect(messages.notifications).toHaveLength(2);
    });

    it("can store intents with params", () => {
      const messages: UiSessionMessages = {
        prompts: [],
        notifications: [],
        intents: [
          { intent: "get_forecast", params: { days: 7, location: "NYC" } },
          { intent: "refresh" },
        ],
      };

      expect(messages.intents).toHaveLength(2);
      expect(messages.intents[0].intent).toBe("get_forecast");
      expect(messages.intents[0].params).toEqual({ days: 7, location: "NYC" });
      expect(messages.intents[1].params).toBeUndefined();
    });
  });

  describe("named handoff envelopes", () => {
    it("parses canonical intent-newline-json payloads", () => {
      expect(
        parseUiPromptHandoff('visualization_annotations_submitted\n{"visualizationId":"flow","annotations":[]}')
      ).toEqual({
        intent: "visualization_annotations_submitted",
        params: { visualizationId: "flow", annotations: [] },
        raw: 'visualization_annotations_submitted\n{"visualizationId":"flow","annotations":[]}',
      });
    });

    it("ignores free-form prompts", () => {
      expect(parseUiPromptHandoff("Please analyze this chart")).toBeUndefined();
      expect(parseUiPromptHandoff("visualization_annotations_submitted {}")).toBeUndefined();
    });
  });
});
