-- Versions of one op on one site: verify-jobs skips a candidate a live version shadows, and an upload asks
-- which op names a site already has.
CREATE INDEX versions_op ON versions (site, op_name, status);
