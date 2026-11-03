import { beforeEach, expect, mock, test } from "bun:test"
import * as hostBridgeClient from "../../challenge/host-bridge-client"

const requestHostBridge = mock(async (): Promise<unknown> => ({
    code: "web-001",
    hint_content: null as string | null,
}))

mock.module("../../challenge/host-bridge-client", () => ({
    ...hostBridgeClient,
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

test("challenge_submit_report sends assigned test outcomes and discoveries", async () => {
    requestHostBridge.mockResolvedValue({
        assets_total: 1,
        assets_scanned: 0,
        assets_pending: 1,
        assets_completed: false,
    })
    const params = {
        asset_hash: "47c28ad18ead250c00600c0bc8d2e7c5",
        report: "### SQL injection report",
        test_results: [
            { test_item: "验证 SQL 注入", status: "completed" as const, evidence: "返回了两个账户记录" },
            { test_item: "验证上传", status: "blocked" as const, evidence: "当前账号无法访问上传模块" },
        ],
        discoveries: ["发现未分配的密码重置入口"],
    }

    await challengeSubmitReportTool.execute("tool-call-results", params, undefined, undefined, { cwd: process.cwd() } as never)

    expect(requestHostBridge).toHaveBeenCalledWith("challenge_submit_report", params)
})

test("challenge_submit_report clearly ends a fully reported assignment while other assets remain", async () => {
    requestHostBridge.mockResolvedValue({
        assets_total: 2,
        assets_scanned: 0,
        assets_pending: 2,
        assets_completed: false,
        solver_task_completed: true,
    })

    const result = await challengeSubmitReportTool.execute(
        "tool-call-finished",
        { asset_hash: "47c28ad18ead250c00600c0bc8d2e7c5", report: "### report" },
        undefined,
        undefined,
        { cwd: process.cwd() } as never,
    )

    expect(result.details.solver_task_completed).toBe(true)
    expect(result.content).toEqual([{
        type: "text",
        text: "资产 47c28ad18ead250c00600c0bc8d2e7c5 的报告已提交。本次分工报告齐全，请结束；剩余资产由 planner 安排。",
    }])
})
