/* Product Details Drawer — shows mapped fields first, then ALL raw source
   data (raw_data = source of truth, never altered), then source info, and
   for multi-supplier products expands each sibling as its own independent
   record ("تجميع للعرض فقط وليس دمجًا للبيانات" — display grouping only). */

const ProductDrawer = (() => {
  const overlay = () => document.getElementById('drawerOverlay');
  const titleAr = () => document.getElementById('drawerTitleAr');
  const titleEn = () => document.getElementById('drawerTitleEn');
  const body = () => document.getElementById('drawerBody');

  const MAPPED_LABELS = {
    product_id: 'رقم المنتج/الخدمة',
    name_ar: 'الاسم (عربي)',
    name_en: 'الاسم (إنجليزي)',
    description_ar: 'الوصف (عربي)',
    description_en: 'الوصف (إنجليزي)',
    supplier_name: 'المورد',
    category_l1: 'الفئة (المستوى الأول)',
    category_l2: 'الفئة (المستوى الثاني)',
    category_l3: 'الفئة (المستوى الثالث)',
    manufacturer: 'الشركة المصنعة',
    model: 'الموديل',
    country_of_origin: 'بلد المنشأ',
    unit: 'وحدة القياس/الشراء',
  };

  function kvRows(obj, labels) {
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
      .map(([k, v]) => `<tr><td class="k">${escapeHtml(labels?.[k] ?? k)}</td><td class="v">${escapeHtml(v)}</td></tr>`)
      .join('');
  }

  function rawDataTable(raw) {
    const rows = kvRows(raw, null);
    return rows || `<tr><td class="v muted" colspan="2">لا توجد بيانات إضافية غير معروضة أعلاه.</td></tr>`;
  }

  // Best-effort, display-only heuristic: no `price` MappedConcept exists in
  // the backend (and none is being added, per the no-backend-changes
  // constraint for this UI-only pass), so scan the source row's raw columns
  // for anything that looks like a price/cost field and show it as-is.
  function findPriceValue(raw) {
    if (!raw) return '';
    const entries = Object.entries(raw).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
    const hit = entries.find(([k]) => /سعر|price|cost|تكلفة/i.test(k));
    if (!hit) return '';
    const val = hit[1];
    // Display-only rounding for readability (raw_data itself is never altered —
    // the full unrounded value is still visible under "كل البيانات").
    if (typeof val === 'number' && !Number.isInteger(val)) return val.toFixed(2);
    return String(val).trim();
  }

  // One row of the combined suppliers table, covering both the currently
  // viewed record and each sibling — same shape either way.
  function supplierRow(mapped, rawData, idx) {
    const name = mapped.supplier_name || 'مورد غير مسمى';
    const code = mapped.product_id || mapped.model || '—';
    const price = findPriceValue(rawData);
    const rawId = `sup-raw-${idx}`;
    return `
      <tr>
        <td>${escapeHtml(name)}</td>
        <td class="code">${escapeHtml(code)}</td>
        <td class="price">${price ? escapeHtml(price) : '—'}</td>
        <td><button class="raw-data-toggle" data-target="${rawId}">كل البيانات ▾</button></td>
      </tr>
      <tr class="hidden" id="${rawId}"><td colspan="4"><table class="kv-table"><tbody>${rawDataTable(rawData)}</tbody></table></td></tr>`;
  }

  async function open(productId, query) {
    overlay().classList.add('open');
    document.body.style.overflow = 'hidden';
    body().innerHTML = `<div class="loading-state"><div class="spinner"></div><p>جارٍ تحميل التفاصيل…</p></div>`;
    titleAr().textContent = '…';
    titleEn().textContent = '';

    try {
      const d = await Api.productDetail(productId);
      titleAr().innerHTML = highlightText(d.mapped.name_ar || d.mapped.description_ar || d.mapped.product_id || '—', query);
      titleEn().innerHTML = highlightText(d.mapped.name_en || d.mapped.description_en || '', query);

      const mappedRows = kvRows(d.mapped, MAPPED_LABELS);
      const supplierCount = 1 + d.siblings.length;

      let html = '';
      if (supplierCount > 1) {
        html += `<div class="multi-supplier-badge">🏷️ متوفر لدى ${supplierCount} موردين — كل مورد يحتفظ ببياناته وسعره الخاص (تجميع للعرض فقط، بدون دمج بيانات)</div>`;
      }

      html += `
        <div class="drawer-section">
          <h3>البيانات الأساسية</h3>
          <table class="kv-table"><tbody>${mappedRows}</tbody></table>
        </div>`;

      if (supplierCount > 1) {
        const rows = [
          supplierRow(d.mapped, d.rawData, 'self'),
          ...d.siblings.map((sib, i) => supplierRow(sib.mapped, sib.rawData, i)),
        ].join('');
        html += `<div class="drawer-section">
          <h3>الموردون (${supplierCount})</h3>
          <table class="supplier-table">
            <thead><tr><th>المورد</th><th>رمز الصنف</th><th>السعر</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      } else {
        html += `<div class="drawer-section">
          <div class="flex-between">
            <h3 style="margin:0; border:none; padding:0;">بيانات إضافية من الملف الأصلي</h3>
            <button class="raw-data-toggle" data-target="mainRawData">عرض الكل ▾</button>
          </div>
          <table class="kv-table hidden" id="mainRawData" style="margin-top:8px;"><tbody>${rawDataTable(d.rawData)}</tbody></table>
        </div>`;
      }

      html += `
        <div class="drawer-section">
          <h3>مصدر البيانات</h3>
          <div class="source-info">
            الاتفاقية: ${escapeHtml(d.agreementNameAr)}<br>
            الملف: ${escapeHtml(d.source.fileName)}<br>
            الورقة: ${escapeHtml(d.source.sheetName)}<br>
            آخر استيراد: ${new Date(d.source.importedAt).toLocaleString('ar-SA')}
          </div>
        </div>`;

      body().innerHTML = html;

      qsa('.raw-data-toggle', body()).forEach((btn) => {
        btn.addEventListener('click', () => {
          const t = document.getElementById(btn.dataset.target);
          t.classList.toggle('hidden');
          const showing = !t.classList.contains('hidden');
          btn.textContent = btn.textContent.replace(/▾|▴/, showing ? '▴' : '▾');
        });
      });
    } catch (err) {
      body().innerHTML = `<div class="error-state">تعذّر تحميل تفاصيل المنتج: ${escapeHtml(err.message)}</div>`;
    }
  }

  function close() {
    overlay().classList.remove('open');
    document.body.style.overflow = '';
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('drawerClose')?.addEventListener('click', close);
    overlay()?.addEventListener('click', (e) => { if (e.target === overlay()) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  });

  return { open, close };
})();
