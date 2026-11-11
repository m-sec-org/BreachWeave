export type LifecycleEventName = "state_transition" | "stale_decision" | "pending_effect" | "source_inclusion" | "board_freshness" | "budget_compliance" | "report_phase" | "export_gap"

export interface LifecycleTelemetryEvent { name: LifecycleEventName; at: string; operation?: string; status?: string; dimensions: Readonly<Record<string, string | number | boolean>> }
export interface LifecycleMetric { name: string; value: number; denominator?: number; profile: string; dimensions: Readonly<Record<string, string | number | boolean>> }

/** Telemetry 仅记录，不参与生命周期判定。 */
export class LifecycleTelemetry {
    private readonly eventsValue: LifecycleTelemetryEvent[] = []
    private readonly metricsValue: LifecycleMetric[] = []
    event(input: Omit<LifecycleTelemetryEvent, "at"> & { at?: string }): LifecycleTelemetryEvent { const event = { ...input, at: input.at ?? new Date().toISOString() }; this.eventsValue.push(event); return structuredClone(event) }
    metric(input: LifecycleMetric): LifecycleMetric { if (!Number.isFinite(input.value) || input.value < 0 || (input.denominator !== undefined && (!Number.isFinite(input.denominator) || input.denominator < 0))) throw new Error("生命周期 metric 数值无效"); this.metricsValue.push(structuredClone(input)); return structuredClone(input) }
    snapshot(): { events: readonly LifecycleTelemetryEvent[]; metrics: readonly LifecycleMetric[]; exportGap: boolean } { return { events: structuredClone(this.eventsValue), metrics: structuredClone(this.metricsValue), exportGap: this.eventsValue.some((event) => event.name === "export_gap") } }
}
