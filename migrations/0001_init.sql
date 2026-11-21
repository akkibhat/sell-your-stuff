-- Sell Your Stuff: the first version of the database.
--
-- Both modes use these tables. In template mode there's one sale with the id
-- 'main' and no seller. In hosted mode every seller owns exactly one sale.
-- Everything a seller can touch (items, offers, photos) carries a sale_id, and
-- every query the Worker runs is scoped by it.

-- One row per hosted seller. Passwords are PBKDF2 hashes with their own salt.
CREATE TABLE sellers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- stored lowercased
  password_hash TEXT NOT NULL,           -- base64
  password_salt TEXT NOT NULL,           -- base64, 16 random bytes
  password_iterations INTEGER NOT NULL,  -- kept per user so it can be raised later
  created_at TEXT NOT NULL
);

-- One row per sale. seller_id and slug are empty for the template sale.
CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  seller_id TEXT UNIQUE REFERENCES sellers(id) ON DELETE CASCADE,
  slug TEXT UNIQUE,
  settings TEXT NOT NULL DEFAULT '{}',   -- JSON: sale name, intro, location, currency, colour, closed
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  price REAL NOT NULL,
  was_price REAL,
  category TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  photos TEXT NOT NULL DEFAULT '[]',     -- JSON list of photo ids, first is the main one
  created_at TEXT NOT NULL
);
CREATE INDEX items_by_sale ON items (sale_id, created_at);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  item_title TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  amount REAL,
  message TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  date TEXT NOT NULL,
  winner INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  picked_up INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX offers_by_sale ON offers (sale_id, date);
CREATE INDEX offers_by_item ON offers (item_id);

-- Which sale owns each photo. The bytes live in R2 (hosted) or KV (template).
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX photos_by_sale ON photos (sale_id);

-- One-time invite codes (hosted mode). Only a hash of each code is kept.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,        -- SHA-256 of the normalised code
  hint TEXT NOT NULL,                    -- first four characters, so the owner can tell them apart
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  used_at TEXT,
  seller_id TEXT REFERENCES sellers(id) ON DELETE SET NULL
);

-- Short-lived counters that slow down spam and password guessing.
-- The key is a hash of the bucket and visitor IP, never the IP itself.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL            -- unix seconds
);
