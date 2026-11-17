import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { fileURLToPath } from "node:url";
import { pool, tx } from "./db.js";
import {
  quote,
  place,
  simulate,
  callback,
  balances,
  messages,
  enqueue,
  uuid,
  Problem,
} from "./domain.js";
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
  api.get("/api/price", async () => {
    const s = (
      await pool.query(
        "SELECT price,price_outage FROM mock_settings WHERE id=1",
      )
    ).rows[0];
    return { price: s.price, outage: s.price_outage, indicative: true };
  });
  api.post<{
    Body: {
      kind: "buy" | "sell" | "withdraw";
      amount?: string;
      gold?: string;
      quoteId?: string;
      sheba?: string;
    };
  }>("/api/orders", async (req) => {
    if (!req.body || !["buy", "sell", "withdraw"].includes(req.body.kind))
      throw new Problem(400, "Invalid order kind");
    return place(req.body.kind, req.body, req.headers["idempotency-key"]);
  });
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
    const [events, entries, jobs] = await Promise.all([
      pool.query("SELECT * FROM events WHERE order_id=$1 ORDER BY id", [id]),
      pool.query(
        "SELECT e.*,j.purpose FROM entries e JOIN journals j ON e.journal_id=j.id WHERE j.order_id=$1 ORDER BY e.id",
        [id],
      ),
      pool.query(
        "SELECT * FROM outbox WHERE order_id=$1 ORDER BY available_at",
        [id],
      ),
    ]);
    return {
      ...o,
      message: messages[o.status],
      events: events.rows,
      entries: entries.rows,
      jobs: jobs.rows,
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
    "/api/gateway/callback/:id",
    async (req) => {
      await callback(req.params.id);
      return { accepted: true };
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
      circuits: circuits(),
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
  api.post<{ Body: { priceOutage: boolean; gatewayOutage: boolean } }>(
    "/api/mock/settings",
    async (req) => {
      if (
        typeof req.body?.priceOutage !== "boolean" ||
        typeof req.body?.gatewayOutage !== "boolean"
      )
        throw new Problem(400, "Boolean outage flags required");
      await pool.query(
        "UPDATE mock_settings SET price_outage=$1,gateway_outage=$2 WHERE id=1",
        [req.body.priceOutage, req.body.gatewayOutage],
      );
      return { ok: true };
    },
  );
  return api;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await app().listen({
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
  });
