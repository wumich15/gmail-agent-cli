/*
 * The only script on this site.
 *
 * It does three things and nothing else: read the port and one-time state the
 * CLI put in the URL fragment, gate the hosted-AI button behind the consent
 * checkbox, and hand the user's choice back to the CLI's own loopback
 * listener.
 *
 * Design rules this file exists to keep:
 *
 * - The port and state arrive in the fragment, never a query string, so they
 *   are not sent to Firebase Hosting, do not land in a server log, and are
 *   not attached to a referrer. They are read once into memory and the
 *   fragment is removed from the visible URL immediately.
 * - The page never accepts a callback URL from anywhere. The destination is
 *   built here from a fixed scheme, a fixed host, a fixed path, and a port
 *   that must be a plain number in range. A page that accepted a URL would be
 *   an open redirect attached to a Google sign-in.
 * - No authorization code, token, or PKCE value ever touches this page; the
 *   CLI keeps all of them.
 * - There is no fetch, no storage, no cookie, and no analytics.
 */

(function () {
  "use strict";

  var LOOPBACK_HOST = "127.0.0.1";
  var BEGIN_PATH = "/begin";

  var ready = document.getElementById("ready");
  var noSession = document.getElementById("no-session");
  var consent = document.getElementById("consent");
  var hostedButton = document.getElementById("connect-hosted");
  var rulesButton = document.getElementById("connect-rules");
  var status = document.getElementById("status");

  function readSession() {
    var fragment = window.location.hash.replace(/^#/, "");
    if (!fragment) return null;
    var params = new URLSearchParams(fragment);
    var port = params.get("port");
    var state = params.get("state");
    // Strict: a port is a plain number in the unprivileged range, and the
    // state is the opaque base64url value the CLI generated. Anything else is
    // treated as no session at all rather than being coerced into one.
    if (!port || !/^\d{1,5}$/.test(port)) return null;
    var portNumber = Number(port);
    if (portNumber < 1024 || portNumber > 65535) return null;
    if (!state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
    return { port: portNumber, state: state };
  }

  var session = readSession();

  // Remove the fragment from the visible URL as soon as it has been read, so
  // a shared screenshot or a copied address cannot carry the one-time state.
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  if (!session) {
    noSession.hidden = false;
    ready.hidden = true;
    return;
  }

  noSession.hidden = true;
  ready.hidden = false;

  consent.addEventListener("change", function () {
    hostedButton.disabled = !consent.checked;
  });

  function begin(mode) {
    // Both buttons are disabled before navigating: a double click would
    // otherwise send a second /begin, which the CLI refuses as a replay and
    // which would only show the user an error they did not cause.
    hostedButton.disabled = true;
    rulesButton.disabled = true;
    status.textContent = "Opening Google…";
    var url =
      "http://" +
      LOOPBACK_HOST +
      ":" +
      session.port +
      BEGIN_PATH +
      "?state=" +
      encodeURIComponent(session.state) +
      "&mode=" +
      encodeURIComponent(mode);
    window.location.href = url;
  }

  hostedButton.addEventListener("click", function () {
    if (!consent.checked) return;
    begin("hosted-ai");
  });

  rulesButton.addEventListener("click", function () {
    begin("rules-only");
  });
})();
