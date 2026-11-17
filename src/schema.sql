CREATE TABLE IF NOT EXISTS wallets (id text PRIMARY KEY);
INSERT INTO wallets VALUES ('demo') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS quotes (
 id uuid PRIMARY KEY, price bigint NOT NULL CHECK(price>0), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
 id uuid PRIMARY KEY, wallet_id text NOT NULL REFERENCES wallets, kind text NOT NULL CHECK(kind IN ('buy','sell','withdraw')),
 idempotency_key text NOT NULL, request_hash text NOT NULL, quote_id uuid REFERENCES quotes,
 amount bigint NOT NULL CHECK(amount>0), gold bigint NOT NULL DEFAULT 0 CHECK(gold>=0), fee bigint NOT NULL DEFAULT 0 CHECK(fee>=0),
 status text NOT NULL, sheba text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(wallet_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS journals (
 id uuid PRIMARY KEY, order_id uuid REFERENCES orders, purpose text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(order_id,purpose)
);
CREATE TABLE IF NOT EXISTS entries (
 id bigserial PRIMARY KEY, journal_id uuid NOT NULL REFERENCES journals, account text NOT NULL,
 asset text NOT NULL CHECK(asset IN ('IRR','GOLD_UG')), amount bigint NOT NULL CHECK(amount<>0)
);
CREATE INDEX IF NOT EXISTS entries_account_idx ON entries(account,asset);
CREATE OR REPLACE FUNCTION check_journal_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT asset FROM entries WHERE journal_id=NEW.journal_id GROUP BY asset HAVING sum(amount)<>0) THEN
  RAISE EXCEPTION 'unbalanced journal';
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS balanced_journal ON entries;
CREATE CONSTRAINT TRIGGER balanced_journal AFTER INSERT ON entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_balance();
CREATE OR REPLACE FUNCTION immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger is append-only'; END $$;
DROP TRIGGER IF EXISTS entries_immutable ON entries;
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON entries FOR EACH ROW EXECUTE FUNCTION immutable_ledger();
DROP TRIGGER IF EXISTS journals_immutable ON journals;
CREATE TRIGGER journals_immutable BEFORE UPDATE OR DELETE ON journals FOR EACH ROW EXECUTE FUNCTION immutable_ledger();
CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders, type text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS outbox (
 id uuid PRIMARY KEY, order_id uuid REFERENCES orders, type text NOT NULL, available_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz, completed_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text, dead boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS gateway_transactions (
 order_id uuid PRIMARY KEY REFERENCES orders, reference uuid NOT NULL UNIQUE, amount bigint NOT NULL, status text NOT NULL,
 mode text NOT NULL, paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mock_settings (id integer PRIMARY KEY CHECK(id=1), price_outage boolean NOT NULL DEFAULT false, gateway_outage boolean NOT NULL DEFAULT false, price bigint NOT NULL DEFAULT 100000000 CHECK(price>0));
INSERT INTO mock_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS reconciliation_reports (id uuid PRIMARY KEY, mismatches jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS idempotency_responses (order_id uuid PRIMARY KEY REFERENCES orders, response jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS worker_status (id text PRIMARY KEY, circuits jsonb NOT NULL, last_seen timestamptz NOT NULL DEFAULT now());

-- Additive v1 MVP completion. Preserve all existing orders and ledger entries.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK(kind IN ('topup','buy','sell','withdraw'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS funding_source text NOT NULL DEFAULT 'gateway' CHECK(funding_source IN ('gateway','wallet'));
ALTER TABLE gateway_transactions ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'verified' CHECK(verification_status IN ('verified','rejected'));
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS provider_published_at timestamptz;
ALTER TABLE mock_settings ADD COLUMN IF NOT EXISTS price_epoch timestamptz NOT NULL DEFAULT now();

-- Part 5: daily risk reservations and cancellable, asset-backed market orders.
ALTER TABLE mock_settings ADD COLUMN IF NOT EXISTS clock_override timestamptz;
ALTER TABLE mock_settings ADD COLUMN IF NOT EXISTS price_pause_started_at timestamptz;
ALTER TABLE mock_settings ADD COLUMN IF NOT EXISTS price_pause_until timestamptz;
ALTER TABLE mock_settings ADD COLUMN IF NOT EXISTS price_outage_started_at timestamptz;
ALTER TABLE mock_settings ADD COLUMN IF NOT EXISTS price_resumed_at timestamptz;
CREATE TABLE IF NOT EXISTS daily_limits (
 wallet_id text NOT NULL REFERENCES wallets, day date NOT NULL, direction text NOT NULL CHECK(direction IN ('buy','sell')),
 used bigint NOT NULL CHECK(used>=0 AND used<=500000000), PRIMARY KEY(wallet_id,day,direction)
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'instant' CHECK(execution_mode IN ('instant','queued'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS execute_after timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS queue_reserved boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cap_day date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cap_amount bigint NOT NULL DEFAULT 0 CHECK(cap_amount>=0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS execution_price bigint;
CREATE INDEX IF NOT EXISTS queued_orders_due ON orders(execute_after) WHERE status='queued';
CREATE UNIQUE INDEX IF NOT EXISTS single_live_execution ON outbox(order_id,type) WHERE type='execute_queued' AND completed_at IS NULL AND dead=false;
CREATE TABLE IF NOT EXISTS opening_prices (session_open timestamptz PRIMARY KEY, price bigint NOT NULL CHECK(price>0), published_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS price_interruptions (
 id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('pause','outage')), started_at timestamptz NOT NULL, ends_at timestamptz,
 CHECK(ends_at IS NULL OR ends_at>=started_at)
);
