import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuth2Client } from "google-auth-library";
import { sendGmailMessagesBatch } from "../../src/gmail/batch.js";

/**
 * Real, non-faked coverage of CLAUDE.md's explicit gate: "Gzip request
 * headers and decompression are verified for both individual and batch
 * transports." The individual-call path already gets `Accept-Encoding:
 * gzip` and gzip decompression for free from `googleapis-common`'s gaxios
 * wrapper (unmodified, existing code) — this test proves the same holds for
 * this session's new custom batch transport, which bypasses that wrapper
 * and (per `batch.ts`'s doc comment) must set the headers and get the
 * decompression itself. A real local HTTP server and real gzip compression
 * are used deliberately instead of a fake, since the property under test is
 * "does the actual network/decompression pipeline work," not "does our code
 * call the right functions."
 */
describe("gzip end-to-end through the batch transport", () => {
  let server: Server;
  let baseUrl: string;
  let receivedHeaders: Record<string, string | string[] | undefined> = {};

  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        receivedHeaders = req.headers;
        const boundary = "server_boundary_1";
        const bodyText =
          `--${boundary}\r\n` +
          `Content-Type: application/http\r\n` +
          `Content-ID: <response-m1>\r\n\r\n` +
          `HTTP/1.1 200 OK\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify({ id: "m1", snippet: "hello from gzip" })}\r\n` +
          `--${boundary}--`;
        const gzipped = gzipSync(Buffer.from(bodyText, "utf-8"));
        res.writeHead(200, {
          "Content-Type": `multipart/mixed; boundary=${boundary}`,
          "Content-Encoding": "gzip",
          "Content-Length": String(gzipped.length)
        });
        res.end(gzipped);
      });
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends Accept-Encoding: gzip and a gzip-tagged User-Agent, and transparently decompresses a real gzip response", async () => {
    const oauthClient = new OAuth2Client();
    oauthClient.setCredentials({ access_token: "test-access-token" });

    const result = await sendGmailMessagesBatch(oauthClient, ["m1"], {
      fields: "id,snippet",
      batchUrl: baseUrl
    });

    expect(result.succeeded.get("m1")).toEqual({ id: "m1", snippet: "hello from gzip" });
    expect(String(receivedHeaders["accept-encoding"])).toContain("gzip");
    expect(String(receivedHeaders["user-agent"])).toContain("(gzip)");
    expect(String(receivedHeaders["authorization"])).toBe("Bearer test-access-token");
  });
});
