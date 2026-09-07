import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { createUser } from "../packages/ui-web/src/auth"

interface CreateUserArgs {
    username: string
    password: string
    configDir: string
}

const DEFAULT_CONFIG_DIR = resolve(homedir(), ".tch-agent", "config")
const USAGE = `Usage: bun run create-user <username> [password] [--config-dir <path>]

If password is omitted, set TCH_USER_PASSWORD in the environment.`

export function parseCreateUserArgs(args: string[], passwordFromEnv?: string): CreateUserArgs {
    const positionals: string[] = []
    let configDir = DEFAULT_CONFIG_DIR

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === "--config-dir") {
            const value = args[index + 1]?.trim()
            if (!value) throw new Error("--config-dir requires a path")
            configDir = resolve(value)
            index += 1
            continue
        }
        if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`)
        positionals.push(arg)
    }

    if (positionals.length > 2) throw new Error("too many positional arguments")

    const username = positionals[0]?.trim() ?? ""
    const password = positionals[1] ?? passwordFromEnv ?? ""
    if (!username) throw new Error("username is required")
    if (!password) throw new Error("password is required")

    return { username, password, configDir }
}

export async function runCreateUser(args: string[], passwordFromEnv?: string): Promise<void> {
    const parsed = parseCreateUserArgs(args, passwordFromEnv)
    await mkdir(parsed.configDir, { recursive: true })
    const user = await createUser({ dir: parsed.configDir }, parsed)
    console.log(`Created user "${user.username}" in ${parsed.configDir}`)
}

if (import.meta.main) {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.log(USAGE)
    } else {
        await runCreateUser(process.argv.slice(2), process.env.TCH_USER_PASSWORD).catch((error) => {
            console.error(error instanceof Error ? error.message : String(error))
            console.error(USAGE)
            process.exitCode = 1
        })
    }
}
