'use strict';
// Runs the FM Bid Board page inside FM Workforce. The board was first built as a Claude artifact; this
// file gives it the same small data API it used there (claude.use('db'), 'user', 'downloads'), backed by
// the Workforce server at /api/estimating/store. Changes save to the app database and every open board
// refreshes after a save and every 20 seconds.
(function () {
  const API = '/api/estimating/store';
  async function req(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!r.ok) {
      const err = new Error((json && json.error) || 'Request failed');
      err.code = r.status === 403 ? 'invalid_argument' : r.status === 401 ? 'unauthenticated' : r.status === 413 ? 'quota_exceeded' : 'unavailable';
      if (r.status === 401 && window.top !== window) window.top.location.reload();
      throw err;
    }
    return json;
  }
  const subs = new Set();
  const docSnap = (r) => ({ id: r.id, exists: r.data !== null && r.data !== undefined, data: () => r.data });
  async function load(s) {
    try {
      const r = await req('GET', `${API}/${s.path}`);
      if (s.kind === 'col') s.cb({ docs: r.map((x) => ({ id: x.id, data: () => x.data })) });
      else s.cb(docSnap(r));
    } catch (e) { if (s.err) s.err(e); }
  }
  let timer = null;
  const refreshAll = () => subs.forEach(load);
  const afterWrite = () => { clearTimeout(timer); timer = setTimeout(refreshAll, 60); };
  setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshAll(); });
  const watch = (path, kind, cb, err) => { const s = { path, kind, cb, err }; subs.add(s); load(s); return () => subs.delete(s); };

  const doc = (path) => ({
    onSnapshot: (cb, err) => watch(path, 'doc', cb, err),
    get: async () => docSnap(await req('GET', `${API}/${path}`)),
    set: async (data) => { await req('PUT', `${API}/${path}`, data); afterWrite(); },
    update: async (patch) => { await req('PATCH', `${API}/${path}`, patch); afterWrite(); },
    delete: async () => { await req('DELETE', `${API}/${path}`); afterWrite(); },
  });
  const collection = (path) => ({
    onSnapshot: (cb, err) => watch(path, 'col', cb, err),
    add: async (data) => { const r = await req('POST', `${API}/${path}`, data); afterWrite(); return { id: r.id }; },
    doc: (id) => doc(`${path}/${id}`),
  });
  const db = Object.freeze({ doc, collection });

  // Who is signed in, and the Go / No-Go scorecard settings.
  window.FM_READY = Promise.all([req('GET', '/api/me'), req('GET', '/api/estimating/config')])
    .then(([me, cfg]) => ({ me: me.user, scorecard: cfg.scorecard, nobid: cfg.nobid_reasons, sources: cfg.sources, isAdmin: me.user.role === 'admin' }))
    .catch(() => ({ me: null, scorecard: null, nobid: [], sources: [], isAdmin: false }));

  const user = Object.freeze({ can: async () => true, canEdit: () => true, isOwner: () => false });
  const downloads = Object.freeze({
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { status: 'saved' };
    },
  });
  // SharePoint reading and document extraction stay with Claude (through the FM Workforce connector),
  // so 'mcp', 'sample' and 'permissions' are not offered here.
  const caps = { db, user, downloads };
  window.claude = Object.freeze({ use: async (name) => caps[name] || null });
  window.FM_APP = true;

})();
