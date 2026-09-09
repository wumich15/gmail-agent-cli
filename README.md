# gmail
gmail app


### Read performance

`gmail` and `gmail cache` use gzip and partial-response fields with concurrent individual reads. Multipart read batching has been removed from both paths; old `GMAIL_AGENT_BATCH_HYDRATION`/`GMAIL_AGENT_BATCH_SIZE` settings no longer select it. Work uses configured Gmail read concurrency (default 5); cache uses 8. Progress appears on stderr.

The shared limiter targets 275 message-read equivalents/minute, including retry/auxiliary quota costs. One hundred reads therefore take roughly 22 seconds of pacing, plus network latency. `gmail --limit 100` can select 100 Inbox plus 100 Spam messages on a full scan, then makes AI calls and grouped writes; it does not cap the whole run to 100 API calls. An explicit per-minute quota rejection pauses the shared queue for the rolling window and retries without permanently reducing this configured pace.

Cache writes still commit in groups of 50, and reversible Trash/label changes still use `messages.batchModify`. Matching assessments are preserved, stale projections are evicted, and partial scans remain recoverable. `GMAIL_AGENT_RATE_LIMIT_RPS` overrides pacing for a verified custom quota.
