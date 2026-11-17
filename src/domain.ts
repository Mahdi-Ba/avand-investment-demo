import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, tx } from "./db.js";
import { balance, journal, lockWallet } from "./ledger.js";
import { priceBreaker, gatewayBreaker } from "./providers.js";
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
export async function quote() {
  let price: bigint;
  try {
    price = await priceBreaker.fire();
  } catch {
    throw new Problem(
      503,
      "قیمت‌دهنده در دسترس نیست؛ کمی بعد دوباره تلاش کنید.",
    );
  }
  return (
    await pool.query(
      "INSERT INTO quotes(id,price,expires_at) VALUES($1,$2,now()+interval '60 seconds') RETURNING *",
      [randomUUID(), price.toString()],
    )
  ).rows[0];
}
async function lockedQuote(c: PoolClient, id: string) {
  const q = (
    await c.query(
      "SELECT *,expires_at>clock_timestamp() AS valid FROM quotes WHERE id=$1",
      [uuid(id)],
    )
  ).rows[0];
  if (!q || !q.valid)
    throw new Problem(409, "قیمت منقضی شده است؛ قیمت تازه بگیرید.");
  return q;
}
export async function place(
  kind: "buy" | "sell" | "withdraw",
  input: {
    amount?: unknown;
    gold?: unknown;
    quoteId?: unknown;
    sheba?: unknown;
  },
  key: unknown,
) {
  if (typeof key !== "string" || key.length < 1 || key.length > 128)
    throw new Problem(400, "Idempotency-Key required (1–128 chars)");
  const n = integer(
    kind === "sell" ? input.gold : input.amount,
    kind === "sell" ? "gold" : "amount",
  );
  const qid = kind === "withdraw" ? null : uuid(input.quoteId);
  const sheba =
    kind === "withdraw"
      ? String(input.sheba ?? "")
          .replace(/\s/g, "")
          .toUpperCase()
      : null;
  if (sheba && !validSheba(sheba))
    throw new Problem(400, "شماره شبا معتبر نیست.");
  if (kind === "withdraw" && !sheba) throw new Problem(400, "Sheba required");
  const hash = createHash("sha256")
    .update(JSON.stringify([kind, n.toString(), qid, sheba]))
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
    const q = qid ? await lockedQuote(c, qid) : null;
    let amount = n,
      gold = 0n,
      fee = 0n;
    if (kind === "buy") {
      fee = (n + 99n) / 100n;
      gold = ((n - fee) * 1000000n) / BigInt(q.price);
      if (gold <= 0n) throw new Problem(400, "مبلغ خرید بسیار کم است.");
    }
    if (kind === "sell") {
      gold = n;
      const gross = (gold * BigInt(q.price)) / 1000000n;
      fee = (gross + 99n) / 100n;
      amount = gross - fee;
      if (amount <= 0n) throw new Problem(400, "مقدار فروش بسیار کم است.");
      if ((await balance(c, "user:demo", "GOLD_UG")) < gold)
        throw new Problem(409, "موجودی طلا کافی نیست.");
    }
    if (kind === "withdraw" && (await balance(c, "user:demo", "IRR")) < amount)
      throw new Problem(409, "موجودی ریالی کافی نیست.");
    const id = randomUUID(),
      status =
        kind === "buy"
          ? "awaiting_payment"
          : kind === "sell"
            ? "completed"
            : "withdrawal_pending";
    const order = (
      await c.query(
        "INSERT INTO orders(id,wallet_id,kind,idempotency_key,request_hash,quote_id,amount,gold,fee,status,sheba) VALUES($1,'demo',$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
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
        ],
      )
    ).rows[0];
    await event(c, id, "order_created", { kind, status });
    if (kind === "buy") await enqueue(c, id, "verify", 5);
    if (kind === "sell") {
      await journal(c, id, "sell", [
        ["user:demo", "GOLD_UG", -gold],
        ["custodian:inventory", "GOLD_UG", gold],
        ["trading:liquidity", "IRR", -(amount + fee)],
        ["user:demo", "IRR", amount],
        ["revenue:fees", "IRR", fee],
      ]);
      await event(c, id, "completed");
    }
    if (kind === "withdraw") {
      await journal(c, id, "reserve", [
        ["user:demo", "IRR", -amount],
        ["user:demo:reserved", "IRR", amount],
      ]);
      await enqueue(c, id, "withdraw", 2);
    }
    return (
      await c.query(
        "INSERT INTO idempotency_responses(order_id,response) VALUES($1,$2) RETURNING response",
        [id, JSON.stringify(order)],
      )
    ).rows[0].response;
  });
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
    if (!o || o.kind !== "buy") throw new Problem(404, "Buy order not found");
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
    if (o.status !== "awaiting_payment")
      throw new Problem(409, "Order is final");
    if (
      mode === "late" &&
      (
        await c.query(
          "SELECT expires_at>clock_timestamp() AS valid FROM quotes WHERE id=$1",
          [o.quote_id],
        )
      ).rows[0].valid
    )
      throw new Problem(
        409,
        "برای پرداخت دیررس ابتدا منتظر پایان شمارش معکوس بمانید.",
      );
    await c.query(
      "INSERT INTO gateway_transactions(order_id,reference,amount,status,mode,paid_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $4='paid' THEN clock_timestamp() ELSE NULL END)",
      [
        id,
        randomUUID(),
        o.amount,
        mode === "failure" || mode === "failed_verify" ? "failed" : "paid",
        mode,
      ],
    );
    await event(c, id, "mock_gateway", { mode });
  });
  if (mode !== "missing") {
    await callback(id);
    if (mode === "duplicate") await callback(id);
  }
}
export async function verify(id: string) {
  // Provider calls are outside the financial transaction; never hold a wallet lock across network I/O.
  const payment = await gatewayBreaker.fire(id);
  return tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query(
        "SELECT o.*,q.expires_at FROM orders o LEFT JOIN quotes q ON q.id=o.quote_id WHERE o.id=$1 FOR UPDATE OF o",
        [id],
      )
    ).rows[0];
    if (
      !o ||
      o.kind !== "buy" ||
      !["awaiting_payment", "payment_pending", "payment_review"].includes(
        o.status,
      )
    )
      return true;
    if (!payment) {
      const expired =
        Date.now() - new Date(o.created_at).getTime() >
        Number(process.env.PAYMENT_DEADLINE_MS ?? 1800000);
      if (expired) {
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
      await c.query(
        "UPDATE orders SET status='payment_failed',updated_at=now() WHERE id=$1",
        [id],
      );
      await event(c, id, "verify_failed");
      return true;
    }
    if (BigInt(payment.amount) !== BigInt(o.amount))
      throw Error("Gateway amount mismatch: manual review required");
    const amount = BigInt(o.amount),
      gold = BigInt(o.gold),
      fee = BigInt(o.fee);
    await journal(c, id, "topup", [
      ["gateway:clearing", "IRR", -amount],
      ["user:demo", "IRR", amount],
    ]);
    const late =
      new Date(payment.paid_at).getTime() > new Date(o.expires_at).getTime();
    if (!late) {
      // The last fractional microgram remains rial cash in the wallet, never silently disappears.
      const p = (
        await c.query("SELECT price FROM quotes WHERE id=$1", [o.quote_id])
      ).rows[0];
      const cost = (gold * BigInt(p.price) + 999999n) / 1000000n;
      await journal(c, id, "buy", [
        ["user:demo", "IRR", -(cost + fee)],
        ["trading:liquidity", "IRR", cost],
        ["revenue:fees", "IRR", fee],
        ["custodian:inventory", "GOLD_UG", -gold],
        ["user:demo", "GOLD_UG", gold],
      ]);
    }
    const status = late ? "credited_to_wallet" : "completed";
    await c.query("UPDATE orders SET status=$2,updated_at=now() WHERE id=$1", [
      id,
      status,
    ]);
    await event(c, id, status, { reference: payment.reference });
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
    };
  });
}
export const messages: Record<string, string> = {
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
