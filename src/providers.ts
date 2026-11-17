import CircuitBreaker from "opossum";
import { pool } from "./db.js";
async function settings() {
  return (await pool.query("SELECT * FROM mock_settings WHERE id=1")).rows[0];
}
const options = {
  timeout: 1500,
  errorThresholdPercentage: 50,
  volumeThreshold: 3,
  resetTimeout: 10000,
  rollingCountTimeout: 30000,
};
export function makePriceBreaker() {
  return new CircuitBreaker(async () => {
    const s = await settings();
    if (s.price_outage) throw Error("Price provider unavailable");
    return BigInt(s.price);
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
