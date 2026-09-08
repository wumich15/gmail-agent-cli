# gmail
gmail app


### Read performance

`gmail` and `gmail cache` use gzip and partial-response fields in batches of up to 50 messages. Read progress appears on stderr, including failures and quota cooldowns. The shared quota pace targets about 300 message reads/minute; actual throughput depends on Gmail latency and retries. Smaller responses reduce bandwidth, not Gmail's per-read quota cost.

Cache writes commit in groups of 50. Valid assessments are preserved; changed labels are reevaluated, stale Inbox/Spam rows are removed, and partial reads remain recoverable. Cleanup uses reversible `messages.batchModify` Trash/label operations in groups of 50, not permanent deletion.

Optional environment controls: `GMAIL_AGENT_BATCH_HYDRATION=0` for individual reads, `GMAIL_AGENT_BATCH_SIZE=1..50` for smaller batches, and `GMAIL_AGENT_RATE_LIMIT_RPS` for a verified custom quota pace. Essential list/history and protection reads remain; redundant history reads and unnecessary Sent scans are avoided.
