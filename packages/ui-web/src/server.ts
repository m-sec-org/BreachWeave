import { DaemonManager } from "../../core/src/index"
import { resolveChallengeDir } from "../../core/src/challenge/store"
import { ARCHIVE_SOLVERS_DIR, solverSessionDir } from "../../core/src/runtime/types"
import { readSolverBoardSnapshot } from "../../core/src/solver/board-store"
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent"
import { CHALLENGE_ENV_CHALLENGE_ID } from "../../core/src/challenge/env"
import { buildChallengeAttackTimeline } from "../../core/src/challenge/attack-timeline"
import { buildChallengeStatsOverview } from "../../core/src/challenge/stats"
import { cp, mkdir, mkdtemp, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import { join, resolve } from "path"
import index from "./index.html"
import { loginUser, registerUser, verifyJwt } from "./auth"

export interface WebServerOptions {
    hostname?: string
    port?: number
}

type ApiRequest = Request & { params: Record<string, string> }
type ApiHandler = (req: ApiRequest) => Response | Promise<Response>

function formatError(error: unknown): string {
    return error instanceof Error ? error.stack || error.message : String(error)
}

function logBackgroundError(scope: string, error: unknown) {
    console.error(`[web:${scope}]`, formatError(error))
}

function runInBackground(scope: string, task: Promise<unknown>) {
    task.catch((error) => {
        logBackgroundError(scope, error)
    })
}

function errorResponse(message: string, status = 500) {
    return Response.json({ error: message }, { status })
}

function parseAssetInput(value: unknown): string[] {
    const rawItems = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : []
    const items: string[] = []
    const seen = new Set<string>()
    for (const item of rawItems) {
        const text = typeof item === "string" ? item.trim() : ""
        if (!text || seen.has(text)) continue
        seen.add(text)
        items.push(text)
    }
    return items
}

function createProgressLogger() {
    let active = false

    return {
        log(message: string) {
            if (!process.stdout.isTTY) {
                console.log(message)
                return
            }

            const text = message.replace(/\s+/g, " ").trim()
            if (!text) return

            active = true
            process.stdout.write(`\r\x1b[2K${text}`)

            if (
                text.startsWith("Image ") ||
                text.startsWith("ERROR:") ||
                text.startsWith("Synced runtime Dockerfile")
            ) {
                process.stdout.write("\n")
                active = false
            }
        },
        flush() {
            if (!process.stdout.isTTY) return
            if (!active) return
            process.stdout.write("\n")
            active = false
        },
    }
}

function sanitizeExportNamePart(value: string, fallback: string): string {
    const normalized = value
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
    return normalized || fallback
}

function buildChallengeArchiveBaseName(challengeId: string): string {
    return `challenge-${sanitizeExportNamePart(challengeId, "unknown")}-solver-sessions`
}

function buildSessionFolderName(index: number, solverId: string, promptName?: string): string {
    const order = `${index}`.padStart(2, "0")
    const prompt = sanitizeExportNamePart(promptName ?? "", "solver")
    const solver = sanitizeExportNamePart(solverId, `solver-${order}`)
    return `${order}-${prompt}-${solver}`
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory()
    } catch {
        return false
    }
}

async function resolveSolverSessionPath(solverId: string): Promise<string | undefined> {
    const activePath = solverSessionDir(solverId)
    if (await isDirectory(activePath)) return activePath

    const archivedPath = resolve(ARCHIVE_SOLVERS_DIR, solverId, "session")
    if (await isDirectory(archivedPath)) return archivedPath

    return
}

async function buildChallengeSolverSessionArchive(
    challengeId: string,
    attempts: Array<{ solver_id: string; prompt_name: string }>,
): Promise<{ fileName: string; stream: ReadableStream<Uint8Array> }> {
    const seenSolverIds = new Set<string>()
    const entries: Array<{ solverId: string; promptName?: string; sessionPath: string }> = []

    for (const attempt of attempts) {
        const solverId = attempt.solver_id.trim()
        if (!solverId || seenSolverIds.has(solverId)) continue
        seenSolverIds.add(solverId)

        const sessionPath = await resolveSolverSessionPath(solverId)
        if (!sessionPath) continue

        entries.push({
            solverId,
            promptName: attempt.prompt_name?.trim() || undefined,
            sessionPath,
        })
    }

    if (entries.length === 0) {
        throw new Error(`no solver sessions found for challenge "${challengeId}"`)
    }

    const tempRoot = await mkdtemp(resolve(tmpdir(), "tch-challenge-session-export-"))
    const archiveBaseName = buildChallengeArchiveBaseName(challengeId)
    const stagingDir = resolve(tempRoot, archiveBaseName)
    await mkdir(stagingDir, { recursive: true })

    for (const [index, entry] of entries.entries()) {
        await cp(entry.sessionPath, resolve(stagingDir, buildSessionFolderName(index + 1, entry.solverId, entry.promptName)), {
            recursive: true,
            force: true,
        })
    }

    const proc = Bun.spawn(["zip", "-rq", "-", archiveBaseName], {
        cwd: tempRoot,
        stdout: "pipe",
        stderr: "pipe",
    })
    if (!proc.stdout) {
        await rm(tempRoot, { recursive: true, force: true })
        throw new Error("zip stdout pipe unavailable")
    }

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const reader = proc.stdout.getReader()
            try {
                while (true) {
                    const result = await reader.read()
                    if (result.done) break
                    if (result.value) controller.enqueue(result.value)
                }

                const exitCode = await proc.exited
                if (exitCode !== 0) {
                    const stderr = (await new Response(proc.stderr ?? "").text()).trim()
                    throw new Error(stderr || `zip failed with exit ${exitCode}`)
                }

                controller.close()
            } catch (error) {
                controller.error(error)
            } finally {
                reader.releaseLock()
                await rm(tempRoot, { recursive: true, force: true })
            }
        },
        async cancel() {
            proc.kill()
            await rm(tempRoot, { recursive: true, force: true })
        },
    })

    return {
        fileName: `${archiveBaseName}.zip`,
        stream,
    }
}

export async function startWeb(options: WebServerOptions) {
    const { hostname = "127.0.0.1", port = 3000 } = options
    const daemon = await DaemonManager.getInstance()
    const config = daemon.config
    const containers = daemon.runtime
    const progress = createProgressLogger()
    await containers.init(progress.log)
    progress.flush()
    daemon.challenge.startSyncLoop()
    const encoder = new TextEncoder()
    const runtimeSubscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()
    const solverSubscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()
    const challengeTimelineSubscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()
    const challengeTimelineBroadcastTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const SSE_KEEPALIVE_MS = 5000

    function encodeSse(event: string, data: unknown) {
        return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    function closeController(controller: ReadableStreamDefaultController<Uint8Array>) {
        try {
            controller.close()
        } catch {
            // ignore already closed streams
        }
    }

    function safeEnqueue(
        controller: ReadableStreamDefaultController<Uint8Array>,
        frame: Uint8Array,
        onFailure?: () => void,
    ): boolean {
        try {
            controller.enqueue(frame)
            return true
        } catch (error) {
            onFailure?.()
            logBackgroundError("sse-enqueue", error)
            closeController(controller)
            return false
        }
    }

    function openSse(req: Request, onStart: (controller: ReadableStreamDefaultController<Uint8Array>) => void, onClose: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                onStart(controller)
                safeEnqueue(controller, encoder.encode(": connected\n\n"), () => onClose(controller))
                const timer = setInterval(() => {
                    safeEnqueue(controller, encoder.encode(": keepalive\n\n"), () => {
                        clearInterval(timer)
                        onClose(controller)
                    })
                }, SSE_KEEPALIVE_MS)
                req.signal.addEventListener(
                    "abort",
                    () => {
                        clearInterval(timer)
                        onClose(controller)
                        closeController(controller)
                    },
                    { once: true },
                )
            },
        })

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            },
        })
    }

    async function pushRuntimeSnapshot(controller: ReadableStreamDefaultController<Uint8Array>) {
        safeEnqueue(controller, encodeSse("status", { docker: await containers.ping(), solvers: containers.list().length }), () => runtimeSubscribers.delete(controller))
        safeEnqueue(controller, encodeSse("solvers", await containers.listAll()), () => runtimeSubscribers.delete(controller))
    }

    async function resolveSolverDetailsPayload(solverId: string) {
        const details = await containers.getDetails(solverId)
        if (!details) return

        const sessionPath = await resolveSolverSessionPath(solverId)
        let board: Awaited<ReturnType<typeof readSolverBoardSnapshot>> = { memory: [], ideas: [] }
        if (sessionPath) {
            try {
                board = await readSolverBoardSnapshot(sessionPath)
            } catch (error) {
                logBackgroundError(`solver-board-read:${solverId}`, error)
            }
        }

        return {
            ...details,
            memory: board.memory,
            ideas: board.ideas,
        }
    }

    async function buildAttackTimelinePayload(challengeId: string) {
        const [memory, ideas, attempts, submissions, statsResult] = await Promise.all([
            daemon.challenge.listMemory(challengeId),
            daemon.challenge.listIdeas(challengeId),
            daemon.challenge.listAttemptLogs(challengeId),
            daemon.challenge.listSubmissionLogs(challengeId),
            daemon.challenge.refreshStats(challengeId),
        ])
        return buildChallengeAttackTimeline({
            challengeId,
            memory,
            ideas,
            attempts,
            submissions,
            solverStats: statsResult.solver_stats,
        })
    }

    async function pushSolverDetails(controller: ReadableStreamDefaultController<Uint8Array>, solverId: string) {
        const details = await resolveSolverDetailsPayload(solverId)
        safeEnqueue(controller, encodeSse("details", details ?? { id: solverId, notFound: true }), () => {
            const subscribers = solverSubscribers.get(solverId)
            subscribers?.delete(controller)
            if (subscribers && subscribers.size === 0) solverSubscribers.delete(solverId)
        })
    }

    async function broadcastRuntimeSnapshot() {
        if (runtimeSubscribers.size === 0) return
        const statusFrame = encodeSse("status", { docker: await containers.ping(), solvers: containers.list().length })
        const solversFrame = encodeSse("solvers", await containers.listAll())
        for (const controller of [...runtimeSubscribers]) {
            safeEnqueue(controller, statusFrame, () => runtimeSubscribers.delete(controller))
            safeEnqueue(controller, solversFrame, () => runtimeSubscribers.delete(controller))
        }
    }

    async function broadcastSolverDetails(solverId: string) {
        const subscribers = solverSubscribers.get(solverId)
        if (!subscribers || subscribers.size === 0) return
        const frame = encodeSse("details", (await resolveSolverDetailsPayload(solverId)) ?? { id: solverId, notFound: true })
        for (const controller of [...subscribers]) {
            safeEnqueue(controller, frame, () => {
                subscribers.delete(controller)
                if (subscribers.size === 0) solverSubscribers.delete(solverId)
            })
        }
    }

    async function resolveChallengeIdForSolver(solverId: string): Promise<string | undefined> {
        const solver = containers.get(solverId) ?? (await containers.listAll()).find((item) => item.id === solverId)
        return solver?.challengeId?.trim() || undefined
    }

    async function broadcastChallengeTimeline(challengeId: string) {
        const subscribers = challengeTimelineSubscribers.get(challengeId)
        if (!subscribers || subscribers.size === 0) return
        const frame = encodeSse("snapshot", await buildAttackTimelinePayload(challengeId))
        for (const controller of [...subscribers]) {
            safeEnqueue(controller, frame, () => {
                subscribers.delete(controller)
                if (subscribers.size === 0) challengeTimelineSubscribers.delete(challengeId)
            })
        }
    }

    async function pushChallengeTimeline(controller: ReadableStreamDefaultController<Uint8Array>, challengeId: string) {
        safeEnqueue(controller, encodeSse("snapshot", await buildAttackTimelinePayload(challengeId)), () => {
            const subscribers = challengeTimelineSubscribers.get(challengeId)
            subscribers?.delete(controller)
            if (subscribers?.size === 0) challengeTimelineSubscribers.delete(challengeId)
        })
    }

    async function broadcastChallengeTimelineForSolver(solverId: string) {
        const challengeId = await resolveChallengeIdForSolver(solverId)
        if (!challengeId) return
        if (challengeTimelineBroadcastTimers.has(challengeId)) return
        const timer = setTimeout(() => {
            challengeTimelineBroadcastTimers.delete(challengeId)
            runInBackground(`broadcast-challenge-timeline:${challengeId}`, broadcastChallengeTimeline(challengeId))
        }, 500)
        challengeTimelineBroadcastTimers.set(challengeId, timer)
    }

    async function refreshChallengePlannerStatusForSolver(solverId: string) {
        const challengeId = await resolveChallengeIdForSolver(solverId)
        if (!challengeId) return
        await Bun.sleep(500)
        await daemon.challenge.refreshChallengePlannerStatusFromSolvers(challengeId)
        await broadcastRuntimeSnapshot()
        await broadcastChallengeTimeline(challengeId)
    }

    function broadcastSolverEvent(solverId: string, event: AgentSessionEvent) {
        const subscribers = solverSubscribers.get(solverId)
        if (!subscribers || subscribers.size === 0) return
        const frame = encodeSse("agent_event", event)
        for (const controller of [...subscribers]) {
            safeEnqueue(controller, frame, () => {
                subscribers.delete(controller)
                if (subscribers.size === 0) solverSubscribers.delete(solverId)
            })
        }
    }

    containers.onEvent((solverId, event) => {
        runInBackground("broadcast-runtime-snapshot", broadcastRuntimeSnapshot())
        broadcastSolverEvent(solverId, event)
        runInBackground(`broadcast-challenge-timeline:${solverId}`, broadcastChallengeTimelineForSolver(solverId))
        if (event.type === "agent_end") {
            runInBackground(`broadcast-solver-details:${solverId}`, broadcastSolverDetails(solverId))
            runInBackground(`refresh-challenge-planner-status:${solverId}`, refreshChallengePlannerStatusForSolver(solverId))
        }
    })

    function extractBearerToken(req: Request): string | undefined {
        const auth = req.headers.get("Authorization")?.trim()
        if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim() || undefined

        const token = new URL(req.url).searchParams.get("token")?.trim()
        return token || undefined
    }

    function withAuth(handler: ApiHandler): ApiHandler {
        return async (req) => {
            const token = extractBearerToken(req)
            if (!token || !(await verifyJwt(config, token))) {
                return errorResponse("unauthorized", 401)
            }
            return handler(req)
        }
    }

    function protectRoutes(routes: Record<string, Record<string, ApiHandler>>): Record<string, Record<string, ApiHandler>> {
        const protectedRoutes: Record<string, Record<string, ApiHandler>> = {}
        for (const [path, route] of Object.entries(routes)) {
            if (path.startsWith("/api/auth/")) {
                protectedRoutes[path] = route
                continue
            }

            const methods: Record<string, ApiHandler> = {}
            for (const [method, handler] of Object.entries(route)) {
                methods[method] = withAuth(handler)
            }
            protectedRoutes[path] = methods
        }
        return protectedRoutes
    }

    const server = Bun.serve({
        hostname,
        port,
        idleTimeout: 30,
        routes: {
            "/": index,
            ...protectRoutes({

            "/api/auth/register": {
                async POST(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown }
                        return Response.json(await registerUser(config, body))
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        const status = message === "registration is disabled" ? 403 : message.includes("already exists") ? 409 : 400
                        return errorResponse(message, status)
                    }
                },
            },

            "/api/auth/login": {
                async POST(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown }
                        return Response.json(await loginUser(config, body))
                    } catch {
                        return errorResponse("invalid username or password", 401)
                    }
                },
            },

            "/api/auth/me": {
                async GET(req) {
                    const token = extractBearerToken(req)
                    const user = token ? await verifyJwt(config, token) : undefined
                    if (!user) return errorResponse("unauthorized", 401)
                    return Response.json({ user })
                },
            },

            "/api/auth/settings": {
                async GET() {
                    const settings = await config.getHostSettings()
                    return Response.json({ registrationEnabled: settings.auth.registrationEnabled ?? true })
                },
            },

            // ── API Keys ──
            "/api/config/api-keys": {
                GET() {
                    return Response.json(config.listApiKeys())
                },
                async POST(req) {
                    const { provider, key } = await req.json()
                    config.setApiKey(provider, key)
                    return Response.json({ ok: true })
                },
                async DELETE(req) {
                    const { provider } = await req.json()
                    config.removeApiKey(provider)
                    return Response.json({ ok: true })
                },
            },

            // ── Providers ──
            "/api/config/providers": {
                async GET() {
                    return Response.json(await config.listProviderPrefs())
                },
                async POST(req) {
                    const entry = await req.json()
                    const result = await config.addProviderPref(entry)
                    return Response.json(result)
                },
                async DELETE(req) {
                    const { id } = await req.json()
                    await config.removeProviderPref(id)
                    return Response.json({ ok: true })
                },
                async PATCH(req) {
                    const { id, ...patch } = await req.json()
                    const result = await config.updateProviderPref(id, patch)
                    return Response.json(result ?? { id })
                },
            },

            // ── Models ──
            "/api/config/models": {
                GET() {
                    return Response.json(config.listAllModels())
                },
            },

            // ── Provider Models ──
            "/api/config/provider-models": {
                async GET() {
                    return Response.json(await config.listConfiguredModels())
                },
                async POST(req) {
                    const { provider, model } = await req.json()
                    await config.addModelToProvider(provider, model)
                    return Response.json({ ok: true })
                },
                async DELETE(req) {
                    const { provider, modelId } = await req.json()
                    await config.removeModelFromProvider(provider, modelId)
                    return Response.json({ ok: true })
                },
            },

            // ── Model Prefs (用户偏好) ──
            "/api/config/model-prefs": {
                async GET() {
                    return Response.json(await config.listModelPrefs())
                },
                async POST(req) {
                    const entry = await req.json()
                    const result = await config.addModelPref(entry)
                    return Response.json(result)
                },
                async DELETE(req) {
                    const { id } = await req.json()
                    await config.removeModelPref(id)
                    return Response.json({ ok: true })
                },
            },

            // ── Test Model ──
            "/api/config/test-model": {
                async POST(req) {
                    const { id } = await req.json()
                    console.log(`[test-model] id=${id}`)
                    const result = await config.testModel(id)
                    console.log(`[test-model] result:`, JSON.stringify(result))
                    return Response.json(result)
                },
            },

            // ── Skills ──
            "/api/config/skills": {
                GET() {
                    return Response.json(
                        config.listSkills().map((s) => ({
                            name: s.name,
                            description: s.description,
                            filePath: s.filePath,
                        })),
                    )
                },
                async POST(req) {
                    const formData = await req.formData()
                    const file = formData.get("file") as File | null
                    if (!file) return Response.json({ error: "missing file" }, { status: 400 })
                    const buffer = await file.arrayBuffer()
                    try {
                        const result = await config.addSkillFromZip(buffer)
                        return Response.json(result)
                    } catch (e: any) {
                        return Response.json({ error: e.message }, { status: 400 })
                    }
                },
                async DELETE(req) {
                    const { name } = await req.json()
                    await config.removeSkill(name)
                    return Response.json({ ok: true })
                },
            },

            "/api/config/skills-git": {
                async POST(req) {
                    const { url } = await req.json()
                    if (!url) return Response.json({ error: "missing url" }, { status: 400 })
                    try {
                        const result = await config.addSkillFromGit(url)
                        return Response.json(result)
                    } catch (e: any) {
                        return Response.json({ error: e.message }, { status: 400 })
                    }
                },
            },

            "/api/config/skills/:name/content": {
                async GET(req) {
                    const name = new URL(req.url).pathname.split("/").at(-2)
                    if (!name) return Response.json({ error: "missing name" }, { status: 400 })
                    const skill = config.getSkill(decodeURIComponent(name))
                    if (!skill?.filePath) return Response.json({ error: "not found" }, { status: 404 })
                    const content = await Bun.file(skill.filePath).text()
                    return Response.json({ content })
                },
            },

            // ── Prompts ──
            "/api/config/prompts": {
                async GET(req) {
                    const type = new URL(req.url).searchParams.get("type")
                    if (type === "agent") return Response.json(await config.listAgentPrompts())
                    if (type === "subagent") return Response.json(await config.listSubagentPrompts())
                    return Response.json({ error: "missing or invalid type" }, { status: 400 })
                },
                async POST(req) {
                    const prompt = await req.json()
                    await config.setPrompt(prompt)
                    return Response.json({ ok: true })
                },
                async DELETE(req) {
                    const { name } = await req.json()
                    await config.removePrompt(name)
                    return Response.json({ ok: true })
                },
            },

            // ── Tools ──
            "/api/config/tools": {
                GET() {
                    return Response.json(config.listTools())
                },
            },

            // ── Host Settings (runtime/challenge) ──
            "/api/config/host-settings": {
                async GET() {
                    return Response.json(await config.getHostSettings())
                },
                async POST(req) {
                    const patch = await req.json()
                    const settings = await config.setHostSettings(patch)
                    await daemon.reloadFromConfig()
                    return Response.json(settings)
                },
            },
            "/api/config/host-planner-prompt": {
                async GET() {
                    const prompt = await config.getChallengePlannerPrompt()
                    if (!prompt) {
                        return Response.json({ error: "challenge planner prompt not found" }, { status: 404 })
                    }
                    return Response.json(prompt)
                },
                async POST(req) {
                    const body = (await req.json().catch(() => ({}))) as { content?: string; model?: string }
                    const prompt = await config.setChallengePlannerPrompt(String(body.content ?? ""), typeof body.model === "string" ? body.model : undefined)
                    return Response.json(prompt)
                },
            },

            "/api/challenges": {
                async GET() {
                    const challenges = await daemon.challenge.listChallengesSafe("challenge-api:web")
                    const items = await Promise.all(
                        challenges.map(async (challenge) => {
                            let submissionCount = 0
                            try {
                                submissionCount = (await daemon.challenge.listSubmissionLogs(challenge.id)).length
                            } catch (error) {
                                console.error(`[challenge:list:${challenge.id}:submissions]`, formatError(error))
                            }
                            return {
                                ...challenge,
                                submission_count: submissionCount,
                            }
                        }),
                    )
                    return Response.json(items)
                },
                async POST(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
                        const name = String(body.name ?? "").trim()
                        if (!name) {
                            return Response.json({ error: "challenge name is required" }, { status: 400 })
                        }
                        const challenge = await daemon.challenge.createChallengeFromInput({
                            name,
                            description: String(body.description ?? ""),
                            assets_url: parseAssetInput(body.assetsUrl ?? body.assets_url),
                            assets_ip: parseAssetInput(body.assetsIp ?? body.assets_ip),
                            planner_prompt: String(body.plannerPrompt ?? body.planner_prompt ?? "").trim() || null,
                            planner_enabled: body.plannerEnabled === false || body.planner_enabled === false ? false : true,
                        })
                        if (!challenge) {
                            return Response.json({ error: "failed to create challenge" }, { status: 500 })
                        }
                        return Response.json(challenge)
                    } catch (error) {
                        return errorResponse(error instanceof Error ? error.message : String(error), 500)
                    }
                },
            },
            "/api/challenges/stats-overview": {
                async GET() {
                    const challenges = await daemon.challenge.listChallengesSafe("challenge-api:stats-overview")
                    const entries = await Promise.all(
                        challenges.map(async (challenge) => {
                            const [statsResult, submissions] = await Promise.all([
                                daemon.challenge.refreshStats(challenge.id),
                                daemon.challenge.listSubmissionLogs(challenge.id),
                            ])
                            return {
                                challenge,
                                stats: statsResult.stats,
                                solver_stats: statsResult.solver_stats,
                                submissions,
                            }
                        }),
                    )
                    return Response.json(buildChallengeStatsOverview(entries))
                },
            },
            "/api/challenges/:id/attack-timeline": {
                async GET(req) {
                    const challengeId = req.params.id
                    const challenge = await daemon.challenge.getChallenge(challengeId)
                    if (!challenge) {
                        return Response.json({ error: "challenge not found" }, { status: 404 })
                    }
                    return Response.json(await buildAttackTimelinePayload(challengeId))
                },
            },
            "/api/challenges/:id/planner-prompt": {
                async GET(req) {
                    const challenge = await daemon.challenge.getChallenge(req.params.id)
                    if (!challenge) return Response.json({ error: "challenge not found" }, { status: 404 })
                    return Response.json({ content: challenge.planner_prompt ?? "" })
                },
                async PATCH(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as { content?: unknown }
                        const content = typeof body.content === "string" ? body.content : null
                        const challenge = await daemon.challenge.updateChallengePlannerPrompt(req.params.id, content)
                        return Response.json({ content: challenge.planner_prompt ?? "", challenge })
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        const status = message.includes("not found") ? 404 : 400
                        return errorResponse(message, status)
                    }
                },
            },
            "/api/challenges/:id/planner-enabled": {
                async PATCH(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as { enabled?: unknown }
                        if (typeof body.enabled !== "boolean") return errorResponse("enabled must be boolean", 400)
                        const challenge = await daemon.challenge.updateChallengePlannerEnabled(req.params.id, body.enabled)
                        return Response.json({ enabled: challenge.planner_enabled !== false, challenge })
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        const status = message.includes("not found") ? 404 : 400
                        return errorResponse(message, status)
                    }
                },
            },
            "/api/challenges/:id/assets/scanned": {
                async PATCH(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as { group?: unknown; asset?: unknown; scanned?: unknown }
                        const group = body.group === "urls" || body.group === "url" ? "urls" : body.group === "ips" || body.group === "ip" ? "ips" : undefined
                        if (!group) return errorResponse("asset group must be urls or ips", 400)
                        const asset = typeof body.asset === "string" ? body.asset.trim() : ""
                        if (!asset) return errorResponse("asset is required", 400)
                        const challenge = await daemon.challenge.updateChallengeAssetScanned(req.params.id, group, asset, body.scanned !== false)
                        return Response.json(challenge)
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        const status = message.includes("not found") ? 404 : 400
                        return errorResponse(message, status)
                    }
                },
            },
            "/api/challenges/:id/attack-timeline/stream": {
                async GET(req) {
                    const challengeId = req.params.id
                    const challenge = await daemon.challenge.getChallenge(challengeId)
                    if (!challenge) {
                        return Response.json({ error: "challenge not found" }, { status: 404 })
                    }
                    return openSse(
                        req,
                        (controller) => {
                            const subscribers = challengeTimelineSubscribers.get(challengeId) ?? new Set<ReadableStreamDefaultController<Uint8Array>>()
                            subscribers.add(controller)
                            challengeTimelineSubscribers.set(challengeId, subscribers)
                            runInBackground(`push-challenge-timeline:${challengeId}`, pushChallengeTimeline(controller, challengeId))
                        },
                        (controller) => {
                            const subscribers = challengeTimelineSubscribers.get(challengeId)
                            subscribers?.delete(controller)
                            if (subscribers?.size === 0) challengeTimelineSubscribers.delete(challengeId)
                        },
                    )
                },
            },
            "/api/challenges/:id": {
                async GET(req) {
                    const challengeId = req.params.id
                    const challenge = await daemon.challenge.getChallenge(challengeId)
                    if (!challenge) {
                        return Response.json({ error: "challenge not found" }, { status: 404 })
                    }
                    const [memory, ideas, attempts, submissions, solvers, statsResult] = await Promise.all([
                        daemon.challenge.listMemory(challengeId),
                        daemon.challenge.listIdeas(challengeId),
                        daemon.challenge.listAttemptLogs(challengeId),
                        daemon.challenge.listSubmissionLogs(challengeId),
                        containers.listAll(),
                        daemon.challenge.refreshStats(challengeId),
                    ])
                    return Response.json({
                        challenge,
                        memory,
                        ideas,
                        attempts,
                        submissions,
                        stats: statsResult.stats,
                        solver_stats: statsResult.solver_stats,
                        solvers: solvers.filter((solver) => solver.challengeId === challengeId),
                    })
                },
                async DELETE(req) {
                    try {
                        const challengeId = req.params.id?.trim() ?? ""
                        if (!challengeId) {
                            return errorResponse("challenge id is required", 400)
                        }
                        await daemon.challenge.deleteChallenge(challengeId)
                        const timer = challengeTimelineBroadcastTimers.get(challengeId)
                        if (timer) {
                            clearTimeout(timer)
                            challengeTimelineBroadcastTimers.delete(challengeId)
                        }
                        challengeTimelineSubscribers.delete(challengeId)
                        return Response.json({ ok: true })
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        if (message.includes("not found")) {
                            return errorResponse(message, 404)
                        }
                        if (message.includes("is required") || message.includes("is invalid")) {
                            return errorResponse(message, 400)
                        }
                        return errorResponse(message, 500)
                    }
                },
            },
            "/api/challenges/:id/solver-sessions.zip": {
                async GET(req) {
                    try {
                        const challengeId = req.params.id
                        const challenge = await daemon.challenge.getChallenge(challengeId)
                        if (!challenge) {
                            return Response.json({ error: "challenge not found" }, { status: 404 })
                        }

                        const attempts = await daemon.challenge.listAttemptLogs(challengeId)
                        const archive = await buildChallengeSolverSessionArchive(challengeId, attempts)
                        return new Response(archive.stream, {
                            headers: {
                                "Cache-Control": "no-store",
                                "Content-Disposition": `attachment; filename="${archive.fileName}"`,
                                "Content-Type": "application/zip",
                            },
                        })
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        const status = message.startsWith("no solver sessions found") ? 404 : 500
                        return errorResponse(message, status)
                    }
                },
            },
            "/api/challenges/:id/memory": {
                async POST(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as {
                            kind?: "fact" | "evidence" | "failure" | "note" | "hint"
                            content?: string
                            refs?: string[]
                            source?: string
                        }
                        const entry = await daemon.challenge.appendMemory({
                            challengeId: req.params.id,
                            kind: body.kind ?? "note",
                            content: body.content ?? "",
                            refs: Array.isArray(body.refs) ? body.refs : [],
                            source: body.source?.trim() || "challenge-ui",
                        })
                        return Response.json(entry)
                    } catch (error) {
                        return errorResponse(error instanceof Error ? error.message : String(error), 500)
                    }
                },
            },
            "/api/challenges/:id/memory/:entryId": {
                async PATCH(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as {
                            kind?: "fact" | "evidence" | "failure" | "note" | "hint"
                            content?: string
                            refs?: string[]
                            source?: string
                        }
                        const entry = await daemon.challenge.updateMemory(req.params.id, req.params.entryId, {
                            kind: body.kind,
                            content: body.content,
                            refs: Array.isArray(body.refs) ? body.refs : body.refs === undefined ? undefined : [],
                            source: body.source,
                        })
                        return Response.json(entry)
                    } catch (error) {
                        return errorResponse(error instanceof Error ? error.message : String(error), 500)
                    }
                },
                async DELETE(req) {
                    try {
                        const entry = await daemon.challenge.deleteMemory(req.params.id, req.params.entryId)
                        return Response.json(entry)
                    } catch (error) {
                        return errorResponse(error instanceof Error ? error.message : String(error), 500)
                    }
                },
            },
            "/api/challenges/:id/ideas": {
                async POST(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as {
                            content?: string
                            status?: "pending" | "testing" | "verified" | "failed" | "skipped"
                            result?: string
                        }
                        const result = await daemon.challenge.addIdea(req.params.id, {
                            content: body.content ?? "",
                            status: body.status,
                            result: body.result,
                        })
                        return Response.json(result)
                    } catch (error) {
                        return errorResponse(error instanceof Error ? error.message : String(error), 500)
                    }
                },
            },
            "/api/challenges/:id/ideas/:ideaId": {
                async PATCH(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as {
                            content?: string
                            status?: "pending" | "testing" | "verified" | "failed" | "skipped"
                            result?: string
                        }
                        const item = await daemon.challenge.updateIdea(req.params.id, req.params.ideaId, {
                            content: body.content,
                            status: body.status,
                            result: body.result,
                        })
                        return Response.json(item)
                    } catch (error) {
                        return errorResponse(error instanceof Error ? error.message : String(error), 500)
                    }
                },
                async DELETE(req) {
                    try {
                        const item = await daemon.challenge.deleteIdea(req.params.id, req.params.ideaId)
                        return Response.json(item)
                    } catch (error) {
                        return errorResponse(error instanceof Error ? error.message : String(error), 500)
                    }
                },
            },
            "/api/challenges/:id/solvers": {
                async POST(req) {
                    try {
                        const body = (await req.json().catch(() => ({}))) as { promptName?: string }
                        const challengeId = req.params.id
                        const promptName = body.promptName?.trim()
                        if (!promptName) {
                            return Response.json({ error: "missing promptName" }, { status: 400 })
                        }
                        const challenge = await daemon.challenge.getChallenge(challengeId)
                        if (challenge?.planner_enabled === false) {
                            return Response.json({ error: "planner is disabled for this challenge" }, { status: 400 })
                        }
                        await daemon.challenge.updateChallengePlannerStatus(challengeId, "starting")
                        runInBackground("launch-challenge-solver:challenge-timeline", broadcastChallengeTimeline(challengeId))
                        runInBackground(`launch-challenge-solver:planner:${challengeId}`, (async () => {
                            try {
                                await daemon.challenge.updateChallengePlannerStatus(challengeId, "running")
                                await broadcastChallengeTimeline(challengeId)
                                const plannerResult = await daemon.challenge.runPlannerForChallenge(challengeId, promptName)
                                if (plannerResult.launchedSolvers.length === 0) {
                                    await daemon.challenge.refreshChallengePlannerStatusFromSolvers(challengeId)
                                }
                                await broadcastRuntimeSnapshot()
                                await broadcastChallengeTimeline(challengeId)
                                for (const solver of plannerResult.launchedSolvers) {
                                    await broadcastSolverDetails(solver.id)
                                }
                            } catch (error) {
                                await daemon.challenge.updateChallengePlannerStatus(challengeId, "stop").catch((statusError) => {
                                    logBackgroundError(`planner-status-stop:${challengeId}`, statusError)
                                })
                                await broadcastChallengeTimeline(challengeId)
                                throw error
                            }
                        })())
                        return Response.json({
                            accepted: true,
                            challengeId,
                            promptName,
                            message: "planner started",
                        })
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e)
                        return Response.json({ error: msg }, { status: 500 })
                    }
                },
            },

            // ── MCP Servers ──
            "/api/config/mcp": {
                GET() {
                    return Response.json(config.listMcpServers())
                },
                async POST(req) {
                    const { name, server } = await req.json()
                    await config.addMcpServer(name, server)
                    return Response.json({ ok: true })
                },
                async DELETE(req) {
                    const { name } = await req.json()
                    await config.removeMcpServer(name)
                    return Response.json({ ok: true })
                },
                async PATCH(req) {
                    const { name, server, newName } = await req.json()
                    if (newName && newName !== name) {
                        await config.renameMcpServer(name, newName)
                    }
                    if (server) {
                        await config.updateMcpServer(newName || name, server)
                    }
                    return Response.json({ ok: true })
                },
            },

            "/api/config/mcp-probe": {
                async POST(req) {
                    const { name, server } = await req.json()
                    try {
                        if (server) {
                            const result = await config.probeMcpDraftServer(server, name ?? "draft")
                            return Response.json(result)
                        }
                        const result = name ? await config.probeMcpServer(name) : await config.probeAllMcpServers()
                        return Response.json(result)
                    } catch (e: any) {
                        return Response.json({ error: e.message }, { status: 500 })
                    }
                },
            },

            "/api/config/mcp-settings": {
                GET() {
                    return Response.json(config.getMcpSettings() ?? {})
                },
                async POST(req) {
                    const settings = await req.json()
                    await config.setMcpSettings(settings)
                    return Response.json({ ok: true })
                },
            },

            // ── Built-in Reference ──
            "/api/config/built-in/providers": {
                GET() {
                    return Response.json(config.listBuiltInProviders())
                },
            },
            "/api/config/built-in/protocols": {
                GET() {
                    return Response.json(config.listSupportedProtocols())
                },
            },
            "/api/config/built-in/models/:provider": {
                GET(req) {
                    const provider = req.params.provider
                    try {
                        const models = config.listBuiltInModels(provider as any)
                        return Response.json(models)
                    } catch {
                        return Response.json([])
                    }
                },
            },
            "/api/config/built-in/model-lookup": {
                GET(req) {
                    const url = new URL(req.url)
                    const api = url.searchParams.get("api")?.trim()
                    const modelId = url.searchParams.get("modelId")?.trim()
                    if (!api || !modelId) return Response.json(null)
                    const model = config.findBuiltInModelByApiAndId(api, modelId)
                    return Response.json(model ?? null)
                },
            },
            "/api/config/discover-models/:provider": {
                async GET(req) {
                    const provider = req.params.provider
                    try {
                        const models = await config.discoverModels(provider)
                        return Response.json(models)
                    } catch (error) {
                        console.error(`[config:discover-models:${provider}]`, formatError(error))
                        const message = error instanceof Error ? error.message : String(error)
                        return Response.json({ error: message }, { status: 500 })
                    }
                },
            },

            // ── Containers ──
            "/api/runtime/status": {
                async GET() {
                    const docker = await containers.ping()
                    return Response.json({ docker, solvers: containers.list().length })
                },
            },
            "/api/runtime/solvers": {
                async GET() {
                    return Response.json(await containers.listAll())
                },
                async POST(req) {
                    const { promptName, task, env } = await req.json()
                    if (!promptName) return Response.json({ error: "missing promptName" }, { status: 400 })
                    if (!task) return Response.json({ error: "missing task" }, { status: 400 })
                    try {
                        // Validate prompt exists before starting container
                        const prompt = await config.getPrompt(promptName)
                        if (!prompt) return Response.json({ error: "prompt not found" }, { status: 404 })
                        if (prompt.meta.isSubagent) return Response.json({ error: "subagent prompt cannot be started as solver" }, { status: 400 })

                        const requestSolverEnv = env && typeof env === "object" ? (env as Record<string, string>) : {}
                        const solver = await containers.launch(promptName, task, requestSolverEnv)
                        const challengeId = requestSolverEnv[CHALLENGE_ENV_CHALLENGE_ID]?.trim()
                        if (challengeId) {
                            await daemon.challenge.appendAttemptLog({
                                challengeId,
                                solverId: solver.id,
                                promptName,
                                task,
                            })
                        }
                        runInBackground("launch-runtime-solver:runtime-snapshot", broadcastRuntimeSnapshot())
                        runInBackground(`launch-runtime-solver:details:${solver.id}`, broadcastSolverDetails(solver.id))
                        return Response.json(solver)
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e)
                        return Response.json({ error: msg }, { status: 500 })
                    }
                },
            },
            "/api/runtime/stream": {
                GET(req) {
                    return openSse(
                        req,
                        (controller) => {
                            runtimeSubscribers.add(controller)
                            runInBackground("push-runtime-snapshot", pushRuntimeSnapshot(controller))
                        },
                        (controller) => {
                            runtimeSubscribers.delete(controller)
                        },
                    )
                },
            },
            "/api/runtime/solvers/:id": {
                async GET(req) {
                    const solver = await resolveSolverDetailsPayload(req.params.id)
                    if (!solver) return Response.json({ error: "not found" }, { status: 404 })
                    return Response.json(solver)
                },
                async DELETE(req) {
                    try {
                        const solver = containers.get(req.params.id) ?? (await containers.listAll()).find((item) => item.id === req.params.id)
                        if (!solver) return Response.json({ error: "not found" }, { status: 404 })

                        if (solver.status === "starting" || solver.status === "running" || solver.status === "stopping") {
                            await containers.stopSolver(req.params.id)
                        } else {
                            await containers.deleteSolver(req.params.id)
                        }
                        if (solver.challengeId) {
                            await daemon.challenge.refreshChallengePlannerStatusFromSolvers(solver.challengeId)
                            runInBackground(`delete-runtime-solver:challenge-timeline:${solver.challengeId}`, broadcastChallengeTimeline(solver.challengeId))
                        }

                        runInBackground("delete-runtime-solver:runtime-snapshot", broadcastRuntimeSnapshot())
                        runInBackground(`delete-runtime-solver:details:${req.params.id}`, broadcastSolverDetails(req.params.id))
                        return Response.json({ ok: true })
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e)
                        const status = msg.includes("still running") ? 400 : 500
                        return Response.json({ error: msg }, { status })
                    }
                },
            },
            "/api/runtime/solvers/:id/stream": {
                GET(req) {
                    const solverId = req.params.id
                    return openSse(
                        req,
                        (controller) => {
                            const subscribers = solverSubscribers.get(solverId) ?? new Set<ReadableStreamDefaultController<Uint8Array>>()
                            subscribers.add(controller)
                            solverSubscribers.set(solverId, subscribers)
                            runInBackground(`push-solver-details:${solverId}`, pushSolverDetails(controller, solverId))
                        },
                        (controller) => {
                            const subscribers = solverSubscribers.get(solverId)
                            subscribers?.delete(controller)
                            if (subscribers && subscribers.size === 0) solverSubscribers.delete(solverId)
                        },
                    )
                },
            },
            "/api/runtime/solvers/:id/command": {
                async POST(req) {
                    const body = await req.json()
                    try {
                        containers.sendCommand(req.params.id, body)
                        return Response.json({ ok: true })
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e)
                        return Response.json({ error: msg }, { status: 404 })
                    }
                },
            },
            }),
        },
        development: {
            hmr: true,
            console: true,
        },
    })

    console.log(`Web UI running at http://${hostname}:${port}`)
    return server
}
