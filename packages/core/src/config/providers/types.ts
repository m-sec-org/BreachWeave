import type { ProviderConfig } from "@mariozechner/pi-coding-agent"
import type { Model, Api } from "@mariozechner/pi-ai"

/** 自定义 provider 注册项 */
export interface CustomProvider {
    name: string
    config: ProviderConfig
}

/** models.json 中单个模型定义——从 SDK Model<Api> 派生，id 必填其余可选 */
export type ModelDefinition = Pick<Model<Api>, "id"> & Partial<Omit<Model<Api>, "id" | "provider" | "api" | "baseUrl">>

export type ModelConfigEntry = {
    id: string
    hash?: string
    provider: string
    providerId?: string
    modelId: string
    thinkingLevel?: string
} & Partial<Omit<Model<Api>, "id" | "provider" | "api" | "baseUrl">>

export interface ProviderPrefEntry {
    id: string
    hash?: string
    name: string
    api?: string
    baseUrl?: string
    apiKey?: string
}

export interface BuiltInProvider {
    provider: string
    apis: string[]
    baseUrls: string[]
    modelCount: number
}

export interface ConfiguredModel {
    provider: string
    providerId?: string
    runtimeProvider?: string
    id: string
    name?: string
    api?: string
    baseUrl?: string
    [key: string]: unknown
}
