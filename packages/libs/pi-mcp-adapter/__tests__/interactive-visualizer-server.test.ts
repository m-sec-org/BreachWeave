import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("interactive visualizer", () => {
  it("dist/app.html exists and contains chart.js", () => {
    const html = readFileSync(
      join(__dirname, "..", "examples", "interactive-visualizer", "dist", "app.html"),
      "utf-8",
    );
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("chart.js");
    expect(html).toContain('<div id="app">');
  });

  it("dist/server.js exists and is executable", () => {
    const server = readFileSync(
      join(__dirname, "..", "examples", "interactive-visualizer", "dist", "server.js"),
      "utf-8",
    );
    expect(server).toContain("#!/usr/bin/env node");
    expect(server).toContain("show_chart");
    expect(server).toContain("interactive-visualizer");
  });
});
