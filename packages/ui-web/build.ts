import tailwind from "bun-plugin-tailwind"

const result = await Bun.build({
    entrypoints: ["./src/server.ts"],
    outdir: "./dist",
    target: "bun",
    plugins: [tailwind],
    minify: true,
})

if (!result.success) {
    for (const log of result.logs) {
        console.error(log)
    }
    process.exit(1)
}
