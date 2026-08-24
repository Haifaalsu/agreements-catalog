-- ============================================================================
-- 001_init.sql
-- دليل منتجات وخدمات الاتفاقيات الإطارية — Initial schema
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- partial / fuzzy text search
CREATE EXTENSION IF NOT EXISTS unaccent;   -- normalization helper
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ----------------------------------------------------------------------------
-- users (Admins). Extensible later for SSO (external_id/provider stay NULL
-- until SSO integration is wired up).
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT NOT NULL,
  email           CITEXT,
  password_hash   TEXT,                       -- NULL once SSO-only
  role            TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','super_admin')),
  sso_provider    TEXT,
  sso_external_id TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_uq ON users(email) WHERE email IS NOT NULL;

-- ----------------------------------------------------------------------------
-- agreements  (الاتفاقيات الإطارية)
-- ----------------------------------------------------------------------------
CREATE TABLE agreements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  name_ar         TEXT NOT NULL,
  name_en         TEXT,
  description_ar  TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  -- 'standard' = normal searchable rows. 'configurator' = cascading filter UI
  -- (e.g. Digital Circuits) instead of raw row listing.
  display_type    TEXT NOT NULL DEFAULT 'standard' CHECK (display_type IN ('standard','configurator')),
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- sources  (نُسخ الاستيراد المعتمدة لكل اتفاقية — واحد "نشط" لكل logical_source_key)
--
-- AMENDMENT 1: replacement is keyed on (agreement_id, logical_source_key),
-- NOT on the literal Excel sheet name, because sheet names may change
-- between future file versions of the same agreement. The original sheet
-- name is still stored for reference/audit, but never used as the
-- replacement key by itself.
-- ----------------------------------------------------------------------------
CREATE TABLE sources (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id        UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,

  -- Logical identity of this data source WITHIN the agreement, e.g.
  -- 'products' / 'accessories' / 'education' / 'support' / 'catalog'.
  -- Chosen by Admin at upload time (with a suggested default derived from
  -- the sheet name), and reused on every subsequent replace.
  logical_source_key  TEXT NOT NULL,

  -- Original literal Excel metadata — informational only, never a join key.
  original_file_name  TEXT NOT NULL,
  sheet_name          TEXT NOT NULL,
  header_row          INTEGER NOT NULL,
  storage_path        TEXT NOT NULL,        -- original .xlsx kept on disk as-is

  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','replaced','archived')),
  -- archived sources (e.g. Microsoft "Old Education") are never shown to
  -- normal users regardless of `status`; this flag is the explicit switch.
  is_visible_to_users BOOLEAN NOT NULL DEFAULT TRUE,

  row_count           INTEGER NOT NULL DEFAULT 0,
  supplier_count       INTEGER,
  category_count       INTEGER,

  superseded_by       UUID REFERENCES sources(id),
  replaced_at         TIMESTAMPTZ,

  imported_by         UUID REFERENCES users(id),
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                TEXT
);

CREATE INDEX sources_agreement_idx ON sources(agreement_id);
-- Only one ACTIVE source per (agreement, logical_source_key) at a time.
CREATE UNIQUE INDEX sources_active_logical_key_uq
  ON sources(agreement_id, logical_source_key)
  WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- products  (السجل الفعلي — صف Excel كما هو، بلا دمج، 1:1)
--
-- raw_data JSONB is the permanent Source of Truth: the entire original row,
-- keyed by the ORIGINAL column headers exactly as they appeared in the file.
-- The mapped_* columns below are derived, rebuildable, search/filter-only
-- projections — dropping and recomputing them never touches raw_data.
-- ----------------------------------------------------------------------------
CREATE TABLE products (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  agreement_id        UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE, -- denormalized for fast queries
  row_number           INTEGER NOT NULL,     -- original Excel row number (for traceability)

  raw_data             JSONB NOT NULL,        -- {"original column header": value, ...}

  -- Mapped / indexed convenience fields (nullable — populated only when a
  -- confident mapping exists for that column in this source).
  mapped_product_id       TEXT,
  mapped_name_ar           TEXT,
  mapped_name_en           TEXT,
  mapped_description_ar    TEXT,
  mapped_description_en    TEXT,
  mapped_supplier_id        TEXT,
  mapped_supplier_name      TEXT,
  mapped_category_l1        TEXT,
  mapped_category_l2        TEXT,
  mapped_category_l3        TEXT,
  mapped_manufacturer        TEXT,
  mapped_model                TEXT,
  mapped_country_of_origin    TEXT,
  mapped_unit                  TEXT,
  mapped_contract_number       TEXT,
  mapped_grouping_id            TEXT,   -- e.g. Telecom "Grouping Id" — stored, NOT used to merge rows

  -- Generic extensible bucket for agreement-specific dimensions that are not
  -- part of the common concept dictionary above (e.g. Digital Circuits'
  -- Bandwidth / SLA / PO Duration / Media / Services). Keyed by a short
  -- English attribute key. Indexed (see 003_configurator_indexes.sql).
  mapped_attributes             JSONB NOT NULL DEFAULT '{}',

  search_vector                 tsvector,

  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX products_source_idx ON products(source_id);
CREATE INDEX products_agreement_idx ON products(agreement_id);
CREATE INDEX products_mapped_product_id_idx ON products(mapped_product_id);
CREATE INDEX products_mapped_supplier_idx ON products(mapped_supplier_name);
CREATE INDEX products_mapped_category_idx ON products(mapped_category_l1, mapped_category_l2, mapped_category_l3);
CREATE INDEX products_search_vector_idx ON products USING GIN(search_vector);
CREATE INDEX products_raw_data_idx ON products USING GIN(raw_data jsonb_path_ops);
CREATE INDEX products_name_ar_trgm_idx ON products USING GIN(mapped_name_ar gin_trgm_ops);
CREATE INDEX products_name_en_trgm_idx ON products USING GIN(mapped_name_en gin_trgm_ops);
CREATE INDEX products_product_id_trgm_idx ON products USING GIN(mapped_product_id gin_trgm_ops);

-- Grouping helper: same product id, multiple suppliers, within one agreement
-- (e.g. Fuel). Used to render "available from X suppliers" WITHOUT merging rows.
CREATE INDEX products_group_idx ON products(agreement_id, mapped_product_id) WHERE mapped_product_id IS NOT NULL;
CREATE INDEX products_grouping_id_idx ON products(agreement_id, mapped_grouping_id) WHERE mapped_grouping_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- field_mappings  (تعريف ربط الأعمدة — محفوظ ليُعاد استخدامه عند كل استبدال)
--
-- AMENDMENT 2: identical header text can appear more than once in the same
-- sheet (confirmed in real files, e.g. "فئة الخدمات المستوى الأول" appearing
-- twice with different content). column_index (0-based physical position in
-- the sheet) disambiguates them, and the mapping is scoped per
-- (agreement_id, logical_source_key) — never a bare column-name match.
-- ----------------------------------------------------------------------------
CREATE TABLE field_mappings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id          UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  logical_source_key    TEXT NOT NULL,
  column_index           INTEGER NOT NULL,     -- 0-based physical column position
  source_column_name     TEXT NOT NULL,         -- literal header text (kept for display)

  mapped_concept          TEXT NOT NULL DEFAULT 'unmapped',
    -- one of: product_id, name_ar, name_en, description_ar, description_en,
    -- supplier_id, supplier_name, category_l1, category_l2, category_l3,
    -- manufacturer, model, country_of_origin, unit, contract_number,
    -- grouping_id, attribute:<key>, unmapped, internal_only

  is_searchable            BOOLEAN NOT NULL DEFAULT FALSE,
  is_filterable             BOOLEAN NOT NULL DEFAULT FALSE,
  visibility                 TEXT NOT NULL DEFAULT 'visible_user'
                               CHECK (visibility IN ('visible_user','admin_only','hidden')),
  display_order               INTEGER NOT NULL DEFAULT 0,
  display_label_ar             TEXT,               -- optional Admin-friendly override label

  confidence                    TEXT NOT NULL DEFAULT 'manual'
                                  CHECK (confidence IN ('auto_high','auto_low','manual')),
  confirmed_by                   UUID REFERENCES users(id),
  confirmed_at                    TIMESTAMPTZ,

  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(agreement_id, logical_source_key, column_index, source_column_name)
);

CREATE INDEX field_mappings_lookup_idx ON field_mappings(agreement_id, logical_source_key);

-- ----------------------------------------------------------------------------
-- configurator_dimensions  (تعريف أبعاد واجهة الـConfigurator لكل اتفاقية)
-- Only used when agreements.display_type = 'configurator'. Tells the frontend
-- which mapped_attributes keys to render as cascading filter steps, in order.
-- ----------------------------------------------------------------------------
CREATE TABLE configurator_dimensions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id    UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  attribute_key   TEXT NOT NULL,       -- key inside mapped_attributes JSONB
  label_ar        TEXT NOT NULL,
  label_en        TEXT,
  step_order      INTEGER NOT NULL,
  UNIQUE(agreement_id, attribute_key)
);

-- ----------------------------------------------------------------------------
-- import_batches (Staging layer — AMENDMENT 4)
--
-- Upload -> Parse -> Header Detection -> Sheet Classification -> Field
-- Mapping -> Staging -> Preview -> Approval -> Commit.
-- Rows living only in staging_products are never visible to end users and
-- are not "active" in any sense until an explicit Approve commits them into
-- `products` inside one transaction.
-- ----------------------------------------------------------------------------
CREATE TABLE import_batches (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id          UUID NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  logical_source_key    TEXT NOT NULL,

  original_file_name    TEXT NOT NULL,
  storage_path           TEXT NOT NULL,
  sheet_name              TEXT,
  header_row               INTEGER,
  header_confidence         TEXT CHECK (header_confidence IN ('high','low','manual')),
  sheet_classification       TEXT CHECK (sheet_classification IN ('data','reference','cover_or_legal','empty')),

  status                      TEXT NOT NULL DEFAULT 'uploaded'
                                CHECK (status IN (
                                  'uploaded','parsing','parsed','mapping_pending',
                                  'ready_for_review','approved','committed','rejected','failed'
                                )),

  total_rows_parsed             INTEGER NOT NULL DEFAULT 0,
  error_count                    INTEGER NOT NULL DEFAULT 0,
  warning_count                  INTEGER NOT NULL DEFAULT 0,

  committed_source_id             UUID REFERENCES sources(id),

  uploaded_by                     UUID REFERENCES users(id),
  uploaded_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at                      TIMESTAMPTZ,
  rejected_at                       TIMESTAMPTZ
);

CREATE INDEX import_batches_agreement_idx ON import_batches(agreement_id);
CREATE INDEX import_batches_status_idx ON import_batches(status);

CREATE TABLE staging_products (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number           INTEGER NOT NULL,

  raw_data              JSONB NOT NULL,

  mapped_product_id        TEXT,
  mapped_name_ar             TEXT,
  mapped_name_en              TEXT,
  mapped_description_ar        TEXT,
  mapped_description_en         TEXT,
  mapped_supplier_id              TEXT,
  mapped_supplier_name             TEXT,
  mapped_category_l1                TEXT,
  mapped_category_l2                TEXT,
  mapped_category_l3                TEXT,
  mapped_manufacturer                TEXT,
  mapped_model                        TEXT,
  mapped_country_of_origin             TEXT,
  mapped_unit                           TEXT,
  mapped_contract_number                 TEXT,
  mapped_grouping_id                      TEXT,
  mapped_attributes                        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX staging_products_batch_idx ON staging_products(batch_id);

CREATE TABLE import_issues (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number     INTEGER,               -- NULL = sheet-level issue
  severity        TEXT NOT NULL CHECK (severity IN ('error','warning')),
  code             TEXT NOT NULL,
  message           TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX import_issues_batch_idx ON import_issues(batch_id);

-- ----------------------------------------------------------------------------
-- synonyms  (قاموس المرادفات القابل للتعديل)
-- ----------------------------------------------------------------------------
CREATE TABLE synonym_groups (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_term TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE synonym_terms (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  synonym_group_id  UUID NOT NULL REFERENCES synonym_groups(id) ON DELETE CASCADE,
  term              TEXT NOT NULL,
  language          TEXT CHECK (language IN ('ar','en')),
  UNIQUE(synonym_group_id, term)
);

CREATE INDEX synonym_terms_term_idx ON synonym_terms(term);

-- ----------------------------------------------------------------------------
-- import_logs (سجل التحديثات — Audit trail)
-- ----------------------------------------------------------------------------
CREATE TABLE import_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  UUID REFERENCES agreements(id),
  source_id      UUID REFERENCES sources(id),
  batch_id        UUID REFERENCES import_batches(id),
  action           TEXT NOT NULL,
    -- upload, mapping_update, approve, reject, archive, restore, delete_source
  performed_by     UUID REFERENCES users(id),
  performed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count          INTEGER,
  error_count         INTEGER,
  warning_count        INTEGER,
  details               JSONB
);

CREATE INDEX import_logs_agreement_idx ON import_logs(agreement_id);
CREATE INDEX import_logs_performed_at_idx ON import_logs(performed_at DESC);

-- ----------------------------------------------------------------------------
-- schema_migrations (tracks which migration files have been applied)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
