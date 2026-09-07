import { resolve } from "path"
import type { ConfigManager } from "../../core/src/index"

export interface AuthUser {
    id: string
    username: string
    createdAt: string
}

interface StoredUser extends AuthUser {
    passwordHash: string
}

interface UsersFile {
    users: StoredUser[]
}

interface UsersConfig {
    dir: string
}

export interface JwtPayload {
    sub: string
    username: string
    iat: number
    exp: number
}

export interface AuthResult {
    user: AuthUser
    token: string
}

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60

function usersPath(config: UsersConfig): string {
    return resolve(config.dir, "users.json")
}

function toPublicUser(user: StoredUser): AuthUser {
    return {
        id: user.id,
        username: user.username,
        createdAt: user.createdAt,
    }
}

function normalizeUsername(username: unknown): string {
    return typeof username === "string" ? username.trim() : ""
}

function normalizePassword(password: unknown): string {
    return typeof password === "string" ? password : ""
}

async function readUsers(config: UsersConfig): Promise<UsersFile> {
    const file = Bun.file(usersPath(config))
    if (!(await file.exists())) return { users: [] }
    try {
        const data = (await file.json()) as unknown
        if (!data || typeof data !== "object" || Array.isArray(data)) return { users: [] }
        const users = (data as { users?: unknown }).users
        if (!Array.isArray(users)) return { users: [] }
        return {
            users: users.filter((user): user is StoredUser => {
                if (!user || typeof user !== "object" || Array.isArray(user)) return false
                const item = user as Partial<StoredUser>
                return typeof item.id === "string" && typeof item.username === "string" && typeof item.passwordHash === "string" && typeof item.createdAt === "string"
            }),
        }
    } catch {
        return { users: [] }
    }
}

async function writeUsers(config: UsersConfig, data: UsersFile): Promise<void> {
    await Bun.write(usersPath(config), JSON.stringify(data, null, 2))
}

function base64UrlEncode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function base64UrlEncodeText(text: string): string {
    return base64UrlEncode(new TextEncoder().encode(text))
}

function base64UrlDecodeText(text: string): string {
    const normalized = text.replaceAll("-", "+").replaceAll("_", "/")
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=")
    return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)))
}

async function importJwtKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
}

async function signJwtInput(input: string, secret: string): Promise<string> {
    const key = await importJwtKey(secret)
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))
    return base64UrlEncode(new Uint8Array(signature))
}

async function getOrCreateJwtSecret(config: ConfigManager): Promise<string> {
    const auth = await config.getHostAuthSettings()
    const existing = typeof auth.jwtSecret === "string" ? auth.jwtSecret.trim() : ""
    if (existing) return existing

    const generated = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)))
    await config.setHostAuthSettings({ jwtSecret: generated })
    return generated
}

async function createToken(config: ConfigManager, user: AuthUser): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const payload: JwtPayload = {
        sub: user.id,
        username: user.username,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
    }
    const header = { alg: "HS256", typ: "JWT" }
    const input = `${base64UrlEncodeText(JSON.stringify(header))}.${base64UrlEncodeText(JSON.stringify(payload))}`
    return `${input}.${await signJwtInput(input, await getOrCreateJwtSecret(config))}`
}

export async function createUser(config: UsersConfig, input: { username?: unknown; password?: unknown }): Promise<AuthUser> {
    const username = normalizeUsername(input.username)
    const password = normalizePassword(input.password)
    if (!username) throw new Error("username is required")
    if (password.length < 8) throw new Error("password must be at least 8 characters")

    const data = await readUsers(config)
    if (data.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
        throw new Error("username already exists")
    }

    const user: StoredUser = {
        id: crypto.randomUUID(),
        username,
        passwordHash: await Bun.password.hash(password, { algorithm: "argon2id" }),
        createdAt: new Date().toISOString(),
    }
    data.users.push(user)
    await writeUsers(config, data)

    return toPublicUser(user)
}

export async function registerUser(config: ConfigManager, input: { username?: unknown; password?: unknown }): Promise<AuthResult> {
    const settings = await config.getHostAuthSettings()
    if (settings.registrationEnabled === false) throw new Error("registration is disabled")

    const publicUser = await createUser(config, input)
    return { user: publicUser, token: await createToken(config, publicUser) }
}

export async function loginUser(config: ConfigManager, input: { username?: unknown; password?: unknown }): Promise<AuthResult> {
    const username = normalizeUsername(input.username)
    const password = normalizePassword(input.password)
    const data = await readUsers(config)
    const user = data.users.find((item) => item.username.toLowerCase() === username.toLowerCase())
    if (!user || !(await Bun.password.verify(password, user.passwordHash))) {
        throw new Error("invalid username or password")
    }

    const publicUser = toPublicUser(user)
    return { user: publicUser, token: await createToken(config, publicUser) }
}

export async function verifyJwt(config: ConfigManager, token: string): Promise<AuthUser | undefined> {
    const parts = token.split(".")
    if (parts.length !== 3) return

    const input = `${parts[0]}.${parts[1]}`
    const expected = await signJwtInput(input, await getOrCreateJwtSecret(config))
    if (expected !== parts[2]) return

    try {
        const payload = JSON.parse(base64UrlDecodeText(parts[1])) as Partial<JwtPayload>
        if (typeof payload.sub !== "string" || typeof payload.username !== "string" || typeof payload.exp !== "number") return
        if (payload.exp <= Math.floor(Date.now() / 1000)) return

        const data = await readUsers(config)
        const user = data.users.find((item) => item.id === payload.sub && item.username === payload.username)
        return user ? toPublicUser(user) : undefined
    } catch {
        return
    }
}
