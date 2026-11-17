import { pool, tx } from "./db.js";
import { journal, lockWallet } from "./ledger.js";
import { enqueue, event, uuid, Problem } from "./domain.js";
import { custodianBreaker, refundBreaker } from "./external.js";
import { marketAt } from "./market.js";
export async function settleCustodian(id: string) {
  const result = await custodianBreaker.fire(id);
  await tx(async (c) => {
    await lockWallet(c);
    if (
      !(
        await c.query(
          "SELECT id FROM events WHERE order_id=$1 AND type='custodian_response'",
          [id],
        )
      ).rowCount
    )
      await event(c, id, "custodian_response", result);
  });
}
export async function requestRefund(id: string) {
  uuid(id);
  return tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!o) throw new Problem(404, "Order not found");
    if (["refund_pending", "refunded"].includes(o.status)) return o;
    if (o.status !== "verification_failed")
      throw new Problem(
        409,
        "بازپرداخت فقط برای وجه کسرشده با verify ناموفق مجاز است.",
      );
    const payment = (
      await c.query(
        "SELECT * FROM gateway_transactions WHERE order_id=$1 AND status='paid' FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!payment) throw new Problem(409, "Charged payment required");
    if (
      (
        await c.query(
          "SELECT id FROM journals WHERE order_id=$1 AND purpose='topup'",
          [id],
        )
      ).rowCount
    )
      throw new Problem(409, "Funds already credited");
    const amount = BigInt(o.amount);
    await journal(c, id, "refund_received", [
      ["gateway:clearing", "IRR", -amount],
      ["suspense:refunds", "IRR", amount],
    ]);
    await c.query(
      "UPDATE orders SET status='refund_pending',updated_at=now() WHERE id=$1",
      [id],
    );
    await event(c, id, "refund_requested");
    await enqueue(c, id, "refund");
    return (await c.query("SELECT * FROM orders WHERE id=$1", [id])).rows[0];
  });
}
export async function settleRefund(id: string) {
  const candidate = (await pool.query("SELECT * FROM orders WHERE id=$1", [id]))
    .rows[0];
  if (!candidate || candidate.status !== "refund_pending") return;
  const receipt = await refundBreaker.fire(id, candidate.amount);
  await tx(async (c) => {
    await lockWallet(c);
    const o = (
      await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (o.status !== "refund_pending") return;
    await journal(c, id, "refund", [
      ["suspense:refunds", "IRR", -BigInt(o.amount)],
      ["gateway:clearing", "IRR", BigInt(o.amount)],
    ]);
    if (BigInt(o.cap_amount) > 0n) {
      await c.query(
        "UPDATE daily_limits SET used=used-$2 WHERE wallet_id='demo' AND day=$1 AND direction='buy'",
        [o.cap_day, o.cap_amount],
      );
      await c.query("UPDATE orders SET cap_day=NULL,cap_amount=0 WHERE id=$1", [
        id,
      ]);
    }
    await c.query(
      "UPDATE orders SET status='refunded',updated_at=now() WHERE id=$1",
      [id],
    );
    await event(c, id, "mock_gateway_refunded", {
      reference: receipt.reference,
    });
  });
}
export async function scheduleReconciliation(at?: Date) {
  const now =
    at ?? (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now;
  const day = marketAt(now).day;
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  if (Number(local) < 2) return;
  await tx(async (c) => {
    const inserted = await c.query(
      "INSERT INTO scheduled_runs(task,day) VALUES('daily_reconciliation',$1) ON CONFLICT DO NOTHING RETURNING day",
      [day],
    );
    if (inserted.rowCount) await enqueue(c, null, "reconcile");
  });
}
