import type { PoolClient } from "pg";
import { pool } from "./db.js";
export const DAILY_CAP = 500000000n; // 50 million tomans, API amounts are rials.
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tehran",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function parts(date: Date) {
  return Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
}
function localInstant(day: string, hour: number) {
  const nominal = Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  let instant = nominal;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(instant));
    const represented = Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    );
    instant += nominal - represented;
  }
  return new Date(instant);
}
export function marketAt(now: Date) {
  const p = parts(now),
    day = `${p.year}-${p.month}-${p.day}`,
    calendar = new Date(`${day}T00:00:00Z`);
  const weekday = calendar.getUTCDay(),
    tradingDay = weekday !== 4 && weekday !== 5;
  const minute = Number(p.hour) * 60 + Number(p.minute),
    isOpen = tradingDay && minute >= 540 && minute < 900;
  let nextOpen: Date | null = null;
  for (let offset = 0; offset < 8; offset++) {
    const date = new Date(calendar.getTime() + offset * 86400000),
      dow = date.getUTCDay();
    if (dow === 4 || dow === 5) continue;
    const open = localInstant(date.toISOString().slice(0, 10), 9);
    if (open.getTime() > now.getTime()) {
      nextOpen = open;
      break;
    }
  }
  return {
    isOpen,
    day,
    sessionOpen: localInstant(day, 9),
    sessionClose: localInstant(day, 15),
    tradingDay,
    nextOpen: nextOpen!,
    freshnessMs: isOpen ? 60000 : 360000,
    feedIntervalMs: isOpen ? 30000 : 300000,
  };
}
export async function businessNow(c?: PoolClient): Promise<Date> {
  return (
    await (c ?? pool).query(
      "SELECT coalesce(clock_override,clock_timestamp()) AS now FROM mock_settings WHERE id=1",
    )
  ).rows[0].now;
}
export async function reserveCap(
  c: PoolClient,
  direction: "buy" | "sell",
  value: bigint,
  when: Date,
) {
  const m = marketAt(when);
  if (m.isOpen) return { allowed: true, day: null, amount: 0n };
  const row = (
    await c.query(
      "SELECT used FROM daily_limits WHERE wallet_id='demo' AND day=$1 AND direction=$2",
      [m.day, direction],
    )
  ).rows[0];
  if (BigInt(row?.used ?? 0) + value > DAILY_CAP)
    return { allowed: false, day: null, amount: 0n };
  await c.query(
    "INSERT INTO daily_limits(wallet_id,day,direction,used) VALUES('demo',$1,$2,$3) ON CONFLICT(wallet_id,day,direction) DO UPDATE SET used=daily_limits.used+excluded.used",
    [m.day, direction, value.toString()],
  );
  return { allowed: true, day: m.day, amount: value };
}
export async function releaseCap(
  c: PoolClient,
  o: { id: string; kind: string; cap_day: string | null; cap_amount: string },
) {
  if (BigInt(o.cap_amount) === 0n) return;
  await c.query(
    "UPDATE daily_limits SET used=used-$3 WHERE wallet_id='demo' AND day=$1 AND direction=$2",
    [o.cap_day, o.kind, o.cap_amount],
  );
  await c.query("UPDATE orders SET cap_day=NULL,cap_amount=0 WHERE id=$1", [
    o.id,
  ]);
}
export async function marketStatus() {
  const now = await businessNow(),
    m = marketAt(now),
    r = await pool.query(
      "SELECT direction,used::text FROM daily_limits WHERE wallet_id='demo' AND day=$1",
      [m.day],
    );
  const used = Object.fromEntries(r.rows.map((x) => [x.direction, x.used]));
  return {
    ...m,
    now,
    clockOverridden: (
      await pool.query(
        "SELECT clock_override IS NOT NULL AS active FROM mock_settings WHERE id=1",
      )
    ).rows[0].active,
    timezone: "Asia/Tehran",
    dailyCap: DAILY_CAP.toString(),
    buyUsed: used.buy ?? "0",
    sellUsed: used.sell ?? "0",
    buyRemaining: (DAILY_CAP - BigInt(used.buy ?? 0)).toString(),
    sellRemaining: (DAILY_CAP - BigInt(used.sell ?? 0)).toString(),
  };
}
