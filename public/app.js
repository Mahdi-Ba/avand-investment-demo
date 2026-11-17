const $ = (id) => document.getElementById(id);
let lockedQuote = null,
  selected = null,
  currentPrice = 0n;
let refreshing = false;
let market = null,
  clockOffset = 0;
const clockNow = () =>
  market?.clockOverridden ? Date.parse(market.now) : Date.now() + clockOffset;
const number = (x) => BigInt(x).toLocaleString("fa-IR");
function grams(x) {
  const n = BigInt(x);
  return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, "0")}`;
}
function toUg(s) {
  if (!/^\d+(\.\d{1,6})?$/.test(s))
    throw Error("مقدار گرم باید حداکثر ۶ رقم اعشار داشته باشد.");
  const [a, b = ""] = s.split(".");
  return (BigInt(a) * 1000000n + BigInt(b.padEnd(6, "0"))).toString();
}
async function api(path, body, key) {
  const r = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error ?? "خطا");
  return d;
}
function notice(t) {
  $("notice").textContent = t;
}
async function act(fn) {
  try {
    await fn();
    await refresh();
  } catch (e) {
    notice(e.message);
  }
}
async function details(id) {
  selected = id;
  $("selectedOrder").textContent = id;
  $("lookup").value = id;
  const o = await api("/orders/" + id);
  $("details").textContent = JSON.stringify(o, null, 2);
  $("orderState").textContent = o.message;
  $("resolveVerification").hidden = o.status !== "verification_failed";
  $("cancelOrder").hidden = !(
    o.execution_mode === "queued" &&
    [
      "queued",
      "awaiting_payment",
      "payment_pending",
      "verification_failed",
      "payment_review",
    ].includes(o.status)
  );
  if (
    o.execution_mode === "queued" &&
    o.execute_after &&
    o.status !== "cancelled" &&
    o.status !== "completed"
  )
    $("orderState").textContent =
      (["awaiting_payment", "payment_pending"].includes(o.status)
        ? "پس از تأیید پرداخت، ریال برای اجرای سفارش در بازار رزرو می‌شود."
        : o.message) +
      " نوبت بازار: " +
      new Date(o.execute_after).toLocaleString("fa-IR", {
        timeZone: "Asia/Tehran",
      });
  $("paymentState").textContent = o.payment
    ? (o.payment.status === "paid"
        ? "درگاه: وجه کسر شده"
        : "درگاه: پرداخت انجام نشده") +
      " / " +
      (o.payment.verification_status === "rejected"
        ? "تأیید نهایی: ناموفق"
        : "تأیید نهایی: موفق")
    : "";
  for (const button of document.querySelectorAll("[data-mode]"))
    button.disabled = !(
      o.funding_source === "gateway" &&
      ["buy", "topup"].includes(o.kind) &&
      ["awaiting_payment", "payment_pending"].includes(o.status) &&
      !o.payment
    );
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [b, orders, p, s, m] = await Promise.all([
      api("/balances"),
      api("/orders"),
      api("/price").catch(() => ({ outage: true })),
      api("/support"),
      api("/market"),
    ]);
    market = m;
    clockOffset = Date.parse(m.now) - Date.now();
    $("marketState").textContent =
      (m.clockOverridden ? "ساعت آزمایشی · " : "") +
      (m.isOpen ? "بازار باز است" : "بازار بسته است") +
      " · " +
      new Date(m.now).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
    $("limits").textContent =
      `باقی‌ماندهٔ سقف امروز / خرید: ${number(m.buyRemaining)} ریال · فروش: ${number(m.sellRemaining)} ریال · بازشدن بعدی: ${new Date(m.nextOpen).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`;
    if (!p.outage && !p.stale) currentPrice = BigInt(p.price);
    $("rials").textContent = number(b.rials);
    $("gold").textContent = grams(b.goldUg);
    $("reserved").textContent = number(b.reservedRials);
    $("reservedGold").textContent = grams(b.reservedGoldUg);
    $("price").textContent =
      p.outage || p.stale ? "قیمت معتبر در دسترس نیست" : number(p.price);
    $("priceFeed").textContent =
      p.outage || p.stale
        ? "قیمت‌دهنده در دسترس نیست؛ موجودی و تاریخچه همچنان قابل مشاهده‌اند."
        : `قیمت ماک: ${m.isOpen ? "هر ۳۰ ثانیه" : "هر ۵ دقیقه"} · انتشار: ${new Date(p.publishedAt).toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran" })}`;
    $("value").textContent =
      p.outage || p.stale
        ? "قیمت در دسترس نیست"
        : number((BigInt(b.goldUg) * currentPrice) / 1000000n);
    $("orders").replaceChildren();
    for (const o of orders) {
      const tr = document.createElement("tr");
      for (const text of [
        o.id.slice(0, 8),
        {
          topup: "شارژ کیف پول",
          buy: "خرید",
          sell: "فروش",
          withdraw: "برداشت",
        }[o.kind],
        (o.kind === "sell" && o.status === "queued" ? "تخمینی: " : "") +
          number(o.amount),
        grams(o.gold),
        o.message,
      ]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      const td = document.createElement("td"),
        button = document.createElement("button");
      button.className = "secondary";
      button.textContent = "مشاهده";
      button.onclick = () => act(() => details(o.id));
      td.append(button);
      tr.append(td);
      $("orders").append(tr);
    }
    if (!orders.length) {
      const tr = document.createElement("tr"),
        td = document.createElement("td");
      td.colSpan = 6;
      td.textContent = "هنوز تراکنشی ثبت نشده است.";
      tr.append(td);
      $("orders").append(tr);
    }
    $("supportData").textContent = JSON.stringify(s, null, 2);
    if (selected) await details(selected);
  } catch (e) {
    notice(e.message);
  } finally {
    refreshing = false;
  }
}
$("getQuote").onclick = () =>
  act(async () => {
    lockedQuote = await api("/quotes", {});
    $("locked").textContent = number(lockedQuote.price) + " ریال";
    notice("قیمت تا پایان شمارش معکوس قفل شد.");
  });
const pendingKeys = new Map();
async function order(body) {
  const signature = JSON.stringify(body);
  const key = pendingKeys.get(signature) ?? crypto.randomUUID();
  pendingKeys.set(signature, key);
  const o = await api("/orders", body, key);
  pendingKeys.delete(signature);
  await details(o.id);
  notice("سفارش ثبت شد: " + o.id.slice(0, 8));
}
$("buyForm").onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    const amount = $("buyAmount").value;
    const exceeds =
      market &&
      !market.isOpen &&
      /^\d+$/.test(amount) &&
      BigInt(amount) > BigInt(market.buyRemaining);
    if (!lockedQuote && !exceeds) throw Error("ابتدا قیمت بگیرید.");
    await order({
      kind: "buy",
      amount,
      ...(!exceeds && lockedQuote ? { quoteId: lockedQuote.id } : {}),
      fundingSource: $("fundingSource").value,
    });
  });
};
$("topupForm").onsubmit = (e) => {
  e.preventDefault();
  act(() => order({ kind: "topup", amount: $("topupAmount").value }));
};
$("resolveVerification").onclick = () =>
  act(async () => {
    if (!selected) throw Error("سفارش را انتخاب کنید.");
    await api("/mock/payments/" + selected + "/resolve-verification", {});
    notice("تأیید مجدد در ماک ثبت شد؛ worker سفارش را بررسی می‌کند.");
  });
$("sellForm").onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    if (!lockedQuote) throw Error("ابتدا قیمت بگیرید.");
    await order({
      kind: "sell",
      gold: toUg($("sellGrams").value),
      quoteId: lockedQuote.id,
    });
  });
};
$("withdrawForm").onsubmit = (e) => {
  e.preventDefault();
  act(() =>
    order({
      kind: "withdraw",
      amount: $("withdrawAmount").value,
      sheba: $("sheba").value,
    }),
  );
};
document.querySelectorAll("[data-mode]").forEach(
  (button) =>
    (button.onclick = () =>
      act(async () => {
        if (!selected)
          throw Error("ابتدا درخواست شارژ یا خرید مستقیم با درگاه بسازید.");
        await api("/mock/payments/" + selected, { mode: button.dataset.mode });
        notice("نتیجه در درگاه ماک ثبت شد؛ worker پرداخت را بررسی می‌کند.");
      })),
);
$("cancelOrder").onclick = () =>
  act(async () => {
    await api("/orders/" + selected + "/cancel", {});
    notice("سفارش لغو و رزرو دارایی آزاد شد.");
  });
$("marketForm").onsubmit = (e) => {
  e.preventDefault();
  act(async () => {
    await api("/mock/market", { clock: $("mockClock").value });
    lockedQuote = null;
    notice("ساعت ماک تغییر کرد؛ برای معاملهٔ فوری قیمت تازه بگیرید.");
  });
};
$("realClock").onclick = () =>
  act(async () => {
    await api("/mock/market", { clock: null, pauseFeed: false });
    $("pauseFeed").checked = false;
    lockedQuote = null;
    notice("ساعت واقعی و جریان عادی قیمت فعال شدند.");
  });
$("pauseFeed").onchange = () =>
  act(() => api("/mock/market", { pauseFeed: $("pauseFeed").checked }));
$("processQueue").onclick = () =>
  act(async () => {
    await api("/support/process-queue", {});
    notice(
      "سفارش‌های آماده برای پردازش بررسی شدند؛ worker صف را خودکار هم بررسی می‌کند.",
    );
  });
$("lookupForm").onsubmit = (e) => {
  e.preventDefault();
  act(() => details($("lookup").value));
};
$("reconcile").onclick = () =>
  act(async () => {
    await api("/support/reconcile", {});
    notice("کار تطبیق در صف قرار گرفت.");
  });
for (const id of ["priceOutage", "gatewayOutage"])
  $(id).onchange = () =>
    act(() =>
      api("/mock/settings", {
        priceOutage: $("priceOutage").checked,
        gatewayOutage: $("gatewayOutage").checked,
      }),
    );
setInterval(() => {
  if (lockedQuote) {
    const remaining = Math.max(
      0,
      Math.ceil((new Date(lockedQuote.expires_at) - clockNow()) / 1000),
    );
    $("countdown").textContent = remaining
      ? `اعتبار باقی‌مانده: ${remaining} ثانیه`
      : "قیمت منقضی شد؛ برای معامله قیمت تازه بگیرید.";
  }
}, 250);
const settings = await api("/mock/settings");
$("priceOutage").checked = settings.price_outage;
$("gatewayOutage").checked = settings.gateway_outage;
await refresh();
setInterval(refresh, 2000);
