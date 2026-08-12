ALTER TABLE users ADD COLUMN birth_date TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;

CREATE INDEX idx_users_created_at ON users(created_at DESC);
CREATE INDEX idx_device_credentials_pairing_code_hash
  ON device_credentials(pairing_code_hash);

ALTER TABLE device_credentials ADD COLUMN rebind_expires_at INTEGER;
ALTER TABLE device_credentials ADD COLUMN rebind_requested_by_user_id TEXT;
