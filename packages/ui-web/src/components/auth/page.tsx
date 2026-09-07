import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { auth, setAuthToken } from "../../lib/api"
import type { AuthResult } from "../../lib/api"
import { Input } from "../ui/input"
import { Label } from "../ui/label"

interface AuthPageProps {
    mode: "login" | "register"
    onAuthenticated: (result: AuthResult) => void
}

function resolveErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function AuthPage({ mode, onAuthenticated }: AuthPageProps) {
    const isRegister = mode === "register"
    const [username, setUsername] = useState("")
    const [password, setPassword] = useState("")
    const [confirmPassword, setConfirmPassword] = useState("")
    const [registrationEnabled, setRegistrationEnabled] = useState(true)
    const [loadingSettings, setLoadingSettings] = useState(isRegister)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState("")

    useEffect(() => {
        if (!isRegister) return
        let active = true
        setLoadingSettings(true)
        auth.settings()
            .then((settings) => {
                if (active) setRegistrationEnabled(settings.registrationEnabled)
            })
            .catch(() => {
                if (active) setRegistrationEnabled(false)
            })
            .finally(() => {
                if (active) setLoadingSettings(false)
            })
        return () => {
            active = false
        }
    }, [isRegister])

    async function handleSubmit(event: FormEvent) {
        event.preventDefault()
        setError("")
        const normalizedUsername = username.trim()
        if (!normalizedUsername) {
            setError("请输入用户名")
            return
        }
        if (password.length < 8) {
            setError("密码至少需要 8 个字符")
            return
        }
        if (isRegister && password !== confirmPassword) {
            setError("两次输入的密码不一致")
            return
        }
        if (isRegister && !registrationEnabled) {
            setError("当前实例已关闭开放注册")
            return
        }

        setSubmitting(true)
        try {
            const result = isRegister ? await auth.register(normalizedUsername, password) : await auth.login(normalizedUsername, password)
            setAuthToken(result.token)
            onAuthenticated(result)
        } catch (submitError) {
            setError(resolveErrorMessage(submitError))
        } finally {
            setSubmitting(false)
        }
    }

    const submitDisabled = submitting || loadingSettings || (isRegister && !registrationEnabled)

    return (
        <main className="flex min-h-screen items-center justify-center overflow-auto bg-white px-6 py-8 text-gray-800">
            <div className="w-full max-w-[560px]">
                <div className="mb-8 flex justify-center">
                    <AuthLogo />
                </div>

                <div className="rounded-xl border border-gray-200 bg-white px-7 py-9 shadow-[0_2px_8px_rgba(0,0,0,0.12)] sm:px-12 sm:py-11">
                    <h1 className="mb-8 text-center text-[34px] font-bold tracking-tight text-gray-800 sm:text-[40px]">
                        {isRegister ? "创建账户" : "BreachWeave"}
                    </h1>

                    <form onSubmit={handleSubmit} className="space-y-5">
                        <FormItem
                            id="auth-username"
                            label="登录"
                            placeholder="输入用户名"
                            value={username}
                            onChange={setUsername}
                            autoComplete="username"
                            disabled={submitting}
                        />

                        <FormItem
                            id="auth-password"
                            label="密码"
                            placeholder="输入密码"
                            type="password"
                            value={password}
                            onChange={setPassword}
                            autoComplete={isRegister ? "new-password" : "current-password"}
                            disabled={submitting}
                        />

                        {isRegister ? (
                            <FormItem
                                id="auth-confirm-password"
                                label="确认密码"
                                placeholder="再次输入密码"
                                type="password"
                                value={confirmPassword}
                                onChange={setConfirmPassword}
                                autoComplete="new-password"
                                disabled={submitting || !registrationEnabled}
                            />
                        ) : null}

                        {isRegister && !loadingSettings && !registrationEnabled ? (
                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                                当前实例已关闭开放注册，请联系管理员开启 `tch.auth.registrationEnabled`。
                            </div>
                        ) : null}

                        {error ? (
                            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                                {error}
                            </div>
                        ) : null}

                        <button
                            type="submit"
                            disabled={submitDisabled}
                            className="mt-4 h-12 w-full rounded-lg bg-[#082567] text-lg font-medium text-white transition hover:bg-[#061d52] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {submitting ? (isRegister ? "创建中..." : "登录中...") : isRegister ? "创建账户" : "登录"}
                        </button>
                    </form>

                    <div className="mt-6 text-center text-base text-gray-600">
                        {isRegister ? "已有账户？" : "还没有账户？"}
                        <a className="ml-1 font-medium text-[#082567] transition hover:text-[#061d52]" href={isRegister ? "#/login" : "#/register"}>
                            {isRegister ? "去登录" : "创建账户"}
                        </a>
                    </div>
                </div>
            </div>
        </main>
    )
}

interface FormItemProps {
    id: string
    label: string
    placeholder: string
    value: string
    onChange: (value: string) => void
    type?: string
    autoComplete?: string
    disabled?: boolean
}

function FormItem({ id, label, placeholder, value, onChange, type = "text", autoComplete, disabled }: FormItemProps) {
    return (
        <div>
            <Label htmlFor={id} className="mb-2.5 block text-base font-medium text-gray-800">
                {label}
            </Label>
            <Input
                id={id}
                type={type}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                autoComplete={autoComplete}
                placeholder={placeholder}
                disabled={disabled}
                className="h-12 w-full rounded-lg border-gray-300 px-4 text-base text-gray-700 placeholder:text-gray-400 focus-visible:border-blue-900 focus-visible:ring-1 focus-visible:ring-blue-900"
            />
        </div>
    )
}

function AuthLogo() {
    return (
        <svg width="76" height="76" viewBox="0 0 1024 1024" fill="currentColor" aria-hidden="true" className="text-black">
            <path d="M615.8336 384H412.16A53.7088 53.7088 0 0 1 358.4 330.3424V126.6688a53.7088 53.7088 0 0 1 53.76-53.6064h203.6736a53.7088 53.7088 0 0 1 53.6064 53.6064v203.6736A53.7088 53.7088 0 0 1 615.8336 384zM414.72 327.68h198.2464V129.3824H414.72zM271.0528 870.4h-194.56a58.0096 58.0096 0 0 1-50.2272-87.04l97.28-168.96a57.9584 57.9584 0 0 1 100.4032 0l97.28 168.96a58.0096 58.0096 0 0 1-50.2272 87.04z m-97.28-228.4032a1.3824 1.3824 0 0 0-1.4336 0.8192l-97.28 168.96a1.3312 1.3312 0 0 0 0 1.6896 1.4336 1.4336 0 0 0 1.4336 0.8192h194.56a1.4336 1.4336 0 0 0 1.4336-0.8192 1.3312 1.3312 0 0 0 0-1.6896l-97.28-168.96a1.4848 1.4848 0 0 0-1.536-1.024zM855.7568 883.3024a155.4944 155.4944 0 1 1 155.4432-155.4432 155.648 155.648 0 0 1-155.4432 155.4432z m0-254.6176a99.1744 99.1744 0 1 0 99.1232 99.1744 99.2256 99.2256 0 0 0-99.1232-99.1744zM515.7376 957.0816a388.1472 388.1472 0 0 1-152.7296-31.488 28.16 28.16 0 1 1 22.1184-51.8144 328.2944 328.2944 0 0 0 288.768-13.824 28.16 28.16 0 0 1 27.0848 49.408 384.9728 384.9728 0 0 1-185.2416 47.7184zM867.072 528.0256A28.16 28.16 0 0 1 839.68 505.344a331.6736 331.6736 0 0 0-97.792-176.0256 28.16 28.16 0 0 1 38.656-40.96 390.656 390.656 0 0 1 54.784 64.4096 383.5904 383.5904 0 0 1 59.392 141.6192 28.1088 28.1088 0 0 1-22.1184 33.1264 28.928 28.928 0 0 1-5.5296 0.512zM160.512 546.048a28.2112 28.2112 0 0 1-27.904-32.256A385.9456 385.9456 0 0 1 263.936 275.968a28.16 28.16 0 1 1 36.5568 42.8544A329.9328 329.9328 0 0 0 188.3136 522.24a28.1088 28.1088 0 0 1-27.8016 23.808z" />
        </svg>
    )
}
