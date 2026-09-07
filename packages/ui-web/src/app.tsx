import { Component, useEffect, useState } from "react"
import type { ReactNode } from "react"
import {
    ChevronRightIcon,
    LogOutIcon,
    XIcon,
    SettingsIcon,
    UserIcon,
} from "lucide-react"
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarMenuSub,
    SidebarMenuSubItem,
    SidebarMenuSubButton,
    SidebarProvider,
    SidebarInset,
    SidebarTrigger,
    SidebarFooter,
} from "./components/ui/sidebar"
import { Separator } from "./components/ui/separator"
import { Toaster } from "./components/ui/sonner"
import { ConfigPage } from "./components/config/page"
import { ChallengePage } from "./components/challenge/page"
import { AttackFlowPage } from "./components/challenge/attack-flow"
import { RuntimeShell } from "./components/runtime/shell"
import { ThemeToggle } from "./components/theme-toggle"
import { configTabs, mainNavItems } from "./data/app-nav"
import { Button } from "./components/ui/button"
import { AuthPage } from "./components/auth/page"
import { auth, clearAuthToken, getAuthToken } from "./lib/api"
import type { AuthResult, AuthUser } from "./lib/api"

function useHash() {
    const [hash, setHash] = useState(location.hash || "#/")
    useEffect(() => {
        const onHash = () => setHash(location.hash || "#/")
        window.addEventListener("hashchange", onHash)
        return () => window.removeEventListener("hashchange", onHash)
    }, [])
    return hash
}

function BreachWeaveLogoIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true" className={className}>
            <path d="M615.8336 384H412.16A53.7088 53.7088 0 0 1 358.4 330.3424V126.6688a53.7088 53.7088 0 0 1 53.76-53.6064h203.6736a53.7088 53.7088 0 0 1 53.6064 53.6064v203.6736A53.7088 53.7088 0 0 1 615.8336 384zM414.72 327.68h198.2464V129.3824H414.72zM271.0528 870.4h-194.56a58.0096 58.0096 0 0 1-50.2272-87.04l97.28-168.96a57.9584 57.9584 0 0 1 100.4032 0l97.28 168.96a58.0096 58.0096 0 0 1-50.2272 87.04z m-97.28-228.4032a1.3824 1.3824 0 0 0-1.4336 0.8192l-97.28 168.96a1.3312 1.3312 0 0 0 0 1.6896 1.4336 1.4336 0 0 0 1.4336 0.8192h194.56a1.4336 1.4336 0 0 0 1.4336-0.8192 1.3312 1.3312 0 0 0 0-1.6896l-97.28-168.96a1.4848 1.4848 0 0 0-1.536-1.024zM855.7568 883.3024a155.4944 155.4944 0 1 1 155.4432-155.4432 155.648 155.648 0 0 1-155.4432 155.4432z m0-254.6176a99.1744 99.1744 0 1 0 99.1232 99.1744 99.2256 99.2256 0 0 0-99.1232-99.1744zM515.7376 957.0816a388.1472 388.1472 0 0 1-152.7296-31.488 28.16 28.16 0 1 1 22.1184-51.8144 328.2944 328.2944 0 0 0 288.768-13.824 28.16 28.16 0 0 1 27.0848 49.408 384.9728 384.9728 0 0 1-185.2416 47.7184zM867.072 528.0256A28.16 28.16 0 0 1 839.68 505.344a331.6736 331.6736 0 0 0-97.792-176.0256 28.16 28.16 0 0 1 38.656-40.96 390.656 390.656 0 0 1 54.784 64.4096 383.5904 383.5904 0 0 1 59.392 141.6192 28.1088 28.1088 0 0 1-22.1184 33.1264 28.928 28.928 0 0 1-5.5296 0.512zM160.512 546.048a28.2112 28.2112 0 0 1-27.904-32.256A385.9456 385.9456 0 0 1 263.936 275.968a28.16 28.16 0 1 1 36.5568 42.8544A329.9328 329.9328 0 0 0 188.3136 522.24a28.1088 28.1088 0 0 1-27.8016 23.808z" />
        </svg>
    )
}

function getErrorMessage(error: unknown) {
    if (error instanceof Error) return error.message
    if (typeof error === "object" && error !== null) {
        const record = error as Record<string, unknown>
        if (typeof record.error === "string") return record.error
        if (typeof record.message === "string") return record.message
    }
    return String(error)
}

function errorMessages(error: unknown, seen = new Set<unknown>()): string[] {
    if (error === undefined || error === null) return []
    if (seen.has(error)) return []
    seen.add(error)

    if (error instanceof Error) return [error.message, error.name]
    if (typeof error === "string") return [error]
    if (typeof error !== "object") return [String(error)]

    const record = error as Record<string, unknown>
    return [
        typeof record.error === "string" ? record.error : undefined,
        typeof record.message === "string" ? record.message : undefined,
        ...errorMessages(record.error, seen),
        ...errorMessages(record.message, seen),
        ...errorMessages(record.reason, seen),
    ].filter((message): message is string => Boolean(message))
}

function isIgnoredGlobalUiError(error: unknown) {
    return errorMessages(error).some((message) =>
        message.includes("ResizeObserver loop completed with undelivered notifications") ||
        message.includes("ResizeObserver loop limit exceeded"),
    )
}

function useGlobalUiError() {
    const [error, setError] = useState("")

    useEffect(() => {
        function handleRejection(event: PromiseRejectionEvent) {
            if (isIgnoredGlobalUiError(event.reason)) {
                event.preventDefault()
                return
            }
            event.preventDefault()
            setError(getErrorMessage(event.reason))
        }

        function handleError(event: ErrorEvent) {
            if (isIgnoredGlobalUiError(event.error ?? event.message)) {
                event.preventDefault()
                event.stopImmediatePropagation()
                return
            }
            event.preventDefault()
            setError(event.error ? getErrorMessage(event.error) : event.message)
        }

        window.addEventListener("unhandledrejection", handleRejection, true)
        window.addEventListener("error", handleError, true)
        return () => {
            window.removeEventListener("unhandledrejection", handleRejection, true)
            window.removeEventListener("error", handleError, true)
        }
    }, [])

    return { error, clearError: () => setError("") }
}

interface AppErrorBoundaryProps {
    children: ReactNode
}

interface AppErrorBoundaryState {
    error: string
}

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { error: "" }

    static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
        return { error: getErrorMessage(error) }
    }

    render() {
        if (this.state.error) {
            return (
                <div className="flex flex-1 items-start justify-center p-6">
                    <div className="w-full max-w-2xl rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">
                        {this.state.error}
                    </div>
                </div>
            )
        }
        return this.props.children
    }
}

function Router() {
    const hash = useHash()
    const attackFlowMatch = hash.match(/^#\/challenge\/([^/?]+)\/attack-flow(?:\?(.*))?$/)
    const challengeMatch = hash.match(/^#\/challenge\/([^/]+)$/)
    if (hash === "#/runtime" || hash.startsWith("#/runtime/")) return <RuntimeShell />
    if (attackFlowMatch) return <AttackFlowPage challengeId={decodeURIComponent(attackFlowMatch[1])} initialSearch={attackFlowMatch[2] ?? ""} />
    if (challengeMatch) return <ChallengePage challengeId={decodeURIComponent(challengeMatch[1])} />
    if (hash.startsWith("#/config/")) {
        const tab = hash.replace("#/config/", "")
        return <ConfigPage activeTab={tab} />
    }
    if (hash === "#/config") return <ConfigPage activeTab="providers" />
    return <ChallengePage />
}

function getPageTitle(hash: string): string {
    if (hash === "#/login") return "Login"
    if (hash === "#/register") return "Register"
    if (hash === "#/" || hash === "#/challenge") return "项目"
    if (hash.startsWith("#/challenge/") && hash.endsWith("/attack-flow")) return "项目 · Attack Flow"
    if (hash.startsWith("#/challenge/")) return "项目"
    if (hash === "#/runtime") return "Runtime"
    if (hash.startsWith("#/runtime/")) return "Runtime · Solver"
    if (hash.startsWith("#/config")) {
        const tab = hash.replace("#/config/", "")
        const found = configTabs.find((t) => t.value === tab)
        return found ? `Config · ${found.label}` : "Configuration"
    }
    return "项目"
}

export function App() {
    const hash = useHash()
    const isConfigOpen = hash.startsWith("#/config")
    const isAttackFlowRoute = /^#\/challenge\/[^/]+\/attack-flow(?:\?.*)?$/.test(hash)
    const { error, clearError } = useGlobalUiError()
    const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
    const [authLoading, setAuthLoading] = useState(true)

    useEffect(() => {
        let active = true
        const token = getAuthToken()
        if (!token) {
            setAuthLoading(false)
            return
        }
        auth.me()
            .then(({ user }) => {
                if (active) setCurrentUser(user)
            })
            .catch(() => {
                clearAuthToken()
                if (active) setCurrentUser(null)
            })
            .finally(() => {
                if (active) setAuthLoading(false)
            })
        return () => {
            active = false
        }
    }, [])

    useEffect(() => {
        if (!currentUser) return
        if (hash === "#/login" || hash === "#/register") {
            location.hash = "#/"
        }
    }, [currentUser, hash])

    function handleAuthenticated(result: AuthResult) {
        setCurrentUser(result.user)
        if (hash === "#/login" || hash === "#/register") {
            location.hash = "#/"
        }
    }

    function handleLogout() {
        clearAuthToken()
        setCurrentUser(null)
        location.hash = "#/login"
    }

    let content: ReactNode

    if (authLoading) {
        content = (
            <main className="flex min-h-screen items-center justify-center bg-background [background:var(--gradient-hero)] p-6">
                <div className="flex items-center gap-3 rounded-xl border border-border bg-card/80 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur">
                    <BreachWeaveLogoIcon className="size-4 text-primary" />
                    正在验证登录状态...
                </div>
            </main>
        )
    } else if (!currentUser) {
        content = <AuthPage mode={hash === "#/register" ? "register" : "login"} onAuthenticated={handleAuthenticated} />
    } else {
        content = (
            <SidebarProvider>
                {error && (
                    <div className="fixed top-4 left-1/2 z-50 flex w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-background/95 px-4 py-3 text-sm text-red-500 shadow-lg backdrop-blur">
                        <span className="min-w-0 flex-1 break-words">{error}</span>
                        <button type="button" onClick={clearError} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
                            <XIcon className="size-4" />
                        </button>
                    </div>
                )}
                <Sidebar>
                    <SidebarContent>
                        <SidebarGroup>
                            <SidebarGroupLabel className="gap-2">
                                <BreachWeaveLogoIcon className="size-4" />
                                BreachWeave
                            </SidebarGroupLabel>
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {/* Main nav items */}
                                    {mainNavItems.map((item) => (
                                        <SidebarMenuItem key={item.hash}>
                                            <SidebarMenuButton render={<a href={item.hash} />} isActive={hash === item.hash}>
                                                <item.icon className="size-4" />
                                                <span>{item.title}</span>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    ))}

                                    {/* Config section with sub-items */}
                                    <SidebarMenuItem>
                                        <SidebarMenuButton render={<a href="#/config/providers" />} isActive={isConfigOpen}>
                                            <SettingsIcon className="size-4" />
                                            <span>Config</span>
                                            <ChevronRightIcon className={`ml-auto size-4 transition-transform ${isConfigOpen ? "rotate-90" : ""}`} />
                                        </SidebarMenuButton>
                                        {isConfigOpen && (
                                            <SidebarMenuSub>
                                                {configTabs.map((tab) => (
                                                    <SidebarMenuSubItem key={tab.value}>
                                                        <SidebarMenuSubButton render={<a href={`#/config/${tab.value}`} />} isActive={hash === `#/config/${tab.value}`}>
                                                            <tab.icon className="size-3.5" />
                                                            <span>{tab.label}</span>
                                                        </SidebarMenuSubButton>
                                                    </SidebarMenuSubItem>
                                                ))}
                                            </SidebarMenuSub>
                                        )}
                                    </SidebarMenuItem>
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </SidebarContent>

                    <SidebarFooter>
                        <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-2">
                            <div className="flex min-w-0 items-center gap-2">
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                                    <UserIcon className="size-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium">{currentUser.username}</div>
                                    <div className="truncate text-xs text-muted-foreground">Authenticated</div>
                                </div>
                                <Button type="button" variant="ghost" size="icon-sm" onClick={handleLogout} aria-label="退出登录">
                                    <LogOutIcon />
                                </Button>
                            </div>
                        </div>
                        <ThemeToggle />
                    </SidebarFooter>
                </Sidebar>
                <SidebarInset className="h-screen min-h-0 min-w-0 overflow-hidden">
                    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                        <SidebarTrigger />
                        <Separator orientation="vertical" className="h-4" />
                        <span className="text-sm font-medium">{getPageTitle(hash)}</span>
                    </header>
                    <div data-app-content-fullscreen-root className={isAttackFlowRoute ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "min-h-0 min-w-0 flex-1 overflow-auto"}>
                        <AppErrorBoundary>
                            <Router />
                        </AppErrorBoundary>
                    </div>
                </SidebarInset>
            </SidebarProvider>
        )
    }

    return (
        <>
            {content}
            <Toaster />
        </>
    )
}
