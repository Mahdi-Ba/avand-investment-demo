import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
} from "vitest";
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
  resolveVerification,
} from "../src/domain.js";
import {
  priceBreaker,
  makePriceBreaker,
  priceSnapshot,
} from "../src/providers.js";
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
    "UPDATE mock_settings SET price_outage=false,gateway_outage=false,price=100000000,price_epoch=now() WHERE id=1",
  );
  priceBreaker.close();
});
afterEach(async () => {
  expect(
    (
      await pool.query(
        "SELECT journal_id,asset FROM entries GROUP BY journal_id,asset HAVING sum(amount)<>0",
      )
    ).rows,
  ).toEqual([]);
  const b = await balances();
  for (const amount of Object.values(b))
    expect(BigInt(amount)).toBeGreaterThanOrEqual(0n);
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
    const payment = (
      await pool.query("SELECT * FROM gateway_transactions WHERE order_id=$1", [
        o.id,
      ])
    ).rows[0];
    expect(payment.status).toBe("paid");
    expect(payment.paid_at).not.toBeNull();
    expect(payment.verification_status).toBe("rejected");
    expect(
      (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id]))
        .rows[0].status,
    ).toBe("verification_failed");
    expect((await reconcile()).mismatches).toEqual([
      expect.objectContaining({ order_id: o.id, type: "gateway_only" }),
    ]);
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

async function topup(amount = "100000000") {
  const o = await place("topup", { amount }, randomUUID());
  await simulate(o.id, "success");
  await verify(o.id);
  return o;
}
describe("Wallet funding and purchases", () => {
  it("independent top-up survives a pending inquiry and duplicate verification without buying gold", async () => {
    const key = randomUUID();
    const payload = { kind: "topup", amount: "100000000" };
    const created = await api.inject({
      method: "POST",
      url: "/api/orders",
      headers: { "idempotency-key": key },
      payload,
    });
    expect(created.statusCode).toBe(200);
    const o = created.json();
    expect(o.quote_id).toBeNull();
    expect(o.fee).toBe("0");
    expect(await verify(o.id)).toBe(false);
    await simulate(o.id, "duplicate");
    await Promise.all(Array.from({ length: 10 }, () => verify(o.id)));
    expect(await balances()).toMatchObject({ rials: "100000000", goldUg: "0" });
    expect(
      (
        await pool.query("SELECT purpose FROM journals WHERE order_id=$1", [
          o.id,
        ])
      ).rows,
    ).toEqual([{ purpose: "topup" }]);
    const replay = await api.inject({
      method: "POST",
      url: "/api/orders",
      headers: { "idempotency-key": key },
      payload,
    });
    expect(replay.body).toBe(created.body);
    expect((await reconcile()).mismatches).toEqual([]);
  });
  it("100 concurrent wallet buys sharing a key debit once with no new gateway transaction", async () => {
    await topup();
    const q = await quote(),
      key = randomUUID(),
      payload = {
        kind: "buy",
        amount: "10000000",
        quoteId: q.id,
        fundingSource: "wallet",
      };
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        api.inject({
          method: "POST",
          url: "/api/orders",
          headers: { "idempotency-key": key },
          payload,
        }),
      ),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    const o = responses[0].json();
    expect(o.status).toBe("completed");
    expect(await balances()).toMatchObject({
      rials: "90000000",
      goldUg: "99000",
    });
    expect(
      (
        await pool.query(
          "SELECT * FROM gateway_transactions WHERE order_id=$1",
          [o.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await pool.query("SELECT * FROM outbox WHERE order_id=$1", [o.id])).rows,
    ).toEqual([]);
    const conflict = await api.inject({
      method: "POST",
      url: "/api/orders",
      headers: { "idempotency-key": key },
      payload: { ...payload, fundingSource: "gateway" },
    });
    expect(conflict.statusCode).toBe(409);
  });
  it("two distinct simultaneous wallet buys cannot spend the same rial balance", async () => {
    await topup();
    const q = await quote();
    const rs = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        place(
          "buy",
          { amount: "70000000", quoteId: q.id, fundingSource: "wallet" },
          randomUUID(),
        ),
      ),
    );
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rs.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await balances()).toMatchObject({
      rials: "30000000",
      goldUg: "693000",
    });
  });
  it("a wallet purchase and a withdrawal serialize spending on the same wallet", async () => {
    await topup();
    const q = await quote();
    const rs = await Promise.allSettled([
      place(
        "buy",
        { amount: "70000000", quoteId: q.id, fundingSource: "wallet" },
        randomUUID(),
      ),
      place(
        "withdraw",
        { amount: "70000000", sheba: "IR820540102680020817909002" },
        randomUUID(),
      ),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rs.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await balances()).rials).toBe("30000000");
  });
  it("insufficient funds and an expired quote create no wallet buy or financial entries", async () => {
    const q = await quote();
    await expect(
      place(
        "buy",
        { amount: "10000000", quoteId: q.id, fundingSource: "wallet" },
        randomUUID(),
      ),
    ).rejects.toThrow("کافی نیست");
    expect((await pool.query("SELECT * FROM orders")).rows).toEqual([]);
    await topup();
    const before = await balances();
    await pool.query(
      "UPDATE quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
      [q.id],
    );
    await expect(
      place(
        "buy",
        { amount: "10000000", quoteId: q.id, fundingSource: "wallet" },
        randomUUID(),
      ),
    ).rejects.toThrow("منقضی");
    expect(await balances()).toEqual(before);
    expect(
      (await pool.query("SELECT * FROM orders WHERE kind='buy'")).rows,
    ).toEqual([]);
  });
  it("wallet buy rounding leaves unspent fractional-gold rials in the wallet", async () => {
    await topup("10001");
    const q = await quote();
    const o = await place(
      "buy",
      { amount: "10001", quoteId: q.id, fundingSource: "wallet" },
      randomUUID(),
    );
    expect(o.fee).toBe("101");
    expect(o.gold).toBe("99");
    expect(await balances()).toMatchObject({ rials: "0", goldUg: "99" });
    // At this price a slightly different inclusive amount leaves a genuine residual.
    await topup("10002");
    const second = await place(
      "buy",
      { amount: "10002", quoteId: q.id, fundingSource: "wallet" },
      randomUUID(),
    );
    expect(second.gold).toBe("99");
    expect(await balances()).toMatchObject({ rials: "1", goldUg: "198" });
  });
  it("a declined independent top-up never credits the wallet", async () => {
    const o = await place("topup", { amount: "10000000" }, randomUUID());
    await simulate(o.id, "failure");
    await verify(o.id);
    expect(
      (
        await pool.query(
          "SELECT status FROM gateway_transactions WHERE order_id=$1",
          [o.id],
        )
      ).rows[0].status,
    ).toBe("failed");
    expect(
      (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id]))
        .rows[0].status,
    ).toBe("payment_failed");
    expect(await balances()).toMatchObject({ rials: "0", goldUg: "0" });
    expect((await reconcile()).mismatches).toEqual([]);
  });
});
describe("Thirty-second price feed", () => {
  it("changes at the exact 30s boundary and is stable inside a slot", () => {
    const epoch = new Date("2026-11-17T00:00:00Z");
    const at = (ms: number) =>
      priceSnapshot(100000000n, epoch, new Date(epoch.getTime() + ms));
    expect(at(0).price).toBe("100000000");
    expect(at(29999)).toEqual(at(0));
    expect(at(30000).price).toBe("100250000");
    expect(at(59999)).toEqual(at(30000));
    expect(at(60000).price).toBe("99850000");
    expect(at(30000).publishedAt).toBe("2026-11-17T00:00:30.000Z");
  });
  it("updates the API quote and indicative price but executes an existing lock at its original price", async () => {
    await topup();
    const locked = await quote();
    await pool.query(
      "UPDATE mock_settings SET price_epoch=now()-interval '31 seconds' WHERE id=1",
    );
    const fresh = await quote();
    expect(locked.price).toBe("100000000");
    expect(fresh.price).toBe("100250000");
    const display = await api.inject({ method: "GET", url: "/api/price" });
    expect(display.json().price).toBe(fresh.price);
    expect(display.json().publishedAt).toBeDefined();
    const o = await place(
      "buy",
      { amount: "100000000", quoteId: locked.id, fundingSource: "wallet" },
      randomUUID(),
    );
    expect(o.gold).toBe("990000");
    expect(
      (await pool.query("SELECT price FROM quotes WHERE id=$1", [locked.id]))
        .rows[0].price,
    ).toBe(locked.price);
  });
});
describe("Charged but rejected verification", () => {
  for (const kind of ["topup", "buy"] as const) {
    it(`${kind}: holds charged money outside available balance, reports it, then settles exactly once after explicit mock resolution`, async () => {
      const q = kind === "buy" ? await quote() : null;
      const o = await place(
        kind,
        { amount: "10000000", ...(q ? { quoteId: q.id } : {}) },
        randomUUID(),
      );
      await simulate(o.id, "failed_verify");
      await Promise.all([verify(o.id), verify(o.id)]);
      expect(await balances()).toMatchObject({ rials: "0", goldUg: "0" });
      const detail = (
        await api.inject({ method: "GET", url: "/api/orders/" + o.id })
      ).json();
      expect(detail.status).toBe("verification_failed");
      expect(detail.payment.status).toBe("paid");
      expect(detail.payment.verification_status).toBe("rejected");
      expect((await reconcile()).mismatches).toEqual([
        expect.objectContaining({ type: "gateway_only", order_id: o.id }),
      ]);
      if (q)
        await pool.query(
          "UPDATE quotes SET expires_at=(SELECT paid_at+interval '1 millisecond' FROM gateway_transactions WHERE order_id=$2) WHERE id=$1",
          [q.id, o.id],
        );
      const resolution = await api.inject({
        method: "POST",
        url: "/api/mock/payments/" + o.id + "/resolve-verification",
        payload: {},
      });
      expect(resolution.statusCode).toBe(200);
      await Promise.all([verify(o.id), verify(o.id)]);
      await resolveVerification(o.id);
      await verify(o.id);
      expect(await balances()).toMatchObject(
        kind === "topup"
          ? { rials: "10000000", goldUg: "0" }
          : { rials: "0", goldUg: "99000" },
      );
      expect((await reconcile()).mismatches).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM journals WHERE order_id=$1 AND purpose='topup'",
            [o.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM events WHERE order_id=$1 AND type='verification_rejected'",
            [o.id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
  }
});
