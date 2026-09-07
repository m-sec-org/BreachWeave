import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "bun:test"
import { createUser } from "../packages/ui-web/src/auth"
import { parseCreateUserArgs } from "./create-user"

test("createUser stores an Argon2id password hash", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "breachweave-create-user-"))
    const user = await createUser({ dir: configDir }, { username: "admin", password: "secure-password" })
    const data = (await Bun.file(join(configDir, "users.json")).json()) as {
        users: Array<{ username: string; passwordHash: string }>
    }

    expect(user.username).toBe("admin")
    expect(user).not.toHaveProperty("passwordHash")
    expect(data.users).toHaveLength(1)
    expect(data.users[0].username).toBe("admin")
    expect(data.users[0].passwordHash).not.toBe("secure-password")
    expect(await Bun.password.verify("secure-password", data.users[0].passwordHash)).toBe(true)
})

test("createUser rejects duplicate usernames case-insensitively", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "breachweave-create-user-"))
    await createUser({ dir: configDir }, { username: "Admin", password: "secure-password" })

    await expect(createUser({ dir: configDir }, { username: "admin", password: "another-password" })).rejects.toThrow("username already exists")
})

test("parseCreateUserArgs accepts an environment password and custom config directory", () => {
    const parsed = parseCreateUserArgs(["admin", "--config-dir", "./custom-config"], "secure-password")

    expect(parsed).toEqual({
        username: "admin",
        password: "secure-password",
        configDir: resolve("./custom-config"),
    })
})
