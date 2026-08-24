/* Shared API + small utility helpers for both the public search UI and the admin UI. */
const API_BASE = ''; // same-origin (server.ts serves this frontend + the API)

const Api = {
  token() { return localStorage.getItem('acp_token') || ''; },
  setToken(t) { if (t) localStorage.setItem('acp_token', t); else localStorage.removeItem('acp_token'); },
  currentUser() {
    try { return JSON.parse(localStorage.getItem('acp_user') || 'null'); } catch { return null; }
  },
  setUser(u) { if (u) localStorage.setItem('acp_user', JSON.stringify(u)); else localStorage.removeItem('acp_user'); },
  logout() { this.setToken(null); this.setUser(null); },

  async request(method, path, body, opts = {}) {
    const headers = {};
    const t = this.token();
    if (t) headers['Authorization'] = `Bearer ${t}`;
    let fetchOpts = { method, headers };
    if (body instanceof FormData) {
      fetchOpts.body = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(body);
    }
    const res = await fetch(API_BASE + path, fetchOpts);
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const msg = (data && (data.error?.message || data.error || data.detail)) || `خطأ في الاتصال (${res.status})`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body ?? {}); },
  put(path, body) { return this.request('PUT', path, body ?? {}); },
  patch(path, body) { return this.request('PATCH', path, body ?? {}); },
  del(path) { return this.request('DELETE', path); },

  // --- Public/search endpoints ---
  search(params) { return this.get('/api/search?' + new URLSearchParams(params).toString()); },
  facets(params) { return this.get('/api/search/facets?' + new URLSearchParams(params).toString()); },
  stats() { return this.get('/api/stats'); },
  agreements(includeInactive) { return this.get('/api/agreements' + (includeInactive ? '?includeInactive=true' : '')); },
  agreement(idOrSlug) { return this.get('/api/agreements/' + encodeURIComponent(idOrSlug)); },
  productDetail(id) { return this.get('/api/products/' + encodeURIComponent(id)); },
  configuratorDimensions(agreement) { return this.get(`/api/configurator/${encodeURIComponent(agreement)}/dimensions`); },
  configuratorStep(agreement, selections) {
    return this.get(`/api/configurator/${encodeURIComponent(agreement)}/step?selections=${encodeURIComponent(JSON.stringify(selections))}`);
  },
};

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Highlights every query word (and its Arabic/English variants loosely) inside `text`. Safe against HTML injection. */
function highlightText(text, query) {
  const safe = escapeHtml(text ?? '');
  if (!query || !query.trim()) return safe;
  const words = query.trim().split(/\s+/).filter((w) => w.length >= 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return safe;
  const re = new RegExp('(' + words.join('|') + ')', 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

function toast(message, kind = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : kind === 'success' ? ' success' : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function debounce(fn, ms) {
  let h;
  return (...args) => { clearTimeout(h); h = setTimeout(() => fn(...args), ms); };
}

function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
