import { LayoutDashboardIcon, BotIcon, SettingsIcon, KeyRoundIcon, WrenchIcon, type LucideIcon } from "lucide-react"

export interface NavItem {
    title: string
    url: string
    icon: LucideIcon
    isActive?: boolean
}

export interface NavGroup {
    label: string
    items: NavItem[]
}

export const sidebarData: NavGroup[] = [
    {
        label: "Main",
        items: [
            { title: "Dashboard", url: "/", icon: LayoutDashboardIcon, isActive: true },
            { title: "Agents", url: "/agents", icon: BotIcon },
        ],
    },
    {
        label: "Settings",
        items: [
            { title: "API Keys", url: "/settings/api-keys", icon: KeyRoundIcon },
            { title: "Tools", url: "/settings/tools", icon: WrenchIcon },
            { title: "General", url: "/settings/general", icon: SettingsIcon },
        ],
    },
]
