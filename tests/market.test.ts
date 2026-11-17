import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pool } from "../src/db.js";
import {
  place,
  quote,
  simulate,
  verify,
  balances,
  cancelOrder,
  executeQueued,
  scheduleQueued,
  callback,
} from "../src/domain.js";
import { marketAt, marketStatus } from "../src/market.js";
import {
  priceBreaker,
  gatewayBreaker,
  openingPrice,
} from "../src/providers.js";
import { app } from "../src/server.js";
const api = app();
const OPEN = "2026-11-17T09:00:00+03:30",
  CLOSED = "2026-11-17T20:00:00+03:30";
async function clock(value: string) {
  await pool.query("UPDATE mock_settings SET clock_override=$1 WHERE id=1", [
    value,
  ]);
}
async function seed(amount = "3000000000") {
  const t = await place("topup", { amount }, randomUUID());
  await simulate(t.id, "success");
  await verify(t.id);
}
async function walletBuy(amount: string, q?: string) {
  return place(
    "buy",
    { amount, fundingSource: "wallet", ...(q ? { quoteId: q } : {}) },
    randomUUID(),
  );
}
async function queuedBuy() {
  await seed();
  await clock(CLOSED);
  return walletBuy("600000000");
}
async function order(id: string) {
  return (await pool.query("SELECT * FROM orders WHERE id=$1", [id])).rows[0];
}
beforeAll(async () => {
  if (!pool.options.connectionString?.includes("avand_test"))
    throw Error("Isolated test DB required");
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
    "UPDATE mock_settings SET custodian_outage=false,custodian_mode='normal',bank_outage=false,clock_override=$1,price_epoch=$1,price=100000000,price_outage=false,gateway_outage=false,price_pause_started_at=NULL,price_pause_until=NULL,price_outage_started_at=NULL,price_resumed_at=NULL WHERE id=1",
    [OPEN],
  );
  priceBreaker.close();
  gatewayBreaker.close();
});
afterEach(async () => {
  expect((await pool.query("SELECT * FROM wallet_balance_drift")).rows).toEqual(
    [],
  );
  expect(
    (
      await pool.query(
        "SELECT journal_id,asset FROM entries GROUP BY journal_id,asset HAVING sum(amount)<>0",
      )
    ).rows,
  ).toEqual([]);
  for (const n of Object.values(await balances()))
    expect(BigInt(n)).toBeGreaterThanOrEqual(0n);
  expect(
    (
      await pool.query(
        "SELECT * FROM daily_limits WHERE used<0 OR used>500000000",
      )
    ).rows,
  ).toEqual([]);
});
afterAll(async () => {
  await api.close();
  await pool.end();
});
it("Tehran hours: Saturday–Wednesday 09:00 inclusive, 15:00 exclusive; Thursday/Friday closed", () => {
  for (const time of ["2026-11-14T09:00:00+03:30", "2026-11-18T14:59:59+03:30"])
    expect(marketAt(new Date(time)).isOpen).toBe(true);
  for (const time of [
    "2026-11-14T08:59:59+03:30",
    "2026-11-18T15:00:00+03:30",
    "2026-11-19T10:00:00+03:30",
    "2026-11-20T10:00:00+03:30",
  ])
    expect(marketAt(new Date(time)).isOpen).toBe(false);
  expect(
    marketAt(new Date("2026-11-18T15:00:00+03:30")).nextOpen.toISOString(),
  ).toBe("2026-11-21T05:30:00.000Z");
  expect(marketAt(new Date("2026-11-17T23:59:59+03:30")).day).toBe(
    "2026-11-17",
  );
  expect(marketAt(new Date("2026-11-18T00:00:00+03:30")).day).toBe(
    "2026-11-18",
  );
});
it("two concurrent buys together exceeding the cap: one executes, the other queues without overspending", async () => {
  await seed();
  await clock(CLOSED);
  const q = await quote();
  const rs = await Promise.all([
    walletBuy("300000000", q.id),
    walletBuy("300000000", q.id),
  ]);
  expect(rs.map((r) => r.status).sort()).toEqual(["completed", "queued"]);
  expect((await marketStatus()).buyUsed).toBe("300000000");
  expect((await balances()).reservedRials).toBe("300000000");
  expect(rs.find((o) => o.status === "queued").gold).toBe("0");
});
it("two concurrent sells exceeding the independent sell cap reserve grams, never future cash", async () => {
  await seed();
  await walletBuy("1000000000", (await quote()).id);
  await clock(CLOSED);
  const q = await quote();
  const rs = await Promise.all(
    Array.from({ length: 2 }, () =>
      place("sell", { gold: "3000000", quoteId: q.id }, randomUUID()),
    ),
  );
  expect(rs.map((o) => o.status).sort()).toEqual(["completed", "queued"]);
  expect((await balances()).reservedGoldUg).toBe("3000000");
  expect((await marketStatus()).sellUsed).toBe("300000000");
  expect((await marketStatus()).buyUsed).toBe("0");
});
it("buy and sell caps are separate; exact cap is allowed, not split, and midnight Tehran resets allowance", async () => {
  await seed();
  await walletBuy("1000000000", (await quote()).id);
  await clock(CLOSED);
  const q = await quote();
  expect((await walletBuy("500000000", q.id)).status).toBe("completed");
  expect(
    (await place("sell", { gold: "5000000", quoteId: q.id }, randomUUID()))
      .status,
  ).toBe("completed");
  expect((await marketStatus()).buyRemaining).toBe("0");
  expect((await marketStatus()).sellRemaining).toBe("0");
  expect((await walletBuy("10000000", q.id)).status).toBe("queued");
  await clock("2026-11-18T00:00:00+03:30");
  expect((await marketStatus()).buyRemaining).toBe("500000000");
  expect((await walletBuy("10000000", (await quote()).id)).status).toBe(
    "completed",
  );
});
it("cancel releases reserved rials once; cancelled order can never execute", async () => {
  const o = await queuedBuy();
  const before = await balances();
  await Promise.all([cancelOrder(o.id), cancelOrder(o.id)]);
  expect((await balances()).reservedRials).toBe("0");
  expect(BigInt((await balances()).rials) - BigInt(before.rials)).toBe(
    600000000n,
  );
  await clock("2026-11-18T09:00:00+03:30");
  await executeQueued(o.id);
  expect((await order(o.id)).status).toBe("cancelled");
  expect(
    (
      await pool.query(
        "SELECT * FROM journals WHERE order_id=$1 AND purpose='buy'",
        [o.id],
      )
    ).rows,
  ).toHaveLength(0);
});
it("cancel versus execution at the same moment has exactly one winner and no stranded reservation", async () => {
  for (let i = 0; i < 8; i++) {
    await clock(OPEN);
    await seed("600000000");
    await clock(CLOSED);
    const o = await walletBuy("600000000");
    await clock("2026-11-18T09:00:00+03:30");
    await Promise.allSettled(
      i % 2
        ? [executeQueued(o.id), cancelOrder(o.id)]
        : [cancelOrder(o.id), executeQueued(o.id)],
    );
    const final = await order(o.id);
    expect(["cancelled", "completed"]).toContain(final.status);
    const purposes = (
      await pool.query("SELECT purpose FROM journals WHERE order_id=$1", [o.id])
    ).rows.map((x) => x.purpose);
    expect(purposes.includes("buy")).toBe(final.status === "completed");
    expect(purposes.includes("queue_release")).toBe(
      final.status === "cancelled",
    );
    expect((await balances()).reservedRials).toBe("0");
  }
});
it("queued buy uses the first opening price even when worker is late and replayed, not the old or current price", async () => {
  const o = await queuedBuy();
  await clock("2026-11-18T09:01:00+03:30");
  const first = await openingPrice(
    new Date(o.execute_after),
    new Date("2026-11-18T09:01:00+03:30"),
  );
  const current = await quote();
  expect(current.price).not.toBe(first.price);
  await Promise.all([executeQueued(o.id), executeQueued(o.id)]);
  const done = await order(o.id);
  expect(done.execution_price).toBe(first.price);
  expect(done.gold).toBe(
    (((600000000n - 6000000n) * 1000000n) / BigInt(first.price)).toString(),
  );
  expect(done.status).toBe("completed");
  expect((await balances()).reservedRials).toBe("0");
  expect((await marketStatus()).buyUsed).toBe("0");
});
it("queued sell executes reserved grams at opening price; cancellation of another sell restores grams", async () => {
  await seed();
  await walletBuy("1500000000", (await quote()).id);
  await clock(CLOSED);
  const q = await quote(),
    o = await place("sell", { gold: "6000000", quoteId: q.id }, randomUUID()),
    cancelled = await place(
      "sell",
      { gold: "6000000", quoteId: q.id },
      randomUUID(),
    );
  await cancelOrder(cancelled.id);
  await clock("2026-11-18T09:00:00+03:30");
  await executeQueued(o.id);
  expect((await order(o.id)).status).toBe("completed");
  expect((await balances()).reservedGoldUg).toBe("0");
  expect((await balances()).goldUg).toBe("8850000");
});
it("a stale price blocks quote creation and an otherwise unexpired old lock without consuming cap", async () => {
  await seed();
  await clock(CLOSED);
  const q = await quote();
  // Keep TTL valid to prove freshness is an independent check.
  await pool.query(
    "UPDATE quotes SET expires_at='2026-11-17T22:00:00+03:30' WHERE id=$1",
    [q.id],
  );
  await pool.query(
    "UPDATE mock_settings SET price_pause_started_at=clock_override,price_pause_until=clock_override+interval '15 minutes' WHERE id=1",
  );
  await clock("2026-11-17T20:07:00+03:30");
  await expect(quote()).rejects.toThrow("کهنه");
  await expect(walletBuy("10000000", q.id)).rejects.toThrow("کهنه");
  expect((await marketStatus()).buyUsed).toBe("0");
  expect(
    (await pool.query("SELECT * FROM orders WHERE kind='buy'")).rows,
  ).toHaveLength(0);
});
it("off-hours feed changes every five minutes, holds during a 15-minute gap and recovers after it", async () => {
  await clock(CLOSED);
  const a = await quote();
  await clock("2026-11-17T20:04:59+03:30");
  const b = await quote();
  expect(b.price).toBe(a.price);
  await clock("2026-11-17T20:05:00+03:30");
  expect((await quote()).price).not.toBe(a.price);
  const paused = await api.inject({
    method: "POST",
    url: "/api/mock/market",
    payload: { pauseFeed: true },
  });
  expect(paused.statusCode).toBe(200);
  await clock("2026-11-17T20:12:00+03:30");
  await expect(quote()).rejects.toThrow("کهنه");
  await clock("2026-11-17T20:20:00+03:30");
  expect((await quote()).price).toBeDefined();
});
it("gateway reservations prevent cap races, a failed payment releases allowance, retry does not reserve twice", async () => {
  await clock(CLOSED);
  const q = await quote();
  const a = await place(
    "buy",
    { amount: "300000000", quoteId: q.id },
    "gateway-a",
  );
  expect(
    (await place("buy", { amount: "300000000", quoteId: q.id }, "gateway-a"))
      .id,
  ).toBe(a.id);
  const b = await place(
    "buy",
    { amount: "300000000", quoteId: q.id },
    "gateway-b",
  );
  expect(b.execution_mode).toBe("queued");
  expect((await marketStatus()).buyUsed).toBe("300000000");
  await simulate(a.id, "failure");
  await verify(a.id);
  expect((await marketStatus()).buyUsed).toBe("0");
});
it("queued gateway buy reserves only verified funds; cancelling before verify credits late money once without trading", async () => {
  await clock(CLOSED);
  const o = await place("buy", { amount: "600000000" }, randomUUID());
  expect(o.execution_mode).toBe("queued");
  await simulate(o.id, "success");
  await cancelOrder(o.id);
  await Promise.all([verify(o.id), verify(o.id)]);
  await callback(o.id);
  await verify(o.id);
  expect((await order(o.id)).status).toBe("cancelled");
  expect(await balances()).toMatchObject({
    rials: "600000000",
    reservedRials: "0",
    goldUg: "0",
  });
});
it("a funded queued gateway buy settles once after market opens, with no second topup", async () => {
  await clock(CLOSED);
  const o = await place("buy", { amount: "600000000" }, randomUUID());
  await simulate(o.id, "success");
  await verify(o.id);
  expect((await order(o.id)).status).toBe("queued");
  expect((await balances()).reservedRials).toBe("600000000");
  await clock("2026-11-18T09:00:00+03:30");
  await executeQueued(o.id);
  await verify(o.id);
  expect((await order(o.id)).status).toBe("completed");
  expect((await balances()).reservedRials).toBe("0");
  expect(
    (
      await pool.query(
        "SELECT * FROM journals WHERE order_id=$1 AND purpose='topup'",
        [o.id],
      )
    ).rows,
  ).toHaveLength(1);
});
it("inside-to-outside market boundary is rechecked when a gateway payment happens", async () => {
  await clock("2026-11-17T14:59:50+03:30");
  const q = await quote();
  const o = await place(
    "buy",
    { amount: "600000000", quoteId: q.id },
    randomUUID(),
  );
  await clock("2026-11-17T15:00:00+03:30");
  await simulate(o.id, "success");
  await verify(o.id);
  expect((await order(o.id)).status).toBe("queued");
  expect((await balances()).goldUg).toBe("0");
});
it("worker scheduling is idempotent and never releases queued funds on Friday", async () => {
  const o = await queuedBuy();
  await clock("2026-11-20T12:00:00+03:30");
  await scheduleQueued();
  expect(await executeQueued(o.id)).toBe(false);
  expect((await order(o.id)).status).toBe("queued");
  await clock("2026-11-21T09:00:00+03:30");
  await Promise.all([scheduleQueued(), scheduleQueued()]);
  expect(
    (
      await pool.query(
        "SELECT * FROM outbox WHERE type='execute_queued' AND order_id=$1",
        [o.id],
      )
    ).rows,
  ).toHaveLength(1);
});

it("execution winning before cancellation returns conflict and never returns spent reservations", async () => {
  const o = await queuedBuy();
  await clock("2026-11-18T09:00:00+03:30");
  await executeQueued(o.id);
  await expect(cancelOrder(o.id)).rejects.toThrow("قابل لغو نیست");
  expect((await balances()).reservedRials).toBe("0");
  expect((await order(o.id)).status).toBe("completed");
});
it("a 15-minute feed pause across opening keeps queued assets reserved and resumes at the first delivered opening tick", async () => {
  const o = await queuedBuy();
  await clock("2026-11-18T08:59:00+03:30");
  await api.inject({
    method: "POST",
    url: "/api/mock/market",
    payload: { pauseFeed: true },
  });
  await clock("2026-11-18T09:00:00+03:30");
  for (let i = 0; i < 10; i++) expect(await executeQueued(o.id)).toBe(false);
  expect((await order(o.id)).status).toBe("queued");
  expect((await balances()).reservedRials).toBe("600000000");
  await clock("2026-11-18T09:14:00+03:30");
  expect(await executeQueued(o.id)).toBe(true);
  const first = (
    await pool.query("SELECT * FROM opening_prices WHERE session_open=$1", [
      o.execute_after,
    ])
  ).rows[0];
  expect(first.published_at.toISOString()).toBe("2026-11-18T05:44:00.000Z");
  expect((await order(o.id)).execution_price).toBe(first.price);
});

it("multiple feed gaps do not replace the first opening tick with a later quote", async () => {
  const o = await queuedBuy();
  await clock("2026-11-18T08:59:00+03:30");
  await api.inject({
    method: "POST",
    url: "/api/mock/market",
    payload: { pauseFeed: true },
  });
  await clock("2026-11-18T09:30:00+03:30");
  await api.inject({
    method: "POST",
    url: "/api/mock/market",
    payload: { pauseFeed: true },
  });
  await clock("2026-11-18T10:00:00+03:30");
  await executeQueued(o.id);
  const first = (
    await pool.query("SELECT * FROM opening_prices WHERE session_open=$1", [
      o.execute_after,
    ])
  ).rows[0];
  expect(first.published_at.toISOString()).toBe("2026-11-18T05:44:00.000Z");
  expect((await order(o.id)).execution_price).toBe(first.price);
});

it("recovery between publication ticks does not invent a price that fell inside the gap", async () => {
  const o = await queuedBuy();
  await clock("2026-11-18T08:59:15+03:30");
  await api.inject({
    method: "POST",
    url: "/api/mock/market",
    payload: { pauseFeed: true },
  });
  await clock("2026-11-18T09:14:15+03:30");
  expect(await executeQueued(o.id)).toBe(false);
  await clock("2026-11-18T09:14:30+03:30");
  expect(await executeQueued(o.id)).toBe(true);
  const first = (
    await pool.query("SELECT * FROM opening_prices WHERE session_open=$1", [
      o.execute_after,
    ])
  ).rows[0];
  expect(first.published_at.toISOString()).toBe("2026-11-18T05:44:30.000Z");
});

it("an off-phase provider epoch waits for the actual first tick at opening instead of inventing a pre-opening tick", async () => {
  const o = await queuedBuy();
  await pool.query(
    "UPDATE mock_settings SET price_epoch='2026-11-17T09:00:17+03:30' WHERE id=1",
  );
  await clock("2026-11-18T09:00:00+03:30");
  await expect(quote()).rejects.toThrow("کهنه");
  expect(await executeQueued(o.id)).toBe(false);
  await clock("2026-11-18T09:00:17+03:30");
  expect(await executeQueued(o.id)).toBe(true);
  const first = (
    await pool.query("SELECT * FROM opening_prices WHERE session_open=$1", [
      o.execute_after,
    ])
  ).rows[0];
  expect(first.published_at.toISOString()).toBe("2026-11-18T05:30:17.000Z");
});
