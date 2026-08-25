import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: rootDirectory });

const config = [
  {
    ignores: [
      ".agents/**",
      ".codex/**",
      ".data/**",
      ".next*/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts"
    ]
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ]
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    // Domain entities are intentionally named `module`; TypeScript ESM files do
    // not expose Node's mutable CommonJS `module` global targeted by this rule.
    rules: { "@next/next/no-assign-module-variable": "off" }
  }
];

export default config;
