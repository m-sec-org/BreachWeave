import { RuntimeDetailPage } from "./detail-page"
import { RuntimeListPage } from "./list-page"

function parseInternalReturnTo(search: string): string | undefined {
    const value = new URLSearchParams(search).get("from")?.trim()
    return value?.startsWith("#/") ? value : undefined
}

export function RuntimeShell() {
    const hash = location.hash || "#/runtime"
    const match = hash.match(/^#\/runtime\/([^/?]+)(?:\?(.*))?$/)
    if (match?.[1]) {
        return <RuntimeDetailPage solverId={decodeURIComponent(match[1])} returnTo={parseInternalReturnTo(match[2] ?? "")} />
    }
    return <RuntimeListPage />
}
