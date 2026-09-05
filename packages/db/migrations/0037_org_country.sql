-- Country of origin per organization, for geo analysis (which markets sign up,
-- which convert, whether a regional price is worth testing).
--
-- Source is Cloudflare's request.cf.country, which is free and present on every
-- Worker request — no IP database, no third-party lookup, no PII beyond a
-- two-letter code we already receive.
--
-- Nullable on purpose: existing rows have no country and there is no way to
-- derive one retroactively. Active accounts fill in the first time they make an
-- authenticated request (see touchOrganizationCountry); dormant accounts stay
-- NULL, which is honest rather than guessed.
ALTER TABLE organizations ADD COLUMN country TEXT;

-- Supports "signups by country" grouping without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_organizations_country ON organizations(country);
