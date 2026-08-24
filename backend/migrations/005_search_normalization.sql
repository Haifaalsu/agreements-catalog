-- ============================================================================
-- 005_search_normalization.sql
-- Arabic/English search normalization — applied ONLY to derived, generated
-- search columns. raw_data and every mapped_* display value are untouched;
-- these columns exist purely so partial/fuzzy matching works the same way
-- whether a value was typed with أ/إ/آ/ا, with or without tashkeel, or in a
-- different case in English. Mirrors src/services/textNormalize.ts — keep
-- the two in sync if either changes.
-- ============================================================================

CREATE OR REPLACE FUNCTION normalize_ar_en(input TEXT) RETURNS TEXT AS $$
DECLARE
  s TEXT;
BEGIN
  IF input IS NULL THEN RETURN ''; END IF;
  s := lower(input);
  s := regexp_replace(s, '[' || chr(160) || E'\r\n\t]+', ' ', 'g'); -- nbsp / line breaks -> space
  s := regexp_replace(s, '[ًٌٍَُِّْٰٕٖٜٟٓٔٗ٘ٙٚٛٝٞ]', '', 'g');        -- tashkeel / Quranic marks
  s := regexp_replace(s, '[إأآا]', 'ا', 'g');
  s := replace(s, 'ى', 'ي');
  s := replace(s, 'ة', 'ه');
  s := replace(s, 'ؤ', 'و');
  s := replace(s, 'ئ', 'ي');
  s := replace(s, 'ـ', '');
  s := trim(regexp_replace(s, '\s+', ' ', 'g'));
  RETURN s;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- One generated column per relevance tier used by the Search Engine
-- (see src/services/searchService.ts): product id, name+description
-- ("identity"), category path, manufacturer+model, supplier.
ALTER TABLE products ADD COLUMN search_norm_product_id TEXT
  GENERATED ALWAYS AS (normalize_ar_en(mapped_product_id)) STORED;

ALTER TABLE products ADD COLUMN search_norm_identity TEXT
  GENERATED ALWAYS AS (normalize_ar_en(
    coalesce(mapped_name_ar,'') || ' ' || coalesce(mapped_name_en,'') || ' ' ||
    coalesce(mapped_description_ar,'') || ' ' || coalesce(mapped_description_en,'')
  )) STORED;

ALTER TABLE products ADD COLUMN search_norm_category TEXT
  GENERATED ALWAYS AS (normalize_ar_en(
    coalesce(mapped_category_l1,'') || ' ' || coalesce(mapped_category_l2,'') || ' ' || coalesce(mapped_category_l3,'')
  )) STORED;

ALTER TABLE products ADD COLUMN search_norm_manufacturer_model TEXT
  GENERATED ALWAYS AS (normalize_ar_en(coalesce(mapped_manufacturer,'') || ' ' || coalesce(mapped_model,''))) STORED;

ALTER TABLE products ADD COLUMN search_norm_supplier TEXT
  GENERATED ALWAYS AS (normalize_ar_en(coalesce(mapped_supplier_name,''))) STORED;

CREATE INDEX products_search_norm_product_id_trgm_idx ON products USING GIN (search_norm_product_id gin_trgm_ops);
CREATE INDEX products_search_norm_identity_trgm_idx ON products USING GIN (search_norm_identity gin_trgm_ops);
CREATE INDEX products_search_norm_category_trgm_idx ON products USING GIN (search_norm_category gin_trgm_ops);
CREATE INDEX products_search_norm_manufacturer_model_trgm_idx ON products USING GIN (search_norm_manufacturer_model gin_trgm_ops);
CREATE INDEX products_search_norm_supplier_trgm_idx ON products USING GIN (search_norm_supplier gin_trgm_ops);
