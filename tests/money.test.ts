import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pool, tx } from "../src/db.js";
import {
  quote,
  place,
  simulate,
  verify,
  balances,
  reconcile,
  settleWithdrawal,
  callback,
  validSheba,
} from "../src/domain.js";
import { priceBreaker, makePriceBreaker } from "../src/providers.js";
import { app } from "../src/server.js";
const api = app();
beforeAll(async () => {
  if (!pool.options.connectionString?.includes("avand_test"))
    throw Error("Tests require avand_test database");
  await pool.query(
    await readFile(new URL("../src/schema.sql", import.meta.url), "utf8"),
  );
  await api.ready();
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE events,outbox,entries,journals,gateway_transactions,orders,quotes,reconciliation_reports RESTART IDENTITY CASCADE",
  );
  await pool.query(
    "UPDATE mock_settings SET price_outage=false,gateway_outage=false WHERE id=1",
  );
  priceBreaker.close();
});
afterAll(async () => {
  await api.close();
  await pool.end();
});
async function buy(amount = "100000000") {
  const q = await quote();
  return place("buy", { amount, quoteId: q.id }, randomUUID());
}
async function paid() {
  const o = await buy();
  await simulate(o.id, "success");
  await verify(o.id);
  return o;
}
describe("Seven required money scenarios (real PostgreSQL)", () => {
  it("1: duplicate callbacks and concurrent verification credit gold exactly once", async () => {
    const o = await buy();
    await simulate(o.id, "duplicate");
    await Promise.all(Array.from({ length: 10 }, () => verify(o.id)));
    expect((await balances()).goldUg).toBe("990000");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM journals WHERE order_id=$1 AND purpose='buy'",
          [o.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("2: 100 concurrent HTTP requests with one key return one identical order", async () => {
    const q = await quote(),
      key = randomUUID(),
      payload = { kind: "buy", amount: "10000000", quoteId: q.id };
    const rs = await Promise.all(
      Array.from({ length: 100 }, () =>
        api.inject({
          method: "POST",
          url: "/api/orders",
          headers: { "idempotency-key": key },
          payload,
        }),
      ),
    );
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body)).size).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n,
    ).toBe(1);
    const conflict = await api.inject({
      method: "POST",
      url: "/api/orders",
      headers: { "idempotency-key": key },
      payload: { ...payload, amount: "20000000" },
    });
    expect(conflict.statusCode).toBe(409);
    const id = rs[0].json().id;
    await simulate(id, "success");
    await verify(id);
    const replay = await api.inject({
      method: "POST",
      url: "/api/orders",
      headers: { "idempotency-key": key },
      payload,
    });
    expect(replay.body).toBe(rs[0].body);
    expect(
      (await api.inject({ method: "GET", url: "/api/orders/" + id })).json()
        .status,
    ).toBe("completed");
  });
  it("3: two simultaneous sells cannot spend more gold than held", async () => {
    await paid();
    const q = await quote();
    const rs = await Promise.allSettled([
      place("sell", { gold: "600000", quoteId: q.id }, randomUUID()),
      place("sell", { gold: "600000", quoteId: q.id }, randomUUID()),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rs.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await balances()).goldUg).toBe("390000");
  });
  it("4: money paid after price expiry is credited as rials without gold", async () => {
    const o = await buy();
    await pool.query(
      "UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
      [o.quote_id],
    );
    await simulate(o.id, "late");
    await verify(o.id);
    expect(await balances()).toMatchObject({ rials: "100000000", goldUg: "0" });
    expect(
      (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id]))
        .rows[0].status,
    ).toBe("credited_to_wallet");
  });
  it("5: missing callback is recovered by gateway inquiry after the configured delay", async () => {
    const o = await buy();
    await simulate(o.id, "missing");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM events WHERE type='callback_received'",
        )
      ).rows[0].n,
    ).toBe(0);
    const job = (
      await pool.query("SELECT * FROM outbox WHERE order_id=$1", [o.id])
    ).rows[0];
    expect(job.type).toBe("verify");
    expect(new Date(job.available_at).getTime()).toBeGreaterThan(
      new Date(o.created_at).getTime(),
    );
    await verify(o.id);
    expect((await balances()).goldUg).toBe("990000");
  });
  it("6: every committed operation balances per asset and DB rejects an unbalanced journal", async () => {
    await paid();
    const q = await quote();
    await place("sell", { gold: "500000", quoteId: q.id }, randomUUID());
    const withdrawal = await place(
      "withdraw",
      { amount: "100000", sheba: "IR820540102680020817909002" },
      randomUUID(),
    );
    await settleWithdrawal(withdrawal.id);
    const sums = (
      await pool.query(
        "SELECT asset,sum(amount)::text AS total FROM entries GROUP BY asset",
      )
    ).rows;
    expect(sums.every((s) => s.total === "0")).toBe(true);
    await expect(
      tx(async (c) => {
        const id = randomUUID();
        await c.query("INSERT INTO journals(id,purpose) VALUES($1,'invalid')", [
          id,
        ]);
        await c.query(
          "INSERT INTO entries(journal_id,account,asset,amount) VALUES($1,'test','IRR',100)",
          [id],
        );
      }),
    ).rejects.toThrow("unbalanced journal");
  });
  it("7: reconciliation reports gateway-only and ledger-only independently", async () => {
    const ledgerOnly = await paid();
    await pool.query(
      "UPDATE gateway_transactions SET status='failed' WHERE order_id=$1",
      [ledgerOnly.id],
    );
    const gatewayOnly = await buy();
    await simulate(gatewayOnly.id, "missing");
    const report = await reconcile();
    expect(report.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          order_id: ledgerOnly.id,
          type: "ledger_only",
        }),
        expect.objectContaining({
          order_id: gatewayOnly.id,
          type: "gateway_only",
        }),
      ]),
    );
  });
});
describe("Additional correctness boundaries", () => {
  it("late callback for an on-time payment honors the original quote", async () => {
    const o = await buy();
    await simulate(o.id, "missing");
    await pool.query(
      "UPDATE quotes SET expires_at=(SELECT paid_at+interval '1 millisecond' FROM gateway_transactions WHERE order_id=$2) WHERE id=$1",
      [o.quote_id, o.id],
    );
    await callback(o.id);
    await verify(o.id);
    expect((await balances()).goldUg).toBe("990000");
  });
  it("failed verification creates no financial entries", async () => {
    const o = await buy();
    await simulate(o.id, "failed_verify");
    await verify(o.id);
    expect(await balances()).toMatchObject({ rials: "0", goldUg: "0" });
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM entries")).rows[0].n,
    ).toBe(0);
  });
  it("price outage opens breaker and never returns a fallback trading quote", async () => {
    await pool.query("UPDATE mock_settings SET price_outage=true WHERE id=1");
    const isolated = makePriceBreaker();
    try {
      for (let i = 0; i < 3; i++)
        await expect(isolated.fire()).rejects.toThrow();
      expect(isolated.opened).toBe(true);
      await expect(quote()).rejects.toThrow();
    } finally {
      isolated.shutdown();
    }
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM quotes")).rows[0].n,
    ).toBe(0);
  });
  it("withdrawal settlement is idempotent and reservation prevents concurrent overspend", async () => {
    await paid();
    const q = await quote();
    await place("sell", { gold: "990000", quoteId: q.id }, randomUUID());
    const rs = await Promise.allSettled([
      place(
        "withdraw",
        { amount: "70000000", sheba: "IR820540102680020817909002" },
        randomUUID(),
      ),
      place(
        "withdraw",
        { amount: "70000000", sheba: "IR820540102680020817909002" },
        randomUUID(),
      ),
    ]);
    expect(rs.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const o = (
      rs.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<any>
    ).value;
    await Promise.all([settleWithdrawal(o.id), settleWithdrawal(o.id)]);
    expect((await balances()).reservedRials).toBe("0");
  });
  it("ledger entries cannot be edited or deleted", async () => {
    await paid();
    await expect(pool.query("UPDATE entries SET amount=0")).rejects.toThrow(
      "append-only",
    );
    await expect(pool.query("DELETE FROM entries")).rejects.toThrow(
      "append-only",
    );
  });
  it("validates Sheba checksum and positive integral money", async () => {
    expect(validSheba("IR820540102680020817909002")).toBe(true);
    expect(validSheba("IR000540102680020817909002")).toBe(false);
    await expect(
      place("buy", { amount: 1.1, quoteId: randomUUID() }, "key"),
    ).rejects.toThrow("positive integer");
  });
});
