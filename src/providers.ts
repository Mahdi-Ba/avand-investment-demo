import CircuitBreaker from "opossum";
import { pool } from "./db.js";
import { marketAt } from "./market.js";
export async function settings() {
  return (
    await pool.query(
      "SELECT *,coalesce(clock_override,clock_timestamp()) AS provider_now FROM mock_settings WHERE id=1",
    )
  ).rows[0];
}
const options = {
  timeout: 1500,
  errorThresholdPercentage: 50,
  volumeThreshold: 3,
  resetTimeout: 10000,
  rollingCountTimeout: 30000,
};
// A deterministic feed changes every 30s, using the shared DB clock and epoch.
// No per-process timer: API instances agree and restarts preserve the feed phase.
export function priceSnapshot(
  base: bigint,
  epoch: Date,
  now: Date,
  intervalMs = 30000,
) {
  const slot = Math.max(
    0,
    Math.floor((now.getTime() - epoch.getTime()) / intervalMs),
  );
  const basisPoints = [0n, 25n, -15n, 40n, -25n, 10n];
  const calculated =
    (base * (10000n + basisPoints[slot % basisPoints.length])) / 10000n;
  const publishedAt = new Date(epoch.getTime() + slot * intervalMs);
  return {
    price: (calculated > 0n ? calculated : 1n).toString(),
    publishedAt: publishedAt.toISOString(),
    nextUpdateAt: new Date(publishedAt.getTime() + intervalMs).toISOString(),
    indicative: true,
  };
}
function feedSnapshot(base: bigint, epoch: Date, at: Date) {
  const m = marketAt(at);
  let snapshot = priceSnapshot(base, epoch, at, m.feedIntervalMs);
  if (m.isOpen && Date.parse(snapshot.publishedAt) < m.sessionOpen.getTime()) {
    snapshot = priceSnapshot(
      base,
      epoch,
      new Date(m.sessionOpen.getTime() - 1),
      300000,
    );
  } else if (!m.isOpen && m.tradingDay && at >= m.sessionClose) {
    const lastOpen = priceSnapshot(
      base,
      epoch,
      new Date(m.sessionClose.getTime() - 1),
    );
    if (Date.parse(lastOpen.publishedAt) > Date.parse(snapshot.publishedAt))
      snapshot = lastOpen;
  }
  return snapshot;
}
export function makePriceBreaker() {
  return new CircuitBreaker(async () => {
    const s = await settings();
    if (s.price_outage) throw Error("Price provider unavailable");
    const now: Date = s.provider_now;
    let effective =
      s.price_pause_until &&
      now < s.price_pause_until &&
      now >= s.price_pause_started_at
        ? new Date(s.price_pause_started_at.getTime() - 1)
        : now;
    let snapshot = feedSnapshot(BigInt(s.price), s.price_epoch, effective);
    // Do not fabricate a publication inside a feed interruption, including the
    // partial interval immediately after recovery. Keep the last real tick.
    const gaps = (
      await pool.query(
        "SELECT started_at,ends_at FROM price_interruptions WHERE started_at<=$1 ORDER BY started_at DESC",
        [now],
      )
    ).rows;
    for (const gap of gaps) {
      const published = Date.parse(snapshot.publishedAt);
      if (
        gap.started_at.getTime() <= published &&
        (!gap.ends_at || published < gap.ends_at.getTime())
      ) {
        effective = new Date(gap.started_at.getTime() - 1);
        snapshot = feedSnapshot(BigInt(s.price), s.price_epoch, effective);
      }
    }
    return {
      ...snapshot,
      stale:
        Date.parse(snapshot.publishedAt) > now.getTime() ||
        now.getTime() - Date.parse(snapshot.publishedAt) >
          marketAt(now).freshnessMs,
    };
  }, options);
}
export const priceBreaker = makePriceBreaker();
export const gatewayBreaker = new CircuitBreaker(async (id: string) => {
  const s = await settings();
  if (s.gateway_outage) throw Error("Gateway unavailable");
  const r = await pool.query(
    "SELECT * FROM gateway_transactions WHERE order_id=$1",
    [id],
  );
  return r.rows[0] ?? null;
}, options);
export const circuits = () =>
  Object.fromEntries(
    (
      [
        ["price", priceBreaker],
        ["gateway", gatewayBreaker],
      ] as const
    ).map(([k, b]) => [
      k,
      {
        state: b.opened ? "open" : b.halfOpen ? "half-open" : "closed",
        stats: b.stats,
      },
    ]),
  );

// Mock provider exposes the first published opening tick (a production adapter
// must persist the feed or contract for historical ticks, never substitute a later price).
export async function openingPrice(open: Date, now: Date) {
  const s = await settings();
  if (s.price_outage) throw Error("Price provider unavailable");
  const cached = (
    await pool.query("SELECT * FROM opening_prices WHERE session_open=$1", [
      open,
    ])
  ).rows[0];
  if (cached) return cached;
  let first = Math.max(open.getTime(), s.price_epoch.getTime());
  if (
    s.price_pause_started_at &&
    s.price_pause_started_at.getTime() <= first &&
    s.price_pause_until?.getTime() > first
  )
    first = s.price_pause_until.getTime();
  if (
    s.price_outage_started_at &&
    s.price_outage_started_at.getTime() <= first &&
    s.price_resumed_at?.getTime() > first
  )
    first = s.price_resumed_at.getTime();
  const interruptions = (
    await pool.query(
      "SELECT * FROM price_interruptions WHERE started_at<=$1 AND (ends_at IS NULL OR ends_at>=$2) ORDER BY started_at",
      [now, open],
    )
  ).rows;
  first =
    s.price_epoch.getTime() +
    Math.ceil((first - s.price_epoch.getTime()) / 30000) * 30000;
  for (const gap of interruptions) {
    if (
      gap.started_at.getTime() <= first &&
      (gap.ends_at === null || gap.ends_at.getTime() > first)
    ) {
      if (!gap.ends_at) throw Error("First opening price has not arrived");
      first =
        s.price_epoch.getTime() +
        Math.ceil((gap.ends_at.getTime() - s.price_epoch.getTime()) / 30000) *
          30000;
    }
  }
  if (first > now.getTime()) throw Error("First opening price has not arrived");
  const tick = priceSnapshot(BigInt(s.price), s.price_epoch, new Date(first));
  await pool.query(
    "INSERT INTO opening_prices(session_open,price,published_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [open, tick.price, tick.publishedAt],
  );
  return (
    await pool.query("SELECT * FROM opening_prices WHERE session_open=$1", [
      open,
    ])
  ).rows[0];
}
