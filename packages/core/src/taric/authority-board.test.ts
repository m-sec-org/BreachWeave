import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { TaricHostModule } from "./host-module"
import { TaricAuthorityBoard } from "./authority-board"
import { TaricAuthorityWorkService } from "./authority-work-service"
import { TaricOperationError } from "./types"

function uuid(number: number): string { return `019a0000-0000-7000-8000-${number.toString().padStart(12, "0")}` }

function fixture() {
    const controls: { fail: boolean; wait?: Promise<void>; contextCalls: number; readSeq: number; contextFields?: Record<string, unknown> } = { fail: false, contextCalls: 0, readSeq: 10 }
    const binding = { projectId: "project", tenantId: "tenant", engagementId: uuid(1), hostPrincipalId: "host", modelPrincipalId: "model" }
    const records = [
        { id: uuid(2), engagement_id: uuid(1), kind: "resource", version: 1, trust_level: "L1", revision: 1, name: "fixture-board-private-payload" },
        { id: uuid(3), engagement_id: uuid(1), kind: "resource_revision", version: 1, trust_level: "L1", revision: 1, resource_ref: uuid(2) },
        { id: uuid(4), engagement_id: uuid(1), kind: "work_item", version: 1, trust_level: "L1", status: "queued", resource_refs: [uuid(2)], acceptance_criteria: ["fixture-board-private-payload"] },
    ]
    const host: Pick<TaricHostModule, "getBinding" | "invokeHost" | "query" | "submitProposal"> = {
        getBinding() { return { ...binding } },
        async query() {
            controls.contextCalls += 1
            await controls.wait
            if (controls.fail) throw new TaricOperationError("invalid_cursor", "fixture authority error")
            return { context_snapshot_id: "ctx_fixture", read_seq: controls.readSeq, items: [{ id: uuid(1), engagement_id: uuid(1), kind: "engagement", version: 1, trust_level: "L2", name: "fixture-board-private-payload" }], truncated_count: 0, omitted_count: 0, omitted_count_complete: true, omitted_as_unexamined: false, ...controls.contextFields }
        },
        async invokeHost(operation, input) {
            if (operation !== "resource.query") throw new Error("unexpected authority operation")
            return { read_seq: input.as_of ?? controls.readSeq, records: records.filter((item) => item.kind === input.kind) }
        },
        async submitProposal() { throw new Error("unexpected authority mutation") },
    }
    const work = new TaricAuthorityWorkService({ host, policyDigest: `sha256:${"a".repeat(64)}` })
    return { controls, host, work, records, board: new TaricAuthorityBoard({ host, work, projectManifest: { resourceIds: [uuid(2)], workItemIds: [uuid(4)] } }) }
}

describe("authority board publication and scheduling", () => {
    test("missing trusted project manifest blocks even complete shared-Engagement reads", async () => {
        const { host, work } = fixture()
        const board = new TaricAuthorityBoard({ host, work })
        await expect(board.initialize()).rejects.toThrow("trusted non-empty project manifest")
        expect(board.snapshot().freshnessAllowsScheduling).toBe(false)
        expect(board.snapshot().records.work).toEqual([])
    })

    test("host allowlist filters another project in the same Engagement and rejects cross-project Work links", async () => {
        const { host, work, records, board } = fixture()
        records.push({ id: uuid(20), engagement_id: uuid(1), kind: "resource", version: 1, trust_level: "L1", revision: 1, name: "foreign-project-resource" })
        records.push({ id: uuid(21), engagement_id: uuid(1), kind: "work_item", version: 1, trust_level: "L1", status: "queued", resource_refs: [uuid(20)], acceptance_criteria: [] })
        const snapshot = await board.initialize()
        expect(JSON.stringify(snapshot)).not.toContain(uuid(20))
        expect(JSON.stringify(snapshot)).not.toContain(uuid(21))
        const invalid = new TaricAuthorityBoard({ host, work, projectManifest: { resourceIds: [uuid(2)], workItemIds: [uuid(21)] } })
        await expect(invalid.initialize()).rejects.toThrow("cross the trusted manifest boundary")
        expect(invalid.snapshot().records.work).toEqual([])
    })

    test("Work budget is tightened independently and the board bounds aggregate raw records", async () => {
        const { host, work, records } = fixture()
        records.push({ id: uuid(5), engagement_id: uuid(1), kind: "work_item", version: 1, trust_level: "L1", status: "queued", resource_refs: [uuid(2)], acceptance_criteria: [] })
        const query = await work.queryWork([], false, 10, { maxRecords: 1 })
        expect(query.diagnostics.status).toBe("truncated")
        const limited = new TaricAuthorityBoard({ host, work, projectManifest: { resourceIds: [uuid(2)], workItemIds: [uuid(4), uuid(5)] }, limits: { maxRecords: 4 } })
        await expect(limited.initialize()).rejects.toThrow()
        expect(limited.snapshot().status).toBe("blocked")
        expect(limited.snapshot().records.work).toEqual([])
    })
    test("publishes only metadata and refreshes on every scheduling decision", async () => {
        const { board, controls } = fixture()
        const first = await board.initialize()
        expect(first.status).toBe("healthy")
        expect(first.launchAuthorized).toBe(false)
        expect(first.completeness.entireEngagementReconstructed).toBe(false)
        expect(JSON.stringify(first)).not.toContain("fixture-board-private-payload")
        controls.readSeq += 1
        const second = await board.refreshForScheduling()
        expect(second.readSeq).toBe(11)
        expect(controls.contextCalls).toBe(2)
        expect(second.queries?.work.readSeq).toBe(11)
        expect(second.queries?.resources.readSeq).toBe(11)
        expect(second.queries?.revisions.readSeq).toBe(11)
    })

    test("failed refresh preserves the complete previous snapshot and blocks scheduling", async () => {
        const { board, controls } = fixture()
        const first = await board.initialize()
        controls.fail = true
        await expect(board.manualRefresh()).rejects.toThrow("fixture authority error")
        const failed = board.snapshot()
        expect(failed.status).toBe("blocked")
        expect(failed.errorCode).toBe("invalid_cursor")
        expect(failed.freshnessAllowsScheduling).toBe(false)
        expect(failed.records).toEqual(first.records)
        expect(failed.readSeq).toBe(first.readSeq)
        expect(failed.revision).toBe(first.revision)
        await expect(board.refreshForScheduling()).rejects.toThrow()
    })

    test("connection loss during a refresh cannot be cleared by its late response", async () => {
        const { board, controls } = fixture()
        await board.initialize()
        let release = () => {}
        controls.wait = new Promise<void>((resolve) => { release = resolve })
        const inFlight = board.manualRefresh()
        board.markConnectionStale("disconnect")
        release()
        const stale = await inFlight
        controls.wait = undefined
        expect(stale.status).toBe("blocked")
        expect(stale.connectionStale).toBe(true)
        await expect(board.refreshForScheduling()).rejects.toThrow("stale projection")
        expect((await board.reconnect()).freshnessAllowsScheduling).toBe(true)
    })

    test("closing during refresh never publishes a late healthy state", async () => {
        const { board, controls } = fixture()
        let release = () => {}
        controls.wait = new Promise<void>((resolve) => { release = resolve })
        const pending = board.initialize()
        board.close()
        release()
        expect((await pending).status).toBe("closed")
        expect(board.snapshot().records.work).toEqual([])
        await expect(board.refreshForScheduling()).rejects.toThrow("closed")
    })

    test("project manifest changes during an in-flight refresh cannot publish the old project inventory", async () => {
        const { board, controls } = fixture()
        await board.initialize()
        let release = () => {}
        controls.wait = new Promise<void>((resolve) => { release = resolve })
        const pending = board.manualRefresh()
        board.updateProjectManifest({ resourceIds: [uuid(20)], workItemIds: [uuid(21)] })
        release()
        await expect(pending).rejects.toMatchObject({ code: "project_manifest_changed" })
        expect(board.snapshot().records).toEqual({ context: [], work: [], resources: [], revisions: [] })
        expect(board.snapshot().freshnessAllowsScheduling).toBe(false)
    })

    test("context omissions or truncation block publication even when the record page looks exhausted", async () => {
        for (const contextFields of [{ truncated_count: 1 }, { omitted_count: 1 }, { omitted_count_complete: false }, { omitted_as_unexamined: true }]) {
            const { board, controls } = fixture()
            controls.contextFields = contextFields
            await expect(board.initialize()).rejects.toMatchObject({ code: "context_truncated" })
            expect(board.snapshot().status).toBe("blocked")
            expect(board.snapshot().records.work).toEqual([])
        }
    })
})

const fixtureSource = process.env.TARIC_WORK_FIXTURE_SOURCE
test.skipIf(!fixtureSource)("real SQLite board rebuilds lost and duplicate notifications without local projection files", async () => {
    const child = Bun.spawn(["bun", resolve(import.meta.dir, "../../../../scripts/smoke-taric-work.ts"), `--source=${fixtureSource}`], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    const report = JSON.parse(stdout) as { assertions: Array<{ id: string; passed: boolean }> }
    for (const id of ["lost_notification_rebuilt_before_scheduling", "duplicate_notifications_requery_without_duplicate_work", "board_rebuilt_after_sql_restart_without_projection_files", "native_invalid_cursor_blocks_board", "truncated_board_snapshot_never_published"]) expect(report.assertions.some((entry) => entry.id === id && entry.passed)).toBe(true)
}, 30_000)
