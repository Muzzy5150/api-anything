-- The registry's tables (docs/REGISTRY.md "What the registry stores"). No args, no response data, no IPs.

CREATE TABLE sites (
  name TEXT PRIMARY KEY,
  -- bound by the first upload; another domain under this name is refused
  domain TEXT NOT NULL,
  base_url TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  login_cookies TEXT,
  notes TEXT,
  first_uploader TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE versions (
  hash TEXT PRIMARY KEY,
  site TEXT NOT NULL REFERENCES sites (name),
  op_name TEXT NOT NULL,
  -- the op's match: method, host, path, operationName (serving groups versions by op_name: catalog.ts)
  sig TEXT NOT NULL,
  operation TEXT NOT NULL,
  parent TEXT,
  -- a heal of a version that was live: promoted by fewer confirmations
  heal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reasons TEXT,
  uploader TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_ok_at TEXT
);
CREATE INDEX versions_site ON versions (site, sig);
CREATE INDEX versions_status ON versions (status);

-- one row per (version, install): its latest outcome
CREATE TABLE reports (
  hash TEXT NOT NULL,
  key TEXT NOT NULL,
  -- sha256 of SALT and the ASN, else the IP's /24 or /48
  network TEXT NOT NULL,
  outcome TEXT NOT NULL,
  tier INTEGER,
  ms INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (hash, key)
);
CREATE INDEX reports_key ON reports (key);

CREATE TABLE keys (
  key TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  uploads INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0
);

-- hourly counters for rate limits; subject is `key:<public key>` or `net:<hashed IP prefix>`
CREATE TABLE rates (
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (subject, kind, hour)
);
