import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import type { ComponentProps } from "react"
import { cn } from "../../lib/utils"

function Slider({ className, ...props }: ComponentProps<typeof SliderPrimitive.Root>) {
    return (
        <SliderPrimitive.Root
            data-slot="slider"
            className={cn("group/slider relative flex w-full touch-none items-center py-1 select-none", className)}
            {...props}
        >
            <SliderPrimitive.Control className="relative flex w-full items-center">
                <SliderPrimitive.Track className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-primary" />
                </SliderPrimitive.Track>
                <SliderPrimitive.Thumb className="block size-4 rounded-full border border-border bg-background shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50" />
            </SliderPrimitive.Control>
        </SliderPrimitive.Root>
    )
}

export { Slider }
