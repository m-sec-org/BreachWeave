import { ProvidersPage } from "./providers"
import { ModelsPage } from "./models"
import { ToolsPage } from "./tools"
import { SkillsPage } from "./skills"
import { PromptsPage } from "./prompts"
import { McpPage } from "./mcp"
import { HostPage, PlannerPage } from "./host"

const configPages: Record<string, { title: string; component: () => React.JSX.Element }> = {
    host: { title: "项目", component: HostPage },
    planner: { title: "Planner", component: PlannerPage },
    providers: { title: "Providers", component: ProvidersPage },
    models: { title: "Models", component: ModelsPage },
    tools: { title: "Tools", component: ToolsPage },
    mcp: { title: "MCP Servers", component: McpPage },
    skills: { title: "Skills", component: SkillsPage },
    prompts: { title: "Prompts", component: PromptsPage },
}

export function ConfigPage({ activeTab }: { activeTab: string }) {
    const page = configPages[activeTab]
    if (!page) return null
    const Page = page.component
    return (
        <div className="flex flex-1 flex-col gap-4 p-6">
            <h1 className="text-2xl font-bold tracking-tight">{page.title}</h1>
            <Page />
        </div>
    )
}
