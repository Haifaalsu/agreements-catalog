/**
 * Arabic/English text normalization shared by:
 *  - the Field Mapper (matching raw column headers against the concept dictionary)
 *  - the Search Engine (query + index normalization, applied at query time only —
 *    never mutates stored raw_data or mapped_* values)
 */

export function normalizeText(input: string | null | undefined): string {
  if (!input) return '';
  let s = String(input);

  // Strip Excel-style header line breaks / non-breaking spaces first.
  s = s.replace(/ /g, ' ').replace(/[\r\n\t]+/g, ' ');

  // Arabic normalization: unify alef variants, remove tashkeel (diacritics),
  // unify taa marbuta / alef maksura for looser matching.
  s = s.replace(/[ً-ٰٟ]/g, ''); // tashkeel + superscript alef
  s = s.replace(/[إأآا]/g, 'ا');
  s = s.replace(/ى/g, 'ي');
  s = s.replace(/ة/g, 'ه');
  s = s.replace(/ؤ/g, 'و');
  s = s.replace(/ئ/g, 'ي');
  s = s.replace(/ـ/g, ''); // tatweel

  // Collapse whitespace, lowercase (safe no-op on Arabic).
  s = s.trim().toLowerCase().replace(/\s+/g, ' ');

  return s;
}

/** Strip common punctuation for even looser header-keyword matching. */
export function normalizeHeaderKey(input: string | null | undefined): string {
  return normalizeText(input).replace(/[()،,.:؛;\-_/\\#"']/g, ' ').replace(/\s+/g, ' ').trim();
}
