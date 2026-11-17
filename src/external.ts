import CircuitBreaker from "opossum";
import { randomUUID } from "node:crypto";
import { pool } from "./db.js";
const options = {
  timeout: 1500,
  volumeThreshold: 3,
  errorThresholdPercentage: 50,
  resetTimeout: 10000,
};
export const custodianBreaker = new CircuitBreaker(async (id: string) => {
  const s = (await pool.query("SELECT * FROM mock_settings WHERE id=1"))
    .rows[0];
  if (s.custodian_outage) throw Error("Custodian unavailable");
  const delta = (
    await pool.query(
      "SELECT (-sum(e.amount))::text AS value FROM entries e JOIN journals j ON j.id=e.journal_id WHERE j.order_id=$1 AND e.account='custodian:inventory'",
      [id],
    )
  ).rows[0].value;
  if (delta === null) throw Error("No custody trade for order");
  if (s.custodian_mode === "missing")
    return { accepted: true, recorded: false };
  const value =
    BigInt(delta) + (s.custodian_mode === "wrong_quantity" ? 1n : 0n);
  await pool.query(
    "INSERT INTO custodian_records(order_id,reference,gold_delta) VALUES($1,$2,$3) ON CONFLICT(order_id) DO NOTHING",
    [id, randomUUID(), value.toString()],
  );
  return { accepted: true, recorded: true };
}, options);
export const bankBreaker = new CircuitBreaker(
  async (id: string, amount: string) => {
    const s = (
      await pool.query("SELECT bank_outage FROM mock_settings WHERE id=1")
    ).rows[0];
    if (s.bank_outage) throw Error("Bank unavailable");
    await pool.query(
      "INSERT INTO bank_records(order_id,reference,amount) VALUES($1,$2,$3) ON CONFLICT(order_id) DO NOTHING",
      [id, randomUUID(), amount],
    );
    const record = (
      await pool.query("SELECT * FROM bank_records WHERE order_id=$1", [id])
    ).rows[0];
    if (record.amount !== amount) throw Error("Bank amount mismatch");
    return record;
  },
  options,
);
export const refundBreaker = new CircuitBreaker(
  async (id: string, amount: string) => {
    const s = (
      await pool.query("SELECT gateway_outage FROM mock_settings WHERE id=1")
    ).rows[0];
    if (s.gateway_outage) throw Error("Gateway refund unavailable");
    await pool.query(
      "INSERT INTO gateway_refunds(order_id,reference,amount) VALUES($1,$2,$3) ON CONFLICT(order_id) DO NOTHING",
      [id, randomUUID(), amount],
    );
    const record = (
      await pool.query("SELECT * FROM gateway_refunds WHERE order_id=$1", [id])
    ).rows[0];
    if (record.amount !== amount) throw Error("Refund amount mismatch");
    return record;
  },
  options,
);
export const externalCircuits = () =>
  Object.fromEntries(
    [
      ["custodian", custodianBreaker],
      ["bank", bankBreaker],
      ["refund", refundBreaker],
    ].map(([name, b]) => [
      name,
      {
        state: (b as CircuitBreaker).opened
          ? "open"
          : (b as CircuitBreaker).halfOpen
            ? "half-open"
            : "closed",
      },
    ]),
  );
