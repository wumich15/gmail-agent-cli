import { runScenarios } from "../helpers/scenarios.js";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/logging/logger.js";

describe("redactSecrets", () => {
  it("preserves all 7 scenarios", async () => {
    await runScenarios([
      { name: "redacts a Bearer token", run: () => {
        expect(redactSecrets("Authorization: Bearer abc123XYZ.def")).not.toContain("abc123XYZ");
      } },
      { name: "redacts an OpenAI-style API key", run: () => {
        expect(redactSecrets("failed with key sk-abcdefghijklmnopqrstuvwxyz")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      } },
      { name: "redacts a Google OAuth access token (ya29.)", run: () => {
        expect(redactSecrets("token=ya29.a0AfH6SMC-example-token-value")).not.toContain("ya29.a0AfH6SMC");
      } },
      { name: "redacts a Google OAuth refresh token (1//)", run: () => {
        expect(redactSecrets("refresh_token: 1//0abcdefghijklmnop")).not.toContain("1//0abcdefghijklmnop");
      } },
      { name: "redacts a refresh_token=... query-style parameter", run: () => {
        expect(redactSecrets("url had refresh_token=SuperSecretValue123 in it")).not.toContain("SuperSecretValue123");
      } },
      { name: "redacts a literal Authorization: header line", run: () => {
        expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
      } },
      { name: "leaves ordinary error text untouched", run: () => {
        const message = "Gmail API returned 404 for message id abc123";
        expect(redactSecrets(message)).toBe(message);
      } }
    ]);
  });
});
