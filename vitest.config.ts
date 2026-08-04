import { definePackageConfig } from "@browsercore/dev/vitest";

export default definePackageConfig({
    name: "@browsercore/http3",
    coverage: {
        thresholds: { statements: 94, branches: 94, functions: 94, lines: 94 },
    },
});
