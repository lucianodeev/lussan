CREATE TABLE lussan_booking.verification_uploads (
 cart_order_id uuid PRIMARY KEY REFERENCES lussan_booking.cart_orders(id) ON DELETE CASCADE,
 document_cipher bytea,
 selfie_cipher bytea,
 document_type text NOT NULL CHECK(document_type IN ('image/jpeg','image/png')),
 selfie_type text NOT NULL CHECK(selfie_type IN ('image/jpeg','image/png')),
 review_status text NOT NULL CHECK(review_status IN ('pending_review','approved','rejected')),
 submitted_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 CHECK(octet_length(document_cipher)<=4194332),
 CHECK(octet_length(selfie_cipher)<=4194332)
);
ALTER TABLE lussan_booking.verification_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON lussan_booking.verification_uploads FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON lussan_booking.verification_uploads TO lussan_booking_api;
CREATE POLICY lussan_backend_verification_files ON lussan_booking.verification_uploads TO lussan_booking_api USING(true) WITH CHECK(true);
GRANT INSERT,UPDATE ON lussan_booking.photo_verifications,lussan_booking.magazine_verifications TO lussan_booking_api;
CREATE POLICY lussan_backend_photo_verification_insert ON lussan_booking.photo_verifications FOR INSERT TO lussan_booking_api WITH CHECK(true);
CREATE POLICY lussan_backend_photo_verification_update ON lussan_booking.photo_verifications FOR UPDATE TO lussan_booking_api USING(true) WITH CHECK(true);
CREATE POLICY lussan_backend_magazine_verification_insert ON lussan_booking.magazine_verifications FOR INSERT TO lussan_booking_api WITH CHECK(true);
CREATE POLICY lussan_backend_magazine_verification_update ON lussan_booking.magazine_verifications FOR UPDATE TO lussan_booking_api USING(true) WITH CHECK(true);
