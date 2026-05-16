/**
 * PBS Map — Auth Page Logic (login.html)
 */

/* ══ Google Sign-In Init ══ */
function initGoogleSignIn() {
  const clientId = (typeof CONFIG !== 'undefined') ? CONFIG.GOOGLE_CLIENT_ID : '';
  if (!clientId || clientId.startsWith('YOUR_')) {
    document.querySelectorAll('.google-btn-wrap').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.divider').forEach(el => el.style.display = 'none');
    return;
  }
  if (typeof google === 'undefined' || !google.accounts) return;

  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleGoogleLogin,
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  const loginContainer = document.getElementById('googleBtnContainer');
  if (loginContainer) {
    google.accounts.id.renderButton(loginContainer, {
      type: 'standard', size: 'large', theme: 'outline',
      text: 'signin_with', shape: 'rectangular',
      logo_alignment: 'left', width: 320,
    });
  }
  const signupContainer = document.getElementById('googleSignupBtn');
  if (signupContainer) {
    google.accounts.id.renderButton(signupContainer, {
      type: 'standard', size: 'large', theme: 'outline',
      text: 'signup_with', shape: 'rectangular',
      logo_alignment: 'left', width: 320,
    });
  }
}
window.onGoogleLibraryLoad = initGoogleSignIn;
if (typeof google !== 'undefined') initGoogleSignIn();

/* ══ Redirect if already logged in ══ */
async function checkAuthRedirect() {
  try {
    const session = await getSession();
    if (session && session.token) {
      window.location.replace('home.html');
    }
  } catch(e) {}

  // Check URL hash for #signup
  if (window.location.hash === '#signup') {
    showPanel('panelSignup');
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAuthRedirect);
} else {
  checkAuthRedirect();
}

/* ══ Panel Switching ══ */
function showPanel(id) {
  document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(id);
  if (panel) panel.classList.add('active');
  clearAlerts();
  // Update URL hash without scroll
  const hash = id === 'panelSignup' ? '#signup' : id === 'panelForgot' ? '#forgot' : '';
  history.replaceState(null, '', hash || window.location.pathname);
}

function clearAlerts() {
  document.querySelectorAll('.alert').forEach(a => {
    a.classList.add('hidden');
    a.textContent = '';
  });
}

/* ══ Utilities ══ */
function showAlert(id, msg, type = 'error') {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function btnLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  const text   = btn.querySelector('.btn-text');
  const loader = btn.querySelector('.btn-loader');
  if (text)   text.style.opacity  = loading ? '0' : '1';
  if (loader) loader.classList.toggle('hidden', !loading);
}

function togglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? '👁' : '🙈';
}

/* ══ LOGIN ══ */
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const identifier = document.getElementById('loginIdentifier').value.trim();
  const password   = document.getElementById('loginPassword').value;

  if (!identifier || !password) {
    showAlert('loginError', 'সকল তথ্য পূরণ করুন।');
    return;
  }

  btnLoading('loginBtn', true);
  try {
    const res = await Auth.login(identifier, password);
    if (res.success) {
      await saveSession({
        token:         res.data.token,
        username:      res.data.username,
        email:         res.data.email,
        user_json:     res.data.user_json     || {},
        active_office: res.data.active_office || null,
        user_api_key:  res.data.user_api_key  || '',
      });
      window.location.replace('home.html');
    } else {
      showAlert('loginError', res.message || 'লগইন ব্যর্থ হয়েছে।');
    }
  } catch (err) {
    showAlert('loginError', 'সার্ভারের সাথে সংযোগ করা যাচ্ছে না। Backend চালু আছে কিনা দেখুন।');
  } finally {
    btnLoading('loginBtn', false);
  }
});

/* ══ GOOGLE LOGIN ══ */
async function handleGoogleLogin(response) {
  clearAlerts();
  const activePanel = document.querySelector('.auth-panel.active');
  const errorId = activePanel && activePanel.id === 'panelSignup' ? 'signupError' : 'loginError';

  try {
    const res = await Auth.googleLogin(response.credential);
    if (res.success) {
      await saveSession({
        token:         res.data.token,
        username:      res.data.username,
        email:         res.data.email,
        user_json:     res.data.user_json     || {},
        active_office: res.data.active_office || null,
        user_api_key:  res.data.user_api_key  || '',
      });
      window.location.replace('home.html');
    } else {
      showAlert(errorId, res.message || 'Google লগইন ব্যর্থ হয়েছে।');
    }
  } catch (err) {
    showAlert(errorId, 'Google লগইনে সমস্যা হয়েছে।');
  }
}

/* ══ SIGNUP ══ */
document.getElementById('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const full_name = document.getElementById('signupName').value.trim();
  const email     = document.getElementById('signupEmail').value.trim();
  const password  = document.getElementById('signupPassword').value;

  if (!email || !password) { showAlert('signupError', 'ইমেইল ও পাসওয়ার্ড আবশ্যক।'); return; }
  if (password.length < 6) { showAlert('signupError', 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'); return; }

  btnLoading('signupBtn', true);
  try {
    const res = await Auth.signup(email, password, full_name || undefined);
    if (res.success) {
      showAlert('signupSuccess',
        `✅ নিবন্ধন সফল! ইউজারনেম: ${res.data.username} — এখন লগইন করুন।`,
        'success'
      );
      document.getElementById('signupForm').reset();
      setTimeout(() => showPanel('panelLogin'), 2800);
    } else {
      showAlert('signupError', res.message || 'নিবন্ধন ব্যর্থ হয়েছে।');
    }
  } catch (err) {
    showAlert('signupError', 'সার্ভারের সাথে সংযোগ করা যাচ্ছে না।');
  } finally {
    btnLoading('signupBtn', false);
  }
});

/* ══ FORGOT PASSWORD ══ */
let _forgotEmail = '';

document.getElementById('forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) { showAlert('forgotError', 'ইমেইল ঠিকানা দিন।'); return; }

  btnLoading('forgotBtn', true);
  try {
    await Auth.forgotPassword(email); // always 200
    _forgotEmail = email;
    showAlert('forgotSuccess', '📧 OTP পাঠানো হয়েছে। ইমেইল চেক করুন (Spam ফোল্ডারও দেখুন)।', 'success');
    document.getElementById('forgotStep1').classList.add('hidden');
    document.getElementById('forgotStep2').classList.remove('hidden');
  } catch (err) {
    showAlert('forgotError', 'সার্ভারের সাথে সংযোগ করা যাচ্ছে না।');
  } finally {
    btnLoading('forgotBtn', false);
  }
});

document.getElementById('resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const otp          = document.getElementById('resetOtp').value.trim();
  const new_password = document.getElementById('resetPassword').value;

  if (!otp || !new_password) { showAlert('forgotError', 'সকল তথ্য পূরণ করুন।'); return; }
  if (new_password.length < 6) { showAlert('forgotError', 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'); return; }

  btnLoading('resetBtn', true);
  try {
    const res = await Auth.resetPassword(_forgotEmail, otp, new_password);
    if (res.success) {
      showAlert('forgotSuccess', '✅ পাসওয়ার্ড পরিবর্তন হয়েছে! লগইন করুন।', 'success');
      setTimeout(() => showPanel('panelLogin'), 2000);
    } else {
      showAlert('forgotError', res.message || 'পাসওয়ার্ড পরিবর্তন ব্যর্থ হয়েছে।');
    }
  } catch (err) {
    showAlert('forgotError', 'সার্ভারের সাথে সংযোগ করা যাচ্ছে না।');
  } finally {
    btnLoading('resetBtn', false);
  }
});
