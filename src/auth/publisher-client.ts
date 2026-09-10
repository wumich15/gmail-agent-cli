/**
 * The publisher-managed Google OAuth *installed-app* client shipped with a
 * release build, so a user only has to press "Connect Gmail" — they never
 * create a Cloud project, enable APIs, or download a credentials file.
 *
 * An installed-app client secret is not confidential. Google says so
 * directly for the native-app flow, which is why this flow additionally
 * requires PKCE S256, a random `state`, and a loopback redirect that only
 * this machine can receive (see `google-oauth.ts`). Publishing these values
 * in the package is therefore expected, not a leak — but it also means the
 * client identity must never be treated as a security boundary, and every
 * real authorization decision stays with Google's consent screen and the
 * user's own account.
 *
 * These are empty in the source tree on purpose: the repository has no
 * publisher Cloud project yet (project ownership, the verified domain, the
 * privacy policy, and the restricted-scope security assessment are all
 * still open decisions). A release build fills them in — and until it does,
 * `resolveOAuthClientCredentials` falls back to the developer environment
 * variables and says exactly that when neither is available, rather than
 * pretending a consumer sign-in path exists.
 */
export const PUBLISHER_OAUTH_CLIENT_ID = "";
export const PUBLISHER_OAUTH_CLIENT_SECRET = "";

export function publisherOAuthClientConfigured(): boolean {
  return PUBLISHER_OAUTH_CLIENT_ID.length > 0 && PUBLISHER_OAUTH_CLIENT_SECRET.length > 0;
}
