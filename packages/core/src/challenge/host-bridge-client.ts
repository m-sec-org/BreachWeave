import type { HostBridgeAction, HostBridgeRequestEvent } from "./host-bridge-types"

interface PendingRequest {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: Timer
}

const pendingRequests = new Map<string, PendingRequest>()

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
}

function serializeJsonLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

export async function requestHostBridge<T>(action: HostBridgeAction, params: unknown): Promise<T> {
    const requestId = crypto.randomUUID()
    const event: HostBridgeRequestEvent = {
        type: "host_bridge_request",
        request_id: requestId,
        action,
        params,
    }

    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRequests.delete(requestId)
            reject(new Error(`host bridge timeout: ${action}`))
        }, 30_000)

        pendingRequests.set(requestId, {
            resolve: (value) => resolve(value as T),
            reject,
            timer,
        })

        try {
            process.stdout.write(serializeJsonLine(event))
        } catch (error) {
            clearTimeout(timer)
            pendingRequests.delete(requestId)
            reject(new Error(`host bridge write failed: ${toErrorMessage(error)}`))
        }
    })
}

export function resolveHostBridgeResponse(requestId: string, success: boolean, data?: unknown, error?: string): void {
    const pending = pendingRequests.get(requestId)
    if (!pending) return
    pendingRequests.delete(requestId)
    clearTimeout(pending.timer)
    if (!success) {
        pending.reject(new Error(error?.trim() || "host bridge request failed"))
        return
    }
    pending.resolve(data)
}
