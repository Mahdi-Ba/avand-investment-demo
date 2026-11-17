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
async function completed(id) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const o = await call("/api/orders/" + id);
    if (o.status === "completed") return o;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Worker did not complete order " + id);
}
console.log("Health:", await call("/health"));
const q = await call("/api/quotes", {});
const buy = await call(
  "/api/orders",
  { kind: "buy", amount: "100000000", quoteId: q.id },
  randomUUID(),
);
await call("/api/mock/payments/" + buy.id, { mode: "duplicate" });
await completed(buy.id);
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
