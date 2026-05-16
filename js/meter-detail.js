/**
 * PBS Map — Meter Detail Panel
 * Floating centered card, opens on pin click.
 * IndexedDB cache (30 min TTL) to minimize API calls.
 * Edit allowed for admin / editor roles only.
 */

const MD_STORE     = 'meter_detail';
const MD_CACHE_TTL = 30 * 60 * 1000; // 30 min

/* ══ IndexedDB ══ */

async function mdCacheGet(accountId) {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const req = db.transaction(MD_STORE, 'readonly').objectStore(MD_STORE).get(accountId);
      req.onsuccess = () => {
        const r = req.result;
        if (!r || Date.now() - r.cached_at > MD_CACHE_TTL) { resolve(null); return; }
        resolve(r);
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function mdCachePut(meter) {
  try {
    const db = await openDB();
    return new Promise(resolve => {
      const req = db.transaction(MD_STORE, 'readwrite').objectStore(MD_STORE)
        .put({ ...meter, cached_at: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror   = () => resolve();
    });
  } catch { /* silent */ }
}

/* ══ State ══ */

let _mdMeter    = null;   // current meter object
let _mdPin      = null;   // current pin from _amPins
let _mdEditMode = false;
let _mdCanEdit  = false;
let _mdGpsPickMode = false;

/* ══ Open ══ */

async function mdOpenPanel(pin) {
  _mdPin      = pin;
  _mdMeter    = null;
  _mdEditMode = false;

  // Show panel in loading state
  const panel = document.getElementById('mdPanel');
  panel.classList.remove('hidden');
  document.getElementById('mdPanelBackdrop').classList.remove('hidden');
  _mdShowLoading(true);

  // Check edit permission (async, non-blocking for display)
  _mdCheckEditRole().then(can => {
    _mdCanEdit = can;
    const btn = document.getElementById('mdEditBtn');
    if (btn) btn.classList.toggle('hidden', !can);
  });

  const accountId = pin.account_id || null;

  if (!accountId) {
    // Not yet synced — show from pin data only
    _mdMeter = _mdLocalMeter(pin);
    _mdRender();
    return;
  }

  // Try cache first → show immediately
  const cached = await mdCacheGet(accountId);
  if (cached) {
    _mdMeter = cached;
    _mdRender();
    mdNoteLoad(accountId);
    return;
  }

  // Not in detail cache — load from meter_queue IndexedDB
  const fresh = await _mdFetch(accountId);
  if (fresh) { _mdMeter = fresh; _mdRender(); mdNoteLoad(accountId); }
  else _mdShowError('Meter data not found.');
}

function _mdLocalMeter(pin) {
  return {
    account_id:        null,
    account_number:    pin.acc,
    office_id:         _session && _session.active_office,
    gps_location:      `${pin.lat},${pin.lng}`,
    account_info_json: { acc_class: pin.accClass || 'h' },
    meter_info_json:   {},
    route_number:      '',
    village:           '',
    meter_number:      '',
    _notSynced:        true,
  };
}

async function _mdFetch(accountId) {
  // Load from meter_queue IndexedDB — no API call needed
  try {
    const records = await msGetByOffice(_session && _session.active_office);
    const rec = records.find(r => r.account_id === accountId);
    if (!rec) return null;

    const ai = typeof rec.account_info_json === 'string'
      ? _mdParse(rec.account_info_json) : (rec.account_info_json || {});
    const mi = typeof rec.meter_info_json === 'string'
      ? _mdParse(rec.meter_info_json) : (rec.meter_info_json || {});

    // Ensure acc_class
    if (!ai.acc_class) ai.acc_class = rec.acc_class || 'h';

    const m = {
      account_id:        rec.account_id,
      account_number:    rec.account_number,
      office_id:         rec.office_id,
      gps_location:      rec.gps_location  || '',
      route_number:      rec.route_number  || '',
      village:           rec.village       || '',
      meter_number:      rec.meter_number  || '',
      account_info_json: ai,
      meter_info_json:   mi,
      _notSynced:        rec.is_synced === 0,
    };

    await mdCachePut(m);
    return m;
  } catch { return null; }
}

async function _mdCheckEditRole() {
  // Use office_cache IndexedDB — no API call
  if (!_session || !_session.active_office) return false;
  try {
    const office = await getOfficeCache(_session.active_office);
    if (office) {
      const uj = _mdParse(office.office_user_json);
      const u  = _session.username;
      return (uj.admin_users || []).includes(u) || (uj.editor_users || []).includes(u);
    }
    // Fallback: check _apOfficeData if admin panel loaded it
    if (typeof _apOfficeData !== 'undefined' && _apOfficeData) {
      const uj = _mdParse(_apOfficeData.office_user_json);
      const u  = _session.username;
      return (uj.admin_users || []).includes(u) || (uj.editor_users || []).includes(u);
    }
    return false;
  } catch { return false; }
}

/* ══ Render ══ */

function _mdRender() {
  _mdShowLoading(false);
  if (!_mdMeter) return;

  const m   = _mdMeter;
  const ai  = _mdParse(m.account_info_json);
  const mi  = _mdParse(m.meter_info_json);
  const cls = ai.acc_class || (_mdPin && _mdPin.accClass) || 'h';
  const cfg = (typeof AM_CLASSES !== 'undefined' && AM_CLASSES[cls]) || { label: cls, color: '#2563eb' };
  const num = m.account_number || '';
  const label = num.length >= 7 ? num.slice(0,3) + '-' + num.slice(3) : num;

  // Header
  _mdSet('mdAccLabel',  label || '—');
  _mdSet('mdSyncBadge', m._notSynced ? '⏳ Not synced' : '✓ Synced');
  document.getElementById('mdSyncBadge').className =
    'md-sync-badge ' + (m._notSynced ? 'md-sync-pending' : 'md-sync-ok');

  // Class badge (header small)
  const cb = document.getElementById('mdClassBadge');
  if (cb) {
    cb.textContent = cfg.label;
    cb.style.cssText = `background:${cfg.color}22;color:${cfg.color};border-color:${cfg.color}55`;
  }

  // View values (Connection Class shown in header badge only)
  _mdSet('mdVName',         ai.name         || '—');
  _mdSet('mdVRoute',        m.route_number   || '—');
  _mdSet('mdVVillage',      m.village        || '—');
  _mdSet('mdVMeterNo',      m.meter_number   || '—');
  _mdSet('mdVManufacturer', mi.manufacturer  || '—');
  _mdSet('mdVType',         _mdTypeLabel(mi.type) || '—');
  _mdSet('mdVGps',          m.gps_location   || '—');
  _mdSet('mdVOther',        mi.other         || '—');

  // Edit values
  _mdVal('mdEName',         ai.name         || '');
  _mdVal('mdERoute',        m.route_number   || '');
  _mdVal('mdEVillage',      m.village        || '');
  _mdVal('mdEMeterNo',      m.meter_number   || '');
  _mdVal('mdEManufacturer', mi.manufacturer  || '');
  _mdVal('mdEGps',          m.gps_location   || '');
  _mdVal('mdEOther',        mi.other         || '');
  const typeEl = document.getElementById('mdEType');
  if (typeEl) typeEl.value = mi.type || '';
  const clsEl = document.getElementById('mdEAccClass');
  if (clsEl) clsEl.value = cls;

  // Edit button visibility
  const editBtn = document.getElementById('mdEditBtn');
  if (editBtn) editBtn.classList.toggle('hidden', !_mdCanEdit || !!m._notSynced);

  // Reading button — synced meter এ দেখাও
  const rdBtn = document.getElementById('mdNoteReadingBtn');
  if (rdBtn) rdBtn.classList.toggle('hidden', !!m._notSynced || !m.account_id);

  // Reset to view mode
  _mdApplyMode(false);
}

function _mdApplyMode(edit) {
  _mdEditMode = edit;
  document.getElementById('mdEditBtn')?.classList.toggle('active', edit);
  document.getElementById('mdSaveRow')?.classList.toggle('hidden', !edit);
  document.getElementById('mdSaveAlert') && (document.getElementById('mdSaveAlert').className = 'md-alert hidden');

  document.querySelectorAll('#mdPanel .md-v').forEach(el => el.classList.toggle('hidden', edit));
  document.querySelectorAll('#mdPanel .md-e').forEach(el => el.classList.toggle('hidden', !edit));
}

/* ══ Toggle edit ══ */
function mdToggleEdit() { _mdApplyMode(!_mdEditMode); }

/* ══ Save ══ */
async function mdSave() {
  if (!_mdMeter || !_mdMeter.account_id) return;
  const alertEl = document.getElementById('mdSaveAlert');
  const saveBtn = document.getElementById('mdSaveBtn');
  alertEl.className = 'md-alert hidden';
  saveBtn.disabled  = true;
  saveBtn.innerHTML = '<span class="md-spinner"></span> Saving…';

  const cls = document.getElementById('mdEAccClass')?.value || 'h';
  const ai  = { ..._mdParse(_mdMeter.account_info_json), name: _mdVal2('mdEName'), acc_class: cls };
  const mi  = { ..._mdParse(_mdMeter.meter_info_json),   manufacturer: _mdVal2('mdEManufacturer'), type: document.getElementById('mdEType')?.value || '', other: _mdVal2('mdEOther') };

  const payload = {
    account_id:        _mdMeter.account_id,
    route_number:      _mdVal2('mdERoute')    || null,
    village:           _mdVal2('mdEVillage')  || null,
    meter_number:      _mdVal2('mdEMeterNo')  || null,
    gps_location:      _mdVal2('mdEGps')      || null,
    account_info_json: ai,
    meter_info_json:   mi,
  };

  try {
    const res = await Meter.edit(_session.token, payload);
    if (res.success) {
      const updated = { ..._mdMeter, ...payload, account_info_json: ai, meter_info_json: mi };
      await mdCachePut(updated);
      _mdMeter = updated;

      // Update pin icon if class changed
      const pin = _amPins.find(p => p.account_id === _mdMeter.account_id);
      if (pin && pin.accClass !== cls) {
        pin.accClass = cls;
        if (pin.marker && _map.hasLayer(pin.marker))
          pin.marker.setIcon(_amBuildIcon(pin.acc, cls, pin.selected));
      }

      _mdRender();
      if (typeof showToast === 'function') showToast('✅ Meter updated.');
    } else {
      alertEl.textContent = '❌ ' + (res.message || 'Save failed.');
      alertEl.className   = 'md-alert md-alert-error';
      saveBtn.disabled    = false;
      saveBtn.innerHTML   = 'Save Changes';
    }
  } catch {
    alertEl.textContent = '❌ Server connection failed.';
    alertEl.className   = 'md-alert md-alert-error';
    saveBtn.disabled    = false;
    saveBtn.innerHTML   = 'Save Changes';
  }
}

/* ══ GPS pick ══ */
function mdPickGps() {
  if (typeof showToast === 'function') showToast('🗺️ Click on map to set GPS');
  _mdGpsPickMode = true;
  if (typeof _amSetMapClickMode === 'function') _amSetMapClickMode(true);
}

function mdHandleGpsPick(lat, lng) {
  _mdGpsPickMode = false;
  const el = document.getElementById('mdEGps');
  if (el) el.value = `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/* ══ Close ══ */
function mdClosePanel() {
  document.getElementById('mdPanel').classList.add('hidden');
  document.getElementById('mdPanelBackdrop').classList.add('hidden');
  _mdMeter    = null;
  _mdPin      = null;
  _mdEditMode = false;
  _mdNoteImages = [];
  const previewEl = document.getElementById('mdNoteImgPreview');
  if (previewEl) { previewEl.innerHTML = ''; previewEl.classList.add('hidden'); }
  const textEl = document.getElementById('mdNoteText');
  if (textEl) textEl.value = '';
  // Deselect all pins
  if (typeof _amPins !== 'undefined' && typeof _amBuildIcon === 'function') {
    _amPins.forEach(p => {
      p.selected = false;
      if (p.marker && _map && _map.hasLayer(p.marker))
        p.marker.setIcon(_amBuildIcon(p.acc, p.accClass, false));
    });
  }
}

/* ══ Helpers ══ */
function _mdShowLoading(on) {
  document.getElementById('mdLoading')?.classList.toggle('hidden', !on);
  document.getElementById('mdBody')?.classList.toggle('hidden', on);
}
function _mdShowError(msg) {
  _mdShowLoading(false);
  const b = document.getElementById('mdBody');
  if (b) b.innerHTML = `<div class="md-error">${msg}</div>`;
}
function _mdSet(id, txt)  { const el = document.getElementById(id); if (el) el.textContent = txt; }
function _mdVal(id, val)  { const el = document.getElementById(id); if (el) el.value = val; }
function _mdVal2(id)      { return (document.getElementById(id)?.value || '').trim(); }
function _mdParse(v)      { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } }
function _mdTypeLabel(v)  {
  return { single_phase:'Single Phase', '3phase':'3 Phase', '3phase_kvarh':'3 Phase kVArh', '3phase_2part':'3 Phase 2-Part', '3phase_netmeter':'3 Phase Net Meter' }[v] || v || '';
}


/* ══════════════════════════════════════════════
   NOTE SECTION
   ══════════════════════════════════════════════ */

let _mdNoteImages = []; // pending image URLs before submit

/* ── Load & render notes (offline-first, full refresh on open) ── */
async function mdNoteLoad(accountId) {
  const sectionEl = document.getElementById('mdNoteSection');

  if (!accountId) {
    if (sectionEl) sectionEl.classList.add('hidden');
    return;
  }
  if (sectionEl) sectionEl.classList.remove('hidden');

  // Guard: stale async callbacks এর বিরুদ্ধে সুরক্ষা
  const isStillActive = () => _mdMeter && _mdMeter.account_id === accountId;

  // ── Step 1: IndexedDB থেকে cached notes সাথে সাথে দেখাও ──
  let cached = [];
  try { cached = await ncGetByAccount(accountId); } catch { cached = []; }

  if (!isStillActive()) return;

  if (cached.length) {
    _mdNoteRender(cached);
  } else {
    // Cache খালি — loading spinner দেখাও
    const listEl = document.getElementById('mdNoteList');
    if (listEl) listEl.innerHTML = '<div class="md-note-loading"><div class="md-spinner"></div></div>';
  }

  // ── Step 2: lastSync time নাও IndexedDB থেকে ──
  let lastSync = null;
  try { lastSync = await ncGetLastSync(accountId); } catch { lastSync = null; }

  // ── Step 3: API তে lastSync পাঠাও — শুধু নতুন notes আসবে ──
  try {
    const res = await Note.getAll(_session.token, accountId, lastSync);
    if (!isStillActive()) return;

    const incoming = (res && res.success && Array.isArray(res.data)) ? res.data : null;

    if (incoming !== null) {
      if (incoming.length > 0) {
        // ── Step 4: নতুন notes গুলো IndexedDB তে merge করো ──

        // Pending temp notes যেগুলো এখন server থেকে confirmed হয়ে এসেছে সেগুলো সরাও
        const pendingNotes = cached.filter(n => n.note_id.startsWith('_temp_'));
        for (const real of incoming) {
          const rj = typeof real.note_json === 'string'
            ? _mdParse(real.note_json) : (real.note_json || {});
          const match = pendingNotes.find(p => {
            const pj = p.note_json || {};
            return p.note_creator === real.note_creator
              && pj.text === rj.text
              && Math.abs(new Date(p.timestamp) - new Date(real.timestamp)) < 15000;
          });
          if (match) {
            try { await ncDelete(match.note_id); } catch { /* silent */ }
          }
          // নতুন note IndexedDB তে save করো (upsert)
          try {
            await ncPut({
              note_id:      real.note_id,
              account_id:   real.account_id || accountId,
              note_creator: real.note_creator,
              note_json:    rj,
              timestamp:    real.timestamp || new Date().toISOString(),
              is_synced:    1,
            });
          } catch { /* silent */ }
        }

        // ── Step 5: lastSync → incoming এর সবচেয়ে নতুন timestamp দিয়ে update করো ──
        const newest = incoming
          .map(n => n.timestamp || '')
          .sort()
          .pop();
        if (newest) {
          const fmt = newest.replace(/\.\d+Z?$/, '').replace('Z', '').replace(' ', 'T');
          try { await ncSaveLastSync(accountId, fmt); } catch { /* silent */ }
        }
      } else {
        // Server থেকে কোনো নতুন note আসেনি — lastSync এখনকার সময় দিয়ে update করো
        // যাতে পরের বার অপ্রয়োজনীয় fetch না হয়
        const now = new Date().toISOString()
          .replace(/\.\d+Z?$/, '').replace('Z', '').replace(' ', 'T');
        try { await ncSaveLastSync(accountId, now); } catch { /* silent */ }
      }

      // ── Step 6: IndexedDB থেকে সব notes নিয়ে re-render করো ──
      if (!isStillActive()) return;
      const all = await ncGetByAccount(accountId).catch(() => cached);
      // reading_cache sync করো (background, non-blocking)
      if (_mdMeter) {
        rcSyncFromNotes(accountId, {
          route_number:   _mdMeter.route_number   || '',
          village:        _mdMeter.village        || '',
          account_number: _mdMeter.account_number || '',
          meter_number:   _mdMeter.meter_number   || '',
        }).catch(() => {});
      }
      _mdNoteRender(all);

    } else {
      // API error — cached notes ই দেখাও
      if (!isStillActive()) return;
      if (!cached.length) _mdNoteRender([]);
    }
  } catch {
    // Network error — cached notes ই দেখাও
    if (!isStillActive()) return;
    if (!cached.length) _mdNoteRender([]);
  }
}

function _mdNoteRender(notes) {
  const listEl  = document.getElementById('mdNoteList');
  const countEl = document.getElementById('mdNoteCount');
  if (!listEl) return;

  const sorted = [...notes].sort((a, b) => {
    const ap = a.note_id.startsWith('_temp_') ? 1 : 0;
    const bp = b.note_id.startsWith('_temp_') ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return (a.timestamp || '') < (b.timestamp || '') ? -1 : 1;
  });

  const syncedCount = sorted.filter(n => !n.note_id.startsWith('_temp_')).length;
  if (countEl) countEl.textContent = syncedCount || '';

  if (!sorted.length) {
    listEl.innerHTML = '<div class="md-note-empty">এখনো কোনো নোট নেই।</div>';
    return;
  }

  listEl.innerHTML = '';
  [...sorted].reverse().forEach(note => {
    const nj        = typeof note.note_json === 'string' ? _mdParse(note.note_json) : (note.note_json || {});
    const isOwn     = _session && note.note_creator === _session.username;
    const isPending = note.note_id.startsWith('_temp_');
    const picUrl    = nj.creator_pic  || '';
    const name      = nj.creator_name || note.note_creator || '?';
    const initials  = name.charAt(0).toUpperCase();
    const ts = isPending
      ? '⏳ পাঠানো হচ্ছে…'
      : note.timestamp
        ? new Date(note.timestamp).toLocaleString('bn-BD', { dateStyle: 'short', timeStyle: 'short' })
        : '';

    const item = document.createElement('div');
    const isReading = nj.type === 'reading';
    item.className = 'md-note-item'
      + (isOwn     ? ' md-note-own'     : '')
      + (isPending ? ' md-note-pending' : '')
      + (isReading ? ' md-note-reading' : '');
    item.dataset.noteId = note.note_id;

    const avatarHtml = picUrl
      ? `<img class="md-note-avatar" src="${picUrl}" alt="${initials}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="md-note-avatar md-note-avatar-init" style="display:none">${initials}</div>`
      : `<div class="md-note-avatar md-note-avatar-init">${initials}</div>`;

    const textHtml = nj.text
      ? `<div class="md-note-text">${_mdNoteEscape(nj.text)}</div>`
      : '';

    let imgsHtml = '';
    if (Array.isArray(nj.images) && nj.images.length) {
      imgsHtml = '<div class="md-note-imgs">'
        + nj.images.map(url =>
            `<img class="md-note-img" src="${url}" loading="lazy" onclick="mdNoteViewImg('${url}')">`
          ).join('')
        + '</div>';
    }

    // Reading card body
    let readingHtml = '';
    if (isReading && nj.reading) {
      const r = nj.reading;
      const fields = [];
      if (r.kwh      != null) fields.push(['kWh',       r.kwh]);
      if (r.kw       != null) fields.push(['kW',        r.kw]);
      if (r.kvarh_lag != null) fields.push(['kVArh-Lag', r.kvarh_lag]);
      if (r.kvarh_led != null) fields.push(['kVArh-Led', r.kvarh_led]);
      readingHtml = `
        <div class="md-note-reading-badge">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          রিডিং
        </div>
        <div class="md-note-reading-grid">
          ${fields.map(([lbl, val]) => `
            <div class="md-note-reading-row">
              <span class="md-note-reading-label">${lbl}</span>
              <span class="md-note-reading-val">${val}</span>
            </div>`).join('')}
        </div>`;
    }

    item.innerHTML = `
      <div class="md-note-meta">
        ${avatarHtml}
        <div class="md-note-author">
          <span class="md-note-name">${_mdNoteEscape(name)}</span>
          <span class="md-note-ts">${ts}</span>
        </div>
        ${isOwn && !isPending ? `<div class="md-note-del-hint">চেপে ধরুন</div>` : ''}
      </div>
      ${readingHtml}
      ${textHtml}
      ${imgsHtml}
    `;

    if (isOwn && !isPending) {
      let _holdTimer = null;
      const startHold = () => { _holdTimer = setTimeout(() => _mdNoteConfirmDelete(note.note_id), 600); };
      const cancelHold = () => clearTimeout(_holdTimer);
      item.addEventListener('mousedown',  startHold);
      item.addEventListener('touchstart', startHold, { passive: true });
      item.addEventListener('mouseup',    cancelHold);
      item.addEventListener('mouseleave', cancelHold);
      item.addEventListener('touchend',   cancelHold);
      item.addEventListener('touchmove',  cancelHold);
    }

    listEl.appendChild(item);
  });
}

async function _mdNoteConfirmDelete(noteId) {
  if (!confirm('এই নোটটি মুছে ফেলবেন?')) return;
  try {
    const res = await Note.delete(_session.token, noteId);
    if (res && res.success) {
      try { await ncDelete(noteId); } catch { /* silent */ }
      try { await rcDelete(noteId); } catch { /* silent */ }  // reading_cache থেকেও সরাও
      const updated = await ncGetByAccount(_mdMeter.account_id).catch(() => []);
      _mdNoteRender(updated);
      if (typeof showToast === 'function') showToast('🗑️ নোট মুছে ফেলা হয়েছে।');
    } else {
      if (typeof showToast === 'function') showToast('❌ ' + ((res && res.message) || 'মুছতে ব্যর্থ।'));
    }
  } catch {
    if (typeof showToast === 'function') showToast('❌ সার্ভারের সাথে সংযোগ করা যাচ্ছে না।');
  }
}

/* ── Image handling ── */
async function mdNoteHandleImages(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;

  const apiKey = (typeof CONFIG !== 'undefined') ? CONFIG.IMGBB_API_KEY : null;
  if (!apiKey || apiKey === 'YOUR_IMGBB_API_KEY') {
    if (typeof showToast === 'function') showToast('⚠️ ImgBB API key সেট করা নেই।');
    return;
  }

  const previewEl = document.getElementById('mdNoteImgPreview');
  if (previewEl) previewEl.classList.remove('hidden');

  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) {
      if (typeof showToast === 'function') showToast('⚠️ ছবির আকার ৫MB এর বেশি হওয়া যাবে না।');
      continue;
    }
    const localUrl = URL.createObjectURL(file);
    const thumb = document.createElement('div');
    thumb.className = 'md-note-img-thumb md-note-img-uploading';
    thumb.innerHTML = `<img src="${localUrl}"><div class="md-note-img-overlay"><div class="md-spinner"></div></div>`;
    if (previewEl) previewEl.appendChild(thumb);

    try {
      const formData = new FormData();
      formData.append('image', file);
      const res  = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, { method: 'POST', body: formData });
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || 'Upload failed');
      const hostedUrl = data.data.url;
      _mdNoteImages.push(hostedUrl);
      thumb.className = 'md-note-img-thumb';
      thumb.innerHTML = `<img src="${hostedUrl}"><button class="md-note-img-remove" onclick="mdNoteRemoveImg(this,'${hostedUrl}')">✕</button>`;
    } catch (e) {
      thumb.remove();
      if (typeof showToast === 'function') showToast('❌ ছবি আপলোড ব্যর্থ: ' + e.message);
    }
  }
  event.target.value = '';
}

function mdNoteRemoveImg(btn, url) {
  _mdNoteImages = _mdNoteImages.filter(u => u !== url);
  btn.closest('.md-note-img-thumb').remove();
  const previewEl = document.getElementById('mdNoteImgPreview');
  if (previewEl && !_mdNoteImages.length) previewEl.classList.add('hidden');
}

/* ── Submit note ── */
async function mdNoteSubmit() {
  if (!_mdMeter || !_mdMeter.account_id) return;

  const textEl    = document.getElementById('mdNoteText');
  const sendBtn   = document.getElementById('mdNoteSendBtn');
  const previewEl = document.getElementById('mdNoteImgPreview');
  const text      = textEl ? textEl.value.trim() : '';

  if (!text && !_mdNoteImages.length) {
    if (typeof showToast === 'function') showToast('⚠️ নোট বা ছবি যোগ করুন।');
    return;
  }

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<div class="md-spinner" style="width:12px;height:12px;border-width:2px"></div>';
  }

  const uj = (_profile && _profile.user_json)
    ? (typeof _profile.user_json === 'string' ? _mdParse(_profile.user_json) : _profile.user_json)
    : {};

  const note_json = {
    type:         _mdNoteImages.length && !text ? 'image' : 'text',
    text:         text || null,
    images:       _mdNoteImages.length ? [..._mdNoteImages] : undefined,
    creator_name: uj.full_name || (_session && _session.username) || '',
    creator_pic:  uj.profile_pic_url || '',
  };
  Object.keys(note_json).forEach(k => note_json[k] === undefined && delete note_json[k]);

  // Save pending note to IndexedDB immediately (is_synced: 0)
  const tempId = '_temp_' + Date.now();
  const tempNote = {
    note_id:      tempId,
    account_id:   _mdMeter.account_id,
    note_creator: (_session && _session.username) || '',
    note_json,
    timestamp:    new Date().toISOString(),
    is_synced:    0,
  };
  try { await ncPut(tempNote); } catch { /* silent */ }

  // Show updated list immediately
  const withPending = await ncGetByAccount(_mdMeter.account_id).catch(() => [tempNote]);
  _mdNoteRender(withPending);

  // Clear compose
  if (textEl) textEl.value = '';
  const savedImages = [..._mdNoteImages];
  _mdNoteImages = [];
  if (previewEl) { previewEl.innerHTML = ''; previewEl.classList.add('hidden'); }

  try {
    const res = await Note.add(_session.token, _mdMeter.account_id, note_json);

    if (res && res.success && res.data && res.data.note_id) {
      // Remove temp, save confirmed note (is_synced: 1)
      try { await ncDelete(tempId); } catch { /* silent */ }
      // Use server timestamp if available, otherwise client time
      const serverTs = res.data.timestamp || new Date().toISOString();
      const realNote = {
        note_id:      res.data.note_id,
        account_id:   _mdMeter.account_id,
        note_creator: (_session && _session.username) || '',
        note_json,
        timestamp:    serverTs,
        is_synced:    1,
      };
      try { await ncPut(realNote); } catch { /* silent */ }

      // lastSync update করো — পরের fetch এ এই note আর আসবে না
      const fmt = serverTs.replace(/\.\d+Z?$/, '').replace('Z', '').replace(' ', 'T');
      try { await ncSaveLastSync(_mdMeter.account_id, fmt); } catch { /* silent */ }

      const updated = await ncGetByAccount(_mdMeter.account_id).catch(() => [realNote]);
      _mdNoteRender(updated);
    } else {
      // Server error — remove temp, restore compose
      try { await ncDelete(tempId); } catch { /* silent */ }
      const reverted = await ncGetByAccount(_mdMeter.account_id).catch(() => []);
      _mdNoteRender(reverted);
      if (textEl) textEl.value = text;
      _mdNoteImages = savedImages;
      if (savedImages.length && previewEl) {
        previewEl.classList.remove('hidden');
        savedImages.forEach(url => {
          const thumb = document.createElement('div');
          thumb.className = 'md-note-img-thumb';
          thumb.innerHTML = `<img src="${url}"><button class="md-note-img-remove" onclick="mdNoteRemoveImg(this,'${url}')">✕</button>`;
          previewEl.appendChild(thumb);
        });
      }
      if (typeof showToast === 'function') showToast('❌ ' + ((res && res.message) || 'নোট পাঠানো ব্যর্থ।'));
    }
  } catch {
    // Network error — keep pending in cache
    if (typeof showToast === 'function') showToast('⚠️ অফলাইন — নোট সংরক্ষিত, সংযোগ হলে sync হবে।');
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> পাঠান`;
    }
  }
}

/* ── Image lightbox ── */
function mdNoteViewImg(url) {
  let lb = document.getElementById('mdNoteLightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'mdNoteLightbox';
    lb.className = 'md-note-lightbox';
    lb.innerHTML = `<div class="md-note-lb-backdrop" onclick="mdNoteCloseLightbox()"></div>
      <img class="md-note-lb-img" id="mdNoteLbImg">
      <button class="md-note-lb-close" onclick="mdNoteCloseLightbox()">✕</button>`;
    document.body.appendChild(lb);
  }
  document.getElementById('mdNoteLbImg').src = url;
  lb.classList.add('open');
}

function mdNoteCloseLightbox() {
  const lb = document.getElementById('mdNoteLightbox');
  if (lb) lb.classList.remove('open');
}

function _mdNoteEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/* ══════════════════════════════════════════════
   READING MODAL
   ══════════════════════════════════════════════ */

// Meter type → required fields config
const RD_FIELDS = {
  single_phase:    [{ key: 'kwh', label: 'kWh' }],
  '3phase':        [{ key: 'kwh', label: 'kWh' }, { key: 'kw', label: 'kW' }],
  '3phase_kvarh':  [{ key: 'kwh', label: 'kWh' }, { key: 'kw', label: 'kW' }, { key: 'kvarh_lag', label: 'kVArh-Lag' }, { key: 'kvarh_led', label: 'kVArh-Led' }],
  '3phase_2part':  [{ key: 'kwh', label: 'kWh' }, { key: 'kw', label: 'kW' }, { key: 'kvarh_lag', label: 'kVArh-Lag' }, { key: 'kvarh_led', label: 'kVArh-Led' }],
  '3phase_netmeter': [{ key: 'kwh', label: 'kWh' }, { key: 'kw', label: 'kW' }, { key: 'kvarh_lag', label: 'kVArh-Lag' }, { key: 'kvarh_led', label: 'kVArh-Led' }],
};

async function mdReadingOpen() {
  if (!_mdMeter) {
    showToast('⚠️ মিটার লোড হয়নি।');
    return;
  }
  if (!_mdMeter.account_id) {
    showToast('⚠️ মিটার sync হয়নি — আগে sync করুন।');
    return;
  }

  const mi       = _mdParse(_mdMeter.meter_info_json);
  const mType    = mi.type || 'single_phase';
  const fields   = RD_FIELDS[mType] || RD_FIELDS['single_phase'];
  const ai       = _mdParse(_mdMeter.account_info_json);

  // Account number xxx-xxxx format
  const rawNum   = _mdMeter.account_number || '';
  const accFmt   = rawNum.length >= 7
    ? rawNum.slice(0,3) + '-' + rawNum.slice(3)
    : rawNum || '—';
  const meterNum = _mdMeter.meter_number || '—';

  // Meter info strip
  const infoEl = document.getElementById('rdMeterInfo');
  if (infoEl) {
    infoEl.innerHTML =
      `<strong>${accFmt}</strong> &nbsp;|&nbsp; মিটার: <strong>${meterNum}</strong>`
      + ` &nbsp;|&nbsp; ${ai.name || '—'} &nbsp;|&nbsp; <strong>${_mdTypeLabel(mType)}</strong>`;
  }

  // Previous reading — last reading-type note for this account
  const prevReading = await _mdGetLastReading(_mdMeter.account_id);
  const prevVals    = prevReading ? (prevReading.reading || {}) : null;
  const prevTs      = prevReading ? prevReading._ts : null;

  // Build input fields — with prev value inline
  const fieldsEl = document.getElementById('rdFields');
  if (fieldsEl) {
    fieldsEl.innerHTML = fields.map(f => {
      const pv = prevVals ? prevVals[f.key] : null;
      const prevHint = pv != null
        ? `<span class="rd-prev-inline">পূর্ব: <strong>${pv}</strong></span>`
        : '';
      return `
        <div class="rd-field-group">
          <div class="rd-field-label-row">
            <span class="rd-field-label">${f.label}</span>
            ${prevHint}
            <span class="rd-diff-badge" id="rdDiff_${f.key}"></span>
          </div>
          <input type="number" step="any" class="rd-field-input" id="rdInput_${f.key}"
            placeholder="${pv != null ? pv : '0.00'}" inputmode="decimal">
        </div>`;
    }).join('');

    // Attach live diff listeners
    if (prevVals) {
      fields.forEach(f => {
        const inp = document.getElementById(`rdInput_${f.key}`);
        if (!inp) return;
        inp.addEventListener('input', () => _mdReadingUpdateDiff(f.key, prevVals[f.key], inp.value));
      });
    }
  }

  // Previous reading summary strip
  const prevEl = document.getElementById('rdPrev');
  if (prevEl) {
    if (prevTs) {
      const pts = new Date(prevTs).toLocaleString('bn-BD', { dateStyle: 'short', timeStyle: 'short' });
      prevEl.innerHTML = `<div class="rd-prev-ts">📅 পূর্ববর্তী রিডিং: ${pts}</div>`;
    } else {
      prevEl.innerHTML = '';
    }
  }

  document.getElementById('rdBackdrop').classList.remove('hidden');
  document.getElementById('rdModal').classList.remove('hidden');

  // Focus first input
  setTimeout(() => {
    const first = document.querySelector('.rd-field-input');
    if (first) first.focus();
  }, 120);
}

function _mdReadingUpdateDiff(key, prev, rawVal) {
  const diffEl = document.getElementById(`rdDiff_${key}`);
  if (!diffEl) return;
  const cleaned = (rawVal || '').trim()
    .replace(/,/g, '.')
    .replace(/[০-৯]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x09E0 + 48));
  const val = parseFloat(cleaned);
  if (prev == null || cleaned === '' || isNaN(val)) {
    diffEl.textContent = '';
    diffEl.className = 'rd-diff-badge';
    return;
  }
  const diff  = (val - prev).toFixed(2);
  const isPos = parseFloat(diff) >= 0;
  diffEl.className    = 'rd-diff-badge ' + (isPos ? 'rd-diff-pos' : 'rd-diff-neg');
  diffEl.textContent  = (isPos ? '+' : '') + diff;
}

async function _mdGetLastReading(accountId) {
  try {
    const notes = await ncGetByAccount(accountId);
    const rdNotes = notes
      .filter(n => {
        const nj = typeof n.note_json === 'string' ? _mdParse(n.note_json) : (n.note_json || {});
        return nj.type === 'reading';
      })
      .sort((a, b) => (a.timestamp || '') < (b.timestamp || '') ? 1 : -1);
    if (!rdNotes.length) return null;
    const last = rdNotes[0];
    const nj = typeof last.note_json === 'string' ? _mdParse(last.note_json) : (last.note_json || {});
    return { reading: nj.reading || {}, _ts: last.timestamp };
  } catch { return null; }
}

function mdReadingClose() {
  document.getElementById('rdBackdrop').classList.add('hidden');
  document.getElementById('rdModal').classList.add('hidden');
}

async function mdReadingSave() {
  if (!_mdMeter || !_mdMeter.account_id) return;

  const mi     = _mdParse(_mdMeter.meter_info_json);
  const mType  = mi.type || 'single_phase';
  const fields = RD_FIELDS[mType] || RD_FIELDS['single_phase'];

  // Collect values
  const reading = {};
  let hasAny = false;
  for (const f of fields) {
    const inp = document.getElementById(`rdInput_${f.key}`);
    if (!inp || inp.value.trim() === '') continue;
    // comma বা space সরাও, Bengali digits → ASCII
    const cleaned = inp.value.trim()
      .replace(/,/g, '.')          // comma → dot
      .replace(/[০-৯]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x09E0 + 48)); // Bengali → ASCII
    const val = parseFloat(cleaned);
    if (!isNaN(val)) { reading[f.key] = val; hasAny = true; }
  }
  if (!hasAny) {
    showToast('⚠️ কমপক্ষে একটি মান দিন।');
    return;
  }

  const saveBtn = document.getElementById('rdSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '…'; }

  const uj = (_profile && _profile.user_json)
    ? (typeof _profile.user_json === 'string' ? _mdParse(_profile.user_json) : _profile.user_json)
    : {};

  const note_json = {
    type:         'reading',
    reading,
    creator_name: uj.full_name || (_session && _session.username) || '',
    creator_pic:  uj.profile_pic_url || '',
  };

  // Save as note (same flow as text note)
  const tempId   = '_temp_' + Date.now();
  const tempNote = {
    note_id:      tempId,
    account_id:   _mdMeter.account_id,
    note_creator: (_session && _session.username) || '',
    note_json,
    timestamp:    new Date().toISOString(),
    is_synced:    0,
  };
  try { await ncPut(tempNote); } catch { /* silent */ }

  // reading_cache তে temp note সহ sync করো (offline এ সাথে সাথে দেখাবে)
  const meterMeta = {
    route_number:   _mdMeter.route_number   || '',
    village:        _mdMeter.village        || '',
    account_number: _mdMeter.account_number || '',
    meter_number:   _mdMeter.meter_number   || '',
  };
  await rcSyncFromNotes(_mdMeter.account_id, meterMeta).catch(() => {});

  // Re-render notes
  const withPending = await ncGetByAccount(_mdMeter.account_id).catch(() => [tempNote]);
  _mdNoteRender(withPending);

  mdReadingClose();

  // Post to server
  try {
    const res = await Note.add(_session.token, _mdMeter.account_id, note_json);
    if (res && res.success && res.data && res.data.note_id) {
      try { await ncDelete(tempId); } catch { /* silent */ }
      const serverTs = res.data.timestamp || new Date().toISOString();
      const realNote = {
        note_id:      res.data.note_id,
        account_id:   _mdMeter.account_id,
        note_creator: (_session && _session.username) || '',
        note_json,
        timestamp:    serverTs,
        is_synced:    1,
      };
      try { await ncPut(realNote); } catch { /* silent */ }

      // Update reading_cache with real note_id
      try { await rcDelete(tempId); } catch { /* silent */ }
      await rcSyncFromNotes(_mdMeter.account_id, meterMeta).catch(() => {});

      const fmt = serverTs.replace(/\.\d+Z?$/, '').replace('Z', '').replace(' ', 'T');
      try { await ncSaveLastSync(_mdMeter.account_id, fmt); } catch { /* silent */ }

      const updated = await ncGetByAccount(_mdMeter.account_id).catch(() => [realNote]);
      _mdNoteRender(updated);
      showToast('✅ রিডিং সেভ হয়েছে।');
    } else {
      try { await ncDelete(tempId); } catch { /* silent */ }
      const reverted = await ncGetByAccount(_mdMeter.account_id).catch(() => []);
      _mdNoteRender(reverted);
      showToast('❌ ' + ((res && res.message) || 'রিডিং পাঠানো ব্যর্থ।'));
    }
  } catch {
    showToast('⚠️ অফলাইন — রিডিং সংরক্ষিত, সংযোগ হলে sync হবে।');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> সেভ করুন`;
    }
  }
}
