/**
 * PBS Map — Home / Map Page
 */

let _session   = null;
let _profile   = null;
let _map       = null;
let _tileLayer = null;
let _mapTileColor = '#aadaff'; // tracks current tile bg color

/* ══ INIT ══ */
async function initApp() {
  _session = await getSession();
  if (!_session || !_session.token) {
    window.location.replace('login.html');
    return;
  }

  // Load cached profile for avatar
  _profile = await getProfileCache();
  if (_profile) applyAvatarAndBadge(_profile);

  // Fetch fresh profile
  try {
    const res = await User.getProfile(_session.token);
    if (res.success && res.data) {
      _profile = res.data;
      if (typeof _profile.user_json === 'string') {
        try { _profile.user_json = JSON.parse(_profile.user_json); } catch { _profile.user_json = {}; }
      }
      await saveProfileCache(_profile);
      await saveSession({
        token:         _session.token,
        username:      _profile.username,
        email:         _profile.email,
        user_json:     _profile.user_json     || {},
        active_office: _profile.active_office || null,
        user_api_key:  _profile.user_api_key  || '',
      });
      _session = await getSession();
      applyAvatarAndBadge(_profile);
    } else if (!res.success) {
      await clearSession();
      window.location.replace('login.html');
      return;
    }
  } catch (e) {
    console.warn('Profile fetch failed (offline?):', e.message);
  }

  initMap();
  attachOfficeSelectListener();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function applyAvatarAndBadge(profile) {
  const uj     = (typeof profile.user_json === 'string') ? tryParse(profile.user_json) : (profile.user_json || {});
  const picUrl = uj.profile_pic_url || '';
  const thumb  = document.getElementById('profileAvatarThumb');
  if (thumb) {
    thumb.src = picUrl || 'img/default-avatar.svg';
    thumb.onerror = () => { thumb.src = 'img/default-avatar.svg'; thumb.onerror = null; };
  }
  // Dropdown username
  const fullName = uj.full_name || profile.username || '';
  const pdUser = document.getElementById('pdUsername');
  if (pdUser) pdUser.textContent = fullName;

  if (profile.active_office) {
    loadOfficeBadge(profile.active_office);
    updateActiveOfficeBadgeInDropdown(profile.active_office);
    checkAdminRole(profile.active_office);
  }
}

/* ══ MAP ══ */
function initMap() {
  _map = L.map('map', {
    center:      [23.8103, 90.4125],
    zoom:        12,
    zoomControl: false,
    tap:         false,   // Leaflet tap handler বন্ধ — mobile touch conflict এড়াতে
    tapTolerance: 15,
  });

  _tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxNativeZoom: 19,
    maxZoom: 19,
  }).addTo(_map);

  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.style.background = '#aadaff';

  // ── Hold to show lat/lng ──────────────────────────────────────
  initLatLngHold(_map);

  // ── Map click → fill location field when in click-mode ────────
  _map.on('click', _amHandleMapClick);

  // ── Zoom indicator + pin resize ───────────────────────────────
  _map.on('zoomend', () => {
    _amRefreshPinSizes();
    const zi = document.getElementById('zoomIndicator');
    if (zi) zi.textContent = 'Z: ' + _map.getZoom();
  });

  setTimeout(hideMapLoader, 1500);

  if (_session && _session.active_office) {
    loadOfficeMap(_session.active_office);
  } else {
    hideMapLoader();
    document.getElementById('noOfficeOverlay').classList.remove('hidden');
  }
}

/* ══ LOCATE ME ══ */
let _locateMarker  = null;  // pulsing dot marker
let _locateWatcher = null;  // watchPosition ID

function locateMe() {
  if (!navigator.geolocation) {
    showToast('❌ এই ব্রাউজারে Geolocation সাপোর্ট নেই।');
    return;
  }

  const btn = document.getElementById('fabLocate');

  // Toggle off — watcher চলছে, বন্ধ করো
  if (_locateWatcher !== null) {
    navigator.geolocation.clearWatch(_locateWatcher);
    _locateWatcher = null;
    if (_locateMarker) { _locateMarker.remove(); _locateMarker = null; }
    if (btn) btn.classList.remove('active');
    return;
  }

  // Permission চাও এবং watcher শুরু করো
  if (btn) btn.classList.add('active');
  showToast('📍 লোকেশন খোঁজা হচ্ছে…');

  _locateWatcher = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lng } = pos.coords;

      // প্রথমবার → map সেখানে fly করো
      if (!_locateMarker) {
        _map.flyTo([lat, lng], 16, { duration: 1.4 });
      } else {
        _locateMarker.setLatLng([lat, lng]);
      }

      // Pulsing dot তৈরি বা update করো
      if (!_locateMarker) {
        const dotIcon = L.divIcon({
          className: '',
          html: '<div class="user-location-dot"></div>',
          iconSize:   [16, 16],
          iconAnchor: [8, 8],
        });
        _locateMarker = L.marker([lat, lng], { icon: dotIcon, zIndexOffset: 1000, interactive: false })
          .addTo(_map);
      }
    },
    (err) => {
      if (btn) btn.classList.remove('active');
      _locateWatcher = null;
      if (_locateMarker) { _locateMarker.remove(); _locateMarker = null; }
      const msgs = {
        1: '❌ লোকেশন পারমিশন দেওয়া হয়নি।',
        2: '❌ লোকেশন নির্ধারণ করা যাচ্ছে না।',
        3: '❌ লোকেশন timeout হয়েছে।',
      };
      showToast(msgs[err.code] || '❌ লোকেশন পাওয়া যায়নি।');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

/* ── Lat/Lng on hold ── */
function initLatLngHold(map) {
  let _holdTimer   = null;
  let _holdTooltip = null;
  const HOLD_MS    = 400; // ms before showing

  function showTooltip(latlng, containerPoint) {
    if (!_holdTooltip) {
      _holdTooltip = document.createElement('div');
      _holdTooltip.id = 'latlngTooltip';
      document.getElementById('map').appendChild(_holdTooltip);
    }
    _holdTooltip.textContent =
      `${latlng.lat.toFixed(6)},  ${latlng.lng.toFixed(6)}`;
    // Position near cursor, offset so it doesn't sit under the finger
    _holdTooltip.style.left = (containerPoint.x + 14) + 'px';
    _holdTooltip.style.top  = (containerPoint.y - 38) + 'px';
    _holdTooltip.classList.add('visible');
  }

  function hideTooltip() {
    if (_holdTooltip) _holdTooltip.classList.remove('visible');
    clearTimeout(_holdTimer);
    _holdTimer = null;
  }

  // Mouse
  map.on('mousedown', e => {
    _holdTimer = setTimeout(() => showTooltip(e.latlng, e.containerPoint), HOLD_MS);
  });
  map.on('mouseup mousemove', hideTooltip);

  // Touch (mobile)
  map.on('touchstart', e => {
    if (e.originalEvent.touches.length !== 1) return;
    const touch = e.originalEvent.touches[0];
    _holdTimer = setTimeout(() => {
      const latlng = map.containerPointToLatLng(
        L.point(touch.clientX - map.getContainer().getBoundingClientRect().left,
                touch.clientY - map.getContainer().getBoundingClientRect().top)
      );
      showTooltip(latlng, L.point(
        touch.clientX - map.getContainer().getBoundingClientRect().left,
        touch.clientY - map.getContainer().getBoundingClientRect().top
      ));
    }, HOLD_MS);
  });
  map.on('touchend touchmove', hideTooltip);
}

function hideMapLoader() {
  const el = document.getElementById('mapLoader');
  if (!el || el.classList.contains('hidden')) return;
  el.classList.add('fade-out');
  setTimeout(() => el.classList.add('hidden'), 400);
}

async function loadOfficeBadge(officeId) {
  try {
    const res = await Public.getOfficeById(officeId);
    if (res.success && res.data) {
      const bn = document.getElementById('officeBadgeName');
      const b  = document.getElementById('officeBadge');
      if (bn) bn.textContent = res.data.office_name;
      if (b)  b.classList.remove('hidden');
    }
  } catch (e) { /* silent */ }
}

async function geocodeArea(areaName) {
  try {
    const res  = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(areaName + ', Bangladesh')}&format=json&limit=1`);
    const data = await res.json();
    if (data && data.length > 0) _map.setView([parseFloat(data[0].lat), parseFloat(data[0].lon)], 12);
  } catch (e) { /* silent */ }
}

/* ══ JOIN OFFICE MODAL ══ */
async function openJoinModal() {
  document.getElementById('joinModalBackdrop').classList.remove('hidden');
  document.getElementById('joinModal').classList.remove('hidden');
  document.getElementById('joinAlert').className = 'alert hidden';
  await loadPbsList();
}
function closeJoinModal() {
  document.getElementById('joinModalBackdrop').classList.add('hidden');
  document.getElementById('joinModal').classList.add('hidden');
}

async function loadPbsList() {
  const sel = document.getElementById('pbsSelect');
  sel.innerHTML = '<option value="">লোড হচ্ছে…</option>';
  try {
    let list = await getPbsCache();
    if (!list) { const r = await Public.getPbsList(); if (r.success) { list = r.data; await savePbsCache(list); } }
    sel.innerHTML = '<option value="">— PBS বেছে নিন —</option>';
    (list || []).forEach(p => {
      const o = document.createElement('option');
      o.value = p.pbs_id; o.textContent = `${p.pbs_name} (${p.pbs_id})`;
      sel.appendChild(o);
    });
  } catch (e) { sel.innerHTML = '<option value="">লোড ব্যর্থ হয়েছে</option>'; }
}

async function loadOffices() {
  const pbsId = document.getElementById('pbsSelect').value;
  const oSel  = document.getElementById('officeSelect');
  const prev  = document.getElementById('officePreview');
  prev.classList.add('hidden');
  oSel.disabled = true;
  oSel.innerHTML = '<option value="">লোড হচ্ছে…</option>';
  if (!pbsId) { oSel.innerHTML = '<option value="">— প্রথমে PBS বেছে নিন —</option>'; return; }
  try {
    let offices = await getOfficesCache(pbsId);
    if (!offices) { const r = await Public.getOfficesByPbs(pbsId); if (r.success) { offices = r.data; await saveOfficesCache(pbsId, offices); } }
    oSel.innerHTML = '<option value="">— অফিস বেছে নিন —</option>';
    oSel.disabled = false;
    (offices || []).forEach(office => {
      const ij = typeof office.office_info_json === 'string' ? tryParse(office.office_info_json) : (office.office_info_json || {});
      const o = document.createElement('option');
      o.value = office.office_id; o.textContent = office.office_name; o.dataset.area = ij.area || '';
      oSel.appendChild(o);
    });
    if (!offices || !offices.length) oSel.innerHTML = '<option value="">এই PBS-এ কোনো অফিস নেই</option>';
  } catch (e) { oSel.innerHTML = '<option value="">লোড ব্যর্থ হয়েছে</option>'; }
}

function attachOfficeSelectListener() {
  const sel = document.getElementById('officeSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const opt  = sel.options[sel.selectedIndex];
    const prev = document.getElementById('officePreview');
    if (opt && opt.value) {
      document.getElementById('opName').textContent = opt.textContent;
      document.getElementById('opArea').textContent = opt.dataset.area || '';
      prev.classList.remove('hidden');
    } else { prev.classList.add('hidden'); }
  });
}

async function submitJoinRequest() {
  const officeId = document.getElementById('officeSelect').value;
  const alertEl  = document.getElementById('joinAlert');
  alertEl.className = 'alert hidden';
  if (!officeId) { alertEl.className = 'alert alert-error'; alertEl.textContent = 'একটি অফিস বেছে নিন।'; alertEl.classList.remove('hidden'); return; }

  const joinBtn = document.getElementById('joinBtn');
  const btnText = document.getElementById('joinBtnText');
  const loader  = document.getElementById('joinLoader');
  joinBtn.disabled = true; btnText.style.opacity = '0'; loader.classList.remove('hidden');

  try {
    const res = await User.joinOffice(_session.token, officeId);
    if (res.success) {
      alertEl.className = 'alert alert-success';
      alertEl.textContent = res.message || '✅ অনুরোধ পাঠানো হয়েছে। অ্যাডমিনের অনুমোদনের জন্য অপেক্ষা করুন।';
      alertEl.classList.remove('hidden');
      setTimeout(closeJoinModal, 2500);
    } else {
      alertEl.className = 'alert alert-error';
      alertEl.textContent = res.message || 'অনুরোধ পাঠানো ব্যর্থ হয়েছে।';
      alertEl.classList.remove('hidden');
    }
  } catch (e) {
    alertEl.className = 'alert alert-error'; alertEl.textContent = 'সার্ভারের সাথে সংযোগ করা যাচ্ছে না।'; alertEl.classList.remove('hidden');
  } finally {
    joinBtn.disabled = false; btnText.style.opacity = '1'; loader.classList.add('hidden');
  }
}

/* ══ UTILS ══ */
function tryParse(str) { try { return JSON.parse(str); } catch { return {}; } }

/* ══ PROFILE DROPDOWN ══ */
function toggleProfileDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('profileDropdown');
  dd.classList.toggle('hidden');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('profileWrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('profileDropdown').classList.add('hidden');
  }
});

function goToProfile() {
  openProfilePanel();
}

async function doLogout() {
  if (typeof setRuntimeApiBase === 'function') setRuntimeApiBase(null);
  await clearSession();
  window.location.replace('login.html');
}

/* ══ DARK MODE ══ */
function initDarkMode() {
  const saved = localStorage.getItem('pbsmap_dark');
  const isDark = saved === null ? true : saved === 'true'; // default dark
  applyDarkMode(isDark);
}

function toggleDarkMode() {
  const isDark = document.body.classList.contains('dark-mode');
  applyDarkMode(!isDark);
  localStorage.setItem('pbsmap_dark', String(!isDark));
}

function applyDarkMode(isDark) {
  document.body.classList.toggle('dark-mode', isDark);
  const toggle = document.getElementById('darkModeToggle');
  if (toggle) toggle.classList.toggle('on', isDark);
}

// Init dark mode on load
initDarkMode();

/* ══════════════════════════════════════════════
   PROFILE PANEL
   ══════════════════════════════════════════════ */

let _pfEditMode = false;

/* ── Open / Close ── */
function openProfilePanel() {
  document.getElementById('profileDropdown').classList.add('hidden');
  document.getElementById('pfPanel').classList.remove('hidden');
  document.getElementById('pfPanelBackdrop').classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Render from cache immediately, then refresh
  if (_profile) renderProfile(_profile);
  refreshProfilePanel();
}

function closeProfilePanel() {
  document.getElementById('pfPanel').classList.add('hidden');
  document.getElementById('pfPanelBackdrop').classList.add('hidden');
  document.body.style.overflow = '';
  // Exit edit mode if open
  if (_pfEditMode) toggleEditMode();
}

async function refreshProfilePanel() {
  try {
    const res = await User.getProfile(_session.token);
    if (res.success && res.data) {
      _profile = res.data;
      if (typeof _profile.user_json === 'string') {
        try { _profile.user_json = JSON.parse(_profile.user_json); } catch { _profile.user_json = {}; }
      }
      await saveProfileCache(_profile);
      renderProfile(_profile);
      applyAvatarAndBadge(_profile);
    }
  } catch (e) { /* silent — use cached */ }
}

/* ── Render ── */
function renderProfile(p) {
  const uj = (typeof p.user_json === 'string') ? pfTryParse(p.user_json) : (p.user_json || {});

  const fullName    = uj.full_name       || p.username || '—';
  const designation = uj.designation     || '—';
  const picUrl      = uj.profile_pic_url || '';
  const mobile      = p.mobile_number    || '—';
  const email       = p.email            || '—';
  const whatsapp    = uj.whatsapp        || '—';
  const pbsName     = uj.pbs_name        || '—';
  const officeName  = uj.office_name     || '—';
  const facebook    = uj.facebook        || '';

  pfSetAvatar(picUrl);
  pfSetEl('pfName',        fullName);
  pfSetEl('pfDesigBadge',  designation !== '—' ? designation : 'পদবী নেই');
  pfSetEl('pfOfficeLabel', officeName !== '—' ? officeName : (pbsName !== '—' ? pbsName : 'অফিস নেই'));
  pfSetVal('pfUsername',   p.username || '');
  pfSetVal('pfApiKey',     p.user_api_key || '');

  pfSetEl('dispFullName',    fullName);
  pfSetEl('dispDesignation', designation);
  pfSetEl('dispPbsName',     pbsName);
  pfSetEl('dispOfficeName',  officeName);
  pfSetEl('dispMobile',      mobile);
  pfSetEl('dispEmail',       email);
  pfSetEl('dispWhatsapp',    whatsapp);

  if (facebook) {
    pfSetEl('dispFacebook', 'View Profile');
    const link = document.getElementById('facebookLink');
    if (link) { link.href = facebook; link.classList.remove('hidden'); }
  } else {
    pfSetEl('dispFacebook', '—');
    const link = document.getElementById('facebookLink');
    if (link) link.classList.add('hidden');
  }

  pfSetVal('editFullName',    fullName    !== '—' ? fullName    : '');
  pfSetVal('editDesignation', designation !== '—' ? designation : '');
  pfSetVal('editPbsName',     pbsName     !== '—' ? pbsName     : '');
  pfSetVal('editOfficeName',  officeName  !== '—' ? officeName  : '');
  pfSetVal('editMobile',      mobile      !== '—' ? mobile      : '');
  pfSetVal('editWhatsapp',    whatsapp    !== '—' ? whatsapp    : '');
  pfSetVal('editFacebook',    facebook);
}

/* ── Edit Mode ── */
function toggleEditMode() {
  _pfEditMode = !_pfEditMode;
  const btn     = document.getElementById('editToggleBtn');
  const saveRow = document.getElementById('pfSaveRow');
  const alertEl = document.getElementById('profileSaveAlert');

  btn.classList.toggle('active', _pfEditMode);
  saveRow.classList.toggle('hidden', !_pfEditMode);
  if (!_pfEditMode && alertEl) { alertEl.className = 'alert hidden'; }

  const fields = [
    ['dispFullName','editFullName'], ['dispDesignation','editDesignation'],
    ['dispPbsName','editPbsName'],   ['dispOfficeName','editOfficeName'],
    ['dispMobile','editMobile'],     ['dispWhatsapp','editWhatsapp'],
    ['dispFacebook','editFacebook'],
  ];
  fields.forEach(([dId, eId]) => {
    const d = document.getElementById(dId);
    const e = document.getElementById(eId);
    if (d) d.classList.toggle('hidden', _pfEditMode);
    if (e) e.classList.toggle('hidden', !_pfEditMode);
  });
  const fbLink = document.getElementById('facebookLink');
  if (fbLink) fbLink.classList.toggle('hidden', _pfEditMode);
}

/* ── Save Profile ── */
async function saveProfile() {
  const fullName    = document.getElementById('editFullName')?.value.trim()    || '';
  const designation = document.getElementById('editDesignation')?.value.trim() || '';
  const pbsName     = document.getElementById('editPbsName')?.value.trim()     || '';
  const officeName  = document.getElementById('editOfficeName')?.value.trim()  || '';
  const mobile      = document.getElementById('editMobile')?.value.trim()      || '';
  const whatsapp    = document.getElementById('editWhatsapp')?.value.trim()    || '';
  const facebook    = document.getElementById('editFacebook')?.value.trim()    || '';

  const alertEl   = document.getElementById('profileSaveAlert');
  const btnText   = document.getElementById('pfSaveBtnText');
  const btnLoader = document.getElementById('pfSaveLoader');

  alertEl.className = 'alert hidden';
  btnText.style.opacity = '0';
  btnLoader.classList.remove('hidden');

  try {
    const payload = {};
    if (fullName)    payload.full_name     = fullName;
    if (mobile)      payload.mobile_number = mobile;
    if (designation) payload.designation   = designation;
    if (pbsName)     payload.pbs_name      = pbsName;
    if (officeName)  payload.office_name   = officeName;
    if (whatsapp)    payload.whatsapp      = whatsapp;
    payload.facebook = facebook;

    const res = await User.updateProfile(_session.token, payload);

    if (res.success) {
      if (_profile) {
        if (!_profile.user_json || typeof _profile.user_json === 'string') {
          _profile.user_json = pfTryParse(_profile.user_json || '{}');
        }
        if (fullName)    _profile.user_json.full_name    = fullName;
        if (designation) _profile.user_json.designation  = designation;
        if (pbsName)     _profile.user_json.pbs_name     = pbsName;
        if (officeName)  _profile.user_json.office_name  = officeName;
        if (whatsapp)    _profile.user_json.whatsapp     = whatsapp;
        _profile.user_json.facebook = facebook;
        if (mobile)      _profile.mobile_number = mobile;
        await saveProfileCache(_profile);
      }
      alertEl.className = 'alert pf-alert-success';
      alertEl.textContent = '✅ তথ্য সফলভাবে সংরক্ষিত হয়েছে।';
      renderProfile(_profile);
      applyAvatarAndBadge(_profile);
      if (_pfEditMode) toggleEditMode();
    } else {
      alertEl.className = 'alert pf-alert-error';
      alertEl.textContent = res.message || 'তথ্য সংরক্ষণ ব্যর্থ হয়েছে।';
    }
  } catch (e) {
    alertEl.className = 'alert pf-alert-error';
    alertEl.textContent = 'সার্ভারের সাথে সংযোগ করা যাচ্ছে না।';
  } finally {
    btnText.style.opacity = '1';
    btnLoader.classList.add('hidden');
  }
}

/* ── Avatar ── */
function pfSetAvatar(url) {
  const el = document.getElementById('pfAvatar');
  if (!el) return;
  el.src = url || 'img/default-avatar.svg';
  el.onerror = () => { el.src = 'img/default-avatar.svg'; el.onerror = null; };
}

async function uploadToImgBB(file) {
  const apiKey = (typeof CONFIG !== 'undefined') ? CONFIG.IMGBB_API_KEY : null;
  if (!apiKey || apiKey === 'YOUR_IMGBB_API_KEY') {
    throw new Error('ImgBB API key সেট করা নেই। config.js ফাইলে IMGBB_API_KEY যোগ করুন।');
  }
  const formData = new FormData();
  formData.append('image', file);
  const res  = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, { method: 'POST', body: formData });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || 'ছবি আপলোড ব্যর্থ হয়েছে।');
  return data.data.url;
}

async function handleAvatarChange(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('⚠️ ছবির আকার ৫MB এর বেশি হওয়া যাবে না।'); return; }

  pfSetAvatar(URL.createObjectURL(file));
  showToast('⏳ ছবি আপলোড হচ্ছে…');

  const avatarInput = document.getElementById('avatarInput');
  const overlay     = document.getElementById('avatarUploadOverlay');
  if (avatarInput) avatarInput.disabled = true;
  if (overlay)     overlay.classList.remove('hidden');

  try {
    const hostedUrl = await uploadToImgBB(file);
    const res = await User.updateProfile(_session.token, { profile_pic_url: hostedUrl });
    if (!res.success) throw new Error(res.message || 'প্রোফাইল আপডেট ব্যর্থ।');

    if (_profile) {
      if (!_profile.user_json || typeof _profile.user_json === 'string') {
        _profile.user_json = pfTryParse(_profile.user_json || '{}');
      }
      _profile.user_json.profile_pic_url = hostedUrl;
      await saveProfileCache(_profile);
    }
    pfSetAvatar(hostedUrl);
    applyAvatarAndBadge(_profile);
    showToast('✅ প্রোফাইল ছবি সফলভাবে আপডেট হয়েছে।');
  } catch (e) {
    pfSetAvatar(_profile?.user_json?.profile_pic_url || '');
    showToast('❌ ' + e.message);
  } finally {
    if (overlay)     overlay.classList.add('hidden');
    if (avatarInput) { avatarInput.disabled = false; avatarInput.value = ''; }
  }
}

/* ── Call / WhatsApp ── */
function pfDoCall() {
  const mobile = _profile && _profile.mobile_number;
  if (mobile && mobile !== '—') { window.location.href = `tel:${mobile}`; }
  else showToast('মোবাইল নম্বর যোগ করুন।');
}
function pfDoWhatsApp() {
  const uj = (_profile && _profile.user_json) ? _profile.user_json : {};
  const wa = uj.whatsapp || (_profile && _profile.mobile_number);
  if (wa && wa !== '—') {
    const num = wa.replace(/\D/g, '');
    window.open(`https://wa.me/${num.startsWith('0') ? '88' + num : num}`, '_blank');
  } else showToast('WhatsApp নম্বর যোগ করুন।');
}

/* ── API Key ── */
async function pfRegenerateApiKey() {
  if (!confirm('নতুন API Key তৈরি করলে পুরনো key অকার্যকর হয়ে যাবে। নিশ্চিত?')) return;
  try {
    const res = await User.regenerateApiKey(_session.token);
    if (res.success) {
      pfSetVal('pfApiKey', res.data.user_api_key);
      await saveSession({ ..._session, user_api_key: res.data.user_api_key });
      _session = await getSession();
      showToast('✅ নতুন API Key তৈরি হয়েছে।');
    } else showToast('❌ ' + (res.message || 'API Key পরিবর্তন ব্যর্থ।'));
  } catch (e) { showToast('❌ সার্ভারের সাথে সংযোগ করা যাচ্ছে না।'); }
}

/* ── Copy ── */
function pfCopyVal(inputId) {
  const el = document.getElementById(inputId);
  if (!el || !el.value) return;
  navigator.clipboard.writeText(el.value)
    .then(() => showToast('📋 কপি হয়েছে!'))
    .catch(() => { el.select(); document.execCommand('copy'); showToast('📋 কপি হয়েছে!'); });
}

/* ── Password Modal ── */
function openPasswordModal() {
  document.getElementById('pwModalBackdrop').classList.remove('hidden');
  document.getElementById('pwModal').classList.remove('hidden');
  const alertEl = document.getElementById('pwAlert');
  if (alertEl) alertEl.className = 'alert hidden';
  ['oldPassword','newPassword','confirmPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.type = 'password'; }
  });
  // Reset eye buttons
  document.querySelectorAll('#pwModal .eye-btn').forEach(btn => btn.textContent = '👁');
}
function closePasswordModal() {
  document.getElementById('pwModalBackdrop').classList.add('hidden');
  document.getElementById('pwModal').classList.add('hidden');
}

async function changePassword() {
  const oldPw   = document.getElementById('oldPassword').value;
  const newPw   = document.getElementById('newPassword').value;
  const confPw  = document.getElementById('confirmPassword').value;
  const alertEl = document.getElementById('pwAlert');
  const btn     = document.getElementById('changePwBtn');
  const btnText = document.getElementById('changePwBtnText');
  const loader  = document.getElementById('changePwLoader');

  alertEl.className = 'alert hidden';

  if (!oldPw || !newPw || !confPw) {
    alertEl.className = 'alert alert-error'; alertEl.textContent = 'সকল তথ্য পূরণ করুন।'; return;
  }
  if (newPw !== confPw) {
    alertEl.className = 'alert alert-error'; alertEl.textContent = 'নতুন পাসওয়ার্ড দুটি মিলছে না।'; return;
  }
  if (newPw.length < 6) {
    alertEl.className = 'alert alert-error'; alertEl.textContent = 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'; return;
  }

  btn.disabled = true; btnText.style.opacity = '0'; loader.classList.remove('hidden');

  try {
    const res = await User.changePassword(_session.token, oldPw, newPw);
    if (res.success) {
      showToast('✅ পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে।');
      closePasswordModal();
    } else {
      alertEl.className = 'alert alert-error';
      alertEl.textContent = res.message || 'পাসওয়ার্ড পরিবর্তন ব্যর্থ হয়েছে।';
    }
  } catch (e) {
    alertEl.className = 'alert alert-error';
    alertEl.textContent = 'সার্ভারের সাথে সংযোগ করা যাচ্ছে না।';
  } finally {
    btn.disabled = false; btnText.style.opacity = '1'; loader.classList.add('hidden');
  }
}

/* ── Toggle password visibility ── */
function pfTogglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? '👁' : '🙈';
}

/* ── Toast ── */
function showToast(msg, duration = 2500) {
  let t = document.getElementById('_toast');
  if (!t) {
    t = document.createElement('div'); t.id = '_toast';
    Object.assign(t.style, {
      position:'fixed', bottom:'24px', left:'50%', transform:'translateX(-50%)',
      background:'rgba(22,27,34,.95)', color:'#e6edf3',
      padding:'10px 20px', borderRadius:'999px', fontSize:'13px', fontWeight:'500',
      zIndex:'9999', boxShadow:'0 4px 20px rgba(0,0,0,.5)',
      border:'1px solid rgba(255,255,255,.1)', backdropFilter:'blur(8px)',
      transition:'opacity .3s ease', whiteSpace:'nowrap', fontFamily:'Inter, sans-serif',
    });
    document.body.appendChild(t);
  }
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; }, duration);
}

/* ── Utils ── */
function pfSetEl(id, text)  { const el = document.getElementById(id); if (el) el.textContent = text; }
function pfSetVal(id, val)  { const el = document.getElementById(id); if (el) el.value = val; }
function pfTryParse(str)    { try { return JSON.parse(str); } catch { return {}; } }

/* ══════════════════════════════════════════════
   ACTIVE OFFICE PANEL
   ══════════════════════════════════════════════ */

let _aoSelectedOffice = null; // currently selected office object in panel

/* ── Dropdown badge ── */
async function updateActiveOfficeBadgeInDropdown(officeId) {
  const badge = document.getElementById('pdActiveOfficeBadge');
  if (!badge) return;
  if (!officeId) { badge.classList.add('hidden'); return; }
  try {
    const res = await Public.getOfficeById(officeId);
    if (res.success && res.data) {
      // Show short name (first word or first 10 chars)
      const name = res.data.office_name || officeId;
      badge.textContent = name.length > 12 ? name.slice(0, 11) + '…' : name;
      badge.classList.remove('hidden');
    }
  } catch { badge.classList.add('hidden'); }
}

/* ── Open / Close ── */
async function openActiveOfficePanel() {
  document.getElementById('profileDropdown').classList.add('hidden');
  document.getElementById('aoPanelBackdrop').classList.remove('hidden');
  document.getElementById('aoPanel').classList.remove('hidden');

  // Reset state
  _aoSelectedOffice = null;
  document.getElementById('aoOfficePreview').classList.add('hidden');
  const alertEl = document.getElementById('aoAlert');
  alertEl.classList.add('hidden');
  alertEl.textContent = '';

  // Show current active office
  await aoRenderCurrentOffice();

  // Load PBS list
  await aoLoadPbsList();
}

function closeActiveOfficePanel() {
  document.getElementById('aoPanelBackdrop').classList.add('hidden');
  document.getElementById('aoPanel').classList.add('hidden');
}

/* ── Current office display ── */
async function aoRenderCurrentOffice() {
  const nameEl = document.getElementById('aoCurrentName');
  const pbsEl  = document.getElementById('aoCurrentPbs');
  const officeId = _session && _session.active_office;

  if (!officeId) {
    nameEl.textContent = 'কোনো অফিস সেট করা নেই';
    pbsEl.textContent  = '';
    return;
  }
  nameEl.textContent = officeId;
  pbsEl.textContent  = '';
  try {
    const res = await Public.getOfficeById(officeId);
    if (res.success && res.data) {
      nameEl.textContent = res.data.office_name;
      // Get PBS name
      const pbsId = res.data.pbs_id;
      let pbsList = await getPbsCache();
      if (!pbsList) {
        const pr = await Public.getPbsList();
        if (pr.success) { pbsList = pr.data; await savePbsCache(pbsList); }
      }
      if (pbsList) {
        const pbs = pbsList.find(p => p.pbs_id == pbsId);
        if (pbs) pbsEl.textContent = pbs.pbs_name;
      }
    }
  } catch { /* silent */ }
}

/* ── PBS list ── */
async function aoLoadPbsList() {
  const sel = document.getElementById('aoPbsSelect');
  sel.innerHTML = '<option value="">লোড হচ্ছে…</option>';
  try {
    let list = await getPbsCache();
    if (!list) {
      const r = await Public.getPbsList();
      if (r.success) { list = r.data; await savePbsCache(list); }
    }
    sel.innerHTML = '<option value="">— PBS বেছে নিন —</option>';
    (list || []).forEach(p => {
      const o = document.createElement('option');
      o.value = p.pbs_id;
      o.textContent = `${p.pbs_name}`;
      sel.appendChild(o);
    });
  } catch {
    sel.innerHTML = '<option value="">লোড ব্যর্থ হয়েছে</option>';
  }
}

/* ── Office list by PBS ── */
async function aoLoadOffices() {
  const pbsId = document.getElementById('aoPbsSelect').value;
  const oSel  = document.getElementById('aoOfficeSelect');
  const preview = document.getElementById('aoOfficePreview');

  preview.classList.add('hidden');
  _aoSelectedOffice = null;
  oSel.disabled = true;
  oSel.innerHTML = '<option value="">লোড হচ্ছে…</option>';

  if (!pbsId) {
    oSel.innerHTML = '<option value="">— প্রথমে PBS বেছে নিন —</option>';
    return;
  }

  try {
    let offices = await getOfficesCache(pbsId);
    if (!offices) {
      const r = await Public.getOfficesByPbs(pbsId);
      if (r.success) { offices = r.data; await saveOfficesCache(pbsId, offices); }
    }
    oSel.innerHTML = '<option value="">— অফিস বেছে নিন —</option>';
    oSel.disabled = false;
    (offices || []).forEach(office => {
      const o = document.createElement('option');
      o.value = office.office_id;
      o.textContent = office.office_name;
      oSel.appendChild(o);
    });
    if (!offices || !offices.length) {
      oSel.innerHTML = '<option value="">এই PBS-এ কোনো অফিস নেই</option>';
    }
  } catch {
    oSel.innerHTML = '<option value="">লোড ব্যর্থ হয়েছে</option>';
  }
}

/* ── Office selected → check membership ── */
async function aoOfficeSelected() {
  const officeId = document.getElementById('aoOfficeSelect').value;
  const preview  = document.getElementById('aoOfficePreview');
  const alertEl  = document.getElementById('aoAlert');

  alertEl.classList.add('hidden');
  alertEl.textContent = '';

  if (!officeId) { preview.classList.add('hidden'); _aoSelectedOffice = null; return; }

  document.getElementById('aoPreviewName').textContent = '…';
  document.getElementById('aoPreviewArea').textContent = '';
  document.getElementById('aoPreviewStatus').textContent = '';
  document.getElementById('aoPreviewActions').innerHTML = '';
  preview.classList.remove('hidden');

  try {
    const res = await Public.getOfficeById(officeId);
    if (!res.success || !res.data) {
      document.getElementById('aoPreviewName').textContent = 'অফিস পাওয়া যায়নি';
      return;
    }

    _aoSelectedOffice = res.data;
    const office = res.data;
    const infoJson = typeof office.office_info_json === 'string'
      ? pfTryParse(office.office_info_json)
      : (office.office_info_json || {});
    const userJson = typeof office.office_user_json === 'string'
      ? pfTryParse(office.office_user_json)
      : (office.office_user_json || {});

    document.getElementById('aoPreviewName').textContent = office.office_name;
    document.getElementById('aoPreviewArea').textContent = infoJson.area || '';

    // Check membership
    const username = _session && _session.username;
    const allRoles = ['admin_users','editor_users','viewer_users','pending_users'];
    let memberRole = null;
    for (const role of allRoles) {
      if ((userJson[role] || []).includes(username)) {
        memberRole = role; break;
      }
    }

    const isActive = _session && _session.active_office === officeId;
    const statusEl  = document.getElementById('aoPreviewStatus');
    const actionsEl = document.getElementById('aoPreviewActions');

    if (memberRole) {
      const roleLabel = {
        admin_users:   '👑 Admin',
        editor_users:  '✏️ Editor',
        viewer_users:  '👁 Viewer',
        pending_users: '⏳ Pending (অনুমোদনের অপেক্ষায়)',
      }[memberRole] || memberRole;

      statusEl.innerHTML = `<span class="ao-status-badge ao-status-member">${roleLabel}</span>`;

      if (memberRole === 'pending_users') {
        actionsEl.innerHTML = `<p class="ao-pending-note">অ্যাডমিনের অনুমোদনের পরে এই অফিস activate করতে পারবেন।</p>`;
      } else if (isActive) {
        actionsEl.innerHTML = `<span class="ao-status-badge ao-status-active">✅ বর্তমানে Active</span>`;
      } else {
        actionsEl.innerHTML = `
          <button class="ao-btn ao-btn-activate" onclick="aoActivateOffice('${officeId}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            এই অফিস Activate করুন
          </button>`;
      }
    } else {
      statusEl.innerHTML = `<span class="ao-status-badge ao-status-none">সদস্য নন</span>`;
      actionsEl.innerHTML = `
        <button class="ao-btn ao-btn-join" onclick="aoJoinOffice('${officeId}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Join Request পাঠান
        </button>`;
    }
  } catch (e) {
    document.getElementById('aoPreviewName').textContent = 'লোড ব্যর্থ হয়েছে';
  }
}

/* ── Activate office ── */
async function aoActivateOffice(officeId) {
  const alertEl = document.getElementById('aoAlert');
  alertEl.classList.add('hidden');

  try {
    const res = await User.updateProfile(_session.token, { active_office: officeId });
    if (!res.success) throw new Error(res.message || 'Activate ব্যর্থ হয়েছে।');

    // Update session + profile cache
    _session.active_office = officeId;
    await saveSession(_session);
    if (_profile) {
      _profile.active_office = officeId;
      await saveProfileCache(_profile);
    }

    showToast('✅ অফিস Activate হয়েছে। Map লোড হচ্ছে…');
    closeActiveOfficePanel();

    // Reload map with new office
    await loadOfficeMap(officeId);
    updateActiveOfficeBadgeInDropdown(officeId);
    aoRenderCurrentOffice();

    // Re-render actions
    document.getElementById('aoPreviewActions').innerHTML =
      `<span class="ao-status-badge ao-status-active">✅ বর্তমানে Active</span>`;

  } catch (e) {
    alertEl.textContent = '❌ ' + e.message;
    alertEl.className = 'ao-alert ao-alert-error';
  }
}

/* ── Join office ── */
async function aoJoinOffice(officeId) {
  const alertEl   = document.getElementById('aoAlert');
  const actionsEl = document.getElementById('aoPreviewActions');
  alertEl.classList.add('hidden');

  const btn = actionsEl.querySelector('.ao-btn-join');
  if (btn) { btn.disabled = true; btn.textContent = 'পাঠানো হচ্ছে…'; }

  try {
    const res = await User.joinOffice(_session.token, officeId);
    if (res.success) {
      alertEl.textContent = '✅ Join request পাঠানো হয়েছে। অ্যাডমিনের অনুমোদনের জন্য অপেক্ষা করুন।';
      alertEl.className = 'ao-alert ao-alert-success';
      actionsEl.innerHTML = `<p class="ao-pending-note">⏳ অনুমোদনের অপেক্ষায়…</p>`;
      document.getElementById('aoPreviewStatus').innerHTML =
        `<span class="ao-status-badge ao-status-member">⏳ Pending</span>`;
    } else {
      alertEl.textContent = '⚠️ ' + (res.message || 'Join ব্যর্থ হয়েছে।');
      alertEl.className = 'ao-alert ao-alert-error';
      if (btn) { btn.disabled = false; btn.textContent = 'Join Request পাঠান'; }
    }
  } catch (e) {
    alertEl.textContent = '❌ সার্ভারের সাথে সংযোগ করা যাচ্ছে না।';
    alertEl.className = 'ao-alert ao-alert-error';
    if (btn) { btn.disabled = false; btn.textContent = 'Join Request পাঠান'; }
  }
}

/* ── Map tile loader ── */
async function loadOfficeMap(officeId) {
  try {
    const res = await Public.getOfficeById(officeId);
    if (!res.success || !res.data) {
      hideMapLoader();
      document.getElementById('noOfficeOverlay').classList.remove('hidden');
      return;
    }

    const office     = res.data;
    const officeName = office.office_name;
    const infoJson   = typeof office.office_info_json === 'string'
      ? tryParse(office.office_info_json)
      : (office.office_info_json || {});

    // ── Override API base from office server config ───────────────
    if (typeof setRuntimeApiBase === 'function') {
      setRuntimeApiBase(infoJson.server || null);
    }

    // ── Save office to IndexedDB cache ────────────────────────────
    saveOfficeCache(office).catch(() => {});

    const bn = document.getElementById('officeBadgeName');
    const b  = document.getElementById('officeBadge');
    if (bn) bn.textContent = officeName;
    if (b)  b.classList.remove('hidden');
    document.getElementById('noOfficeOverlay').classList.add('hidden');

    if (!_map) { hideMapLoader(); return; }

    // ── Clear old state ───────────────────────────────────────────
    if (_tileLayer) { _map.removeLayer(_tileLayer); _tileLayer = null; }
    _amPins.forEach(p => { if (p.marker && _map.hasLayer(p.marker)) _map.removeLayer(p.marker); });
    _amPins.length = 0;
    _map.setMinZoom(1);
    _map.setMaxZoom(23);
    _map.setMaxBounds(null);

    // ── Tile URL ──────────────────────────────────────────────────
    const tileUrl   = infoJson.map_tile_url || 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';
    const isGoogle  = tileUrl.includes('google.com');
    const hasSubdom = tileUrl.includes('{s}');
    const subdomains = hasSubdom ? (isGoogle ? ['0','1','2','3'] : 'abc') : '';

    // ── Auto-detect maxNativeZoom, then build tile layer ─────────
    // Start from config value or 19, test upward to find real max.
    // Map always allows zoom up to 22 (tiles stretch beyond nativeMax).
    const configNative = parseInt(infoJson.max_native_zoom) || 19;
    const MAP_MAX_ZOOM = 22; // user can always zoom to 22, blurry but not blank

    // Build tile layer immediately with config value so map shows fast
    _tileLayer = buildCachedTileLayer(tileUrl, {
      subdomains,
      attribution:   isGoogle ? '© Google Maps' : `© ${officeName}`,
      minNativeZoom: 1,
      maxNativeZoom: configNative,
      maxZoom:       MAP_MAX_ZOOM,
    }).addTo(_map);

    _map.setMaxZoom(MAP_MAX_ZOOM);

    // Auto-detect real maxNativeZoom in background (non-blocking)
    _detectNativeZoomRange(tileUrl, subdomains, _map, configNative).then(({ minNative, maxNative }) => {
      if ((minNative !== configNative || maxNative !== configNative) && _tileLayer && _map.hasLayer(_tileLayer)) {
        _map.removeLayer(_tileLayer);
        _tileLayer = buildCachedTileLayer(tileUrl, {
          subdomains,
          attribution:   isGoogle ? '© Google Maps' : `© ${officeName}`,
          minNativeZoom: minNative,
          maxNativeZoom: maxNative,
          maxZoom:       MAP_MAX_ZOOM,
        }).addTo(_map);
        console.log(`[map] zoom range detected: ${minNative}–${maxNative} (was ${configNative})`);
      }
    }).catch(() => {});

    // ── Bg color ──────────────────────────────────────────────────
    const tileColor = isGoogle ? '#1a1a1a' : '#aadaff';
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.style.background = tileColor;
    document.body.style.background = tileColor;
    _mapTileColor = tileColor;

    // ── Bounds & view ─────────────────────────────────────────────
    let bounds = null;
    if (infoJson.ne_point && infoJson.sw_point) {
      try {
        const ne = infoJson.ne_point.split(',').map(Number);
        const sw = infoJson.sw_point.split(',').map(Number);
        if (ne.length === 2 && sw.length === 2 &&
            !isNaN(ne[0]) && !isNaN(ne[1]) &&
            !isNaN(sw[0]) && !isNaN(sw[1])) {
          bounds = L.latLngBounds(L.latLng(sw[0], sw[1]), L.latLng(ne[0], ne[1]));
        }
      } catch (e) { console.warn('Invalid bounds:', e); }
    }

    if (bounds) {
      // Restrict pan to bounds — user can never leave this area
      _map.setMaxBounds(bounds);

      // Set view to center at zoom 12, then let fitBounds decide final zoom
      const center = bounds.getCenter();
      _map.setView(center, 12, { animate: false });

      // fitBounds to fill screen — this becomes the minimum zoom
      _map.fitBounds(bounds, { padding: [0, 0], animate: false });
      const minZ = _map.getZoom();
      _map.setMinZoom(minZ);

      // Update zoom indicator
      const zi = document.getElementById('zoomIndicator');
      if (zi) zi.textContent = 'Z: ' + minZ;

    } else if (infoJson.lat && infoJson.lng) {
      _map.setView([parseFloat(infoJson.lat), parseFloat(infoJson.lng)], 12, { animate: false });
    } else if (infoJson.area) {
      geocodeArea(infoJson.area);
    } else {
      _map.setView([23.8103, 90.4125], 12, { animate: false });
    }

    hideMapLoader();

    // ── Fetch meters from server then render ──────────────────────
    const fetchToken = _session && _session.token;
    if (fetchToken) {
      msFetchAndMergeAll(fetchToken, officeId, null)
        .then(() => amRenderAllPins(officeId))
        .catch(e => { console.warn('[home] fetch error:', e); amRenderAllPins(officeId); });
    } else {
      amRenderAllPins(officeId);
    }

  } catch (e) {
    console.error(e);
    hideMapLoader();
  }
}

/**
 * Auto-detect the min and max zoom levels a tile server has.
 * Returns { minNative, maxNative }
 */
async function _detectNativeZoomRange(tileUrl, subdomains, map, configNative = 19) {
  const center   = map.getCenter();
  const MAX_TEST = 22;
  const MIN_TEST = 1;

  function latLngToTile(lat, lng, z) {
    const n    = Math.pow(2, z);
    const x    = Math.floor((lng + 180) / 360 * n);
    const latR = lat * Math.PI / 180;
    const y    = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
    return { x, y, z };
  }

  function buildUrl(z, x, y) {
    let url = tileUrl.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    if (url.includes('{s}')) {
      const subs = Array.isArray(subdomains) ? subdomains : (subdomains ? subdomains.split('') : ['a']);
      url = url.replace('{s}', subs[0]);
    }
    return url;
  }

  async function testTile(z) {
    const { x, y } = latLngToTile(center.lat, center.lng, z);
    try {
      const res = await fetch(buildUrl(z, x, y), { method: 'HEAD', cache: 'no-store' });
      return res.ok;
    } catch { return false; }
  }

  // Detect max: start from configNative, go up
  let maxNative = configNative;
  for (let z = configNative; z <= MAX_TEST; z++) {
    if (await testTile(z)) maxNative = z; else break;
  }

  // Detect min: start from configNative, go down
  let minNative = configNative;
  for (let z = configNative - 1; z >= MIN_TEST; z--) {
    if (await testTile(z)) minNative = z; else break;
  }

  return { minNative, maxNative };
}

/**
 * Build a Leaflet TileLayer that caches tiles in IndexedDB.
 * Falls back to network on cache miss.
 */
function buildCachedTileLayer(urlTemplate, options = {}) {
  const CachedLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const img = document.createElement('img');
      img.setAttribute('role', 'presentation');
      img.setAttribute('alt', '');

      const url = this.getTileUrl(coords);

      getTileCached(url).then(cachedObjectUrl => {
        if (cachedObjectUrl) {
          img.src = cachedObjectUrl;
          done(null, img);
          return;
        }
        // Fetch from network and cache
        fetch(url)
          .then(r => {
            if (!r.ok) throw new Error(`${r.status}`);
            return r.blob();
          })
          .then(blob => {
            saveTileCache(url, blob); // fire-and-forget
            img.src = URL.createObjectURL(blob);
            done(null, img);
          })
          .catch(err => {
            // Fallback: let Leaflet load normally
            img.src = url;
            img.onload  = () => done(null, img);
            img.onerror = () => done(err, img);
          });
      });

      return img;
    }
  });

  return new CachedLayer(urlTemplate, options);
}

/* ══════════════════════════════════════════════
   ADD METER PIN (floating button)
   ══════════════════════════════════════════════ */

let _amLat          = null;
let _amLng          = null;
let _amClass        = 'h';     // selected account class
let _amMarker       = null;
let _amMapClickMode = false;
const _amPins       = [];

/* ── Account class config ── */
const AM_CLASSES = {
  h:    { label: 'আবাসিক', color: '#22c55e', icon: 'img/h.svg'    },
  s:    { label: 'দোকান',  color: '#f59e0b', icon: 'img/s.svg'    },
  irr:  { label: 'সেচ',    color: '#06b6d4', icon: 'img/irr.svg'  },
  ind:  { label: 'শিল্প',  color: '#8b5cf6', icon: 'img/ind.svg'  },
  com:  { label: 'বাণিজ্য',color: '#ef4444', icon: 'img/com.svg'  },
  char: { label: 'দাতব্য', color: '#ec4899', icon: 'img/char.svg' },
};

/* prefix → color (first 3 digits of account number) */
const _amPrefixColors = {};
function _amColorForPrefix(prefix) {
  if (!_amPrefixColors[prefix]) {
    // deterministic hue from prefix number
    const hue = (parseInt(prefix, 10) * 47) % 360;
    _amPrefixColors[prefix] = `hsl(${hue},70%,45%)`;
  }
  return _amPrefixColors[prefix];
}

/* ── Pin icon builder ── */
function _amBuildIcon(accRaw, accClass, selected = false) {
  const prefix = accRaw.slice(0, 3);
  const cfg    = AM_CLASSES[accClass] || AM_CLASSES.h;
  const color  = _amColorForPrefix(prefix);
  const zoom   = _map ? _map.getZoom() : 14;

  // ═══════════════════════════════════════════════
  // PIN SIZE CONFIG — এখানে পরিবর্তন করুন
  // ═══════════════════════════════════════════════
  const PIN_BASE_ZOOM   = 14;   // এই zoom-এ base size প্রযোজ্য হবে
  const PIN_BASE_SIZE   = 10;   // zoom=PIN_BASE_ZOOM এ pin-এর px size
  const PIN_STEP        = 4;    // প্রতি zoom level-এ কত px বাড়বে/কমবে
  const PIN_MIN         = 3;    // সর্বনিম্ন size (px)
  const PIN_MAX         = 35;   // সর্বোচ্চ size (px)
  const PIN_SELECT_MULT = 1.4;  // selected pin কতগুণ বড় হবে
  const PIN_TINY_ZOOM   = 12;   // এর নিচে dot mode (bubble নেই)
  const PIN_LABEL_ZOOM  = 17;   // এর নিচে label লুকানো থাকবে
  // ═══════════════════════════════════════════════

  const base = PIN_BASE_SIZE + (zoom - PIN_BASE_ZOOM) * PIN_STEP;
  const size = Math.max(PIN_MIN, Math.min(PIN_MAX, base)) * (selected ? PIN_SELECT_MULT : 1);
  const s      = Math.round(size);

  // Label only visible at zoom ≥ PIN_LABEL_ZOOM (or always for selected)
  const label = accRaw.slice(0, 3) + '-' + accRaw.slice(3);

  // At very small sizes (zoom < PIN_TINY_ZOOM) just show a colored dot, no bubble shape
  const tinyMode  = !selected && zoom < PIN_TINY_ZOOM;
  const showLabel = selected || zoom >= PIN_LABEL_ZOOM;

  const html = tinyMode
    ? `<div class="amp-dot-only" style="--amp-color:${color};--amp-size:${s}px"></div>`
    : `<div class="amp-wrap${selected ? ' amp-selected' : ''}" style="--amp-color:${color};--amp-size:${s}px">
         <div class="amp-bubble">
           <img src="${cfg.icon}" class="amp-icon" alt="${cfg.label}" />
         </div>
         <div class="amp-tail"></div>
         ${showLabel ? `<div class="amp-label">${label}</div>` : ''}
       </div>`;

  return L.divIcon({
    className: '',
    html,
    iconSize:    tinyMode ? [s, s] : [s, s + (showLabel ? 28 : 10)],
    iconAnchor:  tinyMode ? [s/2, s/2] : [s/2, s + (showLabel ? 28 : 10)],
    popupAnchor: [0, tinyMode ? -s/2 : -(s + (showLabel ? 28 : 10))],
  });
}

/* ── Refresh all pin sizes on zoom ── */
function _amRefreshPinSizes() {
  _amPins.forEach(p => {
    if (p.marker && _map.hasLayer(p.marker)) {
      p.marker.setIcon(_amBuildIcon(p.acc, p.accClass, p.selected));
    }
  });
}

/**
 * Render all meters from IndexedDB onto the map.
 * Merges with existing _amPins — never duplicates.
 * Called on office load and after sync.
 */
async function amRenderAllPins(officeId) {
  if (!_map) return;
  const targetOffice = officeId || (_session && _session.active_office);
  if (!targetOffice) return;

  try {
    const records = await msGetByOffice(targetOffice);

    for (const rec of records) {
      if (!rec.gps_location) continue;

      // Skip if already on map (by local_id)
      if (_amPins.find(p => p.local_id === rec.local_id)) continue;

      const parts = rec.gps_location.split(',').map(Number);
      if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;
      const [lat, lng] = parts;

      const accRaw   = rec.account_number;
      const accClass = rec.acc_class || 'h';
      const label    = accRaw.slice(0, 3) + '-' + accRaw.slice(3);

      const icon = _amBuildIcon(accRaw, accClass, false);
      const marker = L.marker([lat, lng], { icon })
        .addTo(_map);

      marker.on('click', () => {
        const pin = _amPins.find(p => p.marker === marker);
        if (!pin) return;
        const wasSelected = pin.selected;
        _amPins.forEach(p => {
          p.selected = false;
          if (p.marker && _map.hasLayer(p.marker))
            p.marker.setIcon(_amBuildIcon(p.acc, p.accClass, false));
        });
        if (!wasSelected) {
          pin.selected = true;
          marker.setIcon(_amBuildIcon(pin.acc, pin.accClass, true));
        }
        mdOpenPanel(pin);
      });

      _amPins.push({
        local_id:   rec.local_id,
        account_id: rec.account_id || null,
        acc:        accRaw,
        accClass,
        label,
        lat, lng,
        marker,
        selected: false,
      });
    }
  } catch (e) {
    console.warn('amRenderAllPins error:', e);
  }
}

/* ── Open modal ── */
function openAddMeterModal() {
  _amLat = null; _amLng = null;
  _amClass = 'h';
  document.getElementById('amAccInput').value = '';
  document.getElementById('amLatInput').value = '';
  document.getElementById('amLngInput').value = '';
  document.getElementById('amAlert').className = 'am-alert hidden';
  _amResetSubmitBtn();
  // Reset class selection
  document.querySelectorAll('.am-class-btn').forEach(b => b.classList.remove('active'));
  const first = document.querySelector('.am-class-btn[data-class="h"]');
  if (first) first.classList.add('active');
  document.getElementById('amBackdrop').classList.remove('hidden');
  document.getElementById('amModal').classList.remove('hidden');
  amGetLocation();
}

function closeAddMeterModal() {
  document.getElementById('amBackdrop').classList.add('hidden');
  document.getElementById('amModal').classList.add('hidden');
  _amSetMapClickMode(false);
}

/* ── Class selector ── */
function amSelectClass(btn) {
  document.querySelectorAll('.am-class-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _amClass = btn.dataset.class;
}

/* ── Map-click mode ── */
function _amSetMapClickMode(on) {
  _amMapClickMode = on;
  const mapClickBtn = document.getElementById('amMapClickBtn');
  if (mapClickBtn) mapClickBtn.classList.toggle('active', on);
  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.style.cursor = on ? 'crosshair' : '';
  // When map-click mode is ON, disable backdrop so map clicks don't close modal
  const backdrop = document.getElementById('amBackdrop');
  if (backdrop) backdrop.style.pointerEvents = on ? 'none' : '';
}

/* Backdrop click — only close if NOT in map-click mode */
function amBackdropClick() {
  if (_amMapClickMode) return;
  closeAddMeterModal();
}

function amLocationFocus() {
  _amSetMapClickMode(true);
  showToast('🗺️ ম্যাপে ক্লিক করুন — সেই লোকেশন সেট হবে');
}

/* ── Manual lat/lng input ── */
function amManualLatLng() {
  const lat = parseFloat(document.getElementById('amLatInput').value);
  const lng = parseFloat(document.getElementById('amLngInput').value);
  if (!isNaN(lat) && !isNaN(lng)) {
    _amLat = lat; _amLng = lng;
    _amSetMapClickMode(false);
  }
}

/* ── Sync lat/lng inputs from internal state ── */
function _amSyncInputs(lat, lng) {
  _amLat = lat; _amLng = lng;
  const latEl = document.getElementById('amLatInput');
  const lngEl = document.getElementById('amLngInput');
  if (latEl) latEl.value = lat !== null ? lat.toFixed(6) : '';
  if (lngEl) lngEl.value = lng !== null ? lng.toFixed(6) : '';
}

/* ── Format account input ── */
function amFormatAccInput(el) {
  let raw = el.value.replace(/\D/g, '').slice(0, 7);
  el.value = raw.length > 3 ? raw.slice(0, 3) + '-' + raw.slice(3) : raw;
  _amSetMapClickMode(false);
}

/* ── GPS location ── */
function amGetLocation() {
  const btn     = document.getElementById('amLocBtn');
  const alertEl = document.getElementById('amAlert');
  alertEl.className = 'am-alert hidden';
  _amSetMapClickMode(false);

  if (!navigator.geolocation) {
    alertEl.textContent = '❌ এই ব্রাউজারে GPS সাপোর্ট নেই।';
    alertEl.className   = 'am-alert am-alert-error';
    return;
  }
  btn.disabled  = true;
  btn.innerHTML = '<span class="am-loc-spinner"></span> নেওয়া হচ্ছে…';

  navigator.geolocation.getCurrentPosition(
    pos => {
      _amSyncInputs(pos.coords.latitude, pos.coords.longitude);
      btn.disabled  = false;
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> আপডেট করুন';
    },
    err => {
      btn.disabled  = false;
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg> আবার চেষ্টা করুন';
      const msg = err.code === 1 ? 'লোকেশন অ্যাক্সেস অনুমতি দিন।'
                : err.code === 2 ? 'লোকেশন পাওয়া যাচ্ছে না।'
                : 'লোকেশন নিতে সময় বেশি লাগছে।';
      alertEl.textContent = '❌ ' + msg;
      alertEl.className   = 'am-alert am-alert-error';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/* ── Map click handler ── */
function _amHandleMapClick(e) {
  // GPS pick mode for meter detail panel
  if (typeof _mdGpsPickMode !== 'undefined' && _mdGpsPickMode) {
    mdHandleGpsPick(e.latlng.lat, e.latlng.lng);
    _amSetMapClickMode(false);
    return;
  }
  if (!_amMapClickMode) return;
  _amSyncInputs(e.latlng.lat, e.latlng.lng);
  _amSetMapClickMode(false);
  const btn = document.getElementById('amLocBtn');
  if (btn) btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> আপডেট করুন';
}

/* ── Place pin ── */
function _amPlacePin(lat, lng, accRaw, accClass) {
  const label = accRaw.slice(0, 3) + '-' + accRaw.slice(3);
  const icon  = _amBuildIcon(accRaw, accClass, false);
  const marker = L.marker([lat, lng], { icon })
    .addTo(_map);

  // Click to select/deselect
  marker.on('click', () => {
    const pin = _amPins.find(p => p.marker === marker);
    if (!pin) return;
    const wasSelected = pin.selected;
    _amPins.forEach(p => { p.selected = false; if (p.marker) p.marker.setIcon(_amBuildIcon(p.acc, p.accClass, false)); });
    if (!wasSelected) {
      pin.selected = true;
      marker.setIcon(_amBuildIcon(pin.acc, pin.accClass, true));
    }
    mdOpenPanel(pin);
  });

  _map.setView([lat, lng], Math.max(_map.getZoom(), 16), { animate: true });
  return marker;
}

function _amResetSubmitBtn() {
  const btn = document.getElementById('amSubmitBtn');
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 14 8 14s8-8.75 8-14a8 8 0 0 0-8-8z"/></svg> ম্যাপে যোগ করুন';
}

/* ── Submit ── */
async function amSubmitPin() {
  const alertEl   = document.getElementById('amAlert');
  const submitBtn = document.getElementById('amSubmitBtn');
  alertEl.className = 'am-alert hidden';

  // Read lat/lng from inputs (user may have typed manually)
  const latVal = parseFloat(document.getElementById('amLatInput').value);
  const lngVal = parseFloat(document.getElementById('amLngInput').value);
  if (!isNaN(latVal) && !isNaN(lngVal)) { _amLat = latVal; _amLng = lngVal; }

  const raw = document.getElementById('amAccInput').value.replace(/\D/g, '');
  if (raw.length !== 7) {
    alertEl.textContent = '⚠️ সঠিক ৭ ডিজিটের অ্যাকাউন্ট নম্বর দিন।';
    alertEl.className   = 'am-alert am-alert-error'; return;
  }
  if (_amLat === null || _amLng === null || isNaN(_amLat) || isNaN(_amLng)) {
    alertEl.textContent = '⚠️ আগে লোকেশন নিন।';
    alertEl.className   = 'am-alert am-alert-error'; return;
  }
  const officeId = _session && _session.active_office;
  if (!officeId) {
    alertEl.textContent = '⚠️ কোনো অফিস active নেই।';
    alertEl.className   = 'am-alert am-alert-error'; return;
  }

  const accFormatted = raw.slice(0, 3) + '-' + raw.slice(3);
  const gpsLocation  = `${_amLat},${_amLng}`;

  submitBtn.disabled  = true;
  submitBtn.innerHTML = '<span class="am-loc-spinner"></span> সেভ হচ্ছে…';

  // Save to IndexedDB
  const record = await msEnqueue(officeId, raw, gpsLocation, _amClass);

  // Place pin immediately
  const marker = _amPlacePin(_amLat, _amLng, raw, _amClass);
  _amPins.push({ local_id: record.local_id, account_id: record.account_id || null, acc: raw, accClass: _amClass,
                 label: accFormatted, lat: _amLat, lng: _amLng, marker, selected: false });

  closeAddMeterModal();
  msSyncBadgeUpdate();

  // Try online sync
  if (navigator.onLine && _session && _session.token) {
    try {
      const res = await Meter.add(_session.token, {
        office_id: officeId, account_number: raw, gps_location: gpsLocation,
        account_info_json: { acc_class: _amClass },
      });
      if (res.success) {
        const newAccountId = res.data && res.data.account_id;
        record.is_synced = 1; record.account_id = newAccountId; record.sync_error = null;
        await msPut(record); msSyncBadgeUpdate();
        // Update pin's account_id so detail panel can edit it
        const pin = _amPins.find(p => p.local_id === record.local_id);
        if (pin) pin.account_id = newAccountId;
        showToast(`✅ ${accFormatted} সেভ হয়েছে`);
      } else { showToast(`📥 ${accFormatted} offline-এ সেভ — পরে sync হবে`); }
    } catch { showToast(`📥 ${accFormatted} offline-এ সেভ — পরে sync হবে`); }
  } else { showToast(`📥 ${accFormatted} offline-এ সেভ — online হলে sync হবে`); }
}



/* ══════════════════════════════════════════════
   ADMIN PANEL
   ══════════════════════════════════════════════ */

let _apOfficeData  = null;   // current office full data
let _apCurrentTab  = 'pending';
let _apSelectedRole = 'viewer';

/* ── Check if current user is admin of active office ── */
async function checkAdminRole(officeId) {
  const btn = document.getElementById('pdAdminPanelBtn');
  if (!btn) return;
  if (!officeId || !_session) { btn.classList.add('hidden'); return; }

  try {
    const res = await Public.getOfficeById(officeId);
    if (!res.success || !res.data) { btn.classList.add('hidden'); return; }
    const userJson = typeof res.data.office_user_json === 'string'
      ? pfTryParse(res.data.office_user_json)
      : (res.data.office_user_json || {});
    const isAdmin = (userJson.admin_users || []).includes(_session.username);
    btn.classList.toggle('hidden', !isAdmin);

    // Show pending badge
    const pendingCount = (userJson.pending_users || []).length;
    const badge = document.getElementById('pdAdminPendingBadge');
    if (badge) {
      badge.textContent = pendingCount;
      badge.style.display = pendingCount > 0 ? 'inline-flex' : 'none';
    }
  } catch { btn.classList.add('hidden'); }
}

/* ── Open / Close ── */
async function openAdminPanel() {
  document.getElementById('profileDropdown').classList.add('hidden');
  document.getElementById('apPanelBackdrop').classList.remove('hidden');
  document.getElementById('apPanel').classList.remove('hidden');
  document.getElementById('apLoading').classList.remove('hidden');
  // Reset tabs
  apSwitchTab('pending');
  await apLoadOfficeData();
}

function closeAdminPanel() {
  document.getElementById('apPanelBackdrop').classList.add('hidden');
  document.getElementById('apPanel').classList.add('hidden');
}

/* ── Load office data ── */
async function apLoadOfficeData() {
  const officeId = _session && _session.active_office;
  if (!officeId) return;
  try {
    const res = await Public.getOfficeById(officeId);
    if (!res.success || !res.data) return;
    _apOfficeData = res.data;
    const nameEl = document.getElementById('apOfficeName');
    if (nameEl) nameEl.textContent = res.data.office_name;
    apRenderCurrentTab();
  } catch (e) {
    console.warn('apLoadOfficeData error:', e);
  } finally {
    document.getElementById('apLoading').classList.add('hidden');
  }
}

/* ── Tab switching ── */
function apSwitchTab(tab) {
  _apCurrentTab = tab;
  ['pending','members','add'].forEach(t => {
    document.getElementById('apTab' + t.charAt(0).toUpperCase() + t.slice(1))
      ?.classList.toggle('active', t === tab);
    document.getElementById('apTabContent' + t.charAt(0).toUpperCase() + t.slice(1))
      ?.classList.toggle('hidden', t !== tab);
  });
  if (_apOfficeData) apRenderCurrentTab();
}

function apRenderCurrentTab() {
  if (!_apOfficeData) return;
  const userJson = typeof _apOfficeData.office_user_json === 'string'
    ? pfTryParse(_apOfficeData.office_user_json)
    : (_apOfficeData.office_user_json || {});

  if (_apCurrentTab === 'pending') apRenderPending(userJson);
  else if (_apCurrentTab === 'members') apRenderMembers(userJson);
}

/* ── Pending tab ── */
function apRenderPending(userJson) {
  const pending = userJson.pending_users || [];
  const el = document.getElementById('apTabContentPending');
  const badge = document.getElementById('apPendingCount');
  if (badge) badge.textContent = pending.length;

  // Update dropdown badge too
  const dropBadge = document.getElementById('pdAdminPendingBadge');
  if (dropBadge) {
    dropBadge.textContent = pending.length;
    dropBadge.style.display = pending.length > 0 ? 'inline-flex' : 'none';
  }

  if (pending.length === 0) {
    el.innerHTML = '<div class="ap-empty">কোনো অপেক্ষমাণ অনুরোধ নেই</div>';
    return;
  }

  el.innerHTML = pending.map(u => `
    <div class="ap-user-row">
      <div class="ap-user-info">
        <div class="ap-user-avatar">${u.charAt(0).toUpperCase()}</div>
        <div class="ap-user-name">${u}</div>
      </div>
      <div class="ap-user-actions">
        <select class="ap-role-select" id="apApproveRole_${u}">
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
        </select>
        <button class="ap-btn ap-btn-approve" onclick="apApproveUser('${u}')">✓ Approve</button>
        <button class="ap-btn ap-btn-remove"  onclick="apRemoveUser('${u}', 'pending')">✕</button>
      </div>
    </div>`).join('');
}

/* ── Members tab ── */
function apRenderMembers(userJson) {
  const el = document.getElementById('apTabContentMembers');
  const groups = [
    { key: 'admin_users',  label: '👑 Admin',  role: 'admin'  },
    { key: 'editor_users', label: '✏️ Editor', role: 'editor' },
    { key: 'viewer_users', label: '👁 Viewer', role: 'viewer' },
  ];

  let html = '';
  groups.forEach(g => {
    const users = userJson[g.key] || [];
    if (users.length === 0) return;
    html += `<div class="ap-group-label">${g.label} (${users.length})</div>`;
    html += users.map(u => `
      <div class="ap-user-row">
        <div class="ap-user-info">
          <div class="ap-user-avatar">${u.charAt(0).toUpperCase()}</div>
          <div class="ap-user-name">${u}</div>
        </div>
        <div class="ap-user-actions">
          <select class="ap-role-select" id="apChangeRole_${u}" onchange="apChangeUserRole('${u}', '${g.role}', this.value)">
            <option value="viewer"  ${g.role==='viewer'  ? 'selected':''}>Viewer</option>
            <option value="editor"  ${g.role==='editor'  ? 'selected':''}>Editor</option>
            <option value="admin"   ${g.role==='admin'   ? 'selected':''}>Admin</option>
          </select>
          <button class="ap-btn ap-btn-remove" onclick="apRemoveUser('${u}', '${g.role}')">✕ Remove</button>
        </div>
      </div>`).join('');
  });

  el.innerHTML = html || '<div class="ap-empty">কোনো সদস্য নেই</div>';
}

/* ── Role selector in Add tab ── */
function apSelectRole(btn) {
  document.querySelectorAll('.ap-role-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _apSelectedRole = btn.dataset.role;
}

/* ── Actions ── */
async function apApproveUser(username) {
  const roleEl = document.getElementById(`apApproveRole_${username}`);
  const role   = roleEl ? roleEl.value : 'viewer';
  await _apAction(() => Office.approveUser(_session.token, _session.active_office, username, role),
    `${username} কে ${role} হিসেবে approve করা হয়েছে`);
}

async function apRemoveUser(username, role) {
  if (!confirm(`${username} কে remove করবেন?`)) return;
  await _apAction(() => Office.removeUser(_session.token, _session.active_office, username, role),
    `${username} remove হয়েছে`);
}

async function apChangeUserRole(username, oldRole, newRole) {
  if (oldRole === newRole) return;
  await _apAction(() => Office.addUser(_session.token, _session.active_office, username, newRole),
    `${username} এর role ${newRole} করা হয়েছে`);
}

async function apAddUser() {
  const username = document.getElementById('apAddUsername').value.trim();
  const alertEl  = document.getElementById('apAddAlert');
  alertEl.className = 'ap-alert hidden';
  if (!username) {
    alertEl.textContent = '⚠️ Username দিন।';
    alertEl.className = 'ap-alert ap-alert-error';
    return;
  }
  await _apAction(() => Office.addUser(_session.token, _session.active_office, username, _apSelectedRole),
    `${username} কে ${_apSelectedRole} হিসেবে যোগ করা হয়েছে`,
    alertEl);
  document.getElementById('apAddUsername').value = '';
}

async function _apAction(apiFn, successMsg, alertEl) {
  document.getElementById('apLoading').classList.remove('hidden');
  try {
    const res = await apiFn();
    if (res.success) {
      showToast('✅ ' + successMsg);
      // Refresh office data
      const r2 = await Public.getOfficeById(_session.active_office);
      if (r2.success && r2.data) {
        _apOfficeData = r2.data;
        apRenderCurrentTab();
        // Update admin button visibility
        checkAdminRole(_session.active_office);
      }
    } else {
      const msg = '❌ ' + (res.message || 'ব্যর্থ হয়েছে।');
      if (alertEl) { alertEl.textContent = msg; alertEl.className = 'ap-alert ap-alert-error'; }
      else showToast(msg);
    }
  } catch (e) {
    const msg = '❌ সার্ভারের সাথে সংযোগ করা যাচ্ছে না।';
    if (alertEl) { alertEl.textContent = msg; alertEl.className = 'ap-alert ap-alert-error'; }
    else showToast(msg);
  } finally {
    document.getElementById('apLoading').classList.add('hidden');
  }
}

/* ══════════════════════════════════════════════
   METER SEARCH
   ══════════════════════════════════════════════ */

function srchClear() {
  const inp = document.getElementById('srchInput');
  if (inp) inp.value = '';
  document.getElementById('srchResults').classList.add('hidden');
  document.getElementById('srchClearBtn').classList.add('hidden');
}

// Close results on outside click
document.addEventListener('click', e => {
  const wrap = document.getElementById('srchWrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('srchResults')?.classList.add('hidden');
  }
});

let _srchTimer = null;
function srchQuery(val) {
  clearTimeout(_srchTimer);
  const clearBtn = document.getElementById('srchClearBtn');
  if (clearBtn) clearBtn.classList.toggle('hidden', !val.trim());

  if (!val.trim()) {
    document.getElementById('srchResults').classList.add('hidden');
    return;
  }
  _srchTimer = setTimeout(() => _srchRun(val.trim()), 180);
}

async function _srchRun(q) {
  const officeId = _session && _session.active_office;
  if (!officeId) return;

  const resultsEl = document.getElementById('srchResults');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = '<div class="srch-hint">Searching…</div>';

  try {
    const matches = await msSearch(officeId, q);

    if (!matches.length) {
      resultsEl.innerHTML = '<div class="srch-hint">No results found.</div>';
      return;
    }

    resultsEl.innerHTML = matches.map(r => {
      const acc     = r.account_number || '';
      const label   = acc.length >= 7 ? acc.slice(0,3) + '-' + acc.slice(3) : acc;
      const cls     = r.acc_class || 'h';
      const cfg     = AM_CLASSES[cls] || AM_CLASSES.h;
      const mnoHtml = r.meter_number  ? `<span class="srch-mno">${r.meter_number}</span>`  : '';
      const vilHtml = r.village       ? `<span class="srch-mno">${r.village}</span>`        : '';
      const dot     = r.is_synced ? '' : '<span class="srch-unsync">●</span>';
      return `<div class="srch-item" onclick="_srchSelect('${r.local_id}')">
        <span class="srch-dot" style="background:${cfg.color}"></span>
        <span class="srch-acc">${label}</span>
        ${mnoHtml}${vilHtml}${dot}
      </div>`;
    }).join('');
  } catch {
    resultsEl.innerHTML = '<div class="srch-hint">Error loading data.</div>';
  }
}

async function _srchSelect(localId) {
  document.getElementById('srchResults').classList.add('hidden');

  const pin = _amPins.find(p => p.local_id === localId);
  if (pin) {
    if (_map && pin.lat && pin.lng)
      _map.setView([pin.lat, pin.lng], Math.max(_map.getZoom(), 16), { animate: true });
    _amPins.forEach(p => {
      p.selected = false;
      if (p.marker && _map.hasLayer(p.marker))
        p.marker.setIcon(_amBuildIcon(p.acc, p.accClass, false));
    });
    pin.selected = true;
    if (pin.marker && _map.hasLayer(pin.marker))
      pin.marker.setIcon(_amBuildIcon(pin.acc, pin.accClass, true));
    mdOpenPanel(pin);
    return;
  }

  // Not on map — open detail from IndexedDB
  const records = await msGetByOffice(_session && _session.active_office);
  const rec     = records.find(r => r.local_id === localId);
  if (rec) {
    mdOpenPanel({
      local_id:   rec.local_id,
      account_id: rec.account_id || null,
      acc:        rec.account_number,
      accClass:   rec.acc_class || 'h',
      lat:        rec.gps_location ? parseFloat(rec.gps_location.split(',')[0]) : null,
      lng:        rec.gps_location ? parseFloat(rec.gps_location.split(',')[1]) : null,
      selected:   false,
    });
  }
}


/* ══════════════════════════════════════════════
   REPORT PANEL
   ══════════════════════════════════════════════ */

let _rpCurrentTab  = 'list';
let _rpAllReadings = [];   // full reading_cache snapshot
let _rpListFiltered = [];  // filtered for table

/* ── Open / Close ── */
async function rpOpen() {
  document.getElementById('rpBackdrop').classList.remove('hidden');
  document.getElementById('rpPanel').classList.remove('hidden');

  // Load all readings from IndexedDB
  _rpAllReadings = await rcGetAll().catch(() => []);

  // Populate route selects
  _rpPopulateRoutes();
}

function rpClose() {
  document.getElementById('rpBackdrop').classList.add('hidden');
  document.getElementById('rpPanel').classList.add('hidden');
}

/* ── Tabs ── */
function rpSwitchTab(tab) {
  _rpCurrentTab = tab;
  const tabMap = { list: 'List', summary: 'Summary' };
  Object.entries(tabMap).forEach(([key, cap]) => {
    document.getElementById(`rpTab${cap}`)?.classList.toggle('active', key === tab);
    document.getElementById(`rpContent${cap}`)?.classList.toggle('hidden', key !== tab);
  });
}

/* ── Populate route dropdowns ── */
function _rpPopulateRoutes() {
  const routes = [...new Set(_rpAllReadings.map(r => r.route_number).filter(Boolean))].sort();
  [document.getElementById('rpRouteSelect'), document.getElementById('rpSummaryRoute')]
    .forEach(sel => {
      if (!sel) return;
      const cur = sel.value;
      sel.innerHTML = '<option value="">— রুট বেছে নিন —</option>'
        + routes.map(r => `<option value="${r}">${r}</option>`).join('');
      if (cur) sel.value = cur;
    });
}

/* ── This month helper ── */
function _rpThisMonth() {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth() };
}
function _rpIsThisMonth(isoStr) {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  const { y, m } = _rpThisMonth();
  return d.getFullYear() === y && d.getMonth() === m;
}

/* ── LIST TAB ── */
function rpLoadList() {
  const route = document.getElementById('rpRouteSelect')?.value || '';
  const wrap  = document.getElementById('rpTableWrap');
  if (!wrap) return;

  if (!route) { wrap.innerHTML = '<div class="rp-empty">রুট বেছে নিন</div>'; return; }

  // This month's readings for this route
  _rpListFiltered = _rpAllReadings.filter(r =>
    r.route_number === route && _rpIsThisMonth(r.reading_time)
  );

  _rpRenderTable(_rpListFiltered, wrap);
}

function rpFilterList(q) {
  const route = document.getElementById('rpRouteSelect')?.value || '';
  const wrap  = document.getElementById('rpTableWrap');
  if (!wrap || !route) return;

  const lq = q.toLowerCase().trim();
  const filtered = lq
    ? _rpListFiltered.filter(r =>
        (r.account_number || '').toLowerCase().includes(lq) ||
        (r.meter_number   || '').toLowerCase().includes(lq) ||
        (r.village        || '').toLowerCase().includes(lq))
    : _rpListFiltered;

  _rpRenderTable(filtered, wrap);
}

function _rpRenderTable(rows, wrap) {
  if (!rows.length) {
    wrap.innerHTML = '<div class="rp-empty">এই মাসে কোনো রিডিং নেই।</div>';
    return;
  }

  const thead = `<tr>
    <th>#</th>
    <th>অ্যাকাউন্ট</th>
    <th>মিটার নং</th>
    <th>গ্রাম</th>
    <th>kWh</th>
    <th>kW</th>
    <th>kVArh-L</th>
    <th>kVArh-Ld</th>
    <th>সময়</th>
  </tr>`;

  const tbody = rows.map((r, i) => {
    const raw = r.account_number || '';
    const accFmt = raw.length >= 7 ? raw.slice(0,3) + '-' + raw.slice(3) : raw || '—';
    const ts = r.reading_time
      ? new Date(r.reading_time).toLocaleString('bn-BD', { dateStyle: 'short', timeStyle: 'short' })
      : '—';
    return `<tr>
      <td>${i + 1}</td>
      <td class="rp-td-acc">${accFmt}</td>
      <td class="rp-td-acc" style="font-size:10px">${r.meter_number || '—'}</td>
      <td>${r.village || '—'}</td>
      <td class="rp-td-kwh">${r.kwh      ?? '—'}</td>
      <td class="rp-td-kwh">${r.kw       ?? '—'}</td>
      <td class="rp-td-kwh">${r.kvarh_lag ?? '—'}</td>
      <td class="rp-td-kwh">${r.kvarh_led ?? '—'}</td>
      <td class="rp-td-time">${ts}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="rp-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

/* ── SUMMARY TAB ── */
async function rpLoadSummary() {
  const route = document.getElementById('rpSummaryRoute')?.value || '';
  const wrap  = document.getElementById('rpSummaryWrap');
  if (!wrap) return;

  if (!route) { wrap.innerHTML = '<div class="rp-empty">রুট বেছে নিন</div>'; return; }

  // All meters in this route from meter_queue / meter_detail
  let allMeters = [];
  try {
    allMeters = await msGetByOffice(_session && _session.active_office);
    allMeters = allMeters.filter(m => (m.route_number || '') === route);
  } catch { allMeters = []; }

  const totalMeters = allMeters.length;

  // This month's readings for this route
  const thisMonthReadings = _rpAllReadings.filter(r =>
    r.route_number === route && _rpIsThisMonth(r.reading_time)
  );

  // Unique accounts read this month
  const readAccounts = new Set(thisMonthReadings.map(r => r.account_number));
  const doneCount    = readAccounts.size;

  // Group by village
  const villageMap = {};
  allMeters.forEach(m => {
    const v = m.village || 'অজানা';
    if (!villageMap[v]) villageMap[v] = { total: 0, done: 0 };
    villageMap[v].total++;
    if (readAccounts.has(m.account_number)) villageMap[v].done++;
  });

  // Render
  const statHtml = `
    <div class="rp-summary-stat">
      <div class="rp-stat-card">
        <div class="rp-stat-val">${totalMeters}</div>
        <div class="rp-stat-label">মোট মিটার</div>
      </div>
      <div class="rp-stat-card">
        <div class="rp-stat-val" style="color:#34d399">${doneCount}</div>
        <div class="rp-stat-label">এ মাসে রিডিং</div>
      </div>
      <div class="rp-stat-card">
        <div class="rp-stat-val" style="color:#f87171">${totalMeters - doneCount}</div>
        <div class="rp-stat-label">বাকি</div>
      </div>
    </div>`;

  const villageHtml = Object.entries(villageMap)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, { total, done }]) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      return `
        <div class="rp-village-card">
          <div style="flex:1;min-width:0">
            <div class="rp-village-name">${name}</div>
            <div class="rp-village-bar-wrap">
              <div class="rp-village-bar" style="width:${pct}%"></div>
            </div>
          </div>
          <div class="rp-village-count">${done}/${total}</div>
        </div>`;
    }).join('');

  wrap.innerHTML = statHtml + (villageHtml || '<div class="rp-empty">কোনো মিটার নেই।</div>');
}

/* ── SETTINGS ── */
function rpSaveSettings() {
  showToast('✅ সেটিং সেভ হয়েছে।');
}
