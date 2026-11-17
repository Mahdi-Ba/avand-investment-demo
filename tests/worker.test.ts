import { beforeAll, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import amqp from "amqplib";
import { pool } from "../src/db.js";
import {
  quote,
  place,
  simulate,
  balances,
  resolveVerification,
} from "../src/domain.js";
let worker: ChildProcess;
let output = "";
const queue = "avand.test." + randomUUID();
async function until(fn: () => Promise<boolean>, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + output);
}
beforeAll(async () => {
  if (!pool.options.connectionString?.includes("avand_test"))
    throw Error("Test DB required");
  await pool.query(
    await readFile(new URL("../src/schema.sql", import.meta.url), "utf8"),
  );
  await pool.query(
    "TRUNCATE events,outbox,entries,journals,gateway_transactions,orders,quotes,reconciliation_reports,daily_limits,opening_prices,price_interruptions RESTART IDENTITY CASCADE",
  );
  await pool.query(
    "UPDATE mock_settings SET price_outage=false,gateway_outage=false,price=100000000,price_epoch='2026-11-17T06:00:00Z',clock_override='2026-11-17T06:00:00Z',price_pause_started_at=NULL,price_pause_until=NULL,price_outage_started_at=NULL,price_resumed_at=NULL WHERE id=1",
  );
  worker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
    env: { ...process.env, AMQP_QUEUE: queue },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout?.on("data", (d) => (output += d));
  worker.stderr?.on("data", (d) => (output += d));
  await until(async () => output.includes("Worker ready"));
});
afterAll(async () => {
  if (worker && worker.exitCode === null) {
    const exited = new Promise<void>((r) => worker.once("exit", () => r()));
    worker.kill("SIGTERM");
    await exited;
  }
  const conn = await amqp.connect(
    process.env.AMQP_URL ?? "amqp://avand:avand_local@localhost:5678",
  );
  const ch = await conn.createChannel();
  await ch.deleteQueue(queue);
  await ch.deleteQueue(queue + ".dead");
  await ch.close();
  await conn.close();
  await pool.end();
});
it("real RabbitMQ worker recovers missing callback and replay after publish never doubles credit", async () => {
  const q = await quote(),
    o = await place(
      "buy",
      { amount: "100000000", quoteId: q.id },
      randomUUID(),
    );
  await simulate(o.id, "missing");
  await until(
    async () =>
      (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id]))
        .rows[0].status === "completed",
  );
  expect((await balances()).goldUg).toBe("990000");
  const j = (await pool.query("SELECT * FROM outbox WHERE order_id=$1", [o.id]))
    .rows[0];
  await until(async () =>
    Boolean(
      (await pool.query("SELECT completed_at FROM outbox WHERE id=$1", [j.id]))
        .rows[0].completed_at,
    ),
  );
  // Replay a real persisted message after the financial commit (crash-before-ack equivalent).
  await pool.query(
    "UPDATE outbox SET completed_at=NULL,published_at=NULL,available_at=now() WHERE id=$1",
    [j.id],
  );
  await until(async () =>
    Boolean(
      (await pool.query("SELECT completed_at FROM outbox WHERE id=$1", [j.id]))
        .rows[0].completed_at,
    ),
  );
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

it("provider failure exhausts retries into DLQ and support replay safely recovers", async () => {
  const before = await balances();
  const q = await quote(),
    o = await place("buy", { amount: "10000000", quoteId: q.id }, randomUUID());
  await simulate(o.id, "missing");
  await pool.query("UPDATE mock_settings SET gateway_outage=true WHERE id=1");
  await pool.query(
    "UPDATE outbox SET attempts=7,available_at=now() WHERE order_id=$1",
    [o.id],
  );
  await until(
    async () =>
      (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id]))
        .rows[0].status === "payment_review",
  );
  expect(await balances()).toEqual(before);
  const dead = (
    await pool.query("SELECT * FROM outbox WHERE order_id=$1", [o.id])
  ).rows[0];
  expect(dead.dead).toBe(true);
  const conn = await amqp.connect(
    process.env.AMQP_URL ?? "amqp://avand:avand_local@localhost:5678",
  );
  const channel = await conn.createChannel();
  await until(
    async () => (await channel.checkQueue(queue + ".dead")).messageCount > 0,
  );
  await channel.close();
  await conn.close();
  await pool.query("UPDATE mock_settings SET gateway_outage=false WHERE id=1");
  await pool.query(
    "UPDATE outbox SET dead=false,attempts=0,published_at=NULL,available_at=now() WHERE id=$1",
    [dead.id],
  );
  await until(
    async () =>
      (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id]))
        .rows[0].status === "completed",
  );
  expect(BigInt((await balances()).goldUg) - BigInt(before.goldUg)).toBe(
    99000n,
  );
});

it("async independent top-up completes through RabbitMQ, then wallet buy settles without a payment job", async () => {
  const before = await balances();
  const t = await place("topup", { amount: "10000000" }, randomUUID());
  await simulate(t.id, "duplicate");
  await until(
    async () =>
      (await pool.query("SELECT status FROM orders WHERE id=$1", [t.id]))
        .rows[0].status === "completed",
  );
  expect(BigInt((await balances()).rials) - BigInt(before.rials)).toBe(
    10000000n,
  );
  const q = await quote(),
    buy = await place(
      "buy",
      { amount: "10000000", quoteId: q.id, fundingSource: "wallet" },
      randomUUID(),
    );
  expect(buy.status).toBe("completed");
  expect(BigInt((await balances()).goldUg) - BigInt(before.goldUg)).toBe(
    BigInt(buy.gold),
  );
  expect(
    (await pool.query("SELECT * FROM outbox WHERE order_id=$1", [buy.id])).rows,
  ).toEqual([]);
});
it("async charged/verify-rejected top-up waits for explicit resolution without duplicate funds", async () => {
  const before = await balances();
  const t = await place("topup", { amount: "1000000" }, randomUUID());
  await simulate(t.id, "failed_verify");
  await until(
    async () =>
      (await pool.query("SELECT status FROM orders WHERE id=$1", [t.id]))
        .rows[0].status === "verification_failed",
  );
  expect(await balances()).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT status,verification_status FROM gateway_transactions WHERE order_id=$1",
        [t.id],
      )
    ).rows[0],
  ).toEqual({ status: "paid", verification_status: "rejected" });
  await resolveVerification(t.id);
  await until(
    async () =>
      (await pool.query("SELECT status FROM orders WHERE id=$1", [t.id]))
        .rows[0].status === "completed",
  );
  await resolveVerification(t.id);
  expect(BigInt((await balances()).rials) - BigInt(before.rials)).toBe(
    1000000n,
  );
});

it("real worker automatically schedules a funded market queue at opening and replay never trades twice", async () => {
  const t = await place("topup", { amount: "600000000" }, randomUUID());
  await simulate(t.id, "success");
  await until(
    async () =>
      (await pool.query("SELECT status FROM orders WHERE id=$1", [t.id]))
        .rows[0].status === "completed",
  );
  await pool.query(
    "UPDATE mock_settings SET clock_override='2026-11-17T20:00:00+03:30' WHERE id=1",
  );
  const o = await place(
    "buy",
    { amount: "600000000", fundingSource: "wallet" },
    randomUUID(),
  );
  expect(o.status).toBe("queued");
  expect((await balances()).reservedRials).toBe("600000000");
  await pool.query(
    "UPDATE mock_settings SET clock_override='2026-11-18T09:00:00+03:30' WHERE id=1",
  );
  await until(
    async () =>
      (await pool.query("SELECT status FROM orders WHERE id=$1", [o.id]))
        .rows[0].status === "completed",
  );
  expect((await balances()).reservedRials).toBe("0");
  const job = (
    await pool.query(
      "SELECT * FROM outbox WHERE order_id=$1 AND type='execute_queued'",
      [o.id],
    )
  ).rows[0];
  await until(async () =>
    Boolean(
      (
        await pool.query("SELECT completed_at FROM outbox WHERE id=$1", [
          job.id,
        ])
      ).rows[0].completed_at,
    ),
  );
  await pool.query(
    "UPDATE outbox SET completed_at=NULL,published_at=NULL,available_at=now() WHERE id=$1",
    [job.id],
  );
  await until(async () =>
    Boolean(
      (
        await pool.query("SELECT completed_at FROM outbox WHERE id=$1", [
          job.id,
        ])
      ).rows[0].completed_at,
    ),
  );
  expect(
    (
      await pool.query(
        "SELECT * FROM journals WHERE order_id=$1 AND purpose='buy'",
        [o.id],
      )
    ).rows,
  ).toHaveLength(1);
});
