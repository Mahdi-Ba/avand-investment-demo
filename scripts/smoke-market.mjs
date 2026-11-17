// Creates synthetic orders only; never deletes data. Restores the original mock clock.
import { randomUUID } from "node:crypto";
const base = process.env.BASE_URL ?? "http://localhost:3000";
async function call(path, body, key, expected = 200) {
  const r = await fetch(base + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (r.status !== expected)
    throw Error(`${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function wait(id, status) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const o = await call("/orders/" + id);
    if (o.status === status) return o;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Worker timeout " + id);
}
const settings = await call("/mock/settings");
if (
  settings.price_outage ||
  settings.gateway_outage ||
  settings.price_pause_until
)
  throw Error("Disable demo outages and feed pause before smoke");
try {
  await call("/mock/market", { clock: "2026-11-17T09:00:00+03:30" });
  const t = await call(
    "/orders",
    { kind: "topup", amount: "1200000000" },
    randomUUID(),
  );
  await call("/mock/payments/" + t.id, { mode: "success" });
  await wait(t.id, "completed");
  await call("/mock/market", { clock: "2026-11-17T20:00:00+03:30" });
  const queued = await Promise.all(
    Array.from({ length: 2 }, () =>
      call(
        "/orders",
        { kind: "buy", amount: "600000000", fundingSource: "wallet" },
        randomUUID(),
      ),
    ),
  );
  if (queued.some((o) => o.status !== "queued"))
    throw Error("Expected queued orders");
  await call("/orders/" + queued[0].id + "/cancel", {});
  const cancelled = await call("/orders/" + queued[0].id);
  if (cancelled.status !== "cancelled") throw Error("Cancel failed");
  await call("/mock/market", {
    clock: new Date(Date.parse(queued[1].execute_after) + 30000).toISOString(),
  });
  const filled = await wait(queued[1].id, "completed");
  if (!filled.execution_price) throw Error("Opening price missing");
  await call("/mock/market", {
    clock: "2026-11-17T20:00:00+03:30",
    pauseFeed: true,
  });
  await call("/mock/market", { clock: "2026-11-17T20:07:00+03:30" });
  await call("/quotes", {}, undefined, 409);
  console.log(
    JSON.stringify(
      {
        cancelled: cancelled.id,
        executed: filled.id,
        openingPrice: filled.execution_price,
        staleQuoteRejected: true,
        balances: await call("/balances"),
      },
      null,
      2,
    ),
  );
} finally {
  await call("/mock/market", {
    clock: settings.clock_override,
    pauseFeed: false,
  });
}
