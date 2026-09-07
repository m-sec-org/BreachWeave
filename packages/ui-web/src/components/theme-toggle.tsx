import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { useTheme, type Theme } from "../hooks/use-theme"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar"

type ThemeOption = {
    value: Theme
    icon: typeof SunIcon
    labelKey: string
}

const THEME_OPTIONS: ThemeOption[] = [
    { value: "light", icon: SunIcon, labelKey: "theme.light" },
    { value: "dark", icon: MoonIcon, labelKey: "theme.dark" },
    { value: "system", icon: MonitorIcon, labelKey: "theme.system" },
]

export function ThemeToggle() {
    const { theme, setTheme, resolved } = useTheme()
    const { t } = useTranslation()
    const ActiveIcon = resolved === "dark" ? MoonIcon : SunIcon
    const activeLabelKey = THEME_OPTIONS.find((option) => option.value === theme)?.labelKey ?? "theme.system"

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <SidebarMenuButton tooltip={t("theme.toggle")}>
                                <ActiveIcon className="size-4" />
                                <span>{t(activeLabelKey)}</span>
                            </SidebarMenuButton>
                        }
                    />
                    <DropdownMenuContent side="top" align="start" sideOffset={8} className="min-w-[10rem]">
                        <DropdownMenuRadioGroup
                            value={theme}
                            onValueChange={(value) => setTheme(value as Theme)}
                        >
                            {THEME_OPTIONS.map((option) => {
                                const Icon = option.icon
                                return (
                                    <DropdownMenuRadioItem key={option.value} value={option.value}>
                                        <Icon className="size-4" />
                                        <span>{t(option.labelKey)}</span>
                                    </DropdownMenuRadioItem>
                                )
                            })}
                        </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    )
}
