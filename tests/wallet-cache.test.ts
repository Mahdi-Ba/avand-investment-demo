import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pool, tx } from "../src/db.js";
import { journal, lockWallet } from "../src/ledger.js";
import { balances, place, simulate, verify, quote } from "../src/domain.js";
const schema = await readFile(
  new URL("../src/schema.sql", import.meta.url),
  "utf8",
);
beforeAll(async () => {
  if (!pool.options.connectionString?.includes("avand_test"))
    throw Error("Test DB required");
  await pool.query(schema);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE events,outbox,entries,journals,gateway_transactions,orders,quotes,reconciliation_reports,daily_limits,opening_prices,price_interruptions,scheduled_runs RESTART IDENTITY CASCADE",
  );
  await pool.query(
    "UPDATE mock_settings SET clock_override='2026-11-17T06:00:00Z',price_epoch='2026-11-17T06:00:00Z',price=100000000,price_outage=false,gateway_outage=false,custodian_outage=false,custodian_mode='normal',bank_outage=false,price_pause_started_at=NULL,price_pause_until=NULL,price_outage_started_at=NULL,price_resumed_at=NULL WHERE id=1",
  );
});
afterEach(async () => {
  expect((await pool.query("SELECT * FROM wallet_balance_drift")).rows).toEqual(
    [],
  );
});
afterAll(async () => {
  await pool.end();
});
async function topup() {
  const o = await place("topup", { amount: "10000000" }, randomUUID());
  await simulate(o.id, "success");
  await verify(o.id);
  return o;
}
it("updates all wallet buckets with postings and rolls back cache, journal and entries together", async () => {
  const o = await topup();
  const before = await balances();
  await expect(
    tx(async (c) => {
      await lockWallet(c);
      await journal(c, o.id, "rollback_probe", [
        ["user:demo", "IRR", -1000n],
        ["user:demo:reserved", "IRR", 1000n],
      ]);
      const inside = (
        await c.query(
          "SELECT available_rials,reserved_rials FROM wallets WHERE id='demo'",
        )
      ).rows[0];
      expect(inside).toMatchObject({
        available_rials: "9999000",
        reserved_rials: "1000",
      });
      throw Error("abort after postings");
    }),
  ).rejects.toThrow("abort after postings");
  expect(await balances()).toEqual(before);
  expect(
    (await pool.query("SELECT * FROM journals WHERE purpose='rollback_probe'"))
      .rows,
  ).toEqual([]);
  await tx(async (c) => {
    await lockWallet(c);
    await journal(c, o.id, "gold_seed", [
      ["custodian:inventory", "GOLD_UG", -100n],
      ["user:demo", "GOLD_UG", 100n],
    ]);
    await journal(c, o.id, "reserve_both", [
      ["user:demo", "IRR", -1000n],
      ["user:demo:reserved", "IRR", 1000n],
      ["user:demo", "GOLD_UG", -40n],
      ["user:demo:reserved", "GOLD_UG", 40n],
    ]);
  });
  expect(await balances()).toEqual({
    rials: "9999000",
    reservedRials: "1000",
    goldUg: "60",
    reservedGoldUg: "40",
  });
});
it("an unbalanced or negative committed posting cannot leave a cached balance", async () => {
  const o = await topup(),
    before = await balances();
  // Raw insert bypasses application journal validation: the DB must still roll it back.
  await expect(
    tx(async (c) => {
      const id = randomUUID();
      await c.query(
        "INSERT INTO journals(id,order_id,purpose) VALUES($1,$2,'invalid')",
        [id, o.id],
      );
      await c.query(
        "INSERT INTO entries(journal_id,account,asset,amount) VALUES($1,'user:demo','IRR',1)",
        [id],
      );
    }),
  ).rejects.toThrow("unbalanced journal");
  expect(await balances()).toEqual(before);
  await expect(
    tx(async (c) => {
      await lockWallet(c);
      await journal(c, o.id, "overdraw", [
        ["user:demo", "IRR", -10000001n],
        ["trading:liquidity", "IRR", 10000001n],
      ]);
    }),
  ).rejects.toThrow("Negative wallet balance");
  expect(await balances()).toEqual(before);
});
it("rejects direct cache edits and unknown wallet accounts", async () => {
  await expect(
    pool.query("UPDATE wallets SET available_rials=42 WHERE id='demo'"),
  ).rejects.toThrow("maintained by ledger");
  await expect(
    pool.query("INSERT INTO wallets(id,available_rials) VALUES('fake',42)"),
  ).rejects.toThrow("start at zero");
  const o = await topup();
  await expect(
    tx((c) =>
      journal(c, o.id, "unknown", [
        ["gateway:clearing", "IRR", -1n],
        ["user:missing", "IRR", 1n],
      ]),
    ),
  ).rejects.toThrow("Unknown wallet account");
});
it("two concurrent wallet purchases cannot spend the same cached rials", async () => {
  await topup();
  const q = await quote();
  const results = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      place(
        "buy",
        { amount: "10000000", fundingSource: "wallet", quoteId: q.id },
        randomUUID(),
      ),
    ),
  );
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
  expect((await balances()).rials).toBe("0");
  expect((await balances()).goldUg).toBe("99000");
});
it("migration backfills a legacy ledger and is repeatable without replaying money", async () => {
  await tx(async (c) => {
    const namespace = "upgrade_" + randomUUID().replaceAll("-", "");
    await c.query(`CREATE SCHEMA ${namespace}`);
    await c.query(`SET LOCAL search_path TO ${namespace}`);
    await c.query(
      schema.slice(0, schema.indexOf("-- Synchronous wallet projection.")),
    );
    const id = randomUUID();
    await c.query("INSERT INTO journals(id,purpose) VALUES($1,'legacy')", [id]);
    await c.query(
      "INSERT INTO entries(journal_id,account,asset,amount) VALUES($1,'gateway:clearing','IRR',-300),($1,'user:demo','IRR',200),($1,'user:demo:reserved','IRR',100),($1,'custodian:inventory','GOLD_UG',-70),($1,'user:demo','GOLD_UG',50),($1,'user:demo:reserved','GOLD_UG',20)",
      [id],
    );
    await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    await c.query(schema);
    const read = async () =>
      (
        await c.query(
          "SELECT available_rials,reserved_rials,available_gold_ug,reserved_gold_ug FROM wallets WHERE id='demo'",
        )
      ).rows[0];
    const expected = {
      available_rials: "200",
      reserved_rials: "100",
      available_gold_ug: "50",
      reserved_gold_ug: "20",
    };
    expect(await read()).toEqual(expected);
    await c.query(schema);
    expect(await read()).toEqual(expected);
    expect((await c.query("SELECT * FROM wallet_balance_drift")).rows).toEqual(
      [],
    );
    await c.query(`DROP SCHEMA ${namespace} CASCADE`);
  });
});
it("truncate resets the projection and audit detects privileged drift without silently repairing it", async () => {
  await topup();
  await tx(async (c) => {
    await c.query(
      "ALTER TABLE wallets DISABLE TRIGGER wallets_projection_guard",
    );
    await c.query(
      "UPDATE wallets SET available_rials=available_rials+1 WHERE id='demo'",
    );
    await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    await c.query(
      "ALTER TABLE wallets ENABLE TRIGGER wallets_projection_guard",
    );
  });
  expect(
    (await pool.query("SELECT * FROM wallet_balance_drift")).rows,
  ).toHaveLength(1);
  await pool.query(schema);
  expect(
    (await pool.query("SELECT * FROM wallet_balance_drift")).rows,
  ).toHaveLength(1);
  await pool.query("TRUNCATE entries");
  expect(await balances()).toEqual({
    rials: "0",
    reservedRials: "0",
    goldUg: "0",
    reservedGoldUg: "0",
  });
});
