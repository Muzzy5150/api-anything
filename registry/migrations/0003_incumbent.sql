-- When a version first went live: of two live versions of an op, the incumbent (the earlier) is served
-- until it degrades. Versions live or degraded now count from when they were made.
ALTER TABLE versions ADD COLUMN live_since TEXT;
UPDATE versions SET live_since = created_at WHERE status IN ('live', 'degraded');

-- The uploader's network hash: a candidate on a site with no live op becomes a verify job once an install
-- on another network reported it ok.
ALTER TABLE versions ADD COLUMN uploader_network TEXT;

-- An uploaded title could claim any brand: a site nobody seeded is titled by its domain.
UPDATE sites SET display_name = domain WHERE first_uploader <> 'seed';
