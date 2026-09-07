import { describe, expect, test } from "bun:test"
import { ChallengeApiClient } from "./api-client"

describe("challenge-api-client", () => {
    test("rate limits concurrent local requests to 3 per second", async () => {
        const timestamps: number[] = []
        const client = ChallengeApiClient.createLocal({
            async listChallenges() {
                timestamps.push(Date.now())
                return {
                    current_level: 1,
                    total_challenges: 1,
                    solved_challenges: 0,
                    challenges: [],
                }
            },
            async startChallenge() {
                return ["127.0.0.1:8080"]
            },
            async stopChallenge() {
                return null
            },
            async getHint(code) {
                return {
                    code,
                    hint_content: null,
                }
            },
        })

        await Promise.all([client.listChallenges(), client.listChallenges(), client.listChallenges(), client.listChallenges()])

        expect(timestamps).toHaveLength(4)
        expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(300)
        expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(300)
        expect(timestamps[3] - timestamps[0]).toBeGreaterThanOrEqual(900)
    })
})
