export type MappedConcept =
  | 'product_id'
  | 'name_ar'
  | 'name_en'
  | 'description_ar'
  | 'description_en'
  | 'supplier_id'
  | 'supplier_name'
  | 'category_l1'
  | 'category_l2'
  | 'category_l3'
  | 'manufacturer'
  | 'model'
  | 'country_of_origin'
  | 'unit'
  | 'contract_number'
  | 'grouping_id'
  | 'unmapped'
  | 'internal_only'
  | `attribute:${string}`;

export type Visibility = 'visible_user' | 'admin_only' | 'hidden';
export type Confidence = 'auto_high' | 'auto_low' | 'manual';

export interface ColumnMappingProposal {
  columnIndex: number;
  sourceColumnName: string;
  mappedConcept: MappedConcept;
  confidence: Confidence;
  isSearchable: boolean;
  isFilterable: boolean;
  visibility: Visibility;
}

export interface DetectedHeader {
  headerRowIndex: number; // 1-based, matches Excel row numbers
  confidence: 'high' | 'low';
  columns: string[]; // header cell text, in physical column order
}

export type SheetClassification = 'data' | 'reference' | 'cover_or_legal' | 'empty';

export interface ParsedRow {
  rowNumber: number; // original Excel row number
  cells: (string | number | boolean | null)[];
}
