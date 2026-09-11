# Product home page copy — {{PRODUCT_NAME}}

Publish at `https://{{DOMAIN}}/`. Google's verification review reads this page
and compares it to the consent screen, the privacy policy, and the app's own
disclosures. Keep the three consistent; the sections below are ordered so a
reviewer can confirm each claim quickly.

---

## {{PRODUCT_NAME}}

**Your inbox, cleaned up on your own computer.**

{{PRODUCT_NAME}} is a terminal app that triages Gmail for you. Run `gmail` and
it trashes the junk, stars what you actually need to read, turns real
appointments into calendar events, and archives everything you have already
read — then prints exactly what it did.

```sh
npm install --global gmail-agent-cli
gmail
```

### What it does

- **Cleans up.** Native Gmail spam, promotions, and low-value automated mail go
  to Gmail's **Trash**. Never permanent deletion. Always undoable with
  `gmail undo`.
- **Protects what matters.** Security alerts, receipts, travel, appointments,
  and deadlines are treated as important even though a machine sent them.
- **Creates calendar events** from mail that states a real date and time —
  private, with no attendees, no invitations, and no duplicates.
- **Archives read mail** so the inbox reflects what is left to do.
- **Unsubscribes on request.** `gmail spam "..."` uses the standard one-click
  unsubscribe header, after showing you the exact endpoint.
- **Reads and writes mail** in `gmail view`, including AI-drafted replies —
  which are never sent until you have seen the exact final message and said yes.

### What it never does

- Never permanently deletes a message.
- Never sends any email without your explicit confirmation of that exact
  message. There is no autoreply and no background sending.
- Never follows instructions written inside an email.
- Never uploads attachments anywhere.
- Never runs in the background or keeps a copy of your mailbox on a server.

### Privacy

Everything runs on your machine. Your Google sign-in lives in your operating
system's credential store; message bodies are never written to disk.

AI is optional and off until you pick it. With **Included GPT**, bounded
message text — never attachments — goes through our gateway to OpenAI with
storage disabled, so you do not need an OpenAI account. You can also bring your
own OpenAI key, or run rules-only with nothing leaving your computer.

Read the [Privacy Policy](https://{{DOMAIN}}/privacy),
[Terms](https://{{DOMAIN}}/terms),
[data deletion](https://{{DOMAIN}}/delete-my-data), and
[security policy](https://{{DOMAIN}}/security).

### Permissions we ask for

| Permission | Why |
| --- | --- |
| See and modify your Gmail (`gmail.modify`) | Read mail to triage it; trash, archive, star, label. Permanent deletion is not possible with this permission and the app never attempts it. |
| Manage events it created (`calendar.events.owned`) | Add appointments it finds. It cannot touch events it did not create. |
| Your email address and basic identity | Show the connected account and enforce fair-use limits on Included GPT. |

### Support

{{SUPPORT_EMAIL}} · Security: {{SECURITY_EMAIL}} · Privacy: {{PRIVACY_EMAIL}}

*{{PRODUCT_NAME}} is published by {{PUBLISHER_LEGAL_NAME}}. Google Workspace,
Gmail, and Google Calendar are trademarks of Google LLC.*
