import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/logging/logger.js";

describe("redactSecrets", () => {
  it("redacts a Bearer token", () => {
    expect(redactSecrets("Authorization: Bearer abc123XYZ.def")).not.toContain("abc123XYZ");
  });

  it("redacts an OpenAI-style API key", () => {
    expect(redactSecrets("failed with key sk-abcdefghijklmnopqrstuvwxyz")).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz"
    );
  });

  it("redacts a Google OAuth access token (ya29.)", () => {
    expect(redactSecrets("token=ya29.a0AfH6SMC-example-token-value")).not.toContain("ya29.a0AfH6SMC");
  });

  it("redacts a Google OAuth refresh token (1//)", () => {
    expect(redactSecrets("refresh_token: 1//0abcdefghijklmnop")).not.toContain("1//0abcdefghijklmnop");
  });

  it("redacts a refresh_token=... query-style parameter", () => {
    expect(redactSecrets("url had refresh_token=SuperSecretValue123 in it")).not.toContain("SuperSecretValue123");
  });

  it("redacts a literal Authorization: header line", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
  });

  it("leaves ordinary error text untouched", () => {
    const message = "Gmail API returned 404 for message id abc123";
    expect(redactSecrets(message)).toBe(message);
  });
});
