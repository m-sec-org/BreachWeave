import { expect, test } from "bun:test"
import { createInstance } from "i18next"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nextProvider, initReactI18next } from "react-i18next"
import { AgentEventCard } from "./agent-event-card"

const agentCardProps = {
    eventCount: 2,
    recentEvents: [],
    kindCounts: {},
    activityBuckets: [8, 40],
} as const

async function renderAgentEventCard(promptName: string) {
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({
        lng: "zh",
        fallbackLng: "zh",
        resources: {
            zh: {
                translation: {
                    flow: {
                        agentCard: {
                            latestEvents: "最新 Events",
                            viewAll: "查看全部 ({{count}})",
                        },
                    },
                    replay: { waiting: "等待事件" },
                },
            },
        },
        interpolation: { escapeValue: false },
    })

    return renderToStaticMarkup(
        createElement(
            I18nextProvider,
            { i18n },
            createElement(AgentEventCard, {
                ...agentCardProps,
                promptName,
            }),
        ),
    )
}

test("agent event card keeps activity bars and hides the recent event scrollbar", async () => {
    const markup = await renderAgentEventCard("solver-a")

    expect(markup).toContain("bg-flow-memory/60")
    expect(markup).toContain("no-scrollbar")
    expect(markup).toContain("overflow-y-auto")
    expect(markup).toContain("border-flow-default")
    expect(markup).not.toContain("border-cyan-400/70")
})

test("agent event card does not specially mark a named solver", async () => {
    const markup = await renderAgentEventCard("漏洞分析智能体")

    expect(markup).toContain("rounded-lg")
    expect(markup).toContain("border-flow-default")
    expect(markup).toContain("bg-flow-default-bg")
    expect(markup).not.toContain("rounded-3xl")
    expect(markup).not.toContain("border-cyan")
})
