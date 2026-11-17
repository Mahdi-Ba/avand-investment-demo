import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, tx } from "./db.js";
import { balance, journal, lockWallet } from "./ledger.js";
import { priceBreaker, gatewayBreaker, openingPrice } from "./providers.js";
import { businessNow, marketAt, reserveCap, releaseCap } from "./market.js";
export class Problem extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function integer(value: unknown, name = "amount"): bigint {
  if (
    typeof value !== "string" ||
    !/^\d{1,16}$/.test(value) ||
    BigInt(value) <= 0n ||
    BigInt(value) > 1000000000000000n
  )
    throw new Problem(
      400,
      `${name} must be a positive integer string (max 10^15)`,
    );
  return BigInt(value);
}
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Problem(400, "Invalid identifier");
  return value;
}
export async function event(
  c: PoolClient,
  id: string,
  type: string,
  data: unknown = {},
) {
  await c.query("INSERT INTO events(order_id,type,data) VALUES($1,$2,$3)", [
    id,
    type,
    JSON.stringify(data),
  ]);
}
export async function enqueue(
  c: PoolClient,
  id: string | null,
  type: string,
  delay = 0,
) {
  await c.query(
    "INSERT INTO outbox(id,order_id,type,available_at) VALUES($1,$2,$3,now()+$4*interval '1 second')",
    [randomUUID(), id, type, delay],
  );
}
export async function currentPrice() {
  try {
    return await priceBreaker.fire();
  } catch {
    throw new Problem(
      503,
      "قیمت‌دهنده در دسترس نیست؛ کمی بعد دوباره تلاش کنید.",
    );
  }
}
export async function quote() {
  const snapshot = await currentPrice();
  if (snapshot.stale)
    throw new Problem(409, "قیمت کهنه است؛ منتظر قیمت تازه بمانید.");
  const now = await businessNow();
  const expires = new Date(
    Math.min(
      now.getTime() + 60000,
      Date.parse(snapshot.publishedAt) + marketAt(now).freshnessMs,
    ),
  );
  return (
    await pool.query(
      "INSERT INTO quotes(id,price,provider_published_at,expires_at) VALUES($1,$2,$3,$4) RETURNING *",
      [randomUUID(), snapshot.price, snapshot.publishedAt, expires],
    )
  ).rows[0];
}
function freshQuote(q: any, now: Date) {
  const published = new Date(q.provider_published_at ?? q.created_at).getTime();
  return (
    published <= now.getTime() &&
    now.getTime() - published <= marketAt(now).freshnessMs
  );
}
async function lockedQuote(c: PoolClient, id: string, now: Date) {
  const q = (await c.query("SELECT * FROM quotes WHERE id=$1", [id])).rows[0];
  if (!q || new Date(q.expires_at).getTime() <= now.getTime())
    throw new Problem(409, "قیمت منقضی شده است؛ قیمت تازه بگیرید.");
  if (!freshQuote(q, now))
    throw new Problem(409, "قیمت کهنه است؛ منتظر قیمت تازه بمانید.");
  return q;
}
export async function place(
  kind: "topup" | "buy" | "sell" | "withdraw",
  input: {
    amount?: unknown;
    gold?: unknown;
    quoteId?: unknown;
    sheba?: unknown;
    fundingSource?: unknown;
  },
  key: unknown,
) {
  if (typeof key !== "string" || key.length < 1 || key.length > 128)
    throw new Problem(400, "Idempotency-Key required (1–128 chars)");
  const n = integer(
    kind === "sell" ? input.gold : input.amount,
    kind === "sell" ? "gold" : "amount",
  );
  if (
    input.fundingSource !== undefined &&
    (kind !== "buy" ||
      typeof input.fundingSource !== "string" ||
      !["wallet", "gateway"].includes(input.fundingSource))
  )
    throw new Problem(
      400,
      "fundingSource is only valid for buys: wallet or gateway",
    );
  const fundingSource =
    kind === "buy"
      ? (input.fundingSource ?? "gateway")
      : kind === "topup"
        ? "gateway"
        : "wallet";
  const qid =
    (kind === "sell" || kind === "buy") && input.quoteId !== undefined
      ? uuid(input.quoteId)
      : null;
  const sheba =
    kind === "withdraw"
      ? String(input.sheba ?? "")
          .replace(/\s/g, "")
          .toUpperCase()
      : null;
  if (kind === "withdraw" && (!sheba || !validSheba(sheba)))
    throw new Problem(400, "شماره شبا معتبر نیست.");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        n.toString(),
        qid,
        sheba,
        ...(kind === "buy" && fundingSource === "wallet" ? ["wallet"] : []),
      ]),
    )
    .digest("hex");
  return tx(async (c) => {
    await lockWallet(c);
    const prior = (
      await c.query(
        "SELECT * FROM orders WHERE wallet_id='demo' AND idempotency_key=$1",
        [key],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash)
        throw new Problem(
          409,
          "Idempotency-Key reused with a different request",
        );
      return (
        await c.query(
          "SELECT response FROM idempotency_responses WHERE order_id=$1",
          [prior.id],
        )
      ).rows[0].response;
    }
    const now = await businessNow(c),
      market = marketAt(now);
    let amount = n,
      gold = 0n,
      fee = 0n,
      q: any = null;
    if (kind === "sell") {
      if (!qid) throw new Problem(400, "quoteId required");
      q = await lockedQuote(c, qid, now);
      gold = n;
      const gross = (gold * BigInt(q.price)) / 1000000n;
      fee = (gross + 99n) / 100n;
      amount = gross - fee;
      if (amount <= 0n) throw new Problem(400, "مقدار فروش بسیار کم است.");
      if ((await balance(c, "user:demo", "GOLD_UG")) < gold)
        throw new Problem(409, "موجودی طلا کافی نیست.");
    }
    const cap =
      kind === "buy" || kind === "sell"
        ? await reserveCap(c, kind, kind === "buy" ? amount : amount + fee, now)
        : { allowed: true, day: null, amount: 0n };
    const queued = !cap.allowed;
    if (kind === "buy") {
      fee = (amount + 99n) / 100n;
      if (!queued) {
        if (!qid) throw new Problem(400, "quoteId required");
        q = await lockedQuote(c, qid, now);
        gold = ((amount - fee) * 1000000n) / BigInt(q.price);
        if (gold <= 0n) throw new Problem(400, "مبلغ خرید بسیار کم است.");
      }
    }
    if (
      (kind === "withdraw" || (kind === "buy" && fundingSource === "wallet")) &&
      (await balance(c, "user:demo", "IRR")) < amount
    )
      throw new Problem(409, "موجودی ریالی کافی نیست.");
    const gateway =
      kind === "topup" || (kind === "buy" && fundingSource === "gateway");
    const id = randomUUID(),
      status = gateway
        ? "awaiting_payment"
        : queued
          ? "queued"
          : kind === "withdraw"
            ? "withdrawal_pending"
            : "completed";
    const order = (
      await c.query(
        "INSERT INTO orders(id,wallet_id,kind,idempotency_key,request_hash,quote_id,amount,gold,fee,status,sheba,funding_source,execution_mode,execute_after,cap_day,cap_amount,execution_price) VALUES($1,'demo',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *",
        [
          id,
          kind,
          key,
          hash,
          qid,
          amount.toString(),
          gold.toString(),
          fee.toString(),
          status,
          sheba,
          fundingSource,
          queued ? "queued" : "instant",
          queued ? market.nextOpen : null,
          cap.day,
          cap.amount.toString(),
          !queued && q ? q.price : null,
        ],
      )
    ).rows[0];
    await event(c, id, "order_created", {
      kind,
      status,
      fundingSource,
      executionMode: order.execution_mode,
    });
    if (gateway) await enqueue(c, id, "verify", 5);
    if (queued && !gateway) await reserveQueued(c, order);
    if (kind === "buy" && !queued && !gateway) {
      await executeBuy(c, order);
      await event(c, id, "completed");
    }
    if (kind === "sell" && !queued) {
      await executeSell(c, order);
      await event(c, id, "completed");
    }
    if (kind === "withdraw") {
      await journal(c, id, "reserve", [
        ["user:demo", "IRR", -amount],
        ["user:demo:reserved", "IRR", amount],
      ]);
      await enqueue(c, id, "withdraw", 2);
    }
    const finalOrder = (await c.query("SELECT * FROM orders WHERE id=$1", [id]))
      .rows[0];
    return (
      await c.query(
        "INSERT INTO idempotency_responses(order_id,response) VALUES($1,$2) RETURNING response",
        [id, JSON.stringify(finalOrder)],
      )
    ).rows[0].response;
  });
}
async function reserveQueued(c: PoolClient, o: any) {
  const asset = o.kind === "buy" ? "IRR" : "GOLD_UG",
    amount = BigInt(o.kind === "buy" ? o.amount : o.gold);
  await journal(c, o.id, "queue_reserve", [
    ["user:demo", asset, -amount],
    ["user:demo:reserved", asset, amount],
  ]);
  await c.query("UPDATE orders SET queue_reserved=true WHERE id=$1", [o.id]);
  await event(c, o.id, "queued", {
    executeAfter: o.execute_after,
    asset,
    amount: amount.toString(),
  });
}
async function executeSell(c: PoolClient, o: any, account = "user:demo") {
  const gold = BigInt(o.gold),
    amount = BigInt(o.amount),
    fee = BigInt(o.fee);
  await journal(c, o.id, "sell", [
    [account, "GOLD_UG", -gold],
    ["custodian:inventory", "GOLD_UG", gold],
    ["trading:liquidity", "IRR", -(amount + fee)],
    ["user:demo", "IRR", amount],
    ["revenue:fees", "IRR", fee],
  ]);
}
async function executeBuy(
  c: PoolClient,
  o: { id: string; quote_id: string; gold: string; fee: string },
  account = "user:demo",
) {
  const gold = BigInt(o.gold),
    fee = BigInt(o.fee);
  // The last fractional microgram remains rial cash in the wallet, never silently disappears.
  const p = (
    await c.query("SELECT price FROM quotes WHERE id=$1", [o.quote_id])
  ).rows[0];
  const cost = (gold * BigInt(p.price) + 999999n) / 1000000n;
  await journal(c, o.id, "buy", [
    [account, "IRR", -(cost + fee)],
    ["trading:liquidity", "IRR", cost],
    ["revenue:fees", "IRR", fee],
    ["custodian:inventory", "GOLD_UG", -gold],
    ["user:demo", "GOLD_UG", gold],
  ]);
}
export function validSheba(s: string) {
  if (!/^IR\d{24}$/.test(s)) return false;
  const digits = s.slice(4) + "1827" + s.slice(2, 4);
  let mod = 0;
  for (const ch of digits) mod = (mod * 10 + Number(ch)) % 97;
  return mod === 1;
}
export async function callback(id: string) {
  uuid(id);
  await tx(async (c) => {
    const o = (await c.query("SELECT id FROM orders WHERE id=$1", [id]))
      .rows[0];
    if (!o) throw new Problem(404, "Order not found");
    await event(c, id, "callback_received");
    await enqueue(c, id, "verify");
  });
}
export async function simulate(id: string, mode: string) {
  uuid(id);
  if (
    ![
      "success",
      "failure",
      "duplicate",
      "late",
      "missing",
      "failed_verify",
    ].includes(mode)
  )
    throw new Problem(400, "Invalid gateway scenario");
  await tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (
      !o ||
      !["buy", "topup"].includes(o.kind) ||
      o.funding_source !== "gateway"
    )
      throw new Problem(404, "Gateway-funded order not found");
    const existing = (
      await c.query("SELECT * FROM gateway_transactions WHERE order_id=$1", [
        id,
      ])
    ).rows[0];
    if (existing)
      throw new Problem(
        409,
        "Gateway payment already simulated; create another order",
      );
    if (!["awaiting_payment", "payment_pending"].includes(o.status))
      throw new Problem(409, "Order is final");
    if (
      mode === "late" &&
      o.kind === "buy" &&
      o.execution_mode !== "queued" &&
      (
        await c.query(
          "SELECT expires_at>(SELECT coalesce(clock_override,clock_timestamp()) FROM mock_settings WHERE id=1) AS valid FROM quotes WHERE id=$1",
          [o.quote_id],
        )
      ).rows[0].valid
    )
      throw new Problem(
        409,
        "برای پرداخت دیررس ابتدا منتظر پایان شمارش معکوس بمانید.",
      );
    await c.query(
      "INSERT INTO gateway_transactions(order_id,reference,amount,status,mode,verification_status,paid_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $4='paid' THEN (SELECT coalesce(clock_override,clock_timestamp()) FROM mock_settings WHERE id=1) ELSE NULL END)",
      [
        id,
        randomUUID(),
        o.amount,
        mode === "failure" ? "failed" : "paid",
        mode,
        mode === "failed_verify" ? "rejected" : "verified",
      ],
    );
    await event(c, id, "mock_gateway", { mode });
  });
  if (mode !== "missing") {
    await callback(id);
    if (mode === "duplicate") await callback(id);
  }
}
export async function resolveVerification(id: string) {
  uuid(id);
  await tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!o) throw new Problem(404, "Order not found");
    const payment = (
      await c.query(
        "SELECT * FROM gateway_transactions WHERE order_id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (
      !payment ||
      payment.mode !== "failed_verify" ||
      payment.status !== "paid"
    )
      throw new Problem(409, "No charged payment with failed verification");
    if (payment.verification_status === "verified") return;
    if (
      ![
        "awaiting_payment",
        "payment_pending",
        "verification_failed",
        "payment_review",
        "cancelled",
      ].includes(o.status)
    )
      throw new Problem(409, "Order is final");
    await c.query(
      "UPDATE gateway_transactions SET verification_status='verified' WHERE order_id=$1",
      [id],
    );
    await event(c, id, "mock_verification_resolved");
    await enqueue(c, id, "verify");
  });
}
export async function verify(id: string) {
  const payment = await gatewayBreaker.fire(id);
  return tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query(
        "SELECT o.*,q.expires_at,q.provider_published_at,q.created_at AS quote_created_at FROM orders o LEFT JOIN quotes q ON q.id=o.quote_id WHERE o.id=$1 FOR UPDATE OF o",
        [id],
      )
    ).rows[0];
    if (
      !o ||
      !["buy", "topup"].includes(o.kind) ||
      o.funding_source !== "gateway" ||
      ![
        "awaiting_payment",
        "payment_pending",
        "payment_review",
        "verification_failed",
        "cancelled",
      ].includes(o.status)
    )
      return true;
    if (
      o.status === "cancelled" &&
      (
        await c.query(
          "SELECT id FROM journals WHERE order_id=$1 AND purpose='topup'",
          [id],
        )
      ).rowCount
    )
      return true;
    if (!payment) {
      if (o.status === "cancelled") return true;
      if (
        Date.now() - new Date(o.created_at).getTime() >
        Number(process.env.PAYMENT_DEADLINE_MS ?? 1800000)
      ) {
        await releaseCap(c, o);
        await c.query(
          "UPDATE orders SET status='payment_failed',updated_at=now() WHERE id=$1",
          [id],
        );
        await event(c, id, "payment_not_found");
        return true;
      }
      if (o.status !== "payment_pending") {
        await c.query(
          "UPDATE orders SET status='payment_pending',updated_at=now() WHERE id=$1",
          [id],
        );
        await event(c, id, "payment_pending");
      }
      return false;
    }
    if (payment.status === "failed") {
      await releaseCap(c, o);
      if (o.status !== "cancelled")
        await c.query(
          "UPDATE orders SET status='payment_failed',updated_at=now() WHERE id=$1",
          [id],
        );
      await event(c, id, "verify_failed");
      return true;
    }
    if (BigInt(payment.amount) !== BigInt(o.amount))
      throw Error("Gateway amount mismatch: manual review required");
    if (payment.verification_status === "rejected") {
      if (!["verification_failed", "cancelled"].includes(o.status)) {
        await c.query(
          "UPDATE orders SET status='verification_failed',updated_at=now() WHERE id=$1",
          [id],
        );
        await event(c, id, "verification_rejected", {
          reference: payment.reference,
          charged: true,
        });
      }
      return true;
    }
    const amount = BigInt(o.amount),
      paidAt = new Date(payment.paid_at);
    await journal(c, id, "topup", [
      ["gateway:clearing", "IRR", -amount],
      ["user:demo", "IRR", amount],
    ]);
    if (o.status === "cancelled") {
      await event(c, id, "cancelled_payment_credited");
      return true;
    }
    if (o.kind === "topup") {
      await c.query(
        "UPDATE orders SET status='completed',updated_at=now() WHERE id=$1",
        [id],
      );
      await event(c, id, "completed");
      return true;
    }
    await releaseCap(c, o);
    const late =
      o.execution_mode !== "queued" &&
      (paidAt.getTime() > new Date(o.expires_at).getTime() ||
        !freshQuote({ ...o, created_at: o.quote_created_at }, paidAt));
    if (late) {
      await c.query(
        "UPDATE orders SET status='credited_to_wallet',updated_at=now() WHERE id=$1",
        [id],
      );
      await event(c, id, "credited_to_wallet");
      return true;
    }
    const cap =
      o.execution_mode === "queued"
        ? { allowed: false, day: null, amount: 0n }
        : await reserveCap(c, "buy", amount, paidAt);
    if (!cap.allowed) {
      const intended = o.execute_after
        ? new Date(o.execute_after)
        : marketAt(paidAt).nextOpen;
      const target = paidAt >= intended ? marketAt(paidAt).nextOpen : intended;
      await c.query(
        "UPDATE orders SET status='queued',execution_mode='queued',execute_after=$2,gold=0,execution_price=NULL,updated_at=now() WHERE id=$1",
        [id, target],
      );
      await reserveQueued(c, { ...o, gold: "0", execute_after: target });
      return true;
    }
    await c.query("UPDATE orders SET cap_day=$2,cap_amount=$3 WHERE id=$1", [
      id,
      cap.day,
      cap.amount.toString(),
    ]);
    await executeBuy(c, o);
    await c.query(
      "UPDATE orders SET status='completed',updated_at=now() WHERE id=$1",
      [id],
    );
    await event(c, id, "completed", { reference: payment.reference });
    return true;
  });
}
export async function cancelOrder(id: string) {
  uuid(id);
  return tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!o) throw new Problem(404, "Order not found");
    if (o.status === "cancelled") return o;
    if (
      o.execution_mode !== "queued" ||
      ![
        "queued",
        "awaiting_payment",
        "payment_pending",
        "verification_failed",
        "payment_review",
      ].includes(o.status)
    )
      throw new Problem(409, "سفارش اجرا شده یا قابل لغو نیست.");
    if (o.queue_reserved) {
      const asset = o.kind === "buy" ? "IRR" : "GOLD_UG",
        value = BigInt(o.kind === "buy" ? o.amount : o.gold);
      await journal(c, id, "queue_release", [
        ["user:demo:reserved", asset, -value],
        ["user:demo", asset, value],
      ]);
    }
    await releaseCap(c, o);
    await c.query(
      "UPDATE orders SET status='cancelled',queue_reserved=false,updated_at=now() WHERE id=$1",
      [id],
    );
    await event(c, id, "cancelled");
    return (await c.query("SELECT * FROM orders WHERE id=$1", [id])).rows[0];
  });
}
export async function scheduleQueued() {
  const now = await businessNow();
  if (!marketAt(now).isOpen) return;
  await pool.query(
    "INSERT INTO outbox(id,order_id,type) SELECT gen_random_uuid(),o.id,'execute_queued' FROM orders o WHERE o.status='queued' AND o.queue_reserved AND o.execute_after<=$1 AND NOT EXISTS(SELECT 1 FROM outbox b WHERE b.order_id=o.id AND b.type='execute_queued' AND b.completed_at IS NULL) ON CONFLICT DO NOTHING",
    [now],
  );
}
export async function executeQueued(id: string) {
  const now = await businessNow();
  if (!marketAt(now).isOpen) return false;
  const candidate = (await pool.query("SELECT * FROM orders WHERE id=$1", [id]))
    .rows[0];
  if (!candidate || candidate.status !== "queued") return true;
  if (new Date(candidate.execute_after) > now) return false;
  let current: Awaited<ReturnType<typeof currentPrice>>;
  try {
    current = await currentPrice();
  } catch (e) {
    if (e instanceof Problem && e.statusCode === 503) return false;
    throw e;
  }
  if (current.stale) return false; // Expected feed gaps wait without exhausting the error budget.
  let first: Awaited<ReturnType<typeof openingPrice>>;
  try {
    first = await openingPrice(new Date(candidate.execute_after), now);
  } catch (e) {
    if (
      e instanceof Error &&
      e.message === "First opening price has not arrived"
    )
      return false;
    throw e;
  }
  return tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!o || o.status !== "queued") return true;
    const at = await businessNow(c);
    if (!marketAt(at).isOpen || new Date(o.execute_after) > at) return false;
    if (!o.queue_reserved) throw Error("Queued assets are not reserved");
    if (
      at.getTime() - Date.parse(current.publishedAt) >
      marketAt(at).freshnessMs
    )
      throw Error("Price became stale while waiting for wallet lock");
    const price = BigInt(first.price),
      quoteId = randomUUID();
    await c.query(
      "INSERT INTO quotes(id,price,expires_at,provider_published_at) VALUES($1,$2,$3,$4)",
      [
        quoteId,
        first.price,
        new Date(at.getTime() + 60000),
        first.published_at,
      ],
    );
    let amount = BigInt(o.amount),
      gold = BigInt(o.gold),
      fee: bigint;
    if (o.kind === "buy") {
      fee = (amount + 99n) / 100n;
      gold = ((amount - fee) * 1000000n) / price;
      if (gold <= 0n) throw Error("Queued buy too small at opening price");
    } else {
      const gross = (gold * price) / 1000000n;
      fee = (gross + 99n) / 100n;
      amount = gross - fee;
      if (amount <= 0n) throw Error("Queued sell too small at opening price");
    }
    const execution = {
      ...o,
      quote_id: quoteId,
      amount: amount.toString(),
      gold: gold.toString(),
      fee: fee.toString(),
    };
    if (o.kind === "buy") {
      await executeBuy(c, execution, "user:demo:reserved");
      const cost = (gold * price + 999999n) / 1000000n,
        change = BigInt(o.amount) - cost - fee;
      if (change > 0n)
        await journal(c, id, "queue_change", [
          ["user:demo:reserved", "IRR", -change],
          ["user:demo", "IRR", change],
        ]);
    } else await executeSell(c, execution, "user:demo:reserved");
    await c.query(
      "UPDATE orders SET status='completed',queue_reserved=false,quote_id=$2,amount=$3,gold=$4,fee=$5,execution_price=$6,updated_at=now() WHERE id=$1",
      [
        id,
        quoteId,
        amount.toString(),
        gold.toString(),
        fee.toString(),
        first.price,
      ],
    );
    await event(c, id, "queued_executed", {
      price: first.price,
      publishedAt: first.published_at,
      sessionOpen: o.execute_after,
    });
    return true;
  });
}
export async function settleWithdrawal(id: string) {
  await tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!o || o.status !== "withdrawal_pending") return;
    await journal(c, id, "withdraw", [
      ["user:demo:reserved", "IRR", -BigInt(o.amount)],
      ["bank:settlement", "IRR", BigInt(o.amount)],
    ]);
    await c.query(
      "UPDATE orders SET status='completed',updated_at=now() WHERE id=$1",
      [id],
    );
    await event(c, id, "mock_bank_settled");
  });
}
export async function reconcile() {
  return tx(async (c) => {
    // One snapshot for both sides: avoid reports containing a half-observed commit.
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const r = await c.query(
      `WITH posted AS (SELECT j.order_id,-sum(e.amount)::bigint AS amount FROM journals j JOIN entries e ON e.journal_id=j.id WHERE j.purpose='topup' AND e.account='gateway:clearing' GROUP BY j.order_id), paid AS (SELECT order_id,amount FROM gateway_transactions WHERE status='paid') SELECT coalesce(p.order_id,l.order_id) AS order_id,p.amount::text AS gateway_amount,l.amount::text AS ledger_amount,CASE WHEN l.order_id IS NULL THEN 'gateway_only' WHEN p.order_id IS NULL THEN 'ledger_only' ELSE 'amount_mismatch' END AS type FROM paid p FULL OUTER JOIN posted l ON p.order_id=l.order_id WHERE p.order_id IS NULL OR l.order_id IS NULL OR p.amount<>l.amount`,
    );
    const report = (
      await c.query(
        "INSERT INTO reconciliation_reports(id,mismatches) VALUES($1,$2) RETURNING *",
        [randomUUID(), JSON.stringify(r.rows)],
      )
    ).rows[0];
    return report;
  });
}
export async function balances() {
  return tx(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    return {
      rials: (await balance(c, "user:demo", "IRR")).toString(),
      goldUg: (await balance(c, "user:demo", "GOLD_UG")).toString(),
      reservedRials: (await balance(c, "user:demo:reserved", "IRR")).toString(),
      reservedGoldUg: (
        await balance(c, "user:demo:reserved", "GOLD_UG")
      ).toString(),
    };
  });
}
export const messages: Record<string, string> = {
  queued:
    "سفارش از سقف خارج ساعات بازار عبور کرده؛ دارایی رزرو شده و با اولین قیمت پس از بازشدن بازار اجرا می‌شود. تا پیش از اجرا می‌توانید لغو کنید.",
  cancelled:
    "سفارش لغو شد؛ رزرو دارایی آزاد است. پرداخت دیررس فقط پس از تأیید درگاه به کیف پول اضافه می‌شود.",
  verification_failed:
    "درگاه کسر وجه را ثبت کرده اما تأیید نهایی پرداخت ناموفق است؛ وجه یا طلا به موجودی اضافه نشده و سفارش در انتظار رفع مغایرت است.",
  payment_review:
    "بررسی خودکار پرداخت متوقف شده؛ پشتیبانی باید وضعیت درگاه را بررسی و پردازش را دوباره اجرا کند. وجه یا طلا دوباره ثبت نشده است.",
  awaiting_payment: "منتظر پرداخت شما هستیم.",
  payment_pending:
    "پرداخت در حال بررسی است؛ در حالت عادی تا ۳۰ دقیقه تعیین تکلیف می‌شود. هنگام قطعی سرویس بررسی ادامه دارد.",
  completed: "عملیات با موفقیت انجام شد.",
  payment_failed: "پرداخت تأیید نشد؛ طلایی تخصیص داده نشده است.",
  credited_to_wallet:
    "پرداخت پس از انقضای قیمت انجام شد؛ مبلغ به کیف پول ریالی برگشت. خرید تازه یا برداشت انجام دهید.",
  withdrawal_pending: "مبلغ رزرو شد؛ در انتظار تسویهٔ بانک شبیه‌سازی‌شده.",
};
