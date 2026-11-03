import { describe, expect, test } from "bun:test"
import {
    TARIC_ARTIFACT_MANIFEST,
    TARIC_BUN_DRIVER_INTEGRITY,
    TARIC_BUN_DRIVER_PACKAGE,
    TARIC_BUN_DRIVER_VERSION,
    TARIC_CLEAN_CONSUMER_PROFILE,
    TARIC_COMPATIBILITY_BASELINE,
    TARIC_PACKAGE_ARTIFACTS,
    TARIC_UPSTREAM_COMMIT,
    TARIC_OPERATION_CONTRACTS,
    getTaricOperationContract,
    compareTaricCompatibility,
    validateExpectedTaricCompatibility,
    validateTaricOperationContracts,
    validateTaricArtifactManifest,
} from "./compatibility"

describe("Taric artifact compatibility manifest", () => {
    test("matches the isolated clean-consumer evidence and has no workspace links", () => {
        expect(() => validateTaricArtifactManifest()).not.toThrow()
        expect(TARIC_ARTIFACT_MANIFEST.status).toBe("clean_consumer_verified")
        expect(TARIC_ARTIFACT_MANIFEST.sourceCommit).toBe(TARIC_UPSTREAM_COMMIT)
        expect(TARIC_COMPATIBILITY_BASELINE).toMatchObject({
            sourceCommit: "1c466f4d8ad8f775f98bf867453b81230469287a",
            apiContractVersion: "1.4.0",
            adapterContractVersion: "1.1",
            schemaVersion: "1.0.0",
            coreVersion: "1.0.4",
            storageContract: "authority-storage/4",
            sqlContract: "authority-sql/4",
        })
        expect(Object.values(TARIC_PACKAGE_ARTIFACTS).every(({ version }) => version === "1.0.4")).toBe(true)
        expect(TARIC_CLEAN_CONSUMER_PROFILE.workspaceLinked).toBe(false)
        expect(TARIC_ARTIFACT_MANIFEST.upstreamComponents["@taric/cli"].version).toBe("1.0.4")
        expect(TARIC_ARTIFACT_MANIFEST.upstreamComponents["@taric/mcp"].version).toBe("1.0.4")
        expect(TARIC_ARTIFACT_MANIFEST.bunDriver).toMatchObject({
            packageName: TARIC_BUN_DRIVER_PACKAGE,
            version: TARIC_BUN_DRIVER_VERSION,
            integrity: TARIC_BUN_DRIVER_INTEGRITY,
        })
    })

    test("locks replay policy and error classes for host operations", () => {
        expect(() => validateTaricOperationContracts()).not.toThrow()
        expect(TARIC_OPERATION_CONTRACTS.find((item) => item.operation === "capture.observation")).toMatchObject({
            replayPolicy: "reconcile_before_replay",
        })
        expect(() => validateTaricOperationContracts(TARIC_OPERATION_CONTRACTS.filter((item) => item.operation !== "capture.observation"))).toThrow("capture.observation")
    })

    test("pins all 66 operations with exact principal, capability and idempotency metadata", () => {
        expect(TARIC_OPERATION_CONTRACTS).toHaveLength(66)
        expect(TARIC_ARTIFACT_MANIFEST.operations).toHaveLength(66)
        expect(TARIC_ARTIFACT_MANIFEST.operationRegistryDigest).toBe("sha256:a37745ab273ccde0574d9c256cd5b984b58a5a98779d169280472f8b0301dd47")
        expect(getTaricOperationContract("review.submit")).toMatchObject({ roles: ["reviewer"], idempotent: false, mutates_authority: true, engagement_scoped: true })
        expect(getTaricOperationContract("artifact.content.read")).toMatchObject({ roles: ["host", "operator"], capability: "content_read", idempotent: false })
        for (const operation of ["proposal.submit", "work.transition", "coverage.record", "artifact.session.bind", "artifact.store.begin", "artifact.store.append", "artifact.store.commit"]) {
            expect(getTaricOperationContract(operation)).toMatchObject({ idempotent: true, replayPolicy: "idempotent_replay" })
        }
        for (const operation of ["capture.observation", "checkpoint.commit", "action.recommend", "action.host-decision", "action.host-result", "action.reconcile"]) {
            expect(getTaricOperationContract(operation)).toMatchObject({ idempotent: false, replayPolicy: "reconcile_before_replay" })
        }
        expect(getTaricOperationContract("scope.init")).toBeUndefined()
        expect(getTaricOperationContract("close.commit")).toBeUndefined()
    })

    test("rejects a missing operation or forged role and replay declarations", () => {
        expect(() => validateTaricOperationContracts(TARIC_OPERATION_CONTRACTS.slice(1))).toThrow("engagement.init")
        const changedRoles = TARIC_OPERATION_CONTRACTS.map((contract) => contract.operation === "review.submit" ? { ...contract, roles: ["host" as const] } : contract)
        expect(() => validateTaricOperationContracts(changedRoles)).toThrow("review.submit.roles")
        const changedReplay = TARIC_OPERATION_CONTRACTS.map((contract) => contract.operation === "capture.observation" ? { ...contract, idempotent: true, replayPolicy: "idempotent_replay" as const } : contract)
        expect(() => validateTaricOperationContracts(changedReplay)).toThrow("capture.observation.idempotent")
    })

    test("rejects source, adapter, schema, SQL, policy and artifact tuple mismatches", () => {
        const compatibility = { ...TARIC_COMPATIBILITY_BASELINE, policyDigest: TARIC_ARTIFACT_MANIFEST.policyDigest, bunDriver: { packageName: TARIC_BUN_DRIVER_PACKAGE, version: TARIC_BUN_DRIVER_VERSION, integrity: TARIC_BUN_DRIVER_INTEGRITY } }
        for (const field of ["sourceCommit", "adapterContractVersion", "schemaVersion", "sqlContract"] as const) {
            const mismatched = { ...compatibility, [field]: "mismatched" }
            expect(compareTaricCompatibility(compatibility, mismatched)).toContain(`${field} mismatch`)
            expect(() => validateExpectedTaricCompatibility(mismatched)).toThrow(`${field} mismatch`)
        }
        expect(compareTaricCompatibility(compatibility, { ...compatibility, policyDigest: "sha256:other" })).toEqual(["policyDigest mismatch"])
        expect(() => validateExpectedTaricCompatibility({ ...compatibility, bunDriver: { ...compatibility.bunDriver, integrity: "sha512:other" } })).toThrow("integrity")
    })
})
