// @ts-check
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "gateway/lib/**", "gateway/node_modules/**"]
  },
  {
    files: ["**/*.ts"],
    ignores: ["gateway/**"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      // Type-aware checks. A dropped promise here means a Gmail mutation
      // whose failure nobody ever sees, so these are errors, not warnings.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  },
  {
    // The gateway is a separate deployable with its own tsconfig (it compiles
    // a few shared `src/ai` files alongside its own sources). It gets the same
    // rules, pointed at that project, rather than being excluded from linting.
    files: ["gateway/src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./gateway/tsconfig.json"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  }
];
