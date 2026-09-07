import { StringDecoder } from "node:string_decoder"
import type { Readable } from "node:stream"

export function serializeJsonLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
    const decoder = new StringDecoder("utf8")
    let buffer = ""

    const onData = (chunk: string | Buffer) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk)
        while (true) {
            const idx = buffer.indexOf("\n")
            if (idx === -1) return
            const line = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 1)
            onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
        }
    }

    const onEnd = () => {
        buffer += decoder.end()
        if (buffer.length > 0) {
            onLine(buffer)
            buffer = ""
        }
    }

    stream.on("data", onData)
    stream.on("end", onEnd)

    return () => {
        stream.off("data", onData)
        stream.off("end", onEnd)
    }
}
