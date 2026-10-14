-- Lussan booking service only. Run in a dedicated PostgreSQL database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS appointments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 service_date date NOT NULL,
 start_time time NOT NULL,
 end_time time NOT NULL,
 duration_minutes integer NOT NULL CHECK(duration_minutes IN(30,60,90,120)),
 amount_cents integer NOT NULL CHECK(amount_cents>0),
 client_name text NOT NULL,
 client_contact text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','confirmed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(start_time<end_time)
);
CREATE INDEX IF NOT EXISTS appointments_date_status_idx ON appointments(service_date,status);
CREATE TABLE IF NOT EXISTS blocked_slots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 service_date date NOT NULL,
 start_time time NOT NULL,
 end_time time NOT NULL,
 note text,
 CHECK(start_time<end_time)
);
CREATE INDEX IF NOT EXISTS blocked_slots_date_idx ON blocked_slots(service_date);
