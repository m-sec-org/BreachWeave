import {
    LayoutDashboardIcon,
    ContainerIcon,
    GlobeIcon,
    ServerIcon,
    CpuIcon,
    WrenchIcon,
    PlugIcon,
    BrainIcon,
    FileTextIcon,
    type LucideIcon,
} from "lucide-react"

export type AppIcon = LucideIcon

export interface NavItem {
    title: string
    hash: string
    icon: AppIcon
}

export interface ConfigTab {
    value: string
    label: string
    icon: AppIcon
}

export const mainNavItems: NavItem[] = [
    { title: "项目", hash: "#/", icon: LayoutDashboardIcon },
    { title: "Runtime", hash: "#/runtime", icon: ContainerIcon },
]

export const configTabs: ConfigTab[] = [
    { value: "host", label: "项目", icon: GlobeIcon },
    { value: "planner", label: "Planner", icon: BrainIcon },
    { value: "providers", label: "Providers", icon: ServerIcon },
    { value: "models", label: "Models", icon: CpuIcon },
    { value: "tools", label: "Tools", icon: WrenchIcon },
    { value: "mcp", label: "MCP", icon: PlugIcon },
    { value: "skills", label: "Skills", icon: BrainIcon },
    { value: "prompts", label: "Agents", icon: FileTextIcon },
]
