/* Admin UI controller: login, agreements, import wizard (upload → sheet
   select → mapping w/ sample values + conflict warnings → preview →
   approve/reject), sources (archive/replace history), synonyms, logs. */

const CONCEPT_LABELS = {
  product_id: 'رقم المنتج/الخدمة', name_ar: 'الاسم (عربي)', name_en: 'الاسم (إنجليزي)',
  description_ar: 'الوصف (عربي)', description_en: 'الوصف (إنجليزي)', supplier_id: 'رقم المورد',
  supplier_name: 'اسم المورد', category_l1: 'الفئة - مستوى 1', category_l2: 'الفئة - مستوى 2',
  category_l3: 'الفئة - مستوى 3', manufacturer: 'الشركة المصنعة', model: 'الموديل',
  country_of_origin: 'بلد المنشأ', unit: 'وحدة القياس/الشراء', contract_number: 'رقم العقد',
  grouping_id: 'معرّف التجميع (Grouping Id)', unmapped: '— غير مربوط —', internal_only: 'داخلي فقط (مخفي)',
};
const CONCEPT_OPTIONS = Object.keys(CONCEPT_LABELS);

// ---------------------------------------------------------------------
// Auth / shell
// ---------------------------------------------------------------------
function showLogin() {
  document.getElementById('loginShell').classList.remove('hidden');
  document.getElementById('adminShell').classList.add('hidden');
}
function showShell() {
  document.getElementById('loginShell').classList.add('hidden');
  document.getElementById('adminShell').classList.remove('hidden');
  const u = Api.currentUser();
  document.getElementById('whoami').textContent = u ? `مرحبًا، ${u.full_name || u.email}` : '';
  initTabs();
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  try {
    const res = await Api.post('/api/auth/login', { email, password });
    Api.setToken(res.token);
    Api.setUser(res.user);
    showShell();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('logoutBtn').addEventListener('click', () => { Api.logout(); showLogin(); });
  if (Api.token()) showShell(); else showLogin();
});

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
const TAB_LOADERS = {
  agreements: renderAgreementsTab,
  import: renderImportTab,
  sources: renderSourcesTab,
  synonyms: renderSynonymsTab,
  logs: renderLogsTab,
};

function initTabs() {
  qsa('.admin-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  switchTab('agreements');
}

function switchTab(name) {
  qsa('.admin-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  qsa('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  TAB_LOADERS[name]?.();
}

// ---------------------------------------------------------------------
// Agreements tab
// ---------------------------------------------------------------------
async function renderAgreementsTab() {
  const el = document.getElementById('tab-agreements');
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const agreements = await Api.agreements(true);
    el.innerHTML = `
      <div class="card">
        <h2>الاتفاقيات (${agreements.length})</h2>
        <div class="table-scroll">
          <table class="data-table">
            <thead><tr><th>الاسم</th><th>المعرّف (slug)</th><th>نوع العرض</th><th>الحالة</th><th>مصادر نشطة</th><th>عدد المنتجات</th></tr></thead>
            <tbody>${agreements.map((a) => `
              <tr>
                <td>${escapeHtml(a.name_ar)}${a.name_en ? `<br><span class="muted small-text">${escapeHtml(a.name_en)}</span>` : ''}</td>
                <td><code>${escapeHtml(a.slug)}</code></td>
                <td>${a.display_type === 'configurator' ? '<span class="tag manual">مُهيّئ (Configurator)</span>' : 'قياسي'}</td>
                <td>${a.status === 'active' ? '<span class="tag high">نشطة</span>' : escapeHtml(a.status)}</td>
                <td>${a.active_source_count}</td>
                <td>${Number(a.product_count).toLocaleString('ar-SA')}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h2>إضافة اتفاقية جديدة</h2>
        <div class="form-row"><label>الاسم (عربي)</label><input id="newAgNameAr"></div>
        <div class="form-row"><label>الاسم (إنجليزي) — اختياري</label><input id="newAgNameEn"></div>
        <div class="form-row"><label>المعرّف (slug) — أحرف إنجليزية صغيرة وشرطات فقط</label><input id="newAgSlug" placeholder="e.g. telecom"></div>
        <div class="form-row"><label>نوع العرض</label>
          <select id="newAgDisplayType"><option value="standard">قياسي (بحث عادي)</option><option value="configurator">مُهيّئ (Configurator) — مثل الدوائر الرقمية</option></select>
        </div>
        <button class="btn" id="createAgBtn">إنشاء الاتفاقية</button>
      </div>`;
    document.getElementById('createAgBtn').addEventListener('click', async () => {
      try {
        await Api.post('/api/agreements', {
          nameAr: document.getElementById('newAgNameAr').value.trim(),
          nameEn: document.getElementById('newAgNameEn').value.trim() || undefined,
          slug: document.getElementById('newAgSlug').value.trim(),
          displayType: document.getElementById('newAgDisplayType').value,
        });
        toast('تم إنشاء الاتفاقية بنجاح', 'success');
        renderAgreementsTab();
      } catch (err) { toast(err.message, 'error'); }
    });
  } catch (err) {
    el.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// Import wizard tab
// ---------------------------------------------------------------------
const importState = {
  step: 1, // 1 upload, 2 sheet select, 3 mapping, 4 preview
  upload: null, // { storagePath, originalFileName, sheets }
  selectedSheet: null,
  agreementId: null,
  logicalSourceKey: '',
  batch: null, // response from POST /batches (mapping, conflicts, sampleValues, batchId)
  currentMapping: null, // editable array
};

async function renderImportTab() {
  const el = document.getElementById('tab-import');
  const agreements = await Api.agreements(true).catch(() => []);
  importState._agreements = agreements;
  renderImportStep();
}

function stepIndicatorHtml() {
  const labels = ['رفع الملف', 'اختيار الورقة', 'ربط الأعمدة (Mapping)', 'معاينة واعتماد'];
  return `<div class="step-indicator">${labels.map((l, i) => {
    const n = i + 1;
    const cls = n < importState.step ? 'done' : n === importState.step ? 'active' : '';
    return `<span class="step ${cls}">${n}. ${l}</span>`;
  }).join('')}</div>`;
}

function renderImportStep() {
  const el = document.getElementById('tab-import');
  const header = stepIndicatorHtml();
  if (importState.step === 1) return renderUploadStep(el, header);
  if (importState.step === 2) return renderSheetStep(el, header);
  if (importState.step === 3) return renderMappingStep(el, header);
  if (importState.step === 4) return renderPreviewStep(el, header);
}

function resetImport() {
  importState.step = 1; importState.upload = null; importState.selectedSheet = null;
  importState.agreementId = null; importState.logicalSourceKey = ''; importState.batch = null; importState.currentMapping = null;
  renderImportStep();
}

// --- Step 1: Upload ---
function renderUploadStep(el, header) {
  el.innerHTML = `<div class="card">${header}
    <h2>الخطوة ١: رفع ملف Excel</h2>
    <div class="dropzone" id="dropzone">
      اسحب ملف Excel هنا أو اضغط للاختيار<br><span class="small-text muted">.xlsx / .xls — حتى 100 ميغابايت</span>
      <input type="file" id="fileInput" accept=".xlsx,.xls" class="hidden">
    </div>
    <div id="uploadStatus" style="margin-top:12px;"></div>
  </div>`;
  const dz = document.getElementById('dropzone');
  const input = document.getElementById('fileInput');
  dz.addEventListener('click', () => input.click());
  ['dragover', 'dragleave', 'drop'].forEach((evt) => dz.addEventListener(evt, (e) => e.preventDefault()));
  dz.addEventListener('dragover', () => dz.classList.add('dragover'));
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => { dz.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) handleUpload(input.files[0]); });
}

async function handleUpload(file) {
  const statusEl = document.getElementById('uploadStatus');
  statusEl.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>جارٍ رفع الملف وفحص الأوراق…</p></div>`;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await Api.post('/api/admin/import/upload', fd);
    importState.upload = res;
    importState.step = 2;
    renderImportStep();
  } catch (err) {
    statusEl.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
  }
}

// --- Step 2: Sheet + target agreement selection ---
function renderSheetStep(el, header) {
  const sheets = importState.upload.sheets;
  el.innerHTML = `<div class="card">${header}
    <h2>الخطوة ٢: اختيار الورقة والاتفاقية المستهدفة</h2>
    <p class="small-text muted">الملف: <b>${escapeHtml(importState.upload.originalFileName)}</b></p>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th></th><th>اسم الورقة</th><th>عدد الصفوف</th><th>عدد الأعمدة</th><th>تصنيف الورقة</th><th>صف العناوين</th></tr></thead>
        <tbody>${sheets.map((s, i) => `
          <tr>
            <td><input type="radio" name="sheetPick" value="${i}" ${s.classification === 'data' ? '' : ''}></td>
            <td>${escapeHtml(s.sheetName)}</td>
            <td>${s.rowCount.toLocaleString('ar-SA')}</td>
            <td>${s.columnCount}</td>
            <td>${s.classification === 'data' ? '<span class="tag high">بيانات</span>' : `<span class="tag low">${escapeHtml(s.classification)}</span>`}</td>
            <td>${s.header.headerRowIndex} (${s.header.confidence === 'high' ? 'ثقة عالية' : 'يحتاج مراجعة'})</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="form-row" style="margin-top:14px;">
      <label>الاتفاقية المستهدفة</label>
      <select id="agreementSelect">
        <option value="">— اختر —</option>
        ${importState._agreements.map((a) => `<option value="${a.id}">${escapeHtml(a.name_ar)} (${escapeHtml(a.slug)})</option>`).join('')}
      </select>
    </div>
    <div class="form-row">
      <label>مفتاح المصدر المنطقي (logical_source_key) — أحرف إنجليزية صغيرة، أرقام و "_" فقط</label>
      <input id="logicalKeyInput" placeholder="e.g. products / devices / accessories">
    </div>
    <div class="flex-between">
      <button class="btn secondary" id="backToUploadBtn">‹ رجوع</button>
      <button class="btn" id="proceedToMappingBtn">التالي: ربط الأعمدة ›</button>
    </div>
  </div>`;

  document.getElementById('backToUploadBtn').addEventListener('click', resetImport);
  document.getElementById('proceedToMappingBtn').addEventListener('click', async () => {
    const idx = Number(qs('input[name=sheetPick]:checked')?.value);
    if (Number.isNaN(idx)) return toast('اختر ورقة أولًا', 'error');
    const agreementId = document.getElementById('agreementSelect').value;
    const logicalSourceKey = document.getElementById('logicalKeyInput').value.trim();
    if (!agreementId) return toast('اختر الاتفاقية المستهدفة', 'error');
    if (!/^[a-z0-9_]+$/.test(logicalSourceKey)) return toast('صيغة مفتاح المصدر غير صحيحة', 'error');

    importState.selectedSheet = sheets[idx];
    importState.agreementId = agreementId;
    importState.logicalSourceKey = logicalSourceKey;

    const btn = document.getElementById('proceedToMappingBtn');
    btn.disabled = true; btn.textContent = 'جارٍ التحليل والترحيل المبدئي…';
    try {
      const sheet = importState.selectedSheet;
      const batch = await Api.post('/api/admin/import/batches', {
        agreementId, logicalSourceKey,
        sheetName: sheet.sheetName,
        headerRowNumber: sheet.header.headerRowIndex,
        headerColumns: sheet.header.columns,
        columnCount: sheet.columnCount,
        storagePath: importState.upload.storagePath,
        originalFileName: importState.upload.originalFileName,
        sheetClassification: sheet.classification,
      });
      importState.batch = batch;
      importState.currentMapping = batch.mapping;
      importState.step = 3;
      renderImportStep();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'التالي: ربط الأعمدة ›';
    }
  });
}

// --- Step 3: Field Mapping screen (the core of this phase's requirement) ---
function renderMappingStep(el, header) {
  const m = importState.currentMapping;
  const conflicts = importState.batch.conflicts || [];
  const sampleValues = importState.batch.sampleValues || [];
  const conflictedIdx = new Set(conflicts.flatMap((c) => c.columns.map((col) => col.columnIndex)));

  const conflictBanner = conflicts.length > 0 ? `
    <div class="conflict-warning-banner">
      <strong>⚠️ تم ربط أكثر من عمود بالمفهوم نفسه — يرجى المراجعة</strong>
      هذا التنبيه غير مانع للمتابعة (قد يكون الربط المتعدد لنفس المفهوم مقصودًا في بعض الحالات)، لكنه يتطلب تأكيدك اليدوي. كل عمود يحتفظ بقيمته كاملة في البيانات الخام دائمًا، ولن يتم استبدال أي عمود بآخر تلقائيًا.
      <ul style="margin:8px 0 0; padding-inline-start:18px;">
        ${conflicts.map((c) => `<li><b>${escapeHtml(CONCEPT_LABELS[c.concept] || c.concept)}</b>: ${c.columns.map((col) => escapeHtml(col.sourceColumnName.split('\n')[0])).join(' + ')}</li>`).join('')}
      </ul>
    </div>` : '';

  el.innerHTML = `<div class="card">${header}
    <h2>الخطوة ٣: ربط الأعمدة (Field Mapping)</h2>
    <p class="small-text muted">تم ترحيل ${importState.batch.totalRowsStaged?.toLocaleString('ar-SA') ?? '—'} صف مبدئيًا إلى منطقة التجهيز (Staging) — لن يتأثر النظام الحي حتى الاعتماد النهائي.</p>
    ${conflictBanner}
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th>#</th><th>اسم العمود الأصلي</th><th>عيّنة من القيم</th><th>المفهوم المقترح</th><th>الثقة</th>
          <th>قابل للبحث</th><th>قابل للتصفية</th><th>الظهور</th>
        </tr></thead>
        <tbody>${m.map((col, i) => mappingRowHtml(col, sampleValues[i] || [], conflictedIdx.has(i))).join('')}</tbody>
      </table>
    </div>
    <div class="flex-between" style="margin-top:16px;">
      <button class="btn secondary" id="backToSheetBtn">‹ رجوع</button>
      <div>
        <button class="btn danger" id="rejectBatchBtn">إلغاء الاستيراد</button>
        <button class="btn" id="saveMappingBtn">حفظ الربط والانتقال للمعاينة ›</button>
      </div>
    </div>
  </div>`;

  wireMappingRowEvents(el);
  document.getElementById('backToSheetBtn').addEventListener('click', () => { importState.step = 2; renderImportStep(); });
  document.getElementById('rejectBatchBtn').addEventListener('click', async () => {
    if (!confirm('هل أنت متأكد من إلغاء عملية الاستيراد هذه؟')) return;
    await Api.post(`/api/admin/import/batches/${importState.batch.batchId}/reject`);
    toast('تم إلغاء الاستيراد', 'success');
    resetImport();
  });
  document.getElementById('saveMappingBtn').addEventListener('click', saveMappingAndProceed);
}

function mappingRowHtml(col, samples, hasConflict) {
  const confTag = col.confidence === 'auto_high' ? 'high' : col.confidence === 'manual' ? 'manual' : 'low';
  const confLabel = col.confidence === 'auto_high' ? 'تلقائي - ثقة عالية' : col.confidence === 'manual' ? 'يدوي' : 'تلقائي - ثقة منخفضة';
  return `<tr class="${hasConflict ? 'conflict-row' : ''}" data-idx="${col.columnIndex}">
    <td>${hasConflict ? '<span class="conflict-icon">⚠️</span>' : ''}${col.columnIndex}</td>
    <td style="max-width:220px; white-space:pre-line;">${escapeHtml(col.sourceColumnName)}</td>
    <td><div class="sample-values">${samples.slice(0, 4).map((s) => `<span class="sv">${escapeHtml(String(s).slice(0, 30))}</span>`).join('') || '<span class="muted">—</span>'}</div></td>
    <td>
      <select class="map-concept-select" data-idx="${col.columnIndex}">
        ${CONCEPT_OPTIONS.map((c) => `<option value="${c}" ${c === col.mappedConcept ? 'selected' : ''}>${escapeHtml(CONCEPT_LABELS[c])}</option>`).join('')}
      </select>
    </td>
    <td><span class="tag ${confTag}">${confLabel}</span></td>
    <td><input type="checkbox" class="map-searchable" data-idx="${col.columnIndex}" ${col.isSearchable ? 'checked' : ''}></td>
    <td><input type="checkbox" class="map-filterable" data-idx="${col.columnIndex}" ${col.isFilterable ? 'checked' : ''}></td>
    <td>
      <select class="map-visibility" data-idx="${col.columnIndex}">
        <option value="visible_user" ${col.visibility === 'visible_user' ? 'selected' : ''}>ظاهر للمستخدم</option>
        <option value="admin_only" ${col.visibility === 'admin_only' ? 'selected' : ''}>للإدارة فقط</option>
        <option value="hidden" ${col.visibility === 'hidden' ? 'selected' : ''}>مخفي</option>
      </select>
    </td>
  </tr>`;
}

function wireMappingRowEvents(el) {
  const byIdx = (idx) => importState.currentMapping.find((c) => c.columnIndex === idx);
  qsa('.map-concept-select', el).forEach((sel) => sel.addEventListener('change', () => {
    const c = byIdx(Number(sel.dataset.idx)); c.mappedConcept = sel.value; c.confidence = 'manual';
  }));
  qsa('.map-searchable', el).forEach((cb) => cb.addEventListener('change', () => {
    byIdx(Number(cb.dataset.idx)).isSearchable = cb.checked;
  }));
  qsa('.map-filterable', el).forEach((cb) => cb.addEventListener('change', () => {
    byIdx(Number(cb.dataset.idx)).isFilterable = cb.checked;
  }));
  qsa('.map-visibility', el).forEach((sel) => sel.addEventListener('change', () => {
    byIdx(Number(sel.dataset.idx)).visibility = sel.value;
  }));
}

async function saveMappingAndProceed() {
  const btn = document.getElementById('saveMappingBtn');
  btn.disabled = true; btn.textContent = 'جارٍ الحفظ…';
  try {
    const payload = { mapping: importState.currentMapping.map((c) => ({
      columnIndex: c.columnIndex, sourceColumnName: c.sourceColumnName, mappedConcept: c.mappedConcept,
      confidence: c.confidence, isSearchable: c.isSearchable, isFilterable: c.isFilterable, visibility: c.visibility,
    })) };
    const res = await Api.put(`/api/admin/import/batches/${importState.batch.batchId}/mapping`, payload);
    if (res.conflicts && res.conflicts.length > 0) {
      // Refresh mapping state (conflicts persist) and stay on step 3 so admin re-reviews.
      const state2 = await Api.get(`/api/admin/import/batches/${importState.batch.batchId}`);
      importState.batch.conflicts = state2.conflicts;
      importState.batch.sampleValues = state2.sampleValues;
      importState.currentMapping = state2.mapping;
      toast('لا يزال هناك تعارض في الربط — تمت مراجعته أدناه، يمكنك المتابعة أو التعديل', 'error');
      renderImportStep();
      return;
    }
    toast(`تم تحديث ${res.updatedRows.toLocaleString('ar-SA')} صف`, 'success');
    importState.step = 4;
    renderImportStep();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'حفظ الربط والانتقال للمعاينة ›';
  }
}

// --- Step 4: Preview + Approve/Reject ---
async function renderPreviewStep(el, header) {
  el.innerHTML = `<div class="card">${header}<h2>الخطوة ٤: معاينة واعتماد</h2><div class="loading-state"><div class="spinner"></div></div></div>`;
  await loadPreviewPage(0);
}

const PREVIEW_COLUMNS = [
  'mapped_product_id', 'mapped_name_ar', 'mapped_name_en', 'mapped_description_ar', 'mapped_description_en',
  'mapped_category_l1', 'mapped_category_l2', 'mapped_category_l3', 'mapped_manufacturer', 'mapped_model',
  'mapped_supplier_name', 'mapped_country_of_origin', 'mapped_unit',
];

async function loadPreviewPage(offset) {
  const el = document.getElementById('tab-import');
  const limit = 25;
  try {
    const preview = await Api.get(`/api/admin/import/batches/${importState.batch.batchId}/preview?limit=${limit}&offset=${offset}`);
    const rows = preview.rows || [];
    const total = preview.total ?? rows.length;
    // Only show columns that actually have a non-null value somewhere in this page —
    // keeps the preview table from being cluttered with concepts this file doesn't use.
    const cols = PREVIEW_COLUMNS.filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined && r[c] !== ''));

    el.innerHTML = `<div class="card">${stepIndicatorHtml()}
      <h2>الخطوة ٤: معاينة واعتماد</h2>
      <p class="small-text muted">معاينة مُقسّمة على صفحات (paginated) مباشرة من قاعدة البيانات — إجمالي ${total.toLocaleString('ar-SA')} صف${preview.distinctSuppliers != null ? ` · ${preview.distinctSuppliers.toLocaleString('ar-SA')} مورد مميز` : ''}${preview.distinctCategories != null ? ` · ${preview.distinctCategories.toLocaleString('ar-SA')} فئة مميزة` : ''}.</p>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr>${cols.map((c) => `<th>${escapeHtml(CONCEPT_LABELS[c.replace('mapped_', '')] || c)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="pagination" style="margin-top:12px;">
        <button id="prevPreviewBtn" ${offset === 0 ? 'disabled' : ''}>‹ السابق</button>
        <span class="page-info">${offset + 1}–${offset + rows.length} من ${total}</span>
        <button id="nextPreviewBtn" ${offset + limit >= total ? 'disabled' : ''}>التالي ›</button>
      </div>
      <div class="flex-between" style="margin-top:18px;">
        <button class="btn secondary" id="backToMappingBtn">‹ رجوع لتعديل الربط</button>
        <div>
          <button class="btn danger" id="rejectFromPreviewBtn">رفض الاستيراد</button>
          <button class="btn" id="approveBtn">✅ اعتماد ونشر الدفعة</button>
        </div>
      </div>
    </div>`;

    document.getElementById('prevPreviewBtn').addEventListener('click', () => loadPreviewPage(Math.max(0, offset - limit)));
    document.getElementById('nextPreviewBtn').addEventListener('click', () => loadPreviewPage(offset + limit));
    document.getElementById('backToMappingBtn').addEventListener('click', () => { importState.step = 3; renderImportStep(); });
    document.getElementById('rejectFromPreviewBtn').addEventListener('click', async () => {
      if (!confirm('هل أنت متأكد من رفض هذه الدفعة؟ لن يتم نشر أي بيانات.')) return;
      await Api.post(`/api/admin/import/batches/${importState.batch.batchId}/reject`);
      toast('تم رفض الدفعة', 'success');
      resetImport();
    });
    document.getElementById('approveBtn').addEventListener('click', async () => {
      if (!confirm('هل أنت متأكد من اعتماد ونشر هذه الدفعة؟ سيتم استبدال أي مصدر نشط سابق بنفس مفتاح المصدر المنطقي.')) return;
      try {
        const res = await Api.post(`/api/admin/import/batches/${importState.batch.batchId}/approve`, {});
        toast(`تم النشر بنجاح — ${res.rowCount.toLocaleString('ar-SA')} صف نشط الآن`, 'success');
        resetImport();
      } catch (err) { toast(err.message, 'error'); }
    });
  } catch (err) {
    el.innerHTML = `<div class="card error-state">${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// Sources tab
// ---------------------------------------------------------------------
async function renderSourcesTab() {
  const el = document.getElementById('tab-sources');
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const sources = await Api.get('/api/admin/sources');
    el.innerHTML = `<div class="card">
      <h2>مصادر البيانات (${sources.length})</h2>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>الملف</th><th>مفتاح المصدر</th><th>الورقة</th><th>الحالة</th><th>الظهور للمستخدمين</th><th>عدد الصفوف</th><th>تاريخ الاستيراد</th><th></th></tr></thead>
          <tbody>${sources.map((s) => `
            <tr>
              <td>${escapeHtml(s.original_file_name)}</td>
              <td><code>${escapeHtml(s.logical_source_key)}</code></td>
              <td>${escapeHtml(s.sheet_name)}</td>
              <td>${s.status === 'active' ? '<span class="tag high">نشط</span>' : s.status === 'replaced' ? '<span class="tag low">مستبدل</span>' : '<span class="tag manual">مؤرشف</span>'}</td>
              <td>${s.is_visible_to_users ? '✅ ظاهر' : '🚫 مخفي (أرشيف — للإدارة فقط)'}</td>
              <td>${Number(s.row_count).toLocaleString('ar-SA')}</td>
              <td>${new Date(s.imported_at).toLocaleDateString('ar-SA')}</td>
              <td>${s.status === 'active' ? `<button class="btn secondary small toggle-vis-btn" data-id="${s.id}" data-vis="${!s.is_visible_to_users}">${s.is_visible_to_users ? 'أرشفة' : 'إظهار'}</button>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
    qsa('.toggle-vis-btn', el).forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await Api.patch(`/api/admin/sources/${btn.dataset.id}`, { isVisibleToUsers: btn.dataset.vis === 'true' });
        toast('تم تحديث حالة الظهور', 'success');
        renderSourcesTab();
      } catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) {
    el.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// Synonyms tab
// ---------------------------------------------------------------------
async function renderSynonymsTab() {
  const el = document.getElementById('tab-synonyms');
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const groups = await Api.get('/api/admin/synonyms');
    el.innerHTML = `
      <div class="card">
        <h2>إضافة مجموعة مرادفات جديدة</h2>
        <div class="form-row"><label>المصطلح الأساسي (Canonical Term)</label><input id="newGroupTerm" placeholder="مثال: سيرفر"></div>
        <button class="btn" id="addGroupBtn">إضافة مجموعة</button>
      </div>
      ${groups.map((g) => `
        <div class="card">
          <div class="flex-between">
            <h3>${escapeHtml(g.canonical_term)}</h3>
            <button class="btn danger small delete-group-btn" data-id="${g.id}">حذف المجموعة</button>
          </div>
          <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px;">
            ${g.terms.map((t) => `<span class="chip">${escapeHtml(t.term)} <span class="muted small-text">(${t.language || '—'})</span> <button class="delete-term-btn" data-id="${t.id}">×</button></span>`).join('') || '<span class="muted small-text">لا توجد مرادفات بعد</span>'}
          </div>
          <div class="form-row" style="flex-direction:row; align-items:flex-end; gap:8px;">
            <input class="new-term-input" data-group="${g.id}" placeholder="مرادف جديد" style="flex:1;">
            <select class="new-term-lang" data-group="${g.id}"><option value="ar">عربي</option><option value="en">إنجليزي</option></select>
            <button class="btn secondary small add-term-btn" data-group="${g.id}">إضافة</button>
          </div>
        </div>`).join('')}`;

    document.getElementById('addGroupBtn').addEventListener('click', async () => {
      const term = document.getElementById('newGroupTerm').value.trim();
      if (!term) return;
      try { await Api.post('/api/admin/synonyms', { canonicalTerm: term }); renderSynonymsTab(); }
      catch (err) { toast(err.message, 'error'); }
    });
    qsa('.delete-group-btn', el).forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('حذف هذه المجموعة بالكامل؟')) return;
      await Api.del(`/api/admin/synonyms/${btn.dataset.id}`); renderSynonymsTab();
    }));
    qsa('.delete-term-btn', el).forEach((btn) => btn.addEventListener('click', async () => {
      await Api.del(`/api/admin/synonyms/terms/${btn.dataset.id}`); renderSynonymsTab();
    }));
    qsa('.add-term-btn', el).forEach((btn) => btn.addEventListener('click', async () => {
      const input = qs(`.new-term-input[data-group="${btn.dataset.group}"]`);
      const lang = qs(`.new-term-lang[data-group="${btn.dataset.group}"]`).value;
      const term = input.value.trim();
      if (!term) return;
      try { await Api.post(`/api/admin/synonyms/${btn.dataset.group}/terms`, { term, language: lang }); renderSynonymsTab(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  } catch (err) {
    el.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------
// Logs tab
// ---------------------------------------------------------------------
async function renderLogsTab() {
  const el = document.getElementById('tab-logs');
  el.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const logs = await Api.get('/api/admin/sources/logs');
    el.innerHTML = `<div class="card">
      <h2>سجل عمليات الاستيراد والتغييرات (آخر ${logs.length})</h2>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>التاريخ</th><th>الاتفاقية</th><th>العملية</th><th>بواسطة</th><th>التفاصيل</th></tr></thead>
          <tbody>${logs.map((l) => `
            <tr>
              <td>${new Date(l.performed_at).toLocaleString('ar-SA')}</td>
              <td>${escapeHtml(l.agreement_name || '—')}</td>
              <td>${escapeHtml(l.action)}</td>
              <td>${escapeHtml(l.performed_by_name || '—')}</td>
              <td><code class="small-text">${escapeHtml(JSON.stringify(l.details || {}))}</code></td>
            </tr>`).join('') || `<tr><td colspan="5" class="muted">لا يوجد سجل بعد</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  } catch (err) {
    el.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
  }
}
