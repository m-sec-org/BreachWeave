import { describe, expect, test } from "bun:test"
import { adaptAttemptCaptureDto, adaptPlatformCaptureDto, adaptReportCaptureDto, adaptSolverCaptureDto, CaptureDtoError, TARIC_CAPTURE_DTO_MAX_BYTES } from "./capture-dto"

const resourceRef = "00000000-0000-4000-8000-000000000001"
const base = {
    resource_ref: resourceRef,
    observed_at: "2026-10-31T00:00:00.000Z",
    statement: "The host observed a bounded response.",
    artifact_refs: [{ host_ref: "host-tool-result:request-1", content_status: "available", integrity_status: "verified" }],
    limitations: ["response body retained by the host"],
}

function capture(kind: "solver" | "attempt" | "report" | "platform", observation: unknown = base, eventId = "capture-1", hostPrincipalId = "host-principal") {
    const input = { hostPrincipalId, eventId, observation }
    if (kind === "solver") return adaptSolverCaptureDto(input)
    if (kind === "attempt") return adaptAttemptCaptureDto(input)
    if (kind === "report") return adaptReportCaptureDto(input)
    return adaptPlatformCaptureDto(input)
}

describe("Taric capture DTO adapters", () => {
    test("accept each source adapter and emit only pinned observation fields", () => {
        const results = [
            capture("solver", { ...base, solver_id: "solver-1", generation: 2 }),
            capture("attempt", { ...base, attempt_id: "00000000-0000-4000-8000-000000000002", prompt_name: "probe" }),
            capture("report", { ...base, submission_id: "submission-1", report: "summary" }),
            capture("platform", { ...base, platform_id: "platform-1", event_type: "response" }),
        ]
        for (const result of results) {
            expect(Object.keys(result.observation).sort()).toEqual(["artifact_refs", "limitations", "observed_at", "resource_ref", "statement"])
            expect(result.observation.artifact_refs[0]).toEqual({ host_ref: "host-tool-result:request-1", content_status: "available", integrity_status: "verified" })
            expect(result.originRef).toMatch(/^bw-origin:(solver|attempt|report|platform):[a-f0-9]{64}$/)
        }
    })

    test("derives a stable host origin without trusting a caller origin", () => {
        const first = capture("solver", { ...base, solver_id: "solver-1" })
        const second = capture("solver", { ...base, solver_id: "solver-1" })
        expect(first.originRef).toBe(second.originRef)
        expect(capture("solver", { ...base, solver_id: "solver-1" }, "capture-2").originRef).not.toBe(first.originRef)
        expect(capture("solver", { ...base, solver_id: "solver-1" }, "capture-1", "other-host").originRef).not.toBe(first.originRef)
    })

    test("rejects unknown fields, invalid UUIDs, and sensitive values", () => {
        for (const observation of [
            { ...base, unknown: "discard me" },
            { ...base, resource_ref: "host-event:fake" },
            { ...base, statement: "Bearer abc.def.ghi" },
            { ...base, limitations: ["password=should-not-cross-the-boundary"] },
            { ...base, artifact_refs: [{ host_ref: "host-ref", secret: "value" }] },
            { ...base, artifact_refs: [{ host_ref: "host-ref", content_status: "not-a-status" }] },
            { ...base, observed_at: "2026-10-31" },
            { ...base, report: "https://user:password@example.test/" },
        ]) {
            expect(() => capture("platform", observation)).toThrow(CaptureDtoError)
        }
    })

    test("rejects oversized source payloads without creating an observation", () => {
        const oversized = { ...base, report: "x".repeat(TARIC_CAPTURE_DTO_MAX_BYTES + 1) }
        expect(() => capture("report", oversized)).toThrow(CaptureDtoError)
    })
})
