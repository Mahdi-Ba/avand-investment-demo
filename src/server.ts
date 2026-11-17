import { requestRefund } from "./operations.js";
import { externalCircuits } from "./external.js";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { fileURLToPath } from "node:url";
import { pool, tx } from "./db.js";
import {
  quote,
  currentPrice,
  resolveVerification,
  place,
  simulate,
  callback,
  balances,
  messages,
  enqueue,
  uuid,
  cancelOrder,
  scheduleQueued,
  Problem,
} from "./domain.js";
import { businessNow, marketStatus } from "./market.js";
import { circuits } from "./providers.js";
export function app() {
  const api = Fastify({ logger: true, bodyLimit: 16384 });
  api.register(staticFiles, {
    root: fileURLToPath(new URL("../public", import.meta.url)),
  });
  api.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 500) api.log.error(e);
    reply.code(status).send({
      error: status === 500 ? "خطای داخلی؛ جزئیات در لاگ ثبت شد." : e.message,
    });
  });
  api.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok", mode: "local-mock" };
  });
  api.get("/api/balances", balances);
  api.post("/api/quotes", quote);
  api.get("/api/price", currentPrice);
  api.get("/api/market", marketStatus);
  api.post<{ Params: { id: string } }>("/api/orders/:id/cancel", async (req) =>
    cancelOrder(req.params.id),
  );
  api.post("/api/support/process-queue", async () => {
    await scheduleQueued();
    return { accepted: true };
  });
  api.post<{ Body: { clock?: string | null; pauseFeed?: boolean } }>(
    "/api/mock/market",
    async (req) => {
      const body = req.body ?? {};
      if (
        body.clock !== undefined &&
        body.clock !== null &&
        (typeof body.clock !== "string" ||
          !/(Z|[+-]\d{2}:\d{2})$/.test(body.clock) ||
          !Number.isFinite(Date.parse(body.clock)))
      )
        throw new Problem(
          400,
          "clock must be an ISO timestamp with an explicit timezone, or null",
        );
      if (body.pauseFeed !== undefined && typeof body.pauseFeed !== "boolean")
        throw new Problem(400, "pauseFeed must be boolean");
      await tx(async (c) => {
        if (body.clock !== undefined)
          await c.query(
            "UPDATE mock_settings SET clock_override=$1 WHERE id=1",
            [body.clock],
          );
        if (body.pauseFeed !== undefined) {
          const now = await businessNow(c);
          await c.query(
            "UPDATE price_interruptions SET ends_at=greatest(started_at,$1) WHERE kind='pause' AND ends_at>$1",
            [now],
          );
          if (body.pauseFeed)
            await c.query(
              "INSERT INTO price_interruptions(id,kind,started_at,ends_at) VALUES($1,'pause',$2,$3)",
              [randomUUID(), now, new Date(now.getTime() + 900000)],
            );
          await c.query(
            "UPDATE mock_settings SET price_pause_started_at=$1,price_pause_until=$2 WHERE id=1",
            [
              body.pauseFeed ? now : null,
              body.pauseFeed ? new Date(now.getTime() + 900000) : null,
            ],
          );
        }
      });
      return marketStatus();
    },
  );
  api.post<{
    Body: {
      kind: "topup" | "buy" | "sell" | "withdraw";
      amount?: string;
      gold?: string;
      quoteId?: string;
      sheba?: string;
      fundingSource?: "wallet" | "gateway";
    };
  }>("/api/orders", async (req) => {
    if (
      !req.body ||
      !["topup", "buy", "sell", "withdraw"].includes(req.body.kind)
    )
      throw new Problem(400, "Invalid order kind");
    return place(req.body.kind, req.body, req.headers["idempotency-key"]);
  });
  api.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/api/history",
    async (req) => {
      const limit =
        req.query.limit === undefined ? 25 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Problem(400, "limit must be between 1 and 100");
      let cursor: string[] | null = null;
      if (req.query.cursor) {
        try {
          cursor = JSON.parse(
            Buffer.from(req.query.cursor, "base64url").toString(),
          );
          if (
            !Array.isArray(cursor) ||
            cursor.length !== 2 ||
            typeof cursor[0] !== "string" ||
            !Number.isFinite(Date.parse(cursor[0]))
          )
            throw Error();
          uuid(cursor[1]);
        } catch {
          throw new Problem(400, "Invalid history cursor");
        }
      }
      const rows = (
        await pool.query(
          "SELECT *,created_at::text AS cursor_created_at FROM orders WHERE wallet_id='demo' AND ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT $3",
          [cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
        )
      ).rows;
      const more = rows.length > limit,
        visible = rows.slice(0, limit),
        last = visible.at(-1);
      const nextCursor = more
        ? Buffer.from(
            JSON.stringify([last.cursor_created_at, last.id]),
          ).toString("base64url")
        : null;
      return {
        items: visible.map(({ cursor_created_at, ...o }) => ({
          ...o,
          message: messages[o.status],
        })),
        nextCursor,
      };
    },
  );
  api.post<{ Params: { id: string } }>(
    "/api/support/orders/:id/refund",
    async (req) => requestRefund(req.params.id),
  );
  api.get("/api/orders", async () => {
    const r = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC LIMIT 100",
    );
    return r.rows.map((o) => ({ ...o, message: messages[o.status] }));
  });
  api.get<{ Params: { id: string } }>("/api/orders/:id", async (req) => {
    const id = uuid(req.params.id),
      o = (await pool.query("SELECT * FROM orders WHERE id=$1", [id])).rows[0];
    if (!o) throw new Problem(404, "Order not found");
    const [events, entries, jobs, payment] = await Promise.all([
      pool.query("SELECT * FROM events WHERE order_id=$1 ORDER BY id", [id]),
      pool.query(
        "SELECT e.*,j.purpose FROM entries e JOIN journals j ON e.journal_id=j.id WHERE j.order_id=$1 ORDER BY e.id",
        [id],
      ),
      pool.query(
        "SELECT * FROM outbox WHERE order_id=$1 ORDER BY available_at",
        [id],
      ),
      pool.query("SELECT * FROM gateway_transactions WHERE order_id=$1", [id]),
    ]);
    return {
      ...o,
      message: messages[o.status],
      events: events.rows,
      entries: entries.rows,
      jobs: jobs.rows,
      payment: payment.rows[0] ?? null,
    };
  });
  api.post<{ Params: { id: string }; Body: { mode: string } }>(
    "/api/mock/payments/:id",
    async (req) => {
      await simulate(req.params.id, req.body?.mode);
      return { accepted: true };
    },
  );
  api.post<{ Params: { id: string } }>(
    "/api/mock/payments/:id/resolve-verification",
    async (req) => {
      await resolveVerification(req.params.id);
      return { accepted: true };
    },
  );
  api.post<{ Params: { id: string } }>(
    "/api/gateway/callback/:id",
    async (req) => {
      await callback(req.params.id);
      return { accepted: true };
    },
  );
  api.get("/api/support/invariants", async () => {
    const totals = (
      await pool.query(
        "SELECT asset,sum(amount)::text AS total FROM entries GROUP BY asset",
      )
    ).rows;
    const invalid = (
      await pool.query(
        "SELECT journal_id,asset FROM entries GROUP BY journal_id,asset HAVING sum(amount)<>0",
      )
    ).rows;
    return {
      balanced: invalid.length === 0 && totals.every((x) => x.total === "0"),
      totals,
      invalid,
    };
  });
  api.post<{ Params: { id: string }; Body: { hidden: boolean } }>(
    "/api/mock/payments/:id/statement",
    async (req) => {
      if (typeof req.body?.hidden !== "boolean")
        throw new Problem(400, "hidden must be boolean");
      const r = await pool.query(
        "UPDATE gateway_transactions SET statement_hidden=$2 WHERE order_id=$1 RETURNING order_id",
        [uuid(req.params.id), req.body.hidden],
      );
      if (!r.rowCount) throw new Problem(404, "Payment not found");
      return { ok: true };
    },
  );
  api.get("/api/support", async () => {
    const [reports, jobs, workers] = await Promise.all([
      pool.query(
        "SELECT * FROM reconciliation_reports ORDER BY created_at DESC LIMIT 1",
      ),
      pool.query(
        "SELECT dead,count(*)::int AS count FROM outbox WHERE completed_at IS NULL GROUP BY dead",
      ),
      pool.query(
        "SELECT * FROM worker_status WHERE last_seen>now()-interval '1 minute'",
      ),
    ]);
    return {
      circuits: { ...circuits(), ...externalCircuits() },
      workers: workers.rows,
      latestReport: reports.rows[0] ?? null,
      jobs: jobs.rows,
    };
  });
  api.post("/api/support/reconcile", async () => {
    await tx((c) => enqueue(c, null, "reconcile"));
    return { accepted: true };
  });
  api.post<{ Params: { id: string } }>(
    "/api/support/jobs/:id/retry",
    async (req) => {
      const r = await pool.query(
        "UPDATE outbox SET dead=false,attempts=0,published_at=NULL,available_at=now() WHERE id=$1 AND dead=true RETURNING id",
        [uuid(req.params.id)],
      );
      if (!r.rowCount) throw new Problem(404, "Dead job not found");
      return { accepted: true };
    },
  );
  api.get(
    "/api/mock/settings",
    async () =>
      (await pool.query("SELECT * FROM mock_settings WHERE id=1")).rows[0],
  );
  api.post<{
    Body: {
      priceOutage: boolean;
      gatewayOutage: boolean;
      custodianOutage?: boolean;
      custodianMode?: string;
      bankOutage?: boolean;
    };
  }>("/api/mock/settings", async (req) => {
    if (
      typeof req.body?.priceOutage !== "boolean" ||
      typeof req.body?.gatewayOutage !== "boolean"
    )
      throw new Problem(400, "Boolean outage flags required");
    if (
      (req.body.custodianOutage !== undefined &&
        typeof req.body.custodianOutage !== "boolean") ||
      (req.body.bankOutage !== undefined &&
        typeof req.body.bankOutage !== "boolean") ||
      (req.body.custodianMode !== undefined &&
        !["normal", "missing", "wrong_quantity"].includes(
          req.body.custodianMode,
        ))
    )
      throw new Problem(400, "Invalid external mock controls");
    await tx(async (c) => {
      await c.query(
        "UPDATE mock_settings SET custodian_outage=coalesce($1,custodian_outage),custodian_mode=coalesce($2,custodian_mode),bank_outage=coalesce($3,bank_outage) WHERE id=1",
        [
          req.body.custodianOutage ?? null,
          req.body.custodianMode ?? null,
          req.body.bankOutage ?? null,
        ],
      );
      const now = await businessNow(c);
      const previous = (
        await c.query(
          "SELECT price_outage FROM mock_settings WHERE id=1 FOR UPDATE",
        )
      ).rows[0];
      if (req.body.priceOutage && !previous.price_outage)
        await c.query(
          "INSERT INTO price_interruptions(id,kind,started_at) VALUES($1,'outage',$2)",
          [randomUUID(), now],
        );
      if (!req.body.priceOutage && previous.price_outage)
        await c.query(
          "UPDATE price_interruptions SET ends_at=greatest(started_at,$1) WHERE kind='outage' AND ends_at IS NULL",
          [now],
        );
      await c.query(
        "UPDATE mock_settings SET price_outage_started_at=CASE WHEN $1 AND NOT price_outage THEN $3 ELSE price_outage_started_at END,price_resumed_at=CASE WHEN NOT $1 AND price_outage THEN $3 ELSE price_resumed_at END,price_outage=$1,gateway_outage=$2 WHERE id=1",
        [req.body.priceOutage, req.body.gatewayOutage, now],
      );
    });
    return { ok: true };
  });
  return api;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await app().listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
  });
