import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db.js";
import { app } from "../src/server.js";
import {
  quote,
  place,
  simulate,
  verify,
  balances,
  reconcile,
  settleWithdrawal,
} from "../src/domain.js";
import {
  settleCustodian,
  requestRefund,
  settleRefund,
  scheduleReconciliation,
} from "../src/operations.js";
import {
  custodianBreaker,
  bankBreaker,
  refundBreaker,
} from "../src/external.js";
const api = app();
beforeAll(async () => {
  if (!pool.options.connectionString?.includes("avand_test"))
    throw Error("Test DB required");
  await pool.query(
    await readFile(new URL("../src/schema.sql", import.meta.url), "utf8"),
  );
  await api.ready();
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE events,outbox,entries,journals,gateway_transactions,orders,quotes,reconciliation_reports,daily_limits,opening_prices,price_interruptions,scheduled_runs RESTART IDENTITY CASCADE",
  );
  await pool.query(
    "UPDATE mock_settings SET clock_override='2026-11-17T06:00:00Z',price_epoch='2026-11-17T06:00:00Z',price=100000000,price_outage=false,gateway_outage=false,custodian_outage=false,custodian_mode='normal',bank_outage=false,price_pause_started_at=NULL,price_pause_until=NULL,price_outage_started_at=NULL,price_resumed_at=NULL WHERE id=1",
  );
  custodianBreaker.close();
  bankBreaker.close();
  refundBreaker.close();
});
afterEach(async () => {
  expect(
    (
      await pool.query(
        "SELECT journal_id,asset FROM entries GROUP BY journal_id,asset HAVING sum(amount)<>0",
      )
    ).rows,
  ).toEqual([]);
  for (const n of Object.values(await balances()))
    expect(BigInt(n)).toBeGreaterThanOrEqual(0n);
});
afterAll(async () => {
  await api.close();
  await pool.end();
});
async function topup() {
  const t = await place("topup", { amount: "100000000" }, randomUUID());
  await simulate(t.id, "success");
  await verify(t.id);
  return t;
}
async function buy() {
  await topup();
  return place(
    "buy",
    {
      amount: "10000000",
      fundingSource: "wallet",
      quoteId: (await quote()).id,
    },
    randomUUID(),
  );
}
async function rejected() {
  const t = await place("topup", { amount: "10000000" }, randomUUID());
  await simulate(t.id, "failed_verify");
  await verify(t.id);
  return t;
}
it("custodian settlement is independently recorded exactly once under replay", async () => {
  const o = await buy();
  await Promise.all([settleCustodian(o.id), settleCustodian(o.id)]);
  expect(
    (
      await pool.query("SELECT * FROM custodian_records WHERE order_id=$1", [
        o.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT gold_delta FROM custodian_records WHERE order_id=$1",
        [o.id],
      )
    ).rows[0].gold_delta,
  ).toBe(o.gold);
  expect((await reconcile(0)).custodian_mismatches).toEqual([]);
});
it("custodian outage preserves the posted trade and missing records are reported then recover", async () => {
  const o = await buy(),
    before = await balances();
  await pool.query("UPDATE mock_settings SET custodian_outage=true WHERE id=1");
  await expect(settleCustodian(o.id)).rejects.toThrow("Custodian unavailable");
  expect(await balances()).toEqual(before);
  expect((await reconcile(0)).custodian_mismatches).toEqual([
    expect.objectContaining({ order_id: o.id, type: "ledger_only" }),
  ]);
  await pool.query(
    "UPDATE mock_settings SET custodian_outage=false WHERE id=1",
  );
  await settleCustodian(o.id);
  expect((await reconcile(0)).custodian_mismatches).toEqual([]);
});
it("silent missing and wrong-quantity custodian responses are detectable independently of gateway", async () => {
  const o = await buy();
  await pool.query(
    "UPDATE mock_settings SET custodian_mode='missing' WHERE id=1",
  );
  await settleCustodian(o.id);
  expect((await reconcile(0)).custodian_mismatches[0].type).toBe("ledger_only");
  await pool.query(
    "UPDATE mock_settings SET custodian_mode='wrong_quantity' WHERE id=1",
  );
  await settleCustodian(o.id);
  expect((await reconcile(0)).custodian_mismatches[0].type).toBe(
    "quantity_mismatch",
  );
  expect((await reconcile(0)).mismatches).toEqual([]);
});
it("bank outage holds reserved withdrawal, replay after recovery settles once", async () => {
  await topup();
  const o = await place(
    "withdraw",
    { amount: "1000000", sheba: "IR820540102680020817909002" },
    randomUUID(),
  );
  await pool.query("UPDATE mock_settings SET bank_outage=true WHERE id=1");
  await expect(settleWithdrawal(o.id)).rejects.toThrow("Bank unavailable");
  expect((await balances()).reservedRials).toBe("1000000");
  await pool.query("UPDATE mock_settings SET bank_outage=false WHERE id=1");
  await Promise.all([settleWithdrawal(o.id), settleWithdrawal(o.id)]);
  expect((await balances()).reservedRials).toBe("0");
  expect(
    (await pool.query("SELECT * FROM bank_records WHERE order_id=$1", [o.id]))
      .rows,
  ).toHaveLength(1);
  expect((await reconcile(0)).bank_mismatches).toEqual([]);
});
it("concurrent refunds return charged-but-unverified money to bank exactly once without wallet credit", async () => {
  const o = await rejected();
  await Promise.all([requestRefund(o.id), requestRefund(o.id)]);
  await verify(o.id);
  expect((await balances()).rials).toBe("0");
  await Promise.all([settleRefund(o.id), settleRefund(o.id)]);
  await requestRefund(o.id);
  expect(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id])).rows[0]
      .status,
  ).toBe("refunded");
  expect(
    (
      await pool.query("SELECT * FROM gateway_refunds WHERE order_id=$1", [
        o.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT * FROM journals WHERE order_id=$1 AND purpose='refund'",
        [o.id],
      )
    ).rows,
  ).toHaveLength(1);
  expect((await reconcile(0)).mismatches).toEqual([]);
  expect(await balances()).toMatchObject({ rials: "0", goldUg: "0" });
});
it("refund outage keeps suspense intact and retry completes without exposing spendable money", async () => {
  const o = await rejected();
  await requestRefund(o.id);
  await pool.query("UPDATE mock_settings SET gateway_outage=true WHERE id=1");
  await expect(settleRefund(o.id)).rejects.toThrow("unavailable");
  expect(
    (
      await pool.query(
        "SELECT sum(amount)::text AS n FROM entries WHERE account='suspense:refunds'",
      )
    ).rows[0].n,
  ).toBe("10000000");
  expect((await balances()).rials).toBe("0");
  await pool.query("UPDATE mock_settings SET gateway_outage=false WHERE id=1");
  await settleRefund(o.id);
  expect(
    (
      await pool.query(
        "SELECT sum(amount)::text AS n FROM entries WHERE account='suspense:refunds'",
      )
    ).rows[0].n,
  ).toBe("0");
});
it("already credited or traded funds cannot be refunded through the failed-payment endpoint", async () => {
  const t = await topup();
  await expect(requestRefund(t.id)).rejects.toThrow("مجاز");
  expect((await pool.query("SELECT * FROM gateway_refunds")).rows).toHaveLength(
    0,
  );
});
it("cursor history traverses more than 100 equal-timestamp orders without skipping or duplicating", async () => {
  const ids = Array.from({ length: 105 }, () => randomUUID());
  await pool.query(
    "INSERT INTO orders(id,wallet_id,kind,idempotency_key,request_hash,amount,status,created_at) SELECT id,'demo','topup',id::text,'fixture',1,'awaiting_payment','2026-11-17T01:00:00.123456Z'::timestamptz FROM unnest($1::uuid[]) id",
    [ids],
  );
  let cursor: string | null = null;
  const found: string[] = [];
  do {
    const url: string =
      "/api/history?limit=17" + (cursor ? "&cursor=" + cursor : "");
    const r = await api.inject({ method: "GET", url });
    expect(r.statusCode).toBe(200);
    const page: { items: { id: string }[]; nextCursor: string | null } =
      r.json();
    found.push(...page.items.map((x: any) => x.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(found).toHaveLength(105);
  expect(new Set(found).size).toBe(105);
  expect(new Set(found)).toEqual(new Set(ids));
});
it("history rejects invalid cursors and unbounded page sizes", async () => {
  for (const suffix of ["?limit=0", "?limit=101", "?cursor=not-json"])
    expect(
      (await api.inject({ method: "GET", url: "/api/history" + suffix }))
        .statusCode,
    ).toBe(400);
});
it("daily reconciliation is durably scheduled once per Tehran day across concurrent workers", async () => {
  await scheduleReconciliation(new Date("2026-11-18T01:59:59+03:30"));
  expect((await pool.query("SELECT * FROM scheduled_runs")).rows).toHaveLength(
    0,
  );
  await Promise.all(
    Array.from({ length: 10 }, () =>
      scheduleReconciliation(new Date("2026-11-18T02:00:00+03:30")),
    ),
  );
  expect((await pool.query("SELECT * FROM scheduled_runs")).rows).toHaveLength(
    1,
  );
  expect(
    (await pool.query("SELECT * FROM outbox WHERE type='reconcile'")).rows,
  ).toHaveLength(1);
});

it("statement omissions create ledger-only discrepancies without changing financial postings", async () => {
  const t = await topup();
  const before = await balances();
  const r = await api.inject({
    method: "POST",
    url: `/api/mock/payments/${t.id}/statement`,
    payload: { hidden: true },
  });
  expect(r.statusCode).toBe(200);
  expect((await reconcile(0)).mismatches).toContainEqual(
    expect.objectContaining({ order_id: t.id, type: "ledger_only" }),
  );
  expect(await balances()).toEqual(before);
  await api.inject({
    method: "POST",
    url: `/api/mock/payments/${t.id}/statement`,
    payload: { hidden: false },
  });
  expect((await reconcile(0)).mismatches).toEqual([]);
});
it("invariant endpoint reports actual balanced journals after financial activity", async () => {
  await buy();
  const r = await api.inject({ method: "GET", url: "/api/support/invariants" });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ balanced: true, invalid: [] });
});
