// Engagement mode env — parallels challenge/env.ts.
// Engagement mode drives the enterprise pentest kernel (de-CTF Observer + scope-guard),
// independent of the CTF challenge/host-bridge path.

export const ENGAGEMENT_ENV_ID = "ENGAGEMENT_ID"
export const ENGAGEMENT_ENV_DIR = "ENGAGEMENT_DIR"

/** True when running an enterprise engagement (not a CTF challenge). */
export function isEngagementMode(): boolean {
    return Boolean(process.env[ENGAGEMENT_ENV_ID]?.trim())
}

/** Current engagement id, or undefined when not in engagement mode. */
export function engagementId(): string | undefined {
    const value = process.env[ENGAGEMENT_ENV_ID]?.trim()
    return value ? value : undefined
}

/** Engagement workspace dir (pentest-workspace root), or undefined. */
export function engagementDir(): string | undefined {
    const value = process.env[ENGAGEMENT_ENV_DIR]?.trim()
    return value ? value : undefined
}
