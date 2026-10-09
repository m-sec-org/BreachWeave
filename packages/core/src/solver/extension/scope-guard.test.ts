import { describe, expect, test } from "bun:test"
import { commandIsDestructive, extractCommandTargets, isSpawnToolName, isTargetInScope } from "./scope-guard-policy"

describe("extractCommandTargets", () => {
    test("pulls host from URL, strips port and userinfo", () => {
        const { hosts, ips } = extractCommandTargets("curl -s https://user:pw@api.corp.com:8443/v1/users")
        expect(hosts).toEqual(["api.corp.com"])
        expect(ips).toEqual([])
    })

    test("pulls bare IPv4 targets", () => {
        const { hosts, ips } = extractCommandTargets("nmap -sV 10.0.0.5")
        expect(hosts).toEqual([])
        expect(ips).toEqual(["10.0.0.5"])
    })
})

describe("isTargetInScope — authorization boundary", () => {
    const allowed = ["api.corp.com"]

    test("exact host in scope", () => {
        expect(isTargetInScope("curl https://api.corp.com/health", allowed)).toBe(true)
    })

    test("legitimate subdomain in scope", () => {
        expect(isTargetInScope("curl https://v2.api.corp.com/health", allowed)).toBe(true)
    })

    test("BYPASS attempt: attacker-controlled parent domain is OUT of scope", () => {
        // The classic substring-match bypass — must be blocked.
        expect(isTargetInScope("curl https://api.corp.com.evil.com/x", allowed)).toBe(false)
    })

    test("BYPASS attempt: allowed string hidden in querystring is OUT of scope", () => {
        expect(isTargetInScope("curl https://evil.com/?x=api.corp.com", allowed)).toBe(false)
    })

    test("unrelated host out of scope", () => {
        expect(isTargetInScope("curl https://example.org", allowed)).toBe(false)
    })

    test("empty allowed_targets = no restriction", () => {
        expect(isTargetInScope("curl https://anything.example", [])).toBe(true)
    })

    test("non-network command is not a scope decision", () => {
        expect(isTargetInScope("ls -la /tmp", allowed)).toBe(true)
    })

    test("CIDR allowance admits IPs inside the range and rejects outside", () => {
        const cidr = ["10.0.0.0/24"]
        expect(isTargetInScope("nmap 10.0.0.42", cidr)).toBe(true)
        expect(isTargetInScope("nmap 10.0.1.42", cidr)).toBe(false)
    })

    test("mixed targets: any out-of-scope target fails the whole command", () => {
        expect(isTargetInScope("curl https://api.corp.com && curl https://evil.com", allowed)).toBe(false)
    })
})

describe("commandIsDestructive — PoC-safe red line", () => {
    test.each([
        ["mysql -e 'DROP TABLE users'", "sql-drop"],
        ["psql -c 'TRUNCATE TABLE audit'", "sql-truncate"],
        ["curl 'http://t/?q=1;DELETE FROM users'", "sql-delete"],
        ["rm -rf /var/www", "fs-rm"],
        ["rm --recursive --force /data", "fs-rm"],
        ["rm --force --recursive /data", "fs-rm"],
        ["dd if=/dev/zero of=/dev/sda", "fs-dd"],
        ["shutdown -h now", "sys-power"],
        ["echo '<?php eval($_POST[0]);' > shell.php", "webshell-write"],
    ])("blocks %s", (command, expected) => {
        const result = commandIsDestructive(command)
        expect(result.destructive).toBe(true)
        expect(result.pattern).toBe(expected)
    })

    test.each([
        ["curl https://api.corp.com/health"],
        ["sqlmap -u https://api.corp.com/?id=1 --technique=B --batch"],
        ["nuclei -u https://api.corp.com"],
        ["cat findings.md"],
    ])("allows non-destructive PoC command %s", (command) => {
        expect(commandIsDestructive(command).destructive).toBe(false)
    })
})

describe("isSpawnToolName — spawn tool name reconciliation", () => {
    test("recognizes the real spawn tool name", () => {
        expect(isSpawnToolName("subagent")).toBe(true)
    })

    test("recognizes the legacy spawn tool name", () => {
        expect(isSpawnToolName("spawn_sub_agent")).toBe(true)
    })

    test.each([["bash"], ["ingest_sub_agent_output"], ["submit_sub_agent_output"], ["document_finding"], [""]])(
        "does not match non-spawn tool %s",
        (name) => {
            expect(isSpawnToolName(name)).toBe(false)
        },
    )
})
