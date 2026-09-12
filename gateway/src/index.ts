import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { handleGatewayRequest } from "./app.js";
import { loadGatewayConfig } from "./config.js";

/**
 * Firebase Functions v2 entry point.
 *
 * A single 2nd-generation HTTPS function is enough for this release: both
 * operations are bounded and non-streaming, and the request/response sizes
 * are capped by the contract. Cloud Run becomes the right runtime only if
 * streaming or a longer request budget is ever needed; `app.ts` is
 * transport-agnostic precisely so that move costs nothing.
 *
 * Spend controls are configured here rather than left to a budget alert,
 * because a budget alert is a notification and not a cap:
 *
 * - `maxInstances` is deliberately low, so a runaway client or a bug cannot
 *   fan out into an unbounded number of paid model calls.
 * - `concurrency` bounds in-flight provider calls per instance.
 * - `timeoutSeconds` is a little above the provider timeout, so a hung
 *   upstream ends as a clean failure rather than by the platform killing the
 *   instance mid-request.
 * - The per-user quota in `quota.ts` is the primary limit; the global
 *   `GATEWAY_DISABLED` kill switch is the incident control.
 */

initializeApp();

// Declared as Secret Manager parameters, not environment variables, so they
// are bound only to this function's runtime and never appear in Hosting
// assets, build arguments, client configuration, or a deploy log.
const providerApiKey = defineSecret("GATEWAY_PROVIDER_API_KEY");
const userIdHmacKey = defineSecret("USER_ID_HMAC_KEY");

export const api = onRequest(
  {
    region: "us-central1",
    secrets: [providerApiKey, userIdHmacKey],
    maxInstances: 5,
    concurrency: 20,
    timeoutSeconds: 60,
    memory: "512MiB",
    // No browser calls this service; only the desktop CLI does. Leaving CORS
    // off keeps a page on any origin from making authenticated requests with
    // a token it somehow obtained.
    cors: false
  },
  (request, response) => {
    void (async () => {
      const config = loadGatewayConfig({
        ...process.env,
        GATEWAY_PROVIDER_API_KEY: providerApiKey.value(),
        USER_ID_HMAC_KEY: userIdHmacKey.value()
      });

      const result = await handleGatewayRequest(
        {
          method: request.method,
          // Hosting rewrites and the function's own URL differ in what they
          // leave in `path`, so both are normalized to the contract's paths.
          path: request.path.replace(/^\/api/, ""),
          headers: request.headers as Record<string, string | undefined>,
          body: request.body as unknown
        },
        { config, now: () => new Date() }
      );

      for (const [name, value] of Object.entries(result.headers ?? {})) {
        response.setHeader(name, value);
      }
      // Nothing this service returns may be cached by anything in front of
      // it: responses are derived from the caller's own mail.
      response.setHeader("cache-control", "no-store");
      response.status(result.status).json(result.body);
    })().catch(() => {
      // handleGatewayRequest already maps every expected failure. Reaching
      // here means the response itself could not be produced, so the reply is
      // deliberately opaque rather than an echo of an unexpected exception.
      if (!response.headersSent) {
        response.status(500).json({ error: "The AI service failed to handle this request." });
      }
    });
  }
);
