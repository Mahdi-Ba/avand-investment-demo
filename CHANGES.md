# Part 5 — changes from v1

## Baseline and provenance

The annotated local tag **v1** points to `a10c7bb3b75fb3854f1ab95f469f3f5d788a26c0`. It was created after a clean working-tree check, TypeScript validation and all **28 baseline tests** passed. The tag has not been moved or rewritten.

## 1. Design changes, section by section

| Design topic | Change and reason |
|---|---|
| Day-one architecture | Added a market-policy module, durable daily-limit records, opening-price snapshots and an execution scheduler in the existing worker. API/worker/PostgreSQL/RabbitMQ remain one modular application. No new distributed service is needed. |
| Ledger | Reused the reserved user account per asset. Queued buys reserve rials; queued sells reserve gold. Cancellation appends a reversing reservation journal; execution consumes the reserved asset. Gold-buy rounding change is returned to available cash. No cached balances or mutable financial history were introduced. |
| Buy flow and states | Added execution_mode=queued, execute_after, queued and cancelled states. Queued buys specify a rial budget, not promised grams. Gateway-backed queued buys are only reserved after verification. Cancellation before verification prevents a trade; verified late money goes to the wallet once. |
| Reconciliation | The existing gateway-versus-topup report is unchanged. Internal reservation transfers are not external payments and must not be treated as gateway mismatches. The end-to-end check after execution and cancellation reported no mismatch. |
| Fund design | Unchanged: delayed brokerage settlement still cannot supply immediate cash. No fund code was required or added. |
| Card design | Automatic gold liquidation must also respect sell caps and price freshness. A liquidation that would queue cannot meet the bank's synchronous deadline; decline or a separately contracted credit facility is required. No card implementation was added. |
| Security/audit | Added events for queued reservation, cancellation and execution, including the actual opening price and publication time. Clock/feed controls remain local mock facilities and are not production controls. Auth/KYC/security-certification scope is unchanged. |
| Monitoring/runbook | Support now sees market hours, next opening, remaining caps and reserved cash/gold. Expected feed gaps keep orders queued without spending the retry error budget. Unexpected errors retain the existing retry/DLQ mechanism. Full monitoring/alert delivery remains outside this prototype. |
| Twelve-week plan | Team size, first hires and launch gates remain unchanged. Validation now additionally requires market-calendar, cap-concurrency, stale-feed and cancellation-race checks. |
| Risks | Opening-price slippage, feed silence and queued-asset double spending are now explicit. Rial/gram reservations, durable first-opening-price selection and transaction locks mitigate them. Real historical-price availability still requires a provider contract. |

The current design is in [ARCHITECTURE.md](docs/ARCHITECTURE.md), including a dedicated Part 5 section and the revised state diagram.

## 2. Code changes and commits

Implementation and automated tests: [dd04d7b](../../commit/dd04d7b).

- [Market policy](src/market.ts): IANA Tehran calendar, next opening, separate 500-million-rial buy/sell counters and risk reservations.
- [Financial flows](src/domain.ts): queue reservation, cancellation, guarded execution, gateway payment-time rechecks and idempotent late-payment handling.
- [Provider](src/providers.ts): 30-second/open and five-minute/closed feed, freshness metadata, first opening ticks and interruption history. It does not invent ticks during gaps or across cadence transitions.
- [Schema](src/schema.sql): additive tables/columns/indexes; existing ledger data and stored idempotency responses are preserved.
- [Worker](src/worker.ts): automatic due-order scheduling through the transactional outbox and RabbitMQ. A unique live execution job and final-state checks make replay safe.
- [API](src/server.ts) and [demo](public/app.js): market status, cancellation, reserved-gold display, queue messages and shared mock-clock/feed controls.
- [HTTP smoke](scripts/smoke-market.mjs): queue, cancel, opening execution and stale-price rejection, with original clock restoration.

No commit was squashed. Compare `git diff v1..HEAD` and run `git show dd04d7b` for the implementation review. This report is committed separately from the implementation.

## 3. Deliberately unchanged

- TypeScript/Fastify, PostgreSQL, RabbitMQ, circuit breakers and the modular API/worker deployment.
- Integer rials/micrograms, fee rate, rounding rules and per-asset double-entry invariant.
- Immutable financial entries, derived balances and idempotency-response snapshots.
- Existing independent top-ups, withdrawals, reconciliation and charged-but-rejected-verification handling.
- Legacy direct gateway buys remain supported; wallet-funded buys remain the UI default.
- Single demo user, mocked external systems, no public deployment, no production authentication, no fund/card code and no claim of production scale verification.

## 4. v1 decisions proved wrong or incomplete

1. **A single 30-second price cadence was insufficient.** Quote TTL alone did not establish freshness. Provider publication time now independently gates trading, even when a quote's TTL was artificially kept valid.
2. **All wallet buys and sells could not remain immediate.** Over-cap requests must become durable orders holding assets rather than failing or executing at an old lock.
3. **Retrying every wait as an error would be wrong.** A valid 15-minute feed silence would exhaust the former error budget before recovery. Expected feed/market waits now reschedule without incrementing error attempts.
4. **Computing the current price at worker execution time would violate the queued-order contract.** Opening snapshots retain the first eligible published tick; a late worker does not substitute a later quote.
5. **Assuming the first tick arrives at exactly 09:00 was wrong.** The HTTP smoke exposed an epoch ending in nonzero seconds. A regression test now proves that a 09:00:17 first tick is awaited and no synthetic pre-opening publication is used.

## 5. New assumptions and policies

- Market days are Saturday through Wednesday, 09:00 inclusive to 15:00 exclusive in `Asia/Tehran`. No extra official-holiday calendar was specified or implemented.
- 50 million tomans is **500 million rials**. The Tehran calendar date, not UTC midnight, keys each day's counters. Buys and sells have separate caps.
- Buy usage counts the inclusive rial budget; sell usage counts gross gold value at the valid acceptance price. Including buy fees is conservative and needs business approval before production.
- Orders crossing the remaining cap are queued **in full**, with no partial immediate fill. They remain queued across midnight until their designated opening; a new day's allowance does not auto-fill them overnight.
- Wallet buys reserve rials; sells reserve micrograms. Unfunded gateway orders reserve no wallet asset. A pending immediate gateway buy holds cap capacity until its outcome is known; failed/expired trades release it.
- Gateway verification evaluates the payment's recorded time and calendar boundary, preventing a pre-15:00 order from bypassing post-15:00 limits. Funds arriving after an unfunded queued order's designated opening move its execution to the next opening after funding.
- Cancellation is allowed while the order is still queued (or awaiting funding for queued execution). The transaction acquiring the wallet/order locks first wins against execution. Completed trades cannot be cancelled; repeated cancellation is safe.
- Maximum acceptable price age is **60 seconds in market hours** and **six minutes outside them**. Quote expiry is also bounded by this freshness deadline. A larger gap blocks immediate trading but preserves queued assets.
- Queued execution requires a fresh current feed and uses the contractual first opening price. That historical execution price is not an arbitrary stale-price fallback.
- The deterministic mock can reconstruct published ticks from its epoch and persisted interruption history. A real integration must retain provider ticks durably or obtain a trustworthy historical-price endpoint. This availability is not claimed for an actual provider.
- If a worker misses an entire session, the order remains reserved until a worker can process it in market hours using its recorded first eligible opening price. Production execution guarantees/backlog limits require a provider agreement and operational policy.
- The explicit clock override is a shared demo clock only. Queue retry leases and networking timeouts use real time. With a frozen clock, advance at least 30 seconds beyond opening to guarantee the first cadence tick has arrived.

## 6. Validation

**49 automated tests pass**, comprising the 28 baseline tests and 21 additions. Required Part 5 cases are covered:

- Concurrent buys that together exceed the cap: exactly one immediate fill, the other queued; counters and reserved cash stay correct. Equivalent concurrent sells cover reserved grams.
- Cancellation and execution racing for one order: one outcome, no double release, no trade after cancellation and no negative/stranded assets. A completed-first case explicitly rejects a late cancellation.
- Stale price: quote creation and trading with an otherwise unexpired lock are rejected without consuming allowance or changing balances.

Additional coverage includes exact-cap acceptance, separate buy/sell counters, Tehran midnight/week boundaries, weekend closure, both reservation assets, late workers, repeated execution, 15-minute/multiple gaps, recovery between cadence ticks, gateway payment-time transitions and cancellation before verification. A real RabbitMQ worker automatically processes the market queue at opening and survives message replay without duplicate financial posting.

Also verified: TypeScript, browser-JavaScript syntax, full Docker Compose startup, successful HTTP market smoke, browser queue/cancel flow, restored real clock, no reconciliation mismatches, and zero ledger sum independently for IRR and GOLD_UG. No benchmark, production deployment or security certification is claimed.


## 7. Operational completion

Added independent mock custodian, bank and refund receipts with circuit breakers, idempotent settlement and outbox retries. Refunds of charged but unverified payments pass through suspense and never expose spendable wallet funds. Reconciliation compares gateway, bank and custody records independently; a daily durable schedule runs from 02:00 Tehran. Legacy seeded receipts are explicitly marked, rather than presented as independent historical evidence.

History now uses a bounded keyset cursor and the interface supports page navigation. A repeatable seven-scenario demo exercises duplicate callbacks, 100 identical concurrent requests, overselling protection, expired payment quotes, missed callbacks, ledger invariants and both directions of statement discrepancies. The final recorded run passed all seven in 24 seconds; the screen recording is about 49 seconds including its start and end.

Validation: **61 tests pass**, TypeScript passes, and the browser demo completed successfully. New tests cover refund races/outages, independent settlement mismatches and recovery, bank retry, equal-timestamp pagination beyond 100 orders, daily scheduler races, statement omission and actual ledger invariants.

Expanded architecture covers accounting accounts, refund/correction workflow, sample reconciliation closure, delayed fund settlement, card payment/liquidity examples and a week-by-week delivery plan. Production authorization, physical treasury inventory, bank settlement files and dual-approval discrepancy resolution remain explicit launch work. Personal work-history examples must come from the candidate; no past employment experience is invented.
