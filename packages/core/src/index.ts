export { ConfigManager } from "./config/index"
export { RuntimeManager } from "./runtime/runtime"
export { runSolverCli, runSubagentCli, runSolverRpc } from "./solver/cli"
export type { SolverEventListener } from "./solver/cli"
export * from "./taric/index"
export * from "./project/index"

import { ConfigManager } from "./config/index"
import { ChallengeManager } from "./challenge/manager"
import { createChallengeHostBridgeHandler } from "./challenge/host-bridge-handler"
import { RuntimeManager } from "./runtime/runtime"
import { createTaricMemoryProviderFactory } from "./taric/provider-factory"
import { ensureDefaultLocalTaricGateway } from "./taric/local-gateway"
import { createAuthorizedChallengeProjectionProvider } from "./challenge/authorized-projection"

export class DaemonManager {
    private static instance: Promise<DaemonManager> | undefined

    readonly config: ConfigManager
    readonly challenge: ChallengeManager
    readonly runtime: RuntimeManager

    private constructor(config: ConfigManager, challenge: ChallengeManager, runtime: RuntimeManager) {
        this.config = config
        this.challenge = challenge
        this.runtime = runtime
    }

    static async getInstance(): Promise<DaemonManager> {
        if (this.instance) return this.instance
        const created = (async () => {
            const config = await ConfigManager.getInstance()
            await ensureDefaultLocalTaricGateway(config)
            const challenge = new ChallengeManager(config, undefined, undefined, createTaricMemoryProviderFactory(config), createAuthorizedChallengeProjectionProvider(config))
            const runtime = new RuntimeManager(config, [createChallengeHostBridgeHandler(challenge)])
            challenge.attachRuntime(runtime)
            runtime.onEvent((solverId, event) => {
                void challenge.captureSolverEvent(solverId, event)
            })
            // Recover canonical authorized WorkRuns before exposing the daemon
            // to Web/TUI lifecycle callers. This is idempotent and failures are
            // retained as a readiness block instead of falling back to files.
            await challenge.recoverAuthorizedStartup("daemon:startup")
            return new DaemonManager(config, challenge, runtime)
        })()
        this.instance = created.catch((error) => {
            if (this.instance === created) {
                this.instance = undefined
            }
            throw error
        })
        return this.instance
    }

    async reloadFromConfig(): Promise<void> {
        await this.challenge.reloadFromConfig()
        await this.runtime.reloadFromConfig()
        await this.challenge.recoverAuthorizedStartup("daemon:reload")
    }

    async close(): Promise<void> {
        await this.runtime.stopAll()
        await this.challenge.close()
    }
}
