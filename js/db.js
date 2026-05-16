/**
 * PBS Map — IndexedDB Manager
 * Handles all local storage via IndexedDB
 */

const DB_NAME    = 'pbsmap_db';
const DB_VERSION = 9;  // v9: reading_cache store added

const STORES = {
  AUTH:       'auth',        // { key: 'session', ... }
  PROFILE:    'profile',     // full profile cache
  PBS:        'pbs',         // pbs list cache
  OFFICES:    'offices',     // offices by pbs_id
  TILE_CACHE: 'tile_cache',  // map tile blobs { key: url, blob, ts }
};

let _db = null;

/** Open (or upgrade) the IndexedDB database */
function openDB() {
  return new Promise((resolve, reject) => {
    if (_db && _db.version >= DB_VERSION) { resolve(_db); return; }

    // Close stale connection if version mismatch
    if (_db) { _db.close(); _db = null; }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Force-close any other tabs/connections holding an older version
    req.onblocked = () => {
      console.warn('[db] upgrade blocked — closing stale connections');
      if (_db) { _db.close(); _db = null; }
    };

    req.onupgradeneeded = (e) => {
      const db  = e.target.result;
      const old = e.oldVersion;

      // Close any existing connection on this instance
      db.onversionchange = () => { db.close(); _db = null; };

      if (!db.objectStoreNames.contains(STORES.AUTH))       db.createObjectStore(STORES.AUTH,       { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.PROFILE))    db.createObjectStore(STORES.PROFILE,    { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.PBS))        db.createObjectStore(STORES.PBS,        { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.OFFICES))    db.createObjectStore(STORES.OFFICES,    { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORES.TILE_CACHE)) db.createObjectStore(STORES.TILE_CACHE, { keyPath: 'key' });

      // Meter offline queue
      if (!db.objectStoreNames.contains('meter_queue')) {
        const mq = db.createObjectStore('meter_queue', { keyPath: 'local_id' });
        mq.createIndex('is_synced',    'is_synced',    { unique: false });
        mq.createIndex('office_id',    'office_id',    { unique: false });
        mq.createIndex('created_at',   'created_at',   { unique: false });
        mq.createIndex('account_id',   'account_id',   { unique: false });
        mq.createIndex('meter_number', 'meter_number', { unique: false });
        mq.createIndex('route_number', 'route_number', { unique: false });
        mq.createIndex('village',      'village',      { unique: false });
      } else if (old < 6) {
        const tx = e.target.transaction;
        const mq = tx.objectStore('meter_queue');
        const existing = Array.from(mq.indexNames);
        if (!existing.includes('account_id'))   mq.createIndex('account_id',   'account_id',   { unique: false });
        if (!existing.includes('meter_number')) mq.createIndex('meter_number', 'meter_number', { unique: false });
        if (!existing.includes('route_number')) mq.createIndex('route_number', 'route_number', { unique: false });
        if (!existing.includes('village'))      mq.createIndex('village',      'village',      { unique: false });
      }

      // Meter detail cache
      if (!db.objectStoreNames.contains('meter_detail')) {
        const md = db.createObjectStore('meter_detail', { keyPath: 'account_id' });
        md.createIndex('office_id', 'office_id', { unique: false });
        md.createIndex('cached_at', 'cached_at', { unique: false });
      }

      // Office cache
      if (!db.objectStoreNames.contains('office_cache')) {
        db.createObjectStore('office_cache', { keyPath: 'office_id' });
      }

      // Note cache (v7: account_id keyPath → v8: note_id keyPath, per-note records)
      if (!db.objectStoreNames.contains('note_cache')) {
        const nc = db.createObjectStore('note_cache', { keyPath: 'note_id' });
        nc.createIndex('account_id', 'account_id', { unique: false });
        nc.createIndex('is_synced',  'is_synced',  { unique: false });
        nc.createIndex('timestamp',  'timestamp',  { unique: false });
      } else if (old < 8) {
        // v7 used account_id as keyPath — must drop and recreate
        db.deleteObjectStore('note_cache');
        const nc = db.createObjectStore('note_cache', { keyPath: 'note_id' });
        nc.createIndex('account_id', 'account_id', { unique: false });
        nc.createIndex('is_synced',  'is_synced',  { unique: false });
        nc.createIndex('timestamp',  'timestamp',  { unique: false });
      }

      // Reading cache (v9)
      // Shape: { note_id, reading_time, route_number, village, account_number,
      //          meter_number, kwh, kw, kvarh_lag, kvarh_led, account_id }
      if (!db.objectStoreNames.contains('reading_cache')) {
        const rc = db.createObjectStore('reading_cache', { keyPath: 'note_id' });
        rc.createIndex('account_id',   'account_id',   { unique: false });
        rc.createIndex('route_number', 'route_number', { unique: false });
        rc.createIndex('reading_time', 'reading_time', { unique: false });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      // Auto-close if another tab upgrades
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/** Generic put — silently skips if store doesn't exist yet */
async function dbPut(storeName, value) {
  const db = await openDB();
  if (!db.objectStoreNames.contains(storeName)) return;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Generic get — returns null if store doesn't exist yet */
async function dbGet(storeName, key) {
  const db = await openDB();
  if (!db.objectStoreNames.contains(storeName)) return null;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

/** Generic delete — silently skips if store doesn't exist yet */
async function dbDelete(storeName, key) {
  const db = await openDB();
  if (!db.objectStoreNames.contains(storeName)) return;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/** Clear entire store — silently skips if store doesn't exist yet */
async function dbClear(storeName) {
  const db = await openDB();
  if (!db.objectStoreNames.contains(storeName)) return;
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/* ── Auth Session Helpers ── */

async function saveSession(data) {
  await dbPut(STORES.AUTH, {
    key:           'session',
    token:         data.token,
    username:      data.username,
    email:         data.email,
    user_json:     data.user_json     || {},
    active_office: data.active_office || null,
    user_api_key:  data.user_api_key  || '',
  });
}

async function getSession() {
  return dbGet(STORES.AUTH, 'session');
}

async function clearSession() {
  await dbClear(STORES.AUTH);
  await dbClear(STORES.PROFILE);
}

/* ── Profile Cache ── */

async function saveProfileCache(profile) {
  await dbPut(STORES.PROFILE, { key: 'profile', ...profile });
}

async function getProfileCache() {
  return dbGet(STORES.PROFILE, 'profile');
}

/* ── PBS Cache ── */

async function savePbsCache(list) {
  await dbPut(STORES.PBS, { key: 'list', data: list, ts: Date.now() });
}

async function getPbsCache() {
  const rec = await dbGet(STORES.PBS, 'list');
  if (!rec) return null;
  // Cache valid for 1 hour
  if (Date.now() - rec.ts > 3600_000) return null;
  return rec.data;
}

/* ── Offices Cache ── */

async function saveOfficesCache(pbsId, list) {
  await dbPut(STORES.OFFICES, { key: `pbs_${pbsId}`, data: list, ts: Date.now() });
}

async function getOfficesCache(pbsId) {
  const rec = await dbGet(STORES.OFFICES, `pbs_${pbsId}`);
  if (!rec) return null;
  if (Date.now() - rec.ts > 1800_000) return null; // 30 min
  return rec.data;
}

/* ── Tile Cache ── */

const TILE_CACHE_TTL = 7 * 24 * 3600_000; // 7 days

async function getTileCached(url) {
  try {
    const rec = await dbGet(STORES.TILE_CACHE, url);
    if (!rec) return null;
    if (Date.now() - rec.ts > TILE_CACHE_TTL) {
      // expired — delete silently
      dbDelete(STORES.TILE_CACHE, url).catch(() => {});
      return null;
    }
    return URL.createObjectURL(rec.blob);
  } catch { return null; }
}

async function saveTileCache(url, blob) {
  try {
    await dbPut(STORES.TILE_CACHE, { key: url, blob, ts: Date.now() });
  } catch { /* storage full or other error — ignore */ }
}

/* ── Office Cache ── */

async function saveOfficeCache(office) {
  await dbPut('office_cache', { ...office, cached_at: Date.now() });
}

async function getOfficeCache(officeId) {
  return dbGet('office_cache', officeId);
}

/* ── Note Cache ── */
/*
 * note_cache store shape (keyPath: note_id):
 * {
 *   note_id:      string   — server UUID or '_temp_xxx' for pending
 *   account_id:   string   — FK to meter
 *   note_creator: string   — username
 *   note_json:    object   — { type, text, images, creator_name, creator_pic }
 *   timestamp:    string   — ISO datetime
 *   is_synced:    0 | 1    — 0 = pending (not yet on server), 1 = confirmed
 * }
 *
 * notes_last_sync is stored on the meter_queue / meter_detail record
 * so we only fetch notes newer than that time.
 */

/** Put a single note into note_cache */
async function ncPut(note) {
  return dbPut('note_cache', note);
}

/** Get all notes for an account_id, sorted oldest→newest */
async function ncGetByAccount(accountId) {
  const db = await openDB();
  if (!db.objectStoreNames.contains('note_cache')) return [];
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('note_cache', 'readonly');
    const req = tx.objectStore('note_cache').index('account_id').getAll(accountId);
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) =>
        (a.timestamp || '') < (b.timestamp || '') ? -1 : 1
      );
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Delete a single note by note_id */
async function ncDelete(noteId) {
  return dbDelete('note_cache', noteId);
}

/** Delete all notes for an account (used when clearing) */
async function ncDeleteByAccount(accountId) {
  const notes = await ncGetByAccount(accountId);
  for (const n of notes) await dbDelete('note_cache', n.note_id);
}

/** Get notes_last_sync for an account from meter_queue or meter_detail */
async function ncGetLastSync(accountId) {
  // Check meter_detail first (has full detail cache)
  const md = await dbGet('meter_detail', accountId);
  if (md && md.notes_last_sync) return md.notes_last_sync;
  // Fallback: meter_queue
  const db = await openDB();
  if (!db.objectStoreNames.contains('meter_queue')) return null;
  return new Promise(resolve => {
    const tx  = db.transaction('meter_queue', 'readonly');
    const idx = tx.objectStore('meter_queue').index('account_id');
    const req = idx.getAll(accountId);
    req.onsuccess = () => {
      const rows = req.result || [];
      const found = rows.find(r => r.notes_last_sync);
      resolve(found ? found.notes_last_sync : null);
    };
    req.onerror = () => resolve(null);
  });
}

/** Save notes_last_sync for an account into meter_detail and meter_queue */
async function ncSaveLastSync(accountId, isoTimestamp) {
  // Update meter_detail
  try {
    const md = await dbGet('meter_detail', accountId);
    if (md) {
      md.notes_last_sync = isoTimestamp;
      await dbPut('meter_detail', md);
    }
  } catch { /* silent */ }
  // Update meter_queue record(s)
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('meter_queue')) return;
    const rows = await new Promise(resolve => {
      const tx  = db.transaction('meter_queue', 'readonly');
      const req = tx.objectStore('meter_queue').index('account_id').getAll(accountId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
    });
    for (const row of rows) {
      row.notes_last_sync = isoTimestamp;
      await dbPut('meter_queue', row);
    }
  } catch { /* silent */ }
}

/** Merge server notes into note_cache, return all notes for account */
async function ncMergeFromServer(accountId, serverNotes) {
  for (const n of serverNotes) {
    // Remove any pending temp note that matches (same creator + same text within 5s)
    // — handled separately; just upsert the real note
    await ncPut({
      note_id:      n.note_id,
      account_id:   n.account_id || accountId,
      note_creator: n.note_creator,
      note_json:    typeof n.note_json === 'string' ? JSON.parse(n.note_json) : (n.note_json || {}),
      timestamp:    n.timestamp || new Date().toISOString(),
      is_synced:    1,
    });
  }
  // Update last_sync to newest note's timestamp
  if (serverNotes.length) {
    const newest = serverNotes
      .map(n => n.timestamp || '')
      .sort()
      .pop();
    if (newest) {
      const fmt = newest.replace(/\.\d+Z?$/, '').replace('Z', '').replace(' ', 'T');
      await ncSaveLastSync(accountId, fmt);
    }
  }
  return ncGetByAccount(accountId);
}

/* ── Reading Cache ── */
/*
 * reading_cache store shape (keyPath: note_id):
 * {
 *   note_id:      string  — same as note_cache note_id (reading type note)
 *   account_id:   string
 *   reading_time: string  — ISO datetime
 *   route_number: string
 *   village:      string
 *   account_number: string
 *   meter_number: string
 *   kwh:          number | null
 *   kw:           number | null
 *   kvarh_lag:    number | null
 *   kvarh_led:    number | null
 * }
 */

/** Upsert a reading record */
async function rcPut(record) {
  return dbPut('reading_cache', record);
}

/** Get a single reading by note_id */
async function rcGet(noteId) {
  return dbGet('reading_cache', noteId);
}

/** Delete a reading by note_id */
async function rcDelete(noteId) {
  return dbDelete('reading_cache', noteId);
}

/** Get all readings for an account */
async function rcGetByAccount(accountId) {
  const db = await openDB();
  if (!db.objectStoreNames.contains('reading_cache')) return [];
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('reading_cache', 'readonly');
    const req = tx.objectStore('reading_cache').index('account_id').getAll(accountId);
    req.onsuccess = () => resolve((req.result || []).sort((a, b) =>
      (a.reading_time || '') < (b.reading_time || '') ? 1 : -1));
    req.onerror = () => reject(req.error);
  });
}

/** Get all readings (all accounts) */
async function rcGetAll() {
  const db = await openDB();
  if (!db.objectStoreNames.contains('reading_cache')) return [];
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('reading_cache', 'readonly');
    const req = tx.objectStore('reading_cache').getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) =>
      (a.reading_time || '') < (b.reading_time || '') ? 1 : -1));
    req.onerror = () => reject(req.error);
  });
}

/** Get all readings for a route */
async function rcGetByRoute(routeNumber) {
  const db = await openDB();
  if (!db.objectStoreNames.contains('reading_cache')) return [];
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('reading_cache', 'readonly');
    const req = tx.objectStore('reading_cache').index('route_number').getAll(routeNumber);
    req.onsuccess = () => resolve((req.result || []).sort((a, b) =>
      (a.reading_time || '') < (b.reading_time || '') ? 1 : -1));
    req.onerror = () => reject(req.error);
  });
}

/**
 * Sync reading_cache from note_cache — note_json.type === 'reading' notes
 * থেকে reading_cache auto-generate করো।
 * Call this after note_cache is updated.
 */
async function rcSyncFromNotes(accountId, meterMeta) {
  try {
    const notes = await ncGetByAccount(accountId);
    for (const n of notes) {
      const nj = n.note_json || {};
      if (nj.type !== 'reading') continue;
      const r = nj.reading || {};
      await rcPut({
        note_id:        n.note_id,
        account_id:     accountId,
        reading_time:   n.timestamp || new Date().toISOString(),
        route_number:   meterMeta.route_number  || '',
        village:        meterMeta.village        || '',
        account_number: meterMeta.account_number || '',
        meter_number:   meterMeta.meter_number   || '',
        kwh:            r.kwh       ?? null,
        kw:             r.kw        ?? null,
        kvarh_lag:      r.kvarh_lag ?? null,
        kvarh_led:      r.kvarh_led ?? null,
        is_synced:      n.is_synced ?? 0,
      });
    }
  } catch { /* silent */ }
}
