const $ = (id) => document.getElementById(id);
let started = 0,
  logs = [],
  step = 0,
  hiddenOrder = null;
async function api(path, body, key, acceptError = false) {
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const d = await r.json();
  if (!r.ok && !acceptError) throw Error(d.error ?? "Request failed");
  return acceptError ? { status: r.status, data: d } : d;
}
function check(value, message) {
  if (!value) throw Error(message);
}
function log(value) {
  logs.push(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  $("trace").textContent = logs.slice(-8).join("\n\n");
}
async function waitOrder(id, status = "completed") {
  const t = Date.now();
  while (Date.now() - t < 30000) {
    const o = await api("/orders/" + id);
    if (o.status === status) return o;
    if (["payment_failed", "payment_review"].includes(o.status))
      throw Error(o.message);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Timeout waiting for order " + id);
}
async function makeBuy(amount = "1000000") {
  const q = await api("/quotes", {});
  return api(
    "/orders",
    { kind: "buy", amount, quoteId: q.id, fundingSource: "gateway" },
    crypto.randomUUID(),
  );
}
async function report() {
  const previous = (await api("/support")).latestReport?.id;
  await api("/support/reconcile", {});
  const t = Date.now();
  while (Date.now() - t < 12000) {
    const r = (await api("/support")).latestReport;
    if (r && r.id !== previous) return r;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("Reconciliation timeout");
}
async function run(n, fn) {
  step = n;
  $("s" + n).textContent = "در حال اجرا…";
  log("SCENARIO " + n);
  await fn();
  $("s" + n).textContent = "موفق";
  $("s" + n).className = "result passed";
  await new Promise((r) => setTimeout(r, 1500));
}
setInterval(() => {
  if (started)
    $("timer").textContent =
      "زمان اجرا: " + Math.round((Date.now() - started) / 1000) + " ثانیه";
}, 250);
$("run").onclick = async () => {
  $("run").disabled = true;
  started = Date.now();
  logs = [];
  $("summary").className = "";
  for (let i = 1; i <= 7; i++) {
    $("s" + i).textContent = "در انتظار";
    $("s" + i).className = "result";
  }
  hiddenOrder = null;
  let original = null;
  try {
    original = await api("/mock/settings");
    await api("/mock/settings", {
      priceOutage: false,
      gatewayOutage: false,
      custodianOutage: false,
      custodianMode: "normal",
      bankOutage: false,
    });
    const market = await api("/market");
    const startTime =
      market.isOpen &&
      Date.parse(market.now) < Date.parse(market.sessionClose) - 120000
        ? market.now
        : new Date(Date.parse(market.nextOpen) + 1800000).toISOString();
    await api("/mock/market", { clock: startTime, pauseFeed: false });
    $("summary").textContent =
      "اجرا آغاز شد؛ نتایج از پاسخ واقعی API و دفترکل خوانده می‌شوند.";
    await run(1, async () => {
      const before = await api("/balances"),
        o = await makeBuy();
      await api("/mock/payments/" + o.id, { mode: "duplicate" });
      const done = await waitOrder(o.id);
      check(
        BigInt((await api("/balances")).goldUg) - BigInt(before.goldUg) ===
          BigInt(done.gold),
        "Duplicate credit",
      );
      check(
        new Set(
          done.entries
            .filter((e) => e.purpose === "buy")
            .map((e) => e.journal_id),
        ).size === 1,
        "Duplicate journal",
      );
      log({
        order: o.id,
        status: done.status,
        goldUg: done.gold,
        buyJournals: 1,
      });
    });
    await run(2, async () => {
      const q = await api("/quotes", {}),
        key = crypto.randomUUID();
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          api(
            "/orders",
            { kind: "buy", amount: "1000000", quoteId: q.id },
            key,
          ),
        ),
      );
      check(
        new Set(results.map((o) => o.id)).size === 1,
        "More than one order",
      );
      check(
        new Set(results.map((o) => JSON.stringify(o))).size === 1,
        "Responses differ",
      );
      await api("/mock/payments/" + results[0].id, { mode: "success" });
      await waitOrder(results[0].id);
      log({
        concurrentRequests: 100,
        uniqueOrders: 1,
        identicalResponses: 100,
        order: results[0].id,
      });
    });
    await run(3, async () => {
      const b = await api("/balances"),
        q = await api("/quotes", {});
      const rs = await Promise.all(
        Array.from({ length: 2 }, () =>
          api(
            "/orders",
            { kind: "sell", gold: b.goldUg, quoteId: q.id },
            crypto.randomUUID(),
            true,
          ),
        ),
      );
      log({ device1: rs[0].status, device2: rs[1].status });
      check(
        rs.filter((r) => r.status === 200).length === 1 &&
          rs.filter((r) => r.status === 409).length === 1,
        "Expected one sell failure",
      );
      check(BigInt((await api("/balances")).goldUg) >= 0n, "Negative gold");
      log({
        device1: rs[0].status,
        device2: rs[1].status,
        goldAfter: (await api("/balances")).goldUg,
      });
    });
    await run(4, async () => {
      const o = await makeBuy(),
        qTime = (await api("/mock/settings")).clock_override;
      await api("/mock/market", {
        clock: new Date(Date.parse(qTime) + 61000).toISOString(),
      });
      const before = await api("/balances");
      await api("/mock/payments/" + o.id, { mode: "late" });
      const done = await waitOrder(o.id, "credited_to_wallet");
      check(
        (await api("/balances")).goldUg === before.goldUg,
        "Late payment bought gold",
      );
      log({
        order: done.id,
        status: done.status,
        policy: "Rials credited to wallet, no gold",
      });
    });
    await run(5, async () => {
      const o = await makeBuy();
      await api("/mock/payments/" + o.id, { mode: "missing" });
      const done = await waitOrder(o.id);
      check(
        !done.events.some((e) => e.type === "callback_received"),
        "Unexpected callback",
      );
      log({
        order: o.id,
        status: done.status,
        callbacks: 0,
        recoveredBy: "worker gateway inquiry",
      });
    });
    await run(6, async () => {
      const invariant = await api("/support/invariants");
      check(invariant.balanced, "Ledger not balanced");
      log(invariant);
    });
    await run(7, async () => {
      const a = await api(
        "/orders",
        { kind: "topup", amount: "1000000" },
        crypto.randomUUID(),
      );
      await api("/mock/payments/" + a.id, { mode: "success" });
      await waitOrder(a.id);
      hiddenOrder = a.id;
      await api("/mock/payments/" + a.id + "/statement", { hidden: true });
      await api("/mock/settings", { priceOutage: false, gatewayOutage: true });
      const b = await api(
        "/orders",
        { kind: "topup", amount: "1000000" },
        crypto.randomUUID(),
      );
      await api("/mock/payments/" + b.id, { mode: "missing" });
      const r = await report();
      check(
        r.mismatches.some(
          (x) => x.order_id === a.id && x.type === "ledger_only",
        ) &&
          r.mismatches.some(
            (x) => x.order_id === b.id && x.type === "gateway_only",
          ),
        "Missing mismatch direction",
      );
      log({ report: r.id, mismatches: r.mismatches });
      await api("/mock/payments/" + a.id + "/statement", { hidden: false });
      hiddenOrder = null;
      await api("/mock/settings", { priceOutage: false, gatewayOutage: false });
      await waitOrder(b.id);
      await report();
    });
    $("summary").textContent =
      "هر ۷ سناریو موفق بود. هیچ سناریویی حذف نشد. جمع دفترکل ریال و طلا صفر است.";
    $("summary").className = "passed";
    const b = await api("/balances");
    $("balances").textContent =
      "ماندهٔ نهایی: " +
      BigInt(b.rials).toLocaleString("fa-IR") +
      " ریال / " +
      (Number(b.goldUg) / 1000000).toFixed(6) +
      " گرم";
  } catch (e) {
    $("s" + step).textContent = "ناموفق";
    $("s" + step).className = "result failed";
    $("summary").textContent =
      "اجرا در سناریوی " + step + " متوقف شد: " + e.message;
    log(e.message);
  } finally {
    if (hiddenOrder)
      await api("/mock/payments/" + hiddenOrder + "/statement", {
        hidden: false,
      });
    if (original) {
      await api("/mock/settings", {
        priceOutage: original.price_outage,
        gatewayOutage: original.gateway_outage,
        custodianOutage: original.custodian_outage,
        custodianMode: original.custodian_mode,
        bankOutage: original.bank_outage,
      });
      await api("/mock/market", {
        clock: original.clock_override,
        pauseFeed: false,
      });
    }
    $("run").disabled = false;
    started = 0;
  }
};
