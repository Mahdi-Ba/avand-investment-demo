const $ = (id) => document.getElementById(id);
let lockedQuote = null,
  selected = null,
  currentPrice = 0n;
let refreshing = false;
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
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [b, orders, p, s] = await Promise.all([
      api("/balances"),
      api("/orders"),
      api("/price"),
      api("/support"),
    ]);
    currentPrice = BigInt(p.price);
    $("rials").textContent = number(b.rials);
    $("gold").textContent = grams(b.goldUg);
    $("reserved").textContent = number(b.reservedRials);
    $("price").textContent = number(p.price);
    $("value").textContent = p.outage
      ? "قیمت در دسترس نیست"
      : number((BigInt(b.goldUg) * currentPrice) / 1000000n);
    $("orders").replaceChildren();
    for (const o of orders) {
      const tr = document.createElement("tr");
      for (const text of [
        o.id.slice(0, 8),
        { buy: "خرید", sell: "فروش", withdraw: "برداشت" }[o.kind],
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
    notice("قیمت برای ۶۰ ثانیه قفل شد.");
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
    if (!lockedQuote) throw Error("ابتدا قیمت بگیرید.");
    await order({
      kind: "buy",
      amount: $("buyAmount").value,
      quoteId: lockedQuote.id,
    });
  });
};
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
        if (!selected) throw Error("ابتدا سفارش خرید بسازید.");
        await api("/mock/payments/" + selected, { mode: button.dataset.mode });
        notice("نتیجه در درگاه ماک ثبت شد؛ worker پرداخت را بررسی می‌کند.");
      })),
);
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
      Math.ceil((new Date(lockedQuote.expires_at) - Date.now()) / 1000),
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
