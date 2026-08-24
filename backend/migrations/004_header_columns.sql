-- ============================================================================
-- 004_header_columns.sql
-- Bugfix: JSONB does not guarantee key order is preserved on storage/retrieval,
-- so column order can NEVER be safely reconstructed from raw_data's keys
-- (needed for amendment 2's column_index-based mapping, and for rendering
-- "جميع بيانات المنتج الأصلية" in the original Excel column order).
-- Store the ordered header list explicitly instead.
-- ============================================================================

ALTER TABLE import_batches ADD COLUMN header_columns TEXT[];
ALTER TABLE sources ADD COLUMN header_columns TEXT[];
