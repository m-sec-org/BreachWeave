/*
定义主题的 hooks，支持系统主题、手动设置主题、自动检测主题

使用方式：
const { theme, setTheme, resolved } = useTheme()

theme: 当前主题
setTheme: 设置主题
resolved: 解析后的主题

theme 的值为 "light" | "dark" | "system"
setTheme 的值为 (next: Theme) => void
resolved 的值为 "light" | "dark"

theme 的值为 "light" 时，表示主题为亮色
theme 的值为 "dark" 时，表示主题为暗色
theme 的值为 "system" 时，表示主题为系统主题

resolved 的值为 "light" 时，表示主题为亮色
resolved 的值为 "dark" 时，表示主题为暗色
resolved 的值为 "system" 时，表示主题为系统主题

setTheme 的值为 (next: Theme) => void

-----
用户自定义配色入口
你只需编辑以下三个文件：

src/theme/tokens.light.css — 修改亮色方案
src/theme/tokens.dark.css — 修改暗色方案
src/theme/tokens.attack-flow.css — 修改攻击流图的节点、边线、画布、图表颜色

*/

import { useEffect, useState } from "react"

export type Theme = "light" | "dark" | "system"

const STORAGE_KEY = "theme"

function resolveTheme(theme: Theme): "light" | "dark" {
    if (theme === "system") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    }
    return theme
}

function applyTheme(resolved: "light" | "dark") {
    const root = document.documentElement
    if (resolved === "dark") {
        root.classList.add("dark")
    } else {
        root.classList.remove("dark")
    }
}

export function useTheme() {
    const [theme, setThemeState] = useState<Theme>(() => {
        if (typeof window === "undefined") return "system"
        return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system"
    })

    useEffect(() => {
        const resolved = resolveTheme(theme)
        applyTheme(resolved)

        if (theme !== "system") return

        const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
        function handleChange() {
            applyTheme(resolveTheme("system"))
        }
        mediaQuery.addEventListener("change", handleChange)
        return () => mediaQuery.removeEventListener("change", handleChange)
    }, [theme])

    function setTheme(next: Theme) {
        localStorage.setItem(STORAGE_KEY, next)
        setThemeState(next)
    }

    const resolved = typeof window !== "undefined" ? resolveTheme(theme) : "light"

    return { theme, setTheme, resolved } as const
}
