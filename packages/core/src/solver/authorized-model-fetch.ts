import { requestHostBridge } from "../challenge/host-bridge-client"

/** Model HTTP bodies travel over the existing stdin/stdout host bridge. */
export function createAuthorizedModelFetch(origin: string, bridge = requestHostBridge): typeof fetch {
    const approved = new URL(origin)
    if (!["https:", "http:"].includes(approved.protocol) || approved.pathname !== "/" || approved.search || approved.hash) throw new Error("authorized model origin is invalid")
    return Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init)
        request.signal.throwIfAborted()
        const url = new URL(request.url)
        if (url.origin !== approved.origin || request.method !== "POST" || url.username || url.password || url.hash) throw new Error("authorized model transport rejected an unapproved request")
        const body = new Uint8Array(await request.arrayBuffer())
        if (body.byteLength > 2 * 1024 * 1024) throw new Error("authorized model request exceeds its bound")
        const transportId = crypto.randomUUID()
        let finished = false
        function cancelHostRequest() {
            if (finished) return
            finished = true
            request.signal.removeEventListener("abort", cancelHostRequest)
            void bridge("authorized_model_cancel", { transportId }).catch(() => {})
        }
        request.signal.addEventListener("abort", cancelHostRequest, { once: true })
        try {
            const response = await bridge<{ status: number; headers: Record<string, string> }>("authorized_model_fetch", {
                transportId,
                url: request.url,
                method: request.method,
                headers: Object.fromEntries(request.headers),
                bodyBase64: Buffer.from(body).toString("base64"),
            }, 10 * 60_000, request.signal)
            const stream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const chunk = await bridge<{ done: boolean; bodyBase64?: string }>("authorized_model_read", { transportId }, 10 * 60_000, request.signal)
                        if (chunk.done) {
                            finished = true
                            request.signal.removeEventListener("abort", cancelHostRequest)
                            controller.close()
                        } else {
                            controller.enqueue(Buffer.from(chunk.bodyBase64 ?? "", "base64"))
                        }
                    } catch (error) {
                        cancelHostRequest()
                        controller.error(error)
                    }
                },
                cancel: cancelHostRequest,
            })
            return new Response([204, 205, 304].includes(response.status) ? null : stream, { status: response.status, headers: response.headers })
        } catch (error) {
            cancelHostRequest()
            throw error
        } finally {
            body.fill(0)
        }
    }, {
        preconnect() {
            throw new Error("authorized model transport does not permit preconnect")
        },
    })
}
