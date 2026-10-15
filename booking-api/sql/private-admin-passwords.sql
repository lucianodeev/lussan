-- Dedicated Lussan credentials; does not modify Supabase Auth or existing records.
CREATE TABLE lussan_booking.private_admin_credentials (
 email text PRIMARY KEY CHECK(email='llucianouam@gmail.com'),
 password_hash text NOT NULL CHECK(password_hash ~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'),
 session_version uuid NOT NULL DEFAULT gen_random_uuid(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lussan_booking.private_admin_password_resets (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lussan_booking.private_admin_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE lussan_booking.private_admin_password_resets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON lussan_booking.private_admin_credentials,lussan_booking.private_admin_password_resets FROM PUBLIC,anon,authenticated;
