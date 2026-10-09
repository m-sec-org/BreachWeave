// Pure authorization/red-line policy for scope-guard.
// SDK-free so it is unit-testable in isolation (no @mariozechner/pi-coding-agent import).

// --- Enterprise authorization: precise target-in-scope matching (fail-closed) ---
// Replaces substring matching, which is bypassable: allowed "api.corp.com" would
// wrongly admit "api.corp.com.evil.com" or the string appearing in a querystring.

function isIpv4(value: string): boolean {
    return ipv4ToInt(value) !== null
}

function ipv4ToInt(ip: string): number | null {
    const parts = ip.split(".")
    if (parts.length !== 4) return null
    let value = 0
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null
        const n = Number(part)
        if (n < 0 || n > 255) return null
        value = (value * 256 + n) >>> 0
    }
    return value >>> 0
}

function ipInCidr(ip: string, cidr: string): boolean {
    const slash = cidr.indexOf("/")
    if (slash < 0) return false
    const range = cidr.slice(0, slash)
    const bits = Number(cidr.slice(slash + 1))
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
    const ipInt = ipv4ToInt(ip)
    const rangeInt = ipv4ToInt(range)
    if (ipInt === null || rangeInt === null) return false
    if (bits === 0) return true
    const mask = (0xffffffff << (32 - bits)) >>> 0
    return (ipInt & mask) === (rangeInt & mask)
}

function normalizeTarget(value: string): string {
    return value.trim().toLowerCase().replace(/\.$/, "")
}

export function extractCommandTargets(command: string): { hosts: string[]; ips: string[] } {
    const hosts = new Set<string>()
    const ips = new Set<string>()

    const urlRe = /\bhttps?:\/\/([^/\s'"`;|()><]+)/gi
    let match: RegExpExecArray | null
    while ((match = urlRe.exec(command)) !== null) {
        let authority = match[1]
        const at = authority.lastIndexOf("@")
        if (at >= 0) authority = authority.slice(at + 1)
        const host = normalizeTarget(authority.replace(/:\d+$/, ""))
        if (!host) continue
        if (isIpv4(host)) ips.add(host)
        else hosts.add(host)
    }

    const ipRe = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g
    while ((match = ipRe.exec(command)) !== null) {
        if (isIpv4(match[1])) ips.add(match[1])
    }

    return { hosts: [...hosts], ips: [...ips] }
}

function hostInAllowedScope(host: string, allowed: string[]): boolean {
    return allowed.some((target) => {
        if (target.includes("/") || isIpv4(target)) return false
        return host === target || host.endsWith(`.${target}`)
    })
}

function ipInAllowedScope(ip: string, allowed: string[]): boolean {
    return allowed.some((target) => {
        if (target.includes("/")) return ipInCidr(ip, target)
        if (isIpv4(target)) return ip === target
        return false
    })
}

/**
 * True when every network target referenced by the command is within allowed_targets.
 * Empty allowed_targets = no restriction. Network intent with an unparseable target
 * fails closed (out of scope).
 */
export function isTargetInScope(command: string, allowedTargets: string[]): boolean {
    const allowed = allowedTargets.map(normalizeTarget).filter((item) => item.length > 0)
    if (allowed.length === 0) return true

    const { hosts, ips } = extractCommandTargets(command)
    const hasNetworkIntent = /\bhttps?:\/\//i.test(command) || hosts.length > 0 || ips.length > 0
    if (!hasNetworkIntent) return true
    if (hosts.length === 0 && ips.length === 0) return false

    for (const host of hosts) if (!hostInAllowedScope(host, allowed)) return false
    for (const ip of ips) if (!ipInAllowedScope(ip, allowed)) return false
    return true
}

// --- PoC-safe red line: block destructive / persistent / DoS command patterns ---
export const DESTRUCTIVE_COMMAND_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    { name: "sql-drop", pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b/i },
    { name: "sql-truncate", pattern: /\bTRUNCATE\s+(TABLE\s+)?\w/i },
    { name: "sql-delete", pattern: /\bDELETE\s+FROM\b/i },
    { name: "sql-update", pattern: /\bUPDATE\s+\S+\s+SET\b/i },
    { name: "sql-insert", pattern: /\bINSERT\s+INTO\b/i },
    { name: "fs-rm", pattern: /\brm\s+(-[a-z]*[rf]|--(recursive|force|dir)\b)/i },
    { name: "fs-mkfs", pattern: /\bmkfs\b/i },
    { name: "fs-dd", pattern: /\bdd\s+if=/i },
    { name: "sys-power", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i },
    { name: "fork-bomb", pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:/ },
    { name: "webshell-write", pattern: />\s*\S+\.(php|phtml|jsp|jspx|asp|aspx|ashx)\b/i },
]

export function commandIsDestructive(command: string): { destructive: boolean; pattern?: string } {
    for (const { name, pattern } of DESTRUCTIVE_COMMAND_PATTERNS) {
        if (pattern.test(command)) return { destructive: true, pattern: name }
    }
    return { destructive: false }
}

// --- Sub-agent spawn tool name reconciliation ---
// The real spawn tool is registered as "subagent" (createSubagentTool). Older code /
// prompts referenced "spawn_sub_agent". Recognize BOTH so the main orchestrator's
// direct-action budget resets on delegation regardless of the name in play (widen-only).
const SPAWN_TOOL_NAMES = new Set(["subagent", "spawn_sub_agent"])

export function isSpawnToolName(name: string): boolean {
    return SPAWN_TOOL_NAMES.has(name)
}
