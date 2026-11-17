# Changes

## Initial baseline under construction

This repository currently implements the agreed first-version scope: local mock services, modular API/worker, PostgreSQL ledger, RabbitMQ, transactional outbox, and circuit breakers.

## MVP completion before the formal v1 milestone

- Added independent, fee-free rial top-ups and atomic purchases from existing wallet balance. Existing gateway-funded buys remain compatible; the UI defaults to wallet funding.
- Added an additive schema upgrade preserving existing ledger/order data and idempotency responses.
- Replaced fixed indicative prices with a deterministic 30-second mock feed based on a shared database clock. Quotes retain their original prices and provider publication times.
- Split charge outcome from verification outcome. `failed_verify` now records money charged with verification rejected, with no spendable credit; reconciliation reports it until explicit mock resolution triggers async settlement. This corrects the earlier shallow failure scenario.
- Fixed mock payments being incorrectly blocked once an unpaid order moved to payment_pending.
- Expanded the automated suite to 28 tests, including real PostgreSQL and RabbitMQ paths; updated the UI and HTTP smoke script.
