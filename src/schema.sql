CREATE TABLE IF NOT EXISTS clinic_slots (
  id text PRIMARY KEY,
  provider text NOT NULL,
  start timestamptz NOT NULL,
  "end" timestamptz NOT NULL,
  CHECK ("end" > start)
);
CREATE TABLE IF NOT EXISTS clinic_bookings (
  id text PRIMARY KEY,
  slot_id text NOT NULL REFERENCES clinic_slots(id),
  name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp())
);
CREATE UNIQUE INDEX IF NOT EXISTS clinic_one_confirmed_per_slot
  ON clinic_bookings(slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS clinic_booking_email_cursor ON clinic_bookings(email, created_at, id);
CREATE TABLE IF NOT EXISTS clinic_idempotency (
  key text PRIMARY KEY,
  request_body text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS clinic_attempts (
  email text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS clinic_attempt_email_time ON clinic_attempts(email, attempted_at);
