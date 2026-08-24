-- ============================================================================
-- 002_triggers.sql
-- Auto-maintained updated_at + search_vector on products
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agreements_set_updated_at BEFORE UPDATE ON agreements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER field_mappings_set_updated_at BEFORE UPDATE ON field_mappings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- search_vector: weighted tsvector combining mapped fields (high weight) and
-- a fallback slice of raw_data values (lower weight) so free-text spec
-- columns (e.g. product spec sheets) remain searchable even without mapping.
-- Uses 'simple' config: Arabic has no dedicated PG text-search dictionary by
-- default, and normalization (alef/hamza/tashkeel) is handled at the
-- application layer before querying, not by the PG dictionary.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION products_build_search_vector(
  p_mapped_product_id TEXT, p_mapped_name_ar TEXT, p_mapped_name_en TEXT,
  p_mapped_description_ar TEXT, p_mapped_description_en TEXT,
  p_mapped_supplier_name TEXT, p_mapped_category_l1 TEXT, p_mapped_category_l2 TEXT,
  p_mapped_category_l3 TEXT, p_mapped_manufacturer TEXT, p_mapped_model TEXT,
  p_raw_data JSONB
) RETURNS tsvector AS $$
DECLARE
  raw_text TEXT;
BEGIN
  SELECT string_agg(value, ' ')
    INTO raw_text
    FROM jsonb_each_text(p_raw_data)
    WHERE value IS NOT NULL AND length(value) < 2000;

  RETURN
    setweight(to_tsvector('simple', coalesce(p_mapped_product_id,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(p_mapped_name_ar,'') || ' ' || coalesce(p_mapped_name_en,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(p_mapped_description_ar,'') || ' ' || coalesce(p_mapped_description_en,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(p_mapped_category_l1,'') || ' ' || coalesce(p_mapped_category_l2,'') || ' ' || coalesce(p_mapped_category_l3,'')), 'C') ||
    setweight(to_tsvector('simple', coalesce(p_mapped_manufacturer,'') || ' ' || coalesce(p_mapped_model,'')), 'C') ||
    setweight(to_tsvector('simple', coalesce(p_mapped_supplier_name,'')), 'D') ||
    setweight(to_tsvector('simple', coalesce(raw_text,'')), 'D');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION products_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := products_build_search_vector(
    NEW.mapped_product_id, NEW.mapped_name_ar, NEW.mapped_name_en,
    NEW.mapped_description_ar, NEW.mapped_description_en,
    NEW.mapped_supplier_name, NEW.mapped_category_l1, NEW.mapped_category_l2,
    NEW.mapped_category_l3, NEW.mapped_manufacturer, NEW.mapped_model,
    NEW.raw_data
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_vector_update
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_vector_trigger();
