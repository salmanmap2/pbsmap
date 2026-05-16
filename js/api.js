/**
 * PBS Map — API Client
 * Wraps all backend calls to http://localhost:8080
 */

const API_BASE = (typeof CONFIG !== 'undefined' ? CONFIG.API_BASE : null) || 'http://localhost:8080';

/**
 * Runtime API base override — set by loadOfficeMap when office_info_json.server is present.
 * Falls back to API_BASE (from config.js) if not set.
 */
let _runtimeApiBase = null;

function setRuntimeApiBase(url) {
  _runtimeApiBase = url ? url.replace(/\/+$/, '') : null;
}

function getEffectiveApiBase() {
  return _runtimeApiBase || API_BASE;
}

/**
 * Core fetch wrapper
 * @param {string} path
 * @param {object} options
 * @param {string|null} token  - JWT token (optional)
 */
async function apiFetch(path, options = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${getEffectiveApiBase()}${path}`, {
    ...options,
    headers,
  });

  let body;
  try { body = await res.json(); }
  catch { body = { success: false, message: 'সার্ভার থেকে সাড়া পাওয়া যায়নি।' }; }

  if (!res.ok && !body.message) {
    body.message = `HTTP ${res.status}`;
  }
  return body;
}

/* ══════════════════════════════════════════════
   AUTH
   ══════════════════════════════════════════════ */

const Auth = {
  signup(email, password, full_name) {
    return apiFetch('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, full_name }),
    });
  },

  login(identifier, password) {
    return apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    });
  },

  googleLogin(google_token) {
    return apiFetch('/api/auth/login/google', {
      method: 'POST',
      body: JSON.stringify({ google_token }),
    });
  },

  forgotPassword(email) {
    return apiFetch('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  },

  verifyOtp(email, otp) {
    return apiFetch('/api/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ email, otp }),
    });
  },

  resetPassword(email, otp, new_password) {
    return apiFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ email, otp, new_password }),
    });
  },
};

/* ══════════════════════════════════════════════
   USER
   ══════════════════════════════════════════════ */

const User = {
  getProfile(token) {
    return apiFetch('/api/user/profile', { method: 'GET' }, token);
  },

  updateProfile(token, data) {
    return apiFetch('/api/user/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }, token);
  },

  changePassword(token, old_password, new_password) {
    return apiFetch('/api/user/change-password', {
      method: 'POST',
      body: JSON.stringify({ old_password, new_password }),
    }, token);
  },

  regenerateApiKey(token) {
    return apiFetch('/api/user/regenerate-api-key', { method: 'POST' }, token);
  },

  joinOffice(token, office_id) {
    return apiFetch('/api/user/join-office', {
      method: 'POST',
      body: JSON.stringify({ office_id }),
    }, token);
  },
};

/* ══════════════════════════════════════════════
   PUBLIC
   ══════════════════════════════════════════════ */

const Public = {
  getPbsList() {
    return apiFetch('/api/public/pbs-list', { method: 'GET' });
  },

  getOfficesByPbs(pbs_id) {
    return apiFetch(`/api/public/offices/${pbs_id}`, { method: 'GET' });
  },

  getOfficeById(office_id) {
    return apiFetch(`/api/public/office/${office_id}`, { method: 'GET' });
  },
};

/* ══════════════════════════════════════════════
   METER
   ══════════════════════════════════════════════ */

const Meter = {
  add(token, data) {
    return apiFetch('/api/meter/add', {
      method: 'POST',
      body: JSON.stringify(data),
    }, token);
  },

  edit(token, data) {
    return apiFetch('/api/meter/edit', {
      method: 'POST',
      body: JSON.stringify(data),
    }, token);
  },

  getAll(token, office_id, last_time = null) {
    const body = { office_id };
    if (last_time) body.last_time = last_time;
    return apiFetch('/api/meter/all', {
      method: 'POST',
      body: JSON.stringify(body),
    }, token);
  },
};

/* ══════════════════════════════════════════════
   NOTE
   ══════════════════════════════════════════════ */

const Note = {
  /** GET all notes for an account — supports incremental sync via last_time */
  getAll(token, account_id, last_time = null) {
    const body = { account_id };
    if (last_time) body.last_time = last_time;
    return apiFetch('/api/note/all', {
      method: 'POST',
      body: JSON.stringify(body),
    }, token);
  },

  /** POST add a note */
  add(token, account_id, note_json) {
    return apiFetch('/api/note/add', {
      method: 'POST',
      body: JSON.stringify({ account_id, note_json }),
    }, token);
  },

  /** POST delete a note */
  delete(token, note_id) {
    return apiFetch('/api/note/delete', {
      method: 'POST',
      body: JSON.stringify({ note_id }),
    }, token);
  },
};

/* ══════════════════════════════════════════════
   OFFICE ADMIN
   ══════════════════════════════════════════════ */

const Office = {
  /** Approve pending user → assign role */
  approveUser(token, office_id, username, role) {
    return apiFetch('/api/office/user-change', {
      method: 'POST',
      body: JSON.stringify({ office_id, approve_username: username, approve_role: role }),
    }, token);
  },

  /** Add user to a role (removes from all other roles first) */
  addUser(token, office_id, username, role) {
    return apiFetch('/api/office/user-change', {
      method: 'POST',
      body: JSON.stringify({ office_id, add_username: username, role }),
    }, token);
  },

  /** Remove user from a role */
  removeUser(token, office_id, username, role) {
    return apiFetch('/api/office/user-change', {
      method: 'POST',
      body: JSON.stringify({ office_id, remove_username: username, remove_role: role }),
    }, token);
  },
};
