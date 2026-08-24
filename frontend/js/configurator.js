/* Digital Circuits Configurator — a distinct cascading-filter entry point.
   Digital Circuits is a 74k-row combinatorial spec table with no product
   ID / supplier / price, so it NEVER appears in general search results
   (search.ts filters WHERE a.display_type = 'standard'); instead this
   modal walks the admin-defined dimension order (category → sub-category →
   bandwidth → SLA → PO duration → media → service), narrowing at every
   step against indexed columns, until a concrete spec match is confirmed. */

const Configurator = (() => {
  const AGREEMENT_SLUG = 'digital-circuits';
  let selections = {};
  let dimensions = [];

  const overlay = () => document.getElementById('configuratorOverlay');
  const body = () => document.getElementById('configuratorBody');

  function stepChips() {
    const chips = Object.entries(selections).map(([key, val], i) => {
      const dim = dimensions.find((d) => d.attributeKey === key);
      return `<span class="configurator-step-chip">${escapeHtml(dim?.labelAr || key)}: ${escapeHtml(val)}
        <button data-key="${escapeHtml(key)}" title="إزالة هذا الاختيار والعودة">×</button></span>`;
    });
    return chips.length ? `<div class="configurator-steps">${chips.join('')}</div>` : '';
  }

  async function renderStep() {
    body().innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
    try {
      const step = await Api.configuratorStep(AGREEMENT_SLUG, selections);
      let html = stepChips();

      if (step.nextDimension) {
        html += `<div class="configurator-current-label">الخطوة: ${escapeHtml(step.nextDimension.labelAr)}${step.nextDimension.labelEn ? ' / ' + escapeHtml(step.nextDimension.labelEn) : ''}</div>`;
        if (step.availableValues.length === 0) {
          html += `<div class="empty-state">لا تتوفر خيارات أخرى ضمن هذا المسار — جرّب العودة خطوة للخلف وتغيير الاختيار السابق.</div>`;
        } else {
          html += `<div class="configurator-options">${step.availableValues.map((v) => `
            <button class="configurator-option-btn" data-key="${escapeHtml(step.nextDimension.attributeKey)}" data-value="${escapeHtml(v.value)}">
              <span>${escapeHtml(v.value)}</span><span class="count">${v.count}</span>
            </button>`).join('')}</div>`;
        }
      } else {
        html += `<div class="configurator-current-label">النتيجة</div>`;
        if (step.totalMatches === 0) {
          html += `<div class="empty-state">لا توجد نتائج مطابقة لهذا المسار الكامل من الاختيارات.</div>`;
        } else {
          html += `<div class="configurator-result-box">
            ✅ تم تأكيد توفر هذه المواصفة ضمن اتفاقية الدوائر الرقمية (${step.totalMatches} سجل مطابق في البيانات الخام).<br>
            <span class="small-text muted">ملاحظة: هذه الاتفاقية لا تتضمن رقم منتج/مورد/سعر منفصل لكل صف — البيانات مبنية على تركيبة (Combinatorial) من الأبعاد السبعة أعلاه، كما وردت في الملف الأصلي دون أي تعديل.</span>
          </div>`;
        }
      }
      body().innerHTML = html;

      qsa('.configurator-option-btn', body()).forEach((btn) => {
        btn.addEventListener('click', () => {
          selections[btn.dataset.key] = btn.dataset.value;
          renderStep();
        });
      });
      qsa('.configurator-step-chip button', body()).forEach((btn) => {
        btn.addEventListener('click', () => {
          // Remove this selection AND every selection after it (cascading reset).
          const keys = Object.keys(selections);
          const idx = keys.indexOf(btn.dataset.key);
          keys.slice(idx).forEach((k) => delete selections[k]);
          renderStep();
        });
      });
    } catch (err) {
      body().innerHTML = `<div class="error-state">تعذّر تحميل المُهيّئ: ${escapeHtml(err.message)}</div>`;
    }
  }

  async function open() {
    selections = {};
    overlay().classList.add('open');
    document.body.style.overflow = 'hidden';
    try {
      dimensions = await Api.configuratorDimensions(AGREEMENT_SLUG);
    } catch { dimensions = []; }
    renderStep();
  }

  function close() {
    overlay().classList.remove('open');
    document.body.style.overflow = '';
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('configuratorClose')?.addEventListener('click', close);
    overlay()?.addEventListener('click', (e) => { if (e.target === overlay()) close(); });
  });

  return { open, close };
})();
