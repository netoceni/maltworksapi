ALTER TABLE sales_leads ADD COLUMN product TEXT NOT NULL DEFAULT 'Contato comercial';
ALTER TABLE sales_leads ADD COLUMN city TEXT NOT NULL DEFAULT 'Não informado';
ALTER TABLE sales_leads ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 999);
ALTER TABLE sales_leads ADD COLUMN campaign TEXT;

CREATE TABLE sales_lead_events (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES sales_leads(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sales_lead_events_lead_created
  ON sales_lead_events(lead_id, created_at DESC);
