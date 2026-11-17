import CircuitBreaker from "opossum";
import { pool } from "./db.js";
async function settings() {
  return (
    await pool.query(
      "SELECT *,clock_timestamp() AS provider_now FROM mock_settings WHERE id=1",
    )
  ).rows[0];
}
const options = {
  timeout: 1500,
  errorThresholdPercentage: 50,
  volumeThreshold: 3,
  resetTimeout: 10000,
  rollingCountTimeout: 30000,
};
// A deterministic feed changes every 30s, using the shared DB clock and epoch.
// No per-process timer: API instances agree and restarts preserve the feed phase.
export function priceSnapshot(base: bigint, epoch: Date, now: Date) {
  const slot = Math.max(
    0,
    Math.floor((now.getTime() - epoch.getTime()) / 30000),
  );
  const basisPoints = [0n, 25n, -15n, 40n, -25n, 10n];
  const calculated =
    (base * (10000n + basisPoints[slot % basisPoints.length])) / 10000n;
  const publishedAt = new Date(epoch.getTime() + slot * 30000);
  return {
    price: (calculated > 0n ? calculated : 1n).toString(),
    publishedAt: publishedAt.toISOString(),
    nextUpdateAt: new Date(publishedAt.getTime() + 30000).toISOString(),
    indicative: true,
  };
}
export function makePriceBreaker() {
  return new CircuitBreaker(async () => {
    const s = await settings();
    if (s.price_outage) throw Error("Price provider unavailable");
    return priceSnapshot(BigInt(s.price), s.price_epoch, s.provider_now);
  }, options);
}
export const priceBreaker = makePriceBreaker();
export const gatewayBreaker = new CircuitBreaker(async (id: string) => {
  const s = await settings();
  if (s.gateway_outage) throw Error("Gateway unavailable");
  const r = await pool.query(
    "SELECT * FROM gateway_transactions WHERE order_id=$1",
    [id],
  );
  return r.rows[0] ?? null;
}, options);
export const circuits = () =>
  Object.fromEntries(
    (
      [
        ["price", priceBreaker],
        ["gateway", gatewayBreaker],
      ] as const
    ).map(([k, b]) => [
      k,
      {
        state: b.opened ? "open" : b.halfOpen ? "half-open" : "closed",
        stats: b.stats,
      },
    ]),
  );
