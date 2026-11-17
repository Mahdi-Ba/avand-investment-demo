# Defense preparation

## Fifteen-minute walkthrough

| Time | Show | Explain |
|---|---|---|
| 0–3 min | README, compose, scope | One codebase, API/worker, mocked providers; what needs a production gate |
| 3–7 min | ledger.ts, schema.sql, money tests | Integer units, per-asset balance, wallet lock, stored idempotency response and journal uniqueness |
| 7–10 min | order detail and latest report | Duplicate/missing callbacks, verify rejection, suspense refund, custodian/bank differences |
| 10–13 min | market.ts, queued order, v1 diff | Tehran midnight, separate caps, reservations, first actual opening tick, cancel race and stale feed |
| 13–15 min | delivery notes | Limits, production readiness and the next day's work |

## Questions to rehearse

1. Why does an unavailable gateway not imply a failed charge? Show verification_failed and refund_pending.
2. What stops two devices spending the same balance? Identify the wallet row lock, transaction and counterparty entries.
3. What happens after commit but before RabbitMQ ack? Show an idempotent replay and the unique financial journal.
4. Why was a synchronous wallet projection added? Show the entry trigger, transaction rollback, wallet lock, initial backfill and drift audit. Explain why an asynchronously updated cache is unsafe for spend decisions.
5. Why does a 15-minute price gap not dead-letter a valid order? Distinguish an expected wait from an unexpected error.
6. What is the exact definition of a day and an opening? Use Asia/Tehran and the boundary tests, not the laptop's timezone.
7. Is completed proof of physical gold? No: the demo has independent settlement records; real inventory limits and a custodian agreement are launch gates.
8. Can fund redemption pay a card now? No, unless the bank supplies contracted credit during the 1–2 working-day receivable.
9. Can cancellation race with an external charge? It prevents the trade; verified late money is credited once or a controlled refund is used.
10. What did v1 get wrong? Show cadence/freshness, queued assets, opening tick timing and expected feed waits in CHANGES.

## Live-coding practice (30 minutes)

Suggested exercise: make the quote TTL configurable with a bounded value and add one meaningful test proving that expiry never exceeds the feed freshness deadline. Keep integer accounting unchanged. Read the relevant test first, modify the smallest owning module, run typecheck and the focused test, then the suite if behavior changes.

Do not spend the session explaining a dependency whose behavior you cannot defend. Be ready to write one journal by hand and compute rounding with example numbers.

## With one more day

I would spend the extra day on operational money-safety evidence: kill and restart the worker between external receipt and ledger commit, restore the database from a backup, and exercise reconciliation against delayed bank/custodian files. I would make treasury inventory and permission-controlled discrepancy resolution explicit before polishing the interface. These checks reduce the risk of a correct-looking balance hiding an unresolved external settlement; they are more valuable than adding another product feature.
