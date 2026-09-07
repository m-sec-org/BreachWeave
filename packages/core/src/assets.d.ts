declare module "*.md" {
    const content: string
    export default content
}

declare module "*.txt" {
    const content: string
    export default content
}

declare module "*.sh" {
    const content: string
    export default content
}

declare module "*.json" {
    const content: string
    export default content
}

declare module "*/Dockerfile" {
    const path: string
    export default path
}

declare module "*/tch-headless-linux-amd64" {
    const path: string
    export default path
}

declare module "*/tch-agent-linux-x64" {
    const path: string
    export default path
}

declare module "*/tch-headless" {
    const path: string
    export default path
}
