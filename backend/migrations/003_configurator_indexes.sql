-- ============================================================================
-- 003_configurator_indexes.sql
-- AMENDMENT 3: dedicated indexed structure for Configurator-type agreements
-- (e.g. Digital Circuits) so cascading DISTINCT/filter queries over tens of
-- thousands of rows do not depend on scanning raw_data JSONB directly.
--
-- Category / Sub Category already have first-class btree columns
-- (mapped_category_l1 / mapped_category_l2 — see products_mapped_category_idx
-- in 001_init.sql). The remaining Digital Circuits dimensions (Bandwidth,
-- SLA, PO Duration, Media, Services) live in mapped_attributes JSONB; each
-- gets its own B-tree expression index below so DISTINCT/equality filtering
-- on them is index-backed rather than a JSONB scan.
--
-- Any future configurator-type agreement's extra dimensions can get the same
-- treatment by adding one expression index per new attribute_key — this is
-- exactly what ensureConfiguratorIndexes() in src/services/configurator.ts
-- does automatically whenever a new configurator_dimensions row is created
-- from the Admin panel, so this does not stay a manual/manual-only step.
-- ============================================================================

CREATE INDEX IF NOT EXISTS products_attr_bandwidth_idx    ON products (((mapped_attributes->>'bandwidth')));
CREATE INDEX IF NOT EXISTS products_attr_sla_idx           ON products (((mapped_attributes->>'sla')));
CREATE INDEX IF NOT EXISTS products_attr_po_duration_idx    ON products (((mapped_attributes->>'po_duration')));
CREATE INDEX IF NOT EXISTS products_attr_media_idx           ON products (((mapped_attributes->>'media')));
CREATE INDEX IF NOT EXISTS products_attr_service_idx          ON products (((mapped_attributes->>'service')));

-- Composite index to accelerate the cascading configurator query pattern:
-- WHERE agreement_id = ? AND category = ? AND sub_category = ? AND ... in order.
CREATE INDEX IF NOT EXISTS products_configurator_cascade_idx
  ON products (agreement_id, mapped_category_l1, mapped_category_l2,
               ((mapped_attributes->>'bandwidth')), ((mapped_attributes->>'sla')));
