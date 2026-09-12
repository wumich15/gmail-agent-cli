import { createHmac, createPublicKey, createVerify, timingSafeEqual } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import type { DecodedIdToken } from "firebase-admin/auth";

/**
 * Who is calling, and under what pseudonym.
 *
 * Two different tokens appear here and they are not interchangeable:
 *
 * - Google's OIDC ID token, presented exactly once at `/v1/session/bootstrap`
 *   to prove which Google account just completed the publisher's consent. It
 *   must carry the publisher's own Desktop OAuth client as its audience;
 *   accepting any other audience would let a token minted for an unrelated
 *   app open a session here.
 * - Firebase ID tokens, presented on every AI request afterwards. They are
 *   verified by the Firebase Admin SDK against this project.
 *
 * The user is identified by a keyed hash of Google's stable `sub`, never by
 * `sub` itself and never by an email address, which is also why the CLI does
 * not request the `email` scope. Every durable record the service keeps
 * (consent receipt, quota counter, log line) is written against that
 * pseudonym, so the stored data cannot be re-identified without the HMAC key,
 * which lives only in Secret Manager.
 */

const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export class IdentityError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

export function pseudonymousUserId(googleSubject: string, hmacKey: string): string {
  return createHmac("sha256", hmacKey).update(`gmail-agent-user-v1 ${googleSubject}`).digest("hex").slice(0, 40);
}

interface GoogleJwk {
  kid?: string;
  alg?: string;
  kty?: string;
  n?: string;
  e?: string;
}

let cachedKeys: { keys: GoogleJwk[]; expiresAtMs: number } | null = null;

async function googleSigningKeys(): Promise<GoogleJwk[]> {
  if (cachedKeys && cachedKeys.expiresAtMs > Date.now()) return cachedKeys.keys;
  const response = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new IdentityError("Could not fetch Google's signing keys.", 503);
  const body = (await response.json()) as { keys?: GoogleJwk[] };
  // Google's cache-control governs how long these are valid; a short floor
  // keeps a key rotation from being cached past its usefulness.
  const maxAge = Number.parseInt(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1] ?? "3600", 10);
  cachedKeys = { keys: body.keys ?? [], expiresAtMs: Date.now() + Math.max(300, maxAge) * 1000 };
  return cachedKeys.keys;
}

export interface GoogleIdentity {
  subject: string;
  pseudonymousId: string;
}

/**
 * Verifies Google's ID token: RS256 signature against Google's published
 * keys, issuer, expiry, and the claim that actually matters here, an
 * audience equal to the publisher's own Desktop OAuth client.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  config: { googleOAuthClientId: string; userIdHmacKey: string }
): Promise<GoogleIdentity> {
  const segments = idToken.split(".");
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (segments.length !== 3 || !headerSegment || !payloadSegment || !signatureSegment) {
    throw new IdentityError("Malformed identity token.", 401);
  }

  let header: { kid?: string; alg?: string };
  let claims: { iss?: string; aud?: string; sub?: string; exp?: number; iat?: number };
  try {
    header = JSON.parse(Buffer.from(headerSegment, "base64url").toString("utf8")) as typeof header;
    claims = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as typeof claims;
  } catch {
    throw new IdentityError("Unreadable identity token.", 401);
  }
  if (header.alg !== "RS256") throw new IdentityError("Unsupported identity token algorithm.", 401);

  const key = (await googleSigningKeys()).find((candidate) => candidate.kid === header.kid);
  if (!key?.n || !key.e) throw new IdentityError("Unknown identity token signing key.", 401);

  const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
  const verified = createVerify("RSA-SHA256")
    .update(`${headerSegment}.${payloadSegment}`)
    .verify(publicKey, Buffer.from(signatureSegment, "base64url"));
  if (!verified) throw new IdentityError("Identity token signature is invalid.", 401);

  if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) throw new IdentityError("Identity token issuer is wrong.", 401);
  if (!claims.sub) throw new IdentityError("Identity token has no subject.", 401);
  if (!claims.exp || claims.exp * 1000 <= Date.now()) throw new IdentityError("Identity token has expired.", 401);
  if (!audienceMatches(claims.aud, config.googleOAuthClientId)) {
    throw new IdentityError("Identity token was issued for a different application.", 401);
  }

  return { subject: claims.sub, pseudonymousId: pseudonymousUserId(claims.sub, config.userIdHmacKey) };
}

function audienceMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verifies a Firebase ID token and returns the pseudonymous ID it was minted for. */
export async function verifyFirebaseIdToken(idToken: string): Promise<{ userId: string; claims: DecodedIdToken }> {
  try {
    // `checkRevoked: true` makes a revoked session stop working on the next
    // request rather than whenever its hour-long token happens to expire,
    // which is what makes "block this user" an operational control instead of
    // an eventual one.
    const decoded = await getAuth().verifyIdToken(idToken, true);
    return { userId: decoded.uid, claims: decoded };
  } catch {
    throw new IdentityError("This session is not valid. Run `gmail setup` to reconnect it.", 401);
  }
}

/** Extracts a bearer token from an Authorization header. */
export function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!match?.[1]) throw new IdentityError("Missing bearer token.", 401);
  return match[1];
}
