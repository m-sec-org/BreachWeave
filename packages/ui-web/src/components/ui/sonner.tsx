import { Toaster as Sonner } from "sonner"
import type { ToasterProps } from "sonner"
import { useTheme } from "../../hooks/use-theme"

export function Toaster(props: ToasterProps) {
    const { theme } = useTheme()

    return (
        <Sonner
            theme={theme}
            position="top-right"
            closeButton
            richColors
            {...props}
        />
    )
}
