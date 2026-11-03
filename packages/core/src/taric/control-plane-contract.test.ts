import { describe, expect, test } from "bun:test"
import { inspectTaricControlPlaneContract, assertTaricControlPlaneContract } from "./control-plane-contract"
import { getTaricOperationContract } from "./compatibility"

describe("locked Taric canonical control-plane mappings", () => {
    test("maps the delivered immutable Scope, audit, report and close contracts", () => {
        const diagnostic = inspectTaricControlPlaneContract()
        expect(diagnostic.status).toBe("available")
        expect(diagnostic.contract).toMatchObject({ sourceCommit: "1c466f4d8ad8f775f98bf867453b81230469287a", apiContractVersion: "1.4.0", storageContract: "authority-storage/4", sqlContract: "authority-sql/4" })
        expect(diagnostic.operationCount).toBe(66)
        expect(diagnostic.missingFacts).toEqual([])
        expect(diagnostic.mappings.every((item) => item.status === "mapped" && item.operations.every((operation) => getTaricOperationContract(operation)))).toBe(true)
        expect(getTaricOperationContract("scope.revise")?.roles).toEqual(["operator"])
        expect(getTaricOperationContract("engagement.close")?.roles).toEqual(["operator"])
        expect(getTaricOperationContract("action.audit.query")?.roles).toEqual(["host", "operator"])
        expect(() => assertTaricControlPlaneContract()).not.toThrow()
    })

    test("returned metadata cannot change subsequent contract diagnostics", () => {
        const report = inspectTaricControlPlaneContract()
        report.mappings.find((item) => item.fact === "scope_roe_revision")!.status = "unsupported"
        expect(inspectTaricControlPlaneContract().status).toBe("available")
        expect(inspectTaricControlPlaneContract().missingFacts).toEqual([])
    })
})
