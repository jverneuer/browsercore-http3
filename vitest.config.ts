import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        name: "@browsercore/http3",
        root: ".",
        include: ["tests/**/*.test.ts"],
        environment: "node",
        globals: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            reporter: ["text", "html", "json-summary"],
            thresholds: { statements: 94, branches: 93, functions: 94, lines: 94 },
            exclude: [
                "**/index.ts",
                "tests/**",
                "node_modules/**",
            ],
        },
    },
});
