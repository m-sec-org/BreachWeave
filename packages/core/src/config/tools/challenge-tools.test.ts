import { beforeEach, expect, mock, test } from "bun:test"

const requestHostBridge = mock(async (): Promise<unknown> => ({
    code: "web-001",
    hint_content: null as string | null,
}))

mock.module("../../challenge/host-bridge-client", () => ({
    requestHostBridge,
}))

const { challengeGetHintTool, challengeSubmitReportTool } = await import("./challenge-tools")

beforeEach(() => {
    requestHostBridge.mockReset()
})

test("challenge_get_hint returns hint text in content", async () => {
    requestHostBridge.mockResolvedValue({
        code: "web-001",
        hint_content: "仔细阅读公共构建日志",
    })

    const result = await challengeGetHintTool.execute(
        "tool-call-1",
        {},
        undefined,
        undefined,
        {
            cwd: process.cwd(),
        } as never,
    )

    expect(requestHostBridge).toHaveBeenCalledWith("challenge_get_hint", {})
    expect(result.content).toEqual([{ type: "text", text: "challenge hint:\n仔细阅读公共构建日志" }])
    expect(result.details).toEqual({
        code: "web-001",
        hint_content: "仔细阅读公共构建日志",
    })
})

test("challenge_get_hint keeps empty-state output when hint is blank", async () => {
    requestHostBridge.mockResolvedValue({
        code: "web-001",
        hint_content: "   ",
    })

    const result = await challengeGetHintTool.execute(
        "tool-call-2",
        {},
        undefined,
        undefined,
        {
            cwd: process.cwd(),
        } as never,
    )

    expect(result.content).toEqual([{ type: "text", text: "challenge hint is empty" }])
})

test("challenge_submit_report sends asset_hash to the host bridge", async () => {
    requestHostBridge.mockResolvedValue({
        assets_total: 2,
        assets_scanned: 1,
        assets_pending: 1,
        assets_completed: false,
    })

    const result = await challengeSubmitReportTool.execute(
        "tool-call-3",
        { asset_hash: "47c28ad18ead250c00600c0bc8d2e7c5", report: "### report" },
        undefined,
        undefined,
        { cwd: process.cwd() } as never,
    )

    expect(requestHostBridge).toHaveBeenCalledWith("challenge_submit_report", {
        asset_hash: "47c28ad18ead250c00600c0bc8d2e7c5",
        report: "### report",
    })
    expect(result.content).toEqual([{
        type: "text",
        text: "submitted report for asset hash: 47c28ad18ead250c00600c0bc8d2e7c5, 1 assets pending",
    }])
})
