import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
export type Posting = [
  account: string,
  asset: "IRR" | "GOLD_UG",
  amount: bigint,
];
export async function journal(
  c: PoolClient,
  orderId: string,
  purpose: string,
  postings: Posting[],
) {
  const sums = new Map<string, bigint>();
  for (const [, asset, n] of postings)
    sums.set(asset, (sums.get(asset) ?? 0n) + n);
  if ([...sums.values()].some((n) => n !== 0n))
    throw Error("Unbalanced journal");
  const id = randomUUID();
  await c.query("INSERT INTO journals(id,order_id,purpose) VALUES($1,$2,$3)", [
    id,
    orderId,
    purpose,
  ]);
  for (const [account, asset, n] of postings)
    if (n !== 0n)
      await c.query(
        "INSERT INTO entries(journal_id,account,asset,amount) VALUES($1,$2,$3,$4)",
        [id, account, asset, n.toString()],
      );
}
export async function balance(c: PoolClient, account: string, asset: string) {
  if (account === "user:demo" || account === "user:demo:reserved") {
    const reserved = account.endsWith(":reserved");
    if (asset !== "IRR" && asset !== "GOLD_UG") throw Error("Unknown asset");
    const column =
      (reserved ? "reserved_" : "available_") +
      (asset === "IRR" ? "rials" : "gold_ug");
    const r = await c.query(
      `SELECT ${column}::text AS value FROM wallets WHERE id='demo'`,
    );
    if (!r.rowCount) throw Error("Wallet not found");
    return BigInt(r.rows[0].value);
  }
  const r = await c.query(
    "SELECT coalesce(sum(amount),0)::text AS value FROM entries WHERE account=$1 AND asset=$2",
    [account, asset],
  );
  return BigInt(r.rows[0].value);
}
export async function lockWallet(c: PoolClient) {
  await c.query("SELECT id FROM wallets WHERE id='demo' FOR UPDATE");
}
