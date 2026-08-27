/* Main Search UI controller — simplified per the reference-mockup redesign:
   no sidebar, no dashboard-style stat cards, no default "browse all" table.
   The employee's flow is: open the link → search → see results → open
   details. Everything technical/administrative lives in /admin.html only. */

const PRIMARY_FILTERS = [
  { key: 'agreementId', facetKey: 'agreements', title: 'الاتفاقية', valueField: 'value', labelField: 'nameAr' },
  { key: 'categoryL1', facetKey: 'categoriesL1', title: 'الفئة' },
  { key: 'supplierName', facetKey: 'suppliers', title: 'المورد' },
];
const MORE_FILTERS = [
  { key: 'manufacturer', facetKey: 'manufacturers', title: 'الشركة المصنعة' },
  { key: 'countryOfOrigin', facetKey: 'countriesOfOrigin', title: 'بلد المنشأ' },
  { key: 'unit', facetKey: 'units', title: 'وحدة القياس' },
];
const ALL_FILTERS = [...PRIMARY_FILTERS, ...MORE_FILTERS];

const state = {
  q: '',
  page: 1,
  pageSize: 20,
  sort: 'relevance',
  filters: {}, // key -> value (single-select per group — kept simple on purpose)
  hasSearched: false,
};
let lastFacets = null;
// Facets (filter option lists + counts) only ever depend on q + filters, not
// on page/pageSize/sort — and computing them is much heavier on the server
// than the main search query (it runs several extra grouped aggregate
// queries). Re-fetching them on every keystroke/page-change was needless
// load, so they're now fetched lazily (see ensureFacetsFresh) only when the
// filters drawer is actually opened, and only if the underlying q/filters
// have changed since the last fetch.
let lastFacetsKey = null;

function buildSearchParams(overrides = {}) {
  const p = { q: state.q, page: state.page, pageSize: state.pageSize, sort: state.sort, ...overrides };
  for (const [k, v] of Object.entries(state.filters)) if (v) p[k] = v;
  return p;
}

function activeFilterCount() {
  return Object.values(state.filters).filter(Boolean).length;
}

// ---------------------------------------------------------------------
// Search execution (with the same stale-response guard as before)
// ---------------------------------------------------------------------
let searchSeq = 0;

async function runSearch() {
  state.hasSearched = true;
  document.getElementById('preSearchEmpty').classList.add('hidden');
  document.getElementById('resultsArea').classList.remove('hidden');

  const mySeq = ++searchSeq;
  const wrap = document.getElementById('resultsTableWrap');
  const countEl = document.getElementById('resultsCount');
  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>جارٍ البحث…</p></div>`;
  try {
    // Facets are intentionally NOT fetched here — they're heavier (several
    // grouped aggregate queries) than the main search query, and their
    // values only matter once the filters drawer is actually opened. See
    // ensureFacetsFresh().
    const searchRes = await Api.search(buildSearchParams());
    if (mySeq !== searchSeq) return;
    renderResultsTable(searchRes);
    renderChips();
    updateFilterBadge();
    countEl.innerHTML = `<b>${searchRes.total.toLocaleString('ar-SA')}</b> نتيجة${state.q ? ` لـ "<b>${escapeHtml(state.q)}</b>"` : ''}`;
  } catch (err) {
    if (mySeq !== searchSeq) return;
    wrap.innerHTML = `<div class="error-state">تعذّر إتمام البحث: ${escapeHtml(err.message)}</div>`;
    countEl.textContent = '';
  }
}

function resetToPreSearch() {
  state.hasSearched = false;
  document.getElementById('resultsArea').classList.add('hidden');
  document.getElementById('preSearchEmpty').classList.remove('hidden');
}

// ---------------------------------------------------------------------
// Results — simple table (CSS collapses it to cards under 720px)
// ---------------------------------------------------------------------
function renderResultsTable(res) {
  const wrap = document.getElementById('resultsTableWrap');
  if (res.results.length === 0) {
    wrap.innerHTML = `<div class="empty-state">لا توجد نتائج مطابقة. جرّب كلمات بحث أخرى أو أزل بعض الفلاتر.</div>`;
    renderPagination(res);
    return;
  }

  // "أضف المورد فقط عندما تكون بيانات المورد موجودة ومفيدة" — decided per
  // this result set, not hard-coded, so the column simply doesn't exist
  // when it wouldn't carry information (e.g. Digital Circuits-style data).
  const showSupplierCol = res.results.some((r) => r.supplierName || r.supplierCount > 1);

  const headCells = [
    '<th>رقم المنتج</th>',
    '<th>وصف المنتج / الخدمة</th>',
    '<th>الفئة</th>',
    showSupplierCol ? '<th>المورد</th>' : '',
    '<th>الاتفاقية / الكتالوج المصدر</th>',
  ].join('');

  const rows = res.results.map((r) => {
    const titleAr = r.nameAr || r.descriptionAr || r.productId || '—';
    const titleEn = r.nameEn || r.descriptionEn || '';
    const supplierCell = r.supplierCount > 1
      ? `<span class="supplier-multi-link">متوفر لدى ${r.supplierCount} موردين</span>`
      : escapeHtml(r.supplierName || '');
    return `
      <tr data-id="${escapeHtml(r.representativeProductRowId)}">
        <td class="col-id" data-label="رقم المنتج">${r.productId ? '#' + escapeHtml(r.productId) : ''}</td>
        <td class="col-desc" data-label="">
          <span class="ar">${highlightText(titleAr, state.q)}</span>
          ${titleEn ? `<span class="en">${highlightText(titleEn, state.q)}</span>` : ''}
        </td>
        <td class="col-cat" data-label="الفئة">${highlightText(r.categoryL1 || '', state.q)}</td>
        ${showSupplierCol ? `<td data-label="المورد">${supplierCell}</td>` : ''}
        <td class="col-agreement" data-label="الاتفاقية">${escapeHtml(r.agreementNameAr)}</td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="results-table-wrap">
      <table class="results-table">
        <thead><tr>${headCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  qsa('tr[data-id]', wrap).forEach((tr) => {
    tr.addEventListener('click', () => ProductDrawer.open(tr.dataset.id, state.q));
  });

  renderPagination(res);
}

function renderPagination(res) {
  const el = document.getElementById('pagination');
  const totalPages = Math.max(1, Math.ceil(res.total / res.pageSize));
  const cur = res.page;
  const mk = (p, label, disabled = false, active = false) =>
    `<button data-page="${p}" ${disabled ? 'disabled' : ''} class="${active ? 'active' : ''}">${label}</button>`;

  let html = '';
  if (totalPages > 1) {
    html += mk(cur - 1, '‹ السابق', cur <= 1);
    const windowStart = Math.max(1, cur - 2);
    const windowEnd = Math.min(totalPages, cur + 2);
    if (windowStart > 1) html += mk(1, '1') + `<span class="page-info">…</span>`;
    for (let p = windowStart; p <= windowEnd; p++) html += mk(p, String(p), false, p === cur);
    if (windowEnd < totalPages) html += `<span class="page-info">…</span>` + mk(totalPages, String(totalPages));
    html += mk(cur + 1, 'التالي ›', cur >= totalPages);
  }
  html += `<select class="page-size-select" id="pageSizeSelect">
    ${[10, 20, 50].map((n) => `<option value="${n}" ${n === state.pageSize ? 'selected' : ''}>${n} لكل صفحة</option>`).join('')}
  </select>`;
  el.innerHTML = html;

  qsa('button[data-page]', el).forEach((btn) => {
    btn.addEventListener('click', () => {
      state.page = Number(btn.dataset.page);
      runSearch();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  document.getElementById('pageSizeSelect').addEventListener('change', (e) => {
    state.pageSize = Number(e.target.value);
    state.page = 1;
    runSearch();
  });
}

function renderChips() {
  const el = document.getElementById('activeFilterChips');
  const groupTitle = (key) => ALL_FILTERS.find((g) => g.key === key)?.title || key;
  // Filter values are stored/sent as raw IDs (e.g. an agreement UUID) — for
  // display, resolve the human-readable label from the same facet data the
  // filters drawer's <select> options were built from, so chips never show
  // a raw UUID to the user.
  const chipLabel = (key, v) => {
    const g = ALL_FILTERS.find((f) => f.key === key);
    if (!g || !lastFacets) return v;
    const values = lastFacets[g.facetKey] || [];
    const match = values.find((item) => (g.valueField ? item[g.valueField] : item.value) === v);
    if (!match) return v;
    return g.labelField ? match[g.labelField] : match.value;
  };
  const entries = Object.entries(state.filters).filter(([, v]) => v);
  if (entries.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = entries.map(([k, v]) =>
    `<span class="chip">${escapeHtml(groupTitle(k))}: ${escapeHtml(chipLabel(k, v))} <button data-key="${k}">×</button></span>`
  ).join('');
  qsa('button', el).forEach((btn) => {
    btn.addEventListener('click', () => {
      delete state.filters[btn.dataset.key];
      state.page = 1;
      runSearch();
    });
  });
}

function updateFilterBadge() {
  const badge = document.getElementById('activeFilterBadge');
  const n = activeFilterCount();
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n === 0);
}

// ---------------------------------------------------------------------
// Filters drawer — only a handful of primary filters visible; the rest
// live under a collapsible "فلاتر إضافية" so the panel never feels like
// a crowded dashboard sidebar.
// ---------------------------------------------------------------------
function filterFieldHtml(g, facets) {
  const values = (facets && facets[g.facetKey]) || [];
  if (values.length === 0) return ''; // dynamic: no data for this result set -> field doesn't render at all
  const current = state.filters[g.key] || '';
  return `<div class="filter-field">
    <label>${g.title}</label>
    <select data-key="${g.key}">
      <option value="">الكل</option>
      ${values.map((v) => {
        const val = g.valueField ? v[g.valueField] : v.value;
        const label = g.labelField ? v[g.labelField] : v.value;
        return `<option value="${escapeHtml(val)}" ${current === val ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('')}
    </select>
  </div>`;
}

function renderFiltersBody(facets) {
  const body = document.getElementById('filterDrawerBody');
  const primaryHtml = PRIMARY_FILTERS.map((g) => filterFieldHtml(g, facets)).join('');
  const moreHtml = MORE_FILTERS.map((g) => filterFieldHtml(g, facets)).join('');
  const hasPrimary = primaryHtml.trim().length > 0;
  const hasMore = moreHtml.trim().length > 0;
  body.innerHTML =
    (hasPrimary ? primaryHtml : '') +
    (hasMore ? `
      <button class="more-filters-toggle" id="moreFiltersToggle">فلاتر إضافية ▾</button>
      <div class="more-filters-body" id="moreFiltersBody">${moreHtml}</div>
    ` : '') +
    (!hasPrimary && !hasMore ? `<p class="no-filters-note">لا تتوفر فلاتر إضافية لنتائج البحث الحالية.</p>` : '');

  document.getElementById('moreFiltersToggle')?.addEventListener('click', () => {
    document.getElementById('moreFiltersBody').classList.toggle('open');
  });
  qsa('.filter-field select', body).forEach((sel) => {
    sel.addEventListener('change', () => {
      state.filters[sel.dataset.key] = sel.value || undefined;
    });
  });
}

// Fetches facets only if q/filters changed since the last fetch — reopening
// the drawer without having changed anything reuses the cached result
// instead of hitting the database again.
async function ensureFacetsFresh() {
  const key = JSON.stringify({ q: state.q, filters: state.filters });
  if (lastFacets && lastFacetsKey === key) return lastFacets;
  const facets = await Api.facets(buildSearchParams());
  lastFacets = facets;
  lastFacetsKey = key;
  return facets;
}

async function openFiltersDrawer() {
  document.getElementById('filtersOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  const body = document.getElementById('filterDrawerBody');
  body.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>جارٍ تحميل الفلاتر…</p></div>`;
  try {
    const facets = await ensureFacetsFresh();
    renderFiltersBody(facets);
  } catch (err) {
    body.innerHTML = `<p class="no-filters-note">تعذّر تحميل الفلاتر، حاولي مرة أخرى.</p>`;
  }
}
function closeFiltersDrawer() {
  document.getElementById('filtersOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ---------------------------------------------------------------------
// Export — small, secondary, purely client-side (no backend change):
// fetches up to a reasonable cap of the CURRENT query+filters and builds
// a CSV in the browser.
// ---------------------------------------------------------------------
async function exportResults() {
  const btn = document.getElementById('exportBtn');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'جارٍ التصدير…';
  try {
    const EXPORT_CAP = 1000;
    const pageSize = 100;
    let all = [];
    let page = 1;
    let total = Infinity;
    while (all.length < Math.min(EXPORT_CAP, total)) {
      const res = await Api.search(buildSearchParams({ page, pageSize }));
      total = res.total;
      all = all.concat(res.results);
      if (res.results.length < pageSize) break;
      page++;
    }
    all = all.slice(0, EXPORT_CAP);

    const headers = ['رقم المنتج', 'الوصف (عربي)', 'الوصف (إنجليزي)', 'الفئة', 'المورد', 'عدد الموردين', 'الاتفاقية'];
    const csvRows = [headers.join(',')];
    for (const r of all) {
      const cells = [
        r.productId || '', r.nameAr || r.descriptionAr || '', r.nameEn || r.descriptionEn || '',
        r.categoryL1 || '', r.supplierName || '', String(r.supplierCount || ''), r.agreementNameAr || '',
      ].map((c) => `"${String(c).replace(/"/g, '""')}"`);
      csvRows.push(cells.join(','));
    }
    const csv = '﻿' + csvRows.join('\r\n'); // BOM so Excel opens Arabic text correctly
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `نتائج_البحث_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`تم تصدير ${all.length.toLocaleString('ar-SA')} نتيجة${total > EXPORT_CAP ? ` (من أصل ${total.toLocaleString('ar-SA')} — الحد الأقصى للتصدير ${EXPORT_CAP.toLocaleString('ar-SA')})` : ''}`, 'success');
  } catch (err) {
    toast('تعذّر تصدير النتائج: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ---------------------------------------------------------------------
// Header stats (2 simple numbers only — no dashboard cards)
// ---------------------------------------------------------------------
async function loadStats() {
  try {
    const s = await Api.stats();
    document.getElementById('statProducts').textContent = s.totalProducts.toLocaleString('ar-SA');
    document.getElementById('statAgreements').textContent = s.totalAgreements.toLocaleString('ar-SA');
  } catch { /* supplementary only */ }
}

async function loadConfiguratorLink() {
  try {
    const agreements = await Api.agreements();
    const cfg = agreements.find((a) => a.display_type === 'configurator');
    if (!cfg) return;
    const wrap = document.getElementById('configuratorLinkWrap');
    wrap.innerHTML = `<button class="configurator-link" id="openConfiguratorBtn">⚙️ ابحث في خدمات الدوائر الرقمية</button>`;
    document.getElementById('openConfiguratorBtn').addEventListener('click', () => Configurator.open());
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------
function wireSearchBox() {
  const input = document.getElementById('searchInput');
  const btn = document.getElementById('searchBtn');
  const doSearch = () => {
    state.q = input.value.trim();
    state.page = 1;
    if (state.q || activeFilterCount() > 0) runSearch();
    else resetToPreSearch();
  };
  btn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  input.addEventListener('input', debounce(doSearch, 400));

  document.getElementById('filtersToggleBtn').addEventListener('click', openFiltersDrawer);
  document.getElementById('filtersClose').addEventListener('click', closeFiltersDrawer);
  document.getElementById('filtersOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('filtersOverlay')) closeFiltersDrawer();
  });
  document.getElementById('applyFiltersBtn').addEventListener('click', () => {
    state.page = 1;
    closeFiltersDrawer();
    runSearch();
  });
  document.getElementById('resetFiltersBtn').addEventListener('click', () => {
    state.filters = {};
    state.page = 1;
    closeFiltersDrawer();
    if (state.q) runSearch(); else resetToPreSearch();
  });
  document.getElementById('exportBtn').addEventListener('click', exportResults);
}

document.addEventListener('DOMContentLoaded', () => {
  wireSearchBox();
  loadStats();
  loadConfiguratorLink();
  // Intentionally no auto-search on load — the page starts clean/empty,
  // matching the "يفتح الرابط → يبحث → تظهر النتائج" flow requested.
});
