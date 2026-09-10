/**
 * The three-view front-end, as plain HTML, CSS, and JavaScript.
 *
 * They are TypeScript string constants rather than files on disk so that
 * `tsc` alone produces a complete, publishable build — no asset-copy step,
 * no chance of a release shipping a `dist/` whose pages are missing.
 *
 * The client is deliberately small and framework-free: three views, no
 * router library, no build step, no dependency that could pull code in
 * from a CDN the content-security policy would refuse anyway. Every piece
 * of display text is written with `textContent`, never `innerHTML`, because
 * some of it originates in email.
 */

export const APP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gmail agent</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    <header>
      <h1>Gmail agent</h1>
      <nav aria-label="Sections">
        <a href="#setup" id="nav-setup">Setup</a>
        <span aria-hidden="true">·</span>
        <a href="#commands" id="nav-commands">Commands</a>
        <span aria-hidden="true">·</span>
        <a href="#status" id="nav-status">Status</a>
      </nav>
    </header>
    <main id="main"></main>
    <p role="status" aria-live="polite" id="live"></p>
    <footer>
      <p>
        This page is served by the <code>gmail ui</code> command running on this computer, and closes when
        that command stops. Your Google sign-in and any AI key stay on this machine.
      </p>
    </footer>
    <script src="/app.js"></script>
  </body>
</html>
`;

export const APP_CSS = `:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #16181d;
  --muted: #4a4f57;
  --line: #c9ced6;
  --accent: #0b5fd0;
  --warn: #8a4b00;
  --error: #a2172a;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #eceff4;
    --muted: #b3bac4;
    --line: #3a4048;
    --accent: #7fb3ff;
    --warn: #f0b866;
    --error: #ff9b9b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
}
header, main, footer, #live {
  max-width: 44rem;
  margin: 0 auto;
  padding: 0 1.25rem;
}
header { padding-top: 2.5rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
h2 { font-size: 1.2rem; margin: 2.5rem 0 0.75rem; }
h3 { font-size: 1rem; margin: 1.75rem 0 0.5rem; }
nav { padding-bottom: 1.5rem; border-bottom: 1px solid var(--line); }
nav a { margin-right: 0.25rem; }
nav a[aria-current="page"] { font-weight: 700; }
main { padding-top: 1rem; padding-bottom: 3rem; }
a { color: var(--accent); text-decoration: underline; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
p { margin: 0.75rem 0; }
.muted { color: var(--muted); }
.error { color: var(--error); }
.warn { color: var(--warn); }
button {
  font: inherit;
  padding: 0.6rem 1rem;
  margin: 0.5rem 0.5rem 0.5rem 0;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 4px;
  cursor: pointer;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { cursor: default; color: var(--muted); }
input[type="text"], input[type="password"], input[type="number"] {
  font: inherit;
  padding: 0.5rem;
  width: 100%;
  max-width: 26rem;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 4px;
}
label { display: block; margin-top: 1rem; font-weight: 600; }
fieldset { border: 1px solid var(--line); border-radius: 4px; padding: 1rem 1.25rem; margin: 1.25rem 0; }
legend { font-weight: 700; padding: 0 0.35rem; }
.option { margin: 1rem 0; }
.option label { font-weight: 600; display: inline; margin: 0 0 0 0.4rem; }
.option p { margin: 0.25rem 0 0 1.6rem; }
dl { margin: 0.5rem 0; }
dt { font-weight: 600; margin-top: 0.75rem; }
dd { margin: 0.15rem 0 0 1.5rem; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.95em; }
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: transparent;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0.75rem;
  overflow-x: auto;
  white-space: pre-wrap;
}
table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
#live { min-height: 1.6rem; }
footer { border-top: 1px solid var(--line); padding-top: 1rem; padding-bottom: 3rem; color: var(--muted); font-size: 0.9rem; }
.skip { position: absolute; left: -9999px; }
.skip:focus { position: static; display: inline-block; padding: 0.5rem; }
.section { border-top: 1px solid var(--line); padding-top: 0.5rem; margin-top: 2rem; }
`;

export const APP_JS = String.raw`"use strict";
/* The whole client. See src/ui/assets.ts for why this is not a framework. */

// The session token arrives once in the launch URL and then lives only
// here, in memory. Stripping it from the address bar keeps a bookmark or a
// shared screenshot from carrying it, and it dies with the server anyway.
var TOKEN = new URLSearchParams(location.search).get("k") || "";
if (TOKEN) {
  history.replaceState(null, "", location.pathname + location.hash);
}

var main = document.getElementById("main");
var live = document.getElementById("live");
var state = { status: null, commands: null, view: "setup", busyAction: null, error: null };
var poll = null;

function el(tag, attrs, children) {
  var node = document.createElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(function (key) {
    if (key === "text") {
      node.textContent = attrs[key];
    } else if (key === "onclick") {
      node.addEventListener("click", attrs[key]);
    } else if (attrs[key] !== null && attrs[key] !== undefined && attrs[key] !== false) {
      node.setAttribute(key, attrs[key] === true ? "" : String(attrs[key]));
    }
  });
  (children || []).forEach(function (child) {
    if (child) node.appendChild(child);
  });
  return node;
}

function say(message) {
  live.textContent = message || "";
}

function api(path, options) {
  options = options || {};
  var headers = { Accept: "application/json" };
  if (TOKEN) headers.Authorization = "Bearer " + TOKEN;
  if (options.body) headers["Content-Type"] = "application/json";
  return fetch(path, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }).then(function (response) {
    return response.json().then(function (data) {
      if (!response.ok) throw new Error(data && data.error ? data.error : "Request failed.");
      return data;
    });
  });
}

function refreshStatus() {
  return api("/api/status")
    .then(function (data) {
      state.status = data;
      state.error = null;
      render();
      var busy = data.run.kind !== "idle";
      if (busy && !poll) poll = setInterval(refreshStatus, 1500);
      if (!busy && poll) {
        clearInterval(poll);
        poll = null;
      }
    })
    .catch(function (error) {
      state.error = error.message;
      render();
    });
}

function act(name, path, body, successMessage) {
  state.busyAction = name;
  render();
  return api(path, { method: "POST", body: body || {} })
    .then(function (data) {
      state.status = data;
      state.busyAction = null;
      state.error = null;
      say(successMessage || "Done.");
      render();
      if (data.run && data.run.kind !== "idle" && !poll) poll = setInterval(refreshStatus, 1500);
    })
    .catch(function (error) {
      state.busyAction = null;
      state.error = error.message;
      say(error.message);
      render();
    });
}

/* ---------- Setup ---------- */

function setupView() {
  var status = state.status;
  var nodes = [el("h2", { text: "Setup" })];
  if (!status) {
    nodes.push(el("p", { class: "muted", text: "Loading current status…" }));
    return nodes;
  }
  var connection = status.connection;

  if (connection.oauthClientSource === "none") {
    nodes.push(
      el("p", { class: "error", text: "This build has no Google sign-in configured, so it cannot connect an account yet." }),
      el("p", {
        text:
          "A released build includes this and needs nothing from you. To run this development build, set " +
          "GMAIL_AGENT_OAUTH_CLIENT_ID and GMAIL_AGENT_OAUTH_CLIENT_SECRET from a Desktop OAuth client, then restart gmail ui."
      })
    );
  }

  nodes.push(el("h3", { text: "1. Gmail" }));
  if (connection.connected) {
    nodes.push(el("p", { text: "Connected as " + connection.emailDisplay + " (timezone " + connection.timezone + ")." }));
  } else {
    nodes.push(el("p", { text: "No Gmail account is connected yet." }));
  }

  if (status.run.kind === "connecting") {
    nodes.push(el("p", { text: "Waiting for you to finish signing in with Google in the browser window that opened." }));
    if (status.run.authorizeUrl) {
      nodes.push(el("p", {}, [el("a", { href: status.run.authorizeUrl, text: "Open the Google sign-in page" })]));
    }
    nodes.push(el("button", { text: "Cancel sign-in", onclick: function () { act("cancel", "/api/connect/cancel", {}, "Sign-in cancelled."); } }));
  } else {
    nodes.push(
      el("button", {
        text: connection.connected ? "Reconnect Gmail" : "Connect Gmail",
        disabled: state.busyAction !== null || connection.oauthClientSource === "none",
        onclick: function () {
          var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
          act("connect", "/api/connect", { timezone: tz }, "Opening Google sign-in in your browser.");
        }
      })
    );
    if (connection.connected) {
      nodes.push(
        el("button", {
          text: "Disconnect",
          disabled: state.busyAction !== null,
          onclick: function () {
            if (!confirm("Remove this computer's access to " + connection.emailDisplay + "? Your mail is not affected.")) return;
            var removeHistory = confirm("Also delete the local run and rule history? Choose Cancel to keep it.");
            act("disconnect", "/api/disconnect", { removeHistory: removeHistory }, "Disconnected.");
          }
        })
      );
    }
  }

  var scopeList = el("dl", {});
  connection.scopes.forEach(function (entry) {
    scopeList.appendChild(el("dt", { text: entry.scope }));
    scopeList.appendChild(el("dd", { text: entry.why }));
  });
  nodes.push(el("h3", { text: "What Google access is used for" }), scopeList);

  /* AI */
  nodes.push(el("h3", { text: "2. AI" }), el("p", { text: status.ai.detail }));
  var fieldset = el("fieldset", {}, [el("legend", { text: "How this app gets AI" })]);
  status.ai.options.forEach(function (option) {
    var id = "ai-" + option.id;
    var row = el("div", { class: "option" }, [
      el("input", { type: "radio", name: "ai", id: id, value: option.id, checked: status.ai.access === option.id }),
      el("label", { for: id, text: option.title }),
      el("p", { text: option.summary }),
      el("p", { class: "muted", text: option.requirements })
    ]);
    fieldset.appendChild(row);
  });
  var keyLabel = el("label", { for: "ai-key", text: "OpenAI API key (only needed for the API-key option)" });
  var keyInput = el("input", { type: "password", id: "ai-key", autocomplete: "off", spellcheck: "false" });
  fieldset.appendChild(keyLabel);
  fieldset.appendChild(keyInput);
  fieldset.appendChild(
    el("p", { class: "muted", text: "Stored in this computer's keychain. It is never shown in this page again, saved in a file, or written to a log." })
  );
  fieldset.appendChild(
    el("button", {
      text: "Save AI choice",
      disabled: state.busyAction !== null,
      onclick: function () {
        var selected = document.querySelector('input[name="ai"]:checked');
        if (!selected) return;
        act("ai", "/api/ai", { choice: selected.value, apiKey: keyInput.value }, "Saved.");
      }
    })
  );
  nodes.push(fieldset);

  /* Preview and run */
  nodes.push(el("h3", { text: "3. Preview, then clean up" }));
  nodes.push(
    el("p", {
      text:
        "A preview reads your mail and shows exactly what would change. It changes nothing. " +
        "Cleaning up is a separate button, and signing in never starts it."
    })
  );
  var limitLabel = el("label", { for: "limit", text: "How many recent messages to look at" });
  var limitInput = el("input", { type: "number", id: "limit", min: "1", value: "50" });
  nodes.push(limitLabel, limitInput);
  nodes.push(
    el("button", {
      text: state.busyAction === "preview" || status.run.kind === "previewing" ? "Previewing…" : "Preview cleanup",
      disabled: !connection.connected || state.busyAction !== null || status.run.kind !== "idle",
      onclick: function () {
        act("preview", "/api/preview", { limit: Number(limitInput.value) || 50 }, "Previewing. Nothing is being changed.");
      }
    }),
    el("button", {
      text: status.run.kind === "running" ? "Cleaning up…" : "Run cleanup",
      disabled: !connection.connected || !status.run.lastPreview || state.busyAction !== null || status.run.kind !== "idle",
      onclick: function () {
        if (!confirm("Apply the changes from the preview? Mail goes to Trash, never permanent deletion, and can be undone.")) return;
        act("run", "/api/run", { confirm: true, limit: Number(limitInput.value) || 50 }, "Applying changes.");
      }
    })
  );
  if (!status.run.lastPreview) {
    nodes.push(el("p", { class: "muted", text: "Run a preview first — cleanup stays disabled until you have seen one." }));
  }
  if (status.run.lastPreview) {
    nodes.push(el("h3", { text: "Latest preview (nothing was changed)" }), summaryNode(status.run.lastPreview));
  }
  return nodes;
}

/* ---------- Commands ---------- */

function commandsView() {
  var nodes = [
    el("h2", { text: "Commands" }),
    el("p", { text: "Every command this app exposes, and every key the terminal inbox understands. No sign-in needed to read this." })
  ];
  var search = el("input", { type: "text", id: "search", placeholder: "Filter commands", "aria-label": "Filter commands" });
  search.value = state.search || "";
  search.addEventListener("input", function () {
    state.search = search.value;
    renderCommands();
    var again = document.getElementById("search");
    if (again) {
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
  });
  nodes.push(search);
  var container = el("div", { id: "command-list" });
  nodes.push(container);
  return nodes;
}

function renderCommands() {
  var container = document.getElementById("command-list");
  if (!container) return;
  container.textContent = "";
  if (!state.commands) {
    container.appendChild(el("p", { class: "muted", text: "Loading…" }));
    return;
  }
  var needle = (state.search || "").trim().toLowerCase();
  var matches = state.commands.commands.filter(function (command) {
    if (!needle) return true;
    return (command.name + " " + command.summary + " " + command.details).toLowerCase().indexOf(needle) !== -1;
  });
  if (matches.length === 0) {
    container.appendChild(el("p", { text: "No command matches that." }));
  }
  matches.forEach(function (command) {
    var block = el("div", { class: "section" }, [
      el("h3", { text: command.name }),
      el("pre", { text: command.synopsis }),
      el("p", { text: command.summary }),
      el("p", { text: command.details })
    ]);
    if (command.options.length) {
      var table = el("table", {}, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Option" }), el("th", { text: "What it does" })])])
      ]);
      var tbody = el("tbody", {});
      command.options.forEach(function (option) {
        tbody.appendChild(el("tr", {}, [el("td", {}, [el("code", { text: option.flag })]), el("td", { text: option.description })]));
      });
      table.appendChild(tbody);
      block.appendChild(table);
    }
    block.appendChild(el("p", {}, [el("strong", { text: "Changes: " }), document.createTextNode(command.sideEffects)]));
    block.appendChild(el("p", {}, [el("strong", { text: "Confirmation: " }), document.createTextNode(command.confirmation)]));
    command.examples.forEach(function (example) {
      block.appendChild(el("pre", { text: example }));
    });
    container.appendChild(block);
  });

  if (!needle) {
    container.appendChild(el("h3", { text: "Terminal inbox keys (gmail view)" }));
    ["list", "read"].forEach(function (context) {
      container.appendChild(el("h3", { text: context === "list" ? "In the message list" : "While reading a message" }));
      var table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Key" }), el("th", { text: "Action" })])])]);
      var tbody = el("tbody", {});
      state.commands.viewControls
        .filter(function (control) {
          return control.context === context || control.context === "both";
        })
        .forEach(function (control) {
          tbody.appendChild(el("tr", {}, [el("td", {}, [el("code", { text: control.keys })]), el("td", { text: control.description })]));
        });
      table.appendChild(tbody);
      container.appendChild(table);
    });
    container.appendChild(el("p", { class: "muted", text: state.commands.viewControlsNote }));
  }
}

/* ---------- Status ---------- */

function statusView() {
  var status = state.status;
  var nodes = [el("h2", { text: "Status" })];
  if (!status) {
    nodes.push(el("p", { class: "muted", text: "Loading…" }));
    return nodes;
  }
  nodes.push(
    el("h3", { text: "Connections" }),
    el("p", { text: "Gmail: " + (status.connection.connected ? "connected as " + status.connection.emailDisplay : "not connected") }),
    el("p", { text: "AI: " + status.ai.detail }),
    el("p", { class: "muted", text: "Sign-in method: " + (status.connection.oauthClientSource === "publisher" ? "included with this app" : status.connection.oauthClientSource === "environment" ? "your own Google Cloud OAuth client" : "not configured") })
  );

  nodes.push(el("h3", { text: "Current activity" }));
  if (status.run.kind === "idle") {
    nodes.push(el("p", { text: status.run.note || "Nothing is running." }));
  } else {
    nodes.push(el("p", { text: describeRun(status.run.kind) + (status.run.note ? " " + status.run.note : "") }));
  }
  if (status.run.lastError) {
    nodes.push(el("p", { class: "error", text: status.run.lastError }));
  }

  if (status.run.lastRun) {
    nodes.push(el("h3", { text: "Last cleanup" }), summaryNode(status.run.lastRun));
    if (status.run.lastRun.runId) {
      nodes.push(el("p", { class: "muted", text: "Undo it from a terminal with: gmail undo " + status.run.lastRun.runId }));
    }
  }
  if (status.run.lastPreview) {
    nodes.push(el("h3", { text: "Last preview" }), summaryNode(status.run.lastPreview));
  }
  nodes.push(
    el("button", { text: "Refresh", disabled: state.busyAction !== null, onclick: function () { refreshStatus(); say("Refreshed."); } })
  );
  return nodes;
}

function describeRun(kind) {
  if (kind === "connecting") return "Waiting for Google sign-in.";
  if (kind === "previewing") return "Previewing. Nothing is being changed.";
  if (kind === "running") return "Applying changes.";
  return "";
}

function summaryNode(summary) {
  // Counts only. The page could render subjects — it is as local as the
  // terminal is — but a preview is a decision aid, and the numbers are what
  // the decision rests on. Anything shown here still goes through
  // textContent, never innerHTML.
  var rows = [
    ["Inbox before", summary.inboxCountBefore],
    ["Inbox after", summary.inboxCountAfter],
    ["Moved to Trash", summary.trashed.length],
    ["Archived (already read)", summary.archivedCount],
    ["Starred", summary.starredCount],
    ["Marked important", summary.markedImportantCount],
    ["Labeled", summary.labeledCount],
    ["Calendar events", summary.calendarCreatedCount],
    ["Left for you to review", summary.reviewCount],
    ["Failures", summary.failureCount]
  ];
  var table = el("table", {}, [
    el("thead", {}, [el("tr", {}, [el("th", { text: summary.dryRun ? "Would happen" : "Happened" }), el("th", { text: "Messages" })])])
  ]);
  var tbody = el("tbody", {});
  rows.forEach(function (row) {
    tbody.appendChild(el("tr", {}, [el("td", { text: row[0] }), el("td", { text: String(row[1]) })]));
  });
  table.appendChild(tbody);
  var nodes = el("div", {}, [table]);
  var reasons = Object.keys(summary.trashedByReason || {});
  if (reasons.length) {
    nodes.appendChild(
      el("p", {
        class: "muted",
        text: "Trash reasons: " + reasons.map(function (key) { return key + " (" + summary.trashedByReason[key] + ")"; }).join(", ")
      })
    );
  }
  if (summary.scanNote) {
    nodes.appendChild(el("p", { class: "muted", text: summary.scanNote }));
  }
  return nodes;
}

/* ---------- Shell ---------- */

function render() {
  main.textContent = "";
  var nodes = state.view === "commands" ? commandsView() : state.view === "status" ? statusView() : setupView();
  nodes.forEach(function (node) {
    main.appendChild(node);
  });
  if (state.error) {
    main.appendChild(el("p", { class: "error", text: state.error }));
  }
  ["setup", "commands", "status"].forEach(function (name) {
    var link = document.getElementById("nav-" + name);
    if (state.view === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (state.view === "commands") renderCommands();
}

function applyHash() {
  var name = (location.hash || "#setup").slice(1);
  state.view = name === "commands" || name === "status" ? name : "setup";
  render();
}

window.addEventListener("hashchange", applyHash);

api("/api/commands").then(function (data) {
  state.commands = data;
  if (state.view === "commands") renderCommands();
});
applyHash();
refreshStatus();
`;
