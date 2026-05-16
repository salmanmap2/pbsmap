/**
 * PBS Map — Meter Offline Store
 * IndexedDB-backed offline queue for meter additions.
 * Syncs to server when online or manually triggered.
 *
 * Store: 'meter_queue'
 * Record shape:
 * {
 *   local_id    : string  — UUID, primary key
 *   office_id   : string
 *   account_number: string  — 7 digits, no dash
 *   gps_location: string  — "lat,lng"
 *   created_at  : string  — ISO timestamp (local)
 *   is_synced   : 0 | 1
 *   account_id  : string | null  — returned by server after sync
 *   sync_error  : string | null  — last sync error message
 * }
 */

const MS_DB_NAME    = 'pbsmap_db';
const MS_DB_VERSION = 3;           // same as db.js
const MS_STORE      = 'meter_queue';

/* ══ DB open — reuses db.js openDB() ══ */
function msOpenDB() {
  // openDB() is defined in db.js and handles all stores including meter_queue
  return openDB();
}

/* ── tiny UUID ── */
function msUUID() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

/* ══ CRUD helpers ══ */

async function msPut(record) {
  const db = await msOpenDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(MS_STORE, 'readwrite');
    const req = tx.objectStore(MS_STORE).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function msGetAll() {
  const db = await msOpenDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(MS_STORE, 'readonly');
    const req = tx.objectStore(MS_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function msGetUnsynced() {
  const db = await msOpenDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(MS_STORE, 'readonly');
    const index = tx.objectStore(MS_STORE).index('is_synced');
    const req   = index.getAll(0);   // is_synced = 0
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

/** Get the latest created_at among synced records (for incremental sync) */
async function msGetLastSyncedTime(officeId) {
  const all = await msGetAll();
  const synced = all.filter(r => r.is_synced === 1 && r.office_id === officeId && r.server_updated_at);
  if (!synced.length) return null;
  synced.sort((a, b) => (a.server_updated_at > b.server_updated_at ? -1 : 1));
  // Strip ms/Z for backend format: "YYYY-MM-DDTHH:MM:SS"
  return synced[0].server_updated_at.replace(/\.\d+Z?$/, '').replace('Z', '').replace(' ', 'T');
}

/* ══ PUBLIC API ══ */

/**
 * Add a meter to the offline queue.
 * Returns the local_id.
 */
async function msEnqueue(officeId, accountNumber, gpsLocation, accClass = 'h') {
  const record = {
    local_id:       msUUID(),
    office_id:      officeId,
    account_number: accountNumber,
    gps_location:   gpsLocation,
    acc_class:      accClass,
    created_at:     new Date().toISOString(),
    is_synced:      0,
    account_id:     null,
    sync_error:     null,
  };
  await msPut(record);
  return record;
}

/**
 * Sync all unsynced records to the server,
 * then pull ALL meters from server and merge into IndexedDB.
 * Records already in IndexedDB are never deleted — only upserted.
 */
async function msSyncAll(token, onProgress) {
  const pending = await msGetUnsynced();
  let synced = 0, failed = 0;

  // ── Step 1: Push unsynced local records ──────────────────────
  for (const record of pending) {
    try {
      const res = await Meter.add(token, {
        office_id:        record.office_id,
        account_number:   record.account_number,
        gps_location:     record.gps_location,
        account_info_json: { acc_class: record.acc_class || 'h' },
      });

      if (res.success) {
        record.is_synced  = 1;
        record.account_id = res.data && res.data.account_id;
        record.sync_error = null;
        synced++;
      } else {
        record.sync_error = res.message || 'Server error';
        failed++;
      }
    } catch (e) {
      record.sync_error = e.message || 'Network error';
      failed++;
    }

    await msPut(record);
    if (typeof onProgress === 'function') onProgress(synced + failed, pending.length, record);
  }

  // ── Step 2: Pull updated meters from server and merge ────────
  try {
    const session = await getSession();
    if (session && session.token && session.active_office) {
      const lastTime = await msGetLastSyncedTime(session.active_office);
      await msFetchAndMergeAll(session.token, session.active_office, lastTime);
    }
  } catch (e) {
    console.warn('[meter-store] Sync pull failed:', e.message);
  }

  return { synced, failed, total: pending.length };
}

function _msTryParse(str) { try { return JSON.parse(str); } catch { return {}; } }

/** Get a record by server account_id */
async function msGetByAccountId(accountId) {
  const all = await msGetAll();
  return all.find(r => r.account_id === accountId) || null;
}

/** Get all records for a specific office */
async function msGetByOffice(officeId) {
  const db = await msOpenDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(MS_STORE, 'readonly');
    const store = tx.objectStore(MS_STORE);
    // Use office_id index if available
    if (store.indexNames.contains('office_id')) {
      const req = store.index('office_id').getAll(officeId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    } else {
      // Fallback: getAll + filter
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result || []).filter(r => r.office_id === officeId));
      req.onerror   = () => reject(req.error);
    }
  });
}

/** Search meters by account_number or meter_number (digits only) */
async function msSearch(officeId, query) {
  const all = await msGetByOffice(officeId);
  const q   = query.replace(/\D/g, '');
  if (!q) return [];
  return all.filter(r => {
    const acc = (r.account_number || '').replace(/\D/g, '');
    const mno = (r.meter_number   || '').replace(/\D/g, '');
    const rno = (r.route_number   || '').replace(/\D/g, '');
    const vil = (r.village        || '').toLowerCase();
    return acc.includes(q) || mno.includes(q) || rno.includes(q)
      || vil.includes(query.toLowerCase().trim());
  }).slice(0, 30);
}

/**
 * Full fetch from server (no last_time) and merge into IndexedDB.
 * Called on login / office load. Never deletes local records.
 */
async function msFetchAndMergeAll(token, officeId, lastTime = null) {
  const res = await Meter.getAll(token, officeId, lastTime);

  if (!res.success) {
    console.warn('[meter-store] msFetchAndMergeAll failed:', res.message);
    return;
  }
  if (!Array.isArray(res.data)) {
    console.warn('[meter-store] msFetchAndMergeAll: data is not array', res);
    return;
  }

  console.log(`[meter-store] Fetched ${res.data.length} meters from server for office ${officeId}`);

  for (const m of res.data) {
    const existing = await msGetByAccountId(m.account_id);
    const infoJson = typeof m.account_info_json === 'string'
      ? _msTryParse(m.account_info_json) : (m.account_info_json || {});

    if (existing) {
      // Merge: update all server fields
      existing.is_synced         = 1;
      existing.account_id        = m.account_id;
      existing.sync_error        = null;
      existing.server_updated_at = m.updated_at || null;
      existing.gps_location      = m.gps_location      || existing.gps_location;
      existing.route_number      = m.route_number      || existing.route_number;
      existing.village           = m.village            || existing.village;
      existing.meter_number      = m.meter_number       || existing.meter_number;
      existing.account_info_json = m.account_info_json  || existing.account_info_json;
      existing.meter_info_json   = m.meter_info_json    || existing.meter_info_json;
      if (infoJson.acc_class) existing.acc_class = infoJson.acc_class;
      await msPut(existing);
    } else {
      await msPut({
        local_id:          'srv_' + m.account_id,
        office_id:         m.office_id,
        account_number:    m.account_number,
        gps_location:      m.gps_location      || '',
        route_number:      m.route_number       || '',
        village:           m.village            || '',
        meter_number:      m.meter_number       || '',
        account_info_json: m.account_info_json  || '{}',
        meter_info_json:   m.meter_info_json    || '{}',
        acc_class:         infoJson.acc_class   || 'h',
        created_at:        new Date().toISOString(),
        server_updated_at: m.updated_at         || null,
        is_synced:         1,
        account_id:        m.account_id,
        sync_error:        null,
      });
    }
  }
}

/**
 * Count unsynced records for a given office (or all offices if omitted).
 */
async function msUnsyncedCount(officeId) {
  const pending = await msGetUnsynced();
  if (!officeId) return pending.length;
  return pending.filter(r => r.office_id === officeId).length;
}

/* ══ Online/offline detection + auto-sync ══ */

let _msSyncInProgress = false;

async function msTryAutoSync() {
  if (_msSyncInProgress) return;
  if (!navigator.onLine) return;

  const session = await getSession();
  if (!session || !session.token || !session.active_office) return;

  // Auto-sync: push unsynced + pull new from server
  const count = await msUnsyncedCount();
  if (count === 0) {
    // Still pull to get other users' new meters
    try {
      const lastTime = await msGetLastSyncedTime(session.active_office);
      await msFetchAndMergeAll(session.token, session.active_office, lastTime);
      if (typeof amRenderAllPins === 'function') amRenderAllPins(session.active_office);
    } catch { /* silent */ }
    return;
  }

  _msSyncInProgress = true;
  msSyncBadgeUpdate();

  try {
    const result = await msSyncAll(session.token);
    msSyncBadgeUpdate();
    if (typeof amRenderAllPins === 'function') amRenderAllPins(session.active_office);
    if (result.synced > 0) {
      if (typeof showToast === 'function')
        showToast(`☁️ ${result.synced}টি মিটার sync হয়েছে`);
    }
  } finally {
    _msSyncInProgress = false;
    msSyncBadgeUpdate();
  }
}

/** Update the sync badge count on the WiFi button */
async function msSyncBadgeUpdate() {
  const badge = document.getElementById('syncBadge');
  const btn   = document.getElementById('syncBtn');
  if (!badge || !btn) return;

  const count = await msUnsyncedCount();
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.remove('hidden');
    btn.classList.add('has-pending');
  } else {
    badge.classList.add('hidden');
    btn.classList.remove('has-pending');
  }
}

/** Manual sync triggered by WiFi button */
async function msTriggerManualSync() {
  if (_msSyncInProgress) {
    if (typeof showToast === 'function') showToast('⏳ Sync চলছে…');
    return;
  }
  if (!navigator.onLine) {
    if (typeof showToast === 'function') showToast('📵 ইন্টারনেট সংযোগ নেই।');
    return;
  }

  const session = await getSession();
  if (!session || !session.token || !session.active_office) return;

  _msSyncInProgress = true;
  const btn = document.getElementById('syncBtn');
  if (btn) btn.classList.add('syncing');

  const count = await msUnsyncedCount();
  if (count > 0) {
    if (typeof showToast === 'function') showToast(`⏳ ${count}টি মিটার sync হচ্ছে…`);
  } else {
    if (typeof showToast === 'function') showToast('🔄 নতুন মিটার চেক করা হচ্ছে…');
  }

  try {
    // ── Step 1: Push local unsynced (if any) ──────────────────────
    let pushResult = { synced: 0, failed: 0, total: 0 };
    if (count > 0) {
      pushResult = await msSyncAll(session.token);
    }

    // ── Step 2: Always pull from server (get other users' meters) ─
    const lastTime = await msGetLastSyncedTime(session.active_office);
    await msFetchAndMergeAll(session.token, session.active_office, lastTime);

    msSyncBadgeUpdate();

    // Re-render all pins
    if (typeof amRenderAllPins === 'function') amRenderAllPins(session.active_office);

    if (pushResult.failed > 0) {
      showToast(`⚠️ ${pushResult.synced}টি সফল, ${pushResult.failed}টি ব্যর্থ।`);
    } else if (pushResult.synced > 0) {
      showToast(`✅ ${pushResult.synced}টি মিটার sync সম্পন্ন।`);
    } else {
      showToast('✅ মিটার আপডেট হয়েছে।');
    }
  } catch (e) {
    console.warn('[meter-store] Manual sync error:', e);
    if (typeof showToast === 'function') showToast('❌ Sync ব্যর্থ হয়েছে।');
  } finally {
    _msSyncInProgress = false;
    if (btn) btn.classList.remove('syncing');
    msSyncBadgeUpdate();
  }
}

/* Auto-sync when coming back online */
window.addEventListener('online',  () => { msSyncBadgeUpdate(); msTryAutoSync(); });
window.addEventListener('offline', () => { msSyncBadgeUpdate(); });

/* Init badge on page load */
document.addEventListener('DOMContentLoaded', () => {
  msOpenDB().then(() => {
    msSyncBadgeUpdate();
    msTryAutoSync();
  });
});
