// Non-destructive local demo: creates synthetic orders, never resets data.
import { randomUUID } from "node:crypto";
const base = process.env.BASE_URL ?? "http://localhost:3000";
async function call(path, body, key) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw Error(JSON.stringify(data));
  return data;
}
async function completed(id, expected = "completed") {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const o = await call("/api/orders/" + id);
    if (o.status === expected) return o;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Worker did not complete order " + id);
}
console.log("Health:", await call("/health"));
const topup = await call(
  "/api/orders",
  { kind: "topup", amount: "100000000" },
  randomUUID(),
);
await call("/api/mock/payments/" + topup.id, { mode: "duplicate" });
await completed(topup.id);
const q = await call("/api/quotes", {});
const buy = await call(
  "/api/orders",
  { kind: "buy", amount: "100000000", quoteId: q.id, fundingSource: "wallet" },
  randomUUID(),
);
if (buy.status !== "completed") throw Error("Wallet buy was not atomic");
const rejected = await call(
  "/api/orders",
  { kind: "topup", amount: "1000000" },
  randomUUID(),
);
const beforeRejection = await call("/api/balances");
await call("/api/mock/payments/" + rejected.id, { mode: "failed_verify" });
const held = await completed(rejected.id, "verification_failed");
if (
  held.payment.status !== "paid" ||
  held.payment.verification_status !== "rejected"
)
  throw Error("Expected charged-but-unverified payment");
if (
  JSON.stringify(await call("/api/balances")) !==
  JSON.stringify(beforeRejection)
)
  throw Error("Rejected verification changed available balance");
await call("/api/mock/payments/" + rejected.id + "/resolve-verification", {});
await completed(rejected.id);
const sell = await call(
  "/api/orders",
  { kind: "sell", gold: "100000", quoteId: q.id },
  randomUUID(),
);
const withdraw = await call(
  "/api/orders",
  { kind: "withdraw", amount: "1000000", sheba: "IR820540102680020817909002" },
  randomUUID(),
);
await completed(withdraw.id);
const prior = (await call("/api/support")).latestReport?.id;
await call("/api/support/reconcile", {});
let report;
const start = Date.now();
while (Date.now() - start < 10000) {
  report = (await call("/api/support")).latestReport;
  if (report && report.id !== prior) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (!report || report.id === prior)
  throw Error("Reconciliation worker did not finish");
console.log(
  JSON.stringify(
    {
      topup: topup.id,
      recoveredVerification: rejected.id,
      buy: buy.id,
      sell: sell.id,
      withdraw: withdraw.id,
      balances: await call("/api/balances"),
      reconciliation: report,
    },
    null,
    2,
  ),
);
