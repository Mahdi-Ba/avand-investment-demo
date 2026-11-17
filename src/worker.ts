import amqp from "amqplib";
import { randomUUID } from "node:crypto";
import { circuits } from "./providers.js";
import { pool, tx } from "./db.js";
import { verify, settleWithdrawal, reconcile, event } from "./domain.js";
const conn = await amqp.connect(
  process.env.AMQP_URL ?? "amqp://avand:avand_local@localhost:5678",
);
const ch = await conn.createConfirmChannel();
const queue = process.env.AMQP_QUEUE ?? "avand.jobs";
const deadQueue = queue + ".dead";
await ch.assertQueue(deadQueue, { durable: true });
await ch.assertQueue(queue, {
  durable: true,
  arguments: {
    "x-dead-letter-exchange": "",
    "x-dead-letter-routing-key": deadQueue,
  },
});
await ch.prefetch(8);
const workerId = randomUUID();
let heartbeatAt = 0;
let publishing = false;
async function publish() {
  if (publishing) return;
  publishing = true;
  try {
    if (Date.now() - heartbeatAt > 5000) {
      await pool.query(
        "INSERT INTO worker_status(id,circuits) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET circuits=excluded.circuits,last_seen=now()",
        [workerId, JSON.stringify(circuits())],
      );
      heartbeatAt = Date.now();
    }
    await tx(async (c) => {
      // Uncompleted jobs are republished after a lease, including broker loss. Duplicates are safe.
      const jobs = await c.query(
        "SELECT * FROM outbox WHERE completed_at IS NULL AND dead=false AND available_at<=now() AND (published_at IS NULL OR published_at<now()-interval '60 seconds') ORDER BY available_at LIMIT 50 FOR UPDATE SKIP LOCKED",
      );
      for (const job of jobs.rows) {
        ch.sendToQueue(queue, Buffer.from(JSON.stringify({ id: job.id })), {
          persistent: true,
          messageId: job.id,
        });
        await ch.waitForConfirms();
        await c.query("UPDATE outbox SET published_at=now() WHERE id=$1", [
          job.id,
        ]);
      }
    });
  } catch (e) {
    console.error("outbox_publish_error", e);
  } finally {
    publishing = false;
  }
}
await ch.consume(
  queue,
  async (msg) => {
    if (!msg) return;
    try {
      const { id } = JSON.parse(msg.content.toString());
      const job = (await pool.query("SELECT * FROM outbox WHERE id=$1", [id]))
        .rows[0];
      if (!job || job.completed_at || job.dead) {
        ch.ack(msg);
        return;
      }
      // Retry schedule is durable in Postgres, never a hot immediate requeue loop.
      if (new Date(job.available_at).getTime() > Date.now()) {
        ch.ack(msg);
        return;
      }
      try {
        let done = true;
        if (job.type === "verify") done = await verify(job.order_id);
        else if (job.type === "withdraw") await settleWithdrawal(job.order_id);
        else if (job.type === "reconcile") await reconcile();
        else throw Error("Unknown job type");
        if (done)
          await pool.query("UPDATE outbox SET completed_at=now() WHERE id=$1", [
            id,
          ]);
        else
          await pool.query(
            "UPDATE outbox SET published_at=NULL,available_at=now()+interval '5 seconds' WHERE id=$1",
            [id],
          );
        ch.ack(msg);
      } catch (e) {
        const attempts = job.attempts + 1,
          error = e instanceof Error ? e.message : String(e);
        const delay =
          Math.min(60, 2 ** Math.min(attempts, 6)) + Math.random() * 2;
        await tx(async (c) => {
          await c.query(
            "UPDATE outbox SET attempts=attempts+1,last_error=$2,dead=$3,published_at=NULL,available_at=now()+$4*interval '1 second' WHERE id=$1",
            [id, error, attempts >= 8, delay],
          );
          if (attempts >= 8 && job.type === "verify") {
            const r = await c.query(
              "UPDATE orders SET status='payment_review',updated_at=now() WHERE id=$1 AND status IN ('awaiting_payment','payment_pending') RETURNING id",
              [job.order_id],
            );
            if (r.rowCount)
              await event(c, job.order_id, "automatic_review_exhausted", {
                jobId: id,
              });
          }
        });
        if (attempts >= 8) ch.nack(msg, false, false);
        else ch.ack(msg);
      }
    } catch (e) {
      console.error("job_processing_error", e);
      ch.nack(msg, false, false);
    }
  },
  { noAck: false },
);
const timer = setInterval(() => void publish(), 500);
await publish();
console.log("Worker ready");
conn.on("error", (e) => console.error("amqp_error", e));
conn.on("close", () => process.exit(1));
async function shutdown() {
  clearInterval(timer);
  await ch.close();
  await conn.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
