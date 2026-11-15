-- 0001_foundation: transactional outbox, consumer de-duplication and the
-- database-side helpers every later migration relies on.
--
-- Roles: migrations run as the schema owner. The application connects as a
-- least-privilege role (DB_APP_ROLE) that is granted only what a migration
-- explicitly passes to fc_app_grant(). Tables are owner-only by default.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Down-migration guards: raise (and so abort the whole down transaction)
-- instead of dropping anything that still holds data.
CREATE FUNCTION fc_assert_table_empty(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  has_rows boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', tbl) INTO has_rows;
  IF has_rows THEN
    RAISE EXCEPTION 'down migration refused: table % still contains data', tbl
      USING ERRCODE = 'FCD01';
  END IF;
END
$$;

CREATE FUNCTION fc_assert_column_empty(tbl regclass, col text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  has_values boolean;
BEGIN
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I IS NOT NULL)', tbl, col)
    INTO has_values;
  IF has_values THEN
    RAISE EXCEPTION 'down migration refused: column %.% still contains data', tbl, col
      USING ERRCODE = 'FCD01';
  END IF;
END
$$;

-- Grants table privileges to the application role named in the `app.role`
-- setting (the runner sets it from DB_APP_ROLE). A no-op when it is unset.
-- Only plain DML privileges can be granted through it.
CREATE FUNCTION fc_app_grant(tbl regclass, privileges text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  app_role text := nullif(current_setting('app.role', true), '');
BEGIN
  IF privileges !~ '^(SELECT|INSERT|UPDATE|DELETE)(, (SELECT|INSERT|UPDATE|DELETE))*$' THEN
    RAISE EXCEPTION 'fc_app_grant: unsupported privilege list "%"', privileges;
  END IF;
  IF app_role IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format('GRANT %s ON %s TO %I', privileges, tbl, app_role);
END
$$;

REVOKE ALL ON FUNCTION fc_app_grant(regclass, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  type            text NOT NULL,
  aggregate_type  text,
  aggregate_id    text,
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  published_at    timestamptz,
  dead_at         timestamptz,
  CONSTRAINT outbox_events_type_format CHECK (type ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  CONSTRAINT outbox_events_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_events_aggregate_pair CHECK ((aggregate_type IS NULL) = (aggregate_id IS NULL)),
  CONSTRAINT outbox_events_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT outbox_events_not_published_and_dead CHECK (NOT (published_at IS NOT NULL AND dead_at IS NOT NULL))
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (next_attempt_at, id)
  WHERE published_at IS NULL AND dead_at IS NULL;

-- One row per (consumer, event): lets consumers skip events they already
-- handled. No foreign key, so old outbox rows can be pruned independently.
CREATE TABLE handled_events (
  consumer   text NOT NULL,
  event_id   uuid NOT NULL,
  handled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id),
  CONSTRAINT handled_events_consumer_format CHECK (consumer ~ '^[a-z][a-z0-9_.-]{0,63}$')
);

SELECT fc_app_grant('outbox_events', 'SELECT, INSERT, UPDATE');
SELECT fc_app_grant('handled_events', 'SELECT, INSERT');
