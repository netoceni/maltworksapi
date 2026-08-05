CREATE TABLE sales_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  email TEXT NOT NULL COLLATE NOCASE,
  phone TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'login-page',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'discarded')),
  consent_at INTEGER NOT NULL,
  notification_status TEXT NOT NULL
    CHECK (notification_status IN ('pending', 'sent', 'failed', 'not_configured')),
  notification_id TEXT,
  notification_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_sales_leads_status_created
  ON sales_leads(status, created_at DESC);

CREATE INDEX idx_sales_leads_email_created
  ON sales_leads(email COLLATE NOCASE, created_at DESC);

CREATE INDEX idx_sales_leads_phone_created
  ON sales_leads(phone, created_at DESC);
