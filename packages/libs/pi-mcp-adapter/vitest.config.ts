import { defineConfig } from "vitest/config.js"

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["__tests__/**/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["*.ts"],
            exclude: ["__tests__/**", "vitest.config.ts", "cli.js"],
        },
    },
})
