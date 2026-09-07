import type { CustomProvider } from "./types"

// 从 providers/ 目录下的各文件导入自定义 provider
import zhipuai from "./zhipuai"

/** 所有自定义 provider 定义 */
export const customProviders: CustomProvider[] = [zhipuai]
