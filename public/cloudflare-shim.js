// Cloudflare Shim for google.script.run
// Per-call runner: withSuccessHandler/withFailureHandler return a NEW runner
// so parallel calls (e.g. getAirportNotes + getFlightDashboardData) never
// overwrite each other's callbacks (fixes race that zeroed allDbFlights).
window.google = window.google || {};
window.google.script = window.google.script || {};

(function () {
  var authState = { user: null, loaded: false };
  var authReady = null;

  function publishAuthenticatedUser() {
    window.awqAuthUser = authState.user;
    window.dispatchEvent(new CustomEvent('awq-auth-ready', { detail: authState.user }));
  }

  // Boot gate for session-dependent modules. Before a session exists every
  // non-auth RPC is rejected with 401 "Authentication required.", so a module
  // that starts on page load paints a bogus backend failure (e.g. the flight
  // board showed "DATABASE CONNECTION ERROR"). Callers register once; the
  // subscription is permanent so each later successful login re-runs the
  // callback, and a session restored before registration fires it immediately.
  function whenAuthenticated(callback) {
    if (typeof callback !== 'function') return;
    window.addEventListener('awq-auth-ready', function () { callback(); });
    if (authState.loaded && authState.user) callback();
  }

  function accountDisplayName() {
    return (authState.user && authState.user.profile && authState.user.profile.fullName) || (authState.user && authState.user.email) || '';
  }

  function refreshAccountIdentity() {
    var nameEl = document.getElementById('awq-account-name');
    if (nameEl) nameEl.textContent = accountDisplayName();
    var roleEl = document.getElementById('awq-account-role');
    if (roleEl && authState.user) roleEl.textContent = String(authState.user.role).toUpperCase();
  }

  function csrfToken() {
    var match = document.cookie.match(/(?:^|; )awq_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function isAuthMethod(method) {
    return method === 'authLogin' || method === 'authLogout' || method === 'authMe';
  }

  // A session can disappear while the app is open (cookie expiry, revocation).
  // Drop the stale identity and ask for credentials, so "Authentication
  // required." never lands in a module as an error state.
  function invalidateSession() {
    authState.user = null;
    window.awqAuthUser = null;
    var bar = document.getElementById('awq-user-bar');
    if (bar) bar.remove();
    showLogin();
  }

  function showLogin() {
    if (document.getElementById('awq-login-gate')) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', showLogin, { once: true }); return; }
    var gate = document.createElement('div');
    gate.id = 'awq-login-gate';
    gate.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#07101d;display:grid;place-items:center;padding:24px;font-family:system-ui,sans-serif;color:#f8fafc';
    gate.innerHTML = '<form id="awq-login-form" style="width:min(420px,100%);padding:32px;border:1px solid #334155;border-radius:16px;background:#0f172a;box-shadow:0 24px 80px #0008">' +
      '<div style="font:800 12px/1 monospace;letter-spacing:.16em;color:#fb7185">AWQ CLOUD BRIEFING / AUTHENTICATION</div>' +
      '<h1 style="margin:18px 0 8px;font-size:28px">Sign in</h1><p style="color:#94a3b8;margin:0 0 24px">Use your assigned AWQ Cloud account.</p>' +
      '<label style="display:block;font-size:13px;margin:14px 0 6px">Email</label><input id="awq-login-email" type="email" autocomplete="username" required style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#111827;color:#fff;box-sizing:border-box">' +
      '<label style="display:block;font-size:13px;margin:14px 0 6px">Password</label><input id="awq-login-password" type="password" autocomplete="current-password" required style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#111827;color:#fff;box-sizing:border-box">' +
      '<button type="submit" style="width:100%;margin-top:22px;padding:12px;border:0;border-radius:8px;background:#fb7185;color:#19040a;font-weight:800;cursor:pointer">Sign in</button>' +
      '<p id="awq-login-error" role="alert" style="min-height:20px;color:#fda4af;margin:14px 0 0;font-size:13px"></p>' +
      // Public legal notice. This gate is the ONLY thing an unauthenticated
      // visitor (and a Google OAuth reviewer) sees, and the consent screen
      // requires the homepage to identify the app and link its privacy policy.
      // Links only: adding a <button> here would break tests that click
      // '#awq-login-form button' under strict mode.
      '<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid #334155;color:#94a3b8;font-size:12px;line-height:1.65">' +
      'AWQ Cloud Briefing is a flight dispatch briefing workspace for flight watch, NOTAM, TAF, weather, FIR and crew briefing reports. ' +
      '<a href="/privacy" style="color:#fb7185">Privacy Policy</a> &middot; <a href="/terms" style="color:#fb7185">Terms of Service</a></p></form>';
    document.body.appendChild(gate);
    document.getElementById('awq-login-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var error = document.getElementById('awq-login-error');
      error.textContent = 'Signing in...';
      try {
        var login = await callRpc('authLogin', [document.getElementById('awq-login-email').value, document.getElementById('awq-login-password').value], true);
        // Hydrate the full access state (authMe carries the profile) so the
        // account panel can show the name immediately after signing in.
        var me = await callRpc('authMe', [], true);
        authState.user = (me && me.user)
          ? { email: me.user, role: me.tier, mustChangePassword: me.mustChangePassword, profile: me.profile || null }
          : { email: login.user.email, role: login.user.role, mustChangePassword: login.user.mustChangePassword, profile: null };
        authState.loaded = true;
        gate.remove();
        installUserBar();
        publishAuthenticatedUser();
      } catch (loginError) {
        error.textContent = 'Invalid email or password.';
      }
    });
  }

  function installUserBar() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', installUserBar, { once: true });
      return;
    }
    if (!authState.user || document.getElementById('awq-user-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'awq-user-bar';
    bar.style.cssText = 'position:relative;flex-shrink:0;font:600 12px system-ui,sans-serif';
    bar.innerHTML = '<style>' +
      '@media(max-width:480px){.occ-nav-bar .nav-actions{width:100%;justify-content:flex-end;gap:8px}.occ-nav-bar .utc-heartbeat{margin-right:auto}}' +
      '#awq-user-bar button{font:inherit;cursor:pointer;color:#e2e8f0}' +
      '#awq-user-bar button:focus-visible{outline:2px solid #cbd5e1;outline-offset:2px}' +
      '#awq-account-toggle{display:grid;place-items:center;width:44px;height:44px;padding:0;border:1px solid #334155;border-radius:10px;background:#0f172a;box-shadow:0 4px 12px #0002}' +
      '#awq-account-toggle:hover,#awq-account-toggle[aria-expanded="true"]{background:#334155}' +
      '#awq-account-panel{position:fixed;inset:auto;margin:0;width:208px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:8px;border:1px solid #334155;border-radius:10px;background:#0f172a;color:#e2e8f0;box-shadow:0 8px 24px #0003}' +
      '#awq-account-name{display:block;padding:8px 12px 0;color:#f8fafc;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#awq-account-role{display:block;padding:4px 12px 8px;color:#cbd5e1}' +
      '#awq-account-panel button{display:block;width:100%;min-height:44px;padding:8px 12px;border:0;border-radius:6px;background:transparent;text-align:left}' +
      '#awq-account-panel button:hover{background:#334155}' +
      '#awq-account-panel #awq-logout{color:#fda4af}' +
      '#awq-account-error{margin:4px 12px;color:#fda4af;font-weight:400}' +
      '</style><button id="awq-account-toggle" type="button" aria-label="Account" title="Account" aria-expanded="false" aria-controls="awq-account-panel" popovertarget="awq-account-panel">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg></button>' +
      '<div id="awq-account-panel" popover="auto" aria-label="Account actions"><span id="awq-account-name"></span><span id="awq-account-role"></span><button id="awq-profile" type="button">My profile</button><button id="awq-change-password" type="button">Change password</button><button id="awq-logout" type="button">Logout</button><p id="awq-account-error" role="alert" hidden></p></div>';
    document.querySelector('.occ-nav-bar .nav-actions').appendChild(bar);
    var panel = document.getElementById('awq-account-panel');
    var toggle = document.getElementById('awq-account-toggle');
    refreshAccountIdentity();
    var dismissListeners = null;
    panel.addEventListener('beforetoggle', function (event) {
      if (dismissListeners) dismissListeners.abort();
      if (event.newState !== 'open') return;
      var rect = toggle.getBoundingClientRect();
      panel.style.top = (rect.bottom + 8) + 'px';
      panel.style.right = Math.max(16, window.innerWidth - rect.right) + 'px';
      dismissListeners = new AbortController();
      function dismiss() { panel.hidePopover(); }
      window.addEventListener('resize', dismiss, { signal: dismissListeners.signal });
      document.addEventListener('scroll', dismiss, { capture: true, signal: dismissListeners.signal });
    });
    panel.addEventListener('toggle', function (event) {
      toggle.setAttribute('aria-expanded', String(event.newState === 'open'));
    });
    document.getElementById('awq-logout').addEventListener('click', async function () {
      var button = this;
      var error = document.getElementById('awq-account-error');
      button.disabled = true;
      error.hidden = true;
      try {
        await callRpc('authLogout', [], false);
        panel.hidePopover();
        invalidateSession();
      } catch (logoutError) {
        error.textContent = 'Could not sign out. Please try again.';
        error.hidden = false;
      } finally { button.disabled = false; }
    });
    document.getElementById('awq-profile').addEventListener('click', function () { panel.hidePopover(); showProfileDialog(); });
    document.getElementById('awq-change-password').addEventListener('click', async function () {
      panel.hidePopover();
      showChangePasswordDialog();
    });
  }

  function showChangePasswordDialog() {
    if (document.getElementById('awq-change-password-dialog')) return;
    var dialog = document.createElement('div');
    dialog.id = 'awq-change-password-dialog';
    dialog.style.cssText = 'position:fixed;inset:0;z-index:100001;background:#07101dcc;display:grid;place-items:center;padding:24px;font-family:system-ui,sans-serif;color:#f8fafc';
    dialog.innerHTML = '<form id="awq-change-password-form" style="width:min(420px,100%);padding:28px;border:1px solid #334155;border-radius:16px;background:#0f172a;box-shadow:0 24px 80px #0008">' +
      '<h2 style="margin:0 0 20px;font-size:22px">Change password</h2>' +
      '<label for="awq-current-password" style="display:block;font-size:13px;margin:14px 0 6px">Current password</label>' +
      '<input id="awq-current-password" name="currentPassword" type="password" autocomplete="current-password" required style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#111827;color:#fff;box-sizing:border-box">' +
      '<label for="awq-new-password" style="display:block;font-size:13px;margin:14px 0 6px">New password</label>' +
      '<input id="awq-new-password" name="newPassword" type="password" autocomplete="new-password" minlength="12" required style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#111827;color:#fff;box-sizing:border-box">' +
      '<label for="awq-confirm-password" style="display:block;font-size:13px;margin:14px 0 6px">Confirm new password</label>' +
      '<input id="awq-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#111827;color:#fff;box-sizing:border-box">' +
      '<p id="awq-change-password-error" role="alert" style="min-height:20px;color:#fda4af;margin:14px 0 0;font-size:13px"></p>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px"><button id="awq-cancel-password" type="button" style="padding:10px 14px;border:1px solid #475569;border-radius:8px;background:transparent;color:#cbd5e1;cursor:pointer">Cancel</button><button type="submit" style="padding:10px 14px;border:0;border-radius:8px;background:#fb7185;color:#19040a;font-weight:800;cursor:pointer">Update password</button></div></form>';
    document.body.appendChild(dialog);
    document.getElementById('awq-cancel-password').addEventListener('click', function () { dialog.remove(); });
    document.getElementById('awq-change-password-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var oldPassword = document.getElementById('awq-current-password').value;
      var newPassword = document.getElementById('awq-new-password').value;
      var confirmPassword = document.getElementById('awq-confirm-password').value;
      var error = document.getElementById('awq-change-password-error');
      if (newPassword.length < 12) { error.textContent = 'New password must be at least 12 characters.'; return; }
      if (newPassword !== confirmPassword) { error.textContent = 'New passwords do not match.'; return; }
      error.textContent = 'Updating password...';
      try {
        await callRpc('authChangePassword', [oldPassword, newPassword], false);
        dialog.remove();
        window.alert('Password changed. Please sign in again.');
        authState.user = null;
        window.awqAuthUser = null;
        var userBar = document.getElementById('awq-user-bar');
        if (userBar) userBar.remove();
        showLogin();
      } catch (changeError) { error.textContent = changeError.message || 'Password change failed.'; }
    });
  }

  function showProfileDialog() {
    if (document.getElementById('awq-profile-dialog')) return;
    var dialog = document.createElement('div');
    dialog.id = 'awq-profile-dialog';
    dialog.style.cssText = 'position:fixed;inset:0;z-index:100001;background:#07101dcc;display:grid;place-items:center;padding:24px;font-family:system-ui,sans-serif;color:#f8fafc';
    dialog.innerHTML = '<form id="awq-profile-form" style="width:min(420px,100%);padding:28px;border:1px solid #334155;border-radius:16px;background:#0f172a;box-shadow:0 24px 80px #0008">' +
      '<h2>My profile</h2>' +
      '<label for="awq-profile-name" style="display:block;font-size:13px;margin:14px 0 6px">Name</label>' +
      '<input id="awq-profile-name" name="fullName" type="text" maxlength="100" autocomplete="name" style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#111827;color:#fff;box-sizing:border-box">' +
      '<p id="awq-profile-fullName-error" role="alert" style="min-height:16px;color:#fda4af;margin:6px 0 0;font-size:12px"></p>' +
      '<label for="awq-profile-iaa" style="display:block;font-size:13px;margin:14px 0 6px">IAA ID</label>' +
      '<input id="awq-profile-iaa" name="iaaId" type="text" placeholder="IAA-12345" autocomplete="off" style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#111827;color:#fff;box-sizing:border-box">' +
      '<p id="awq-profile-iaaId-error" role="alert" style="min-height:16px;color:#fda4af;margin:6px 0 0;font-size:12px"></p>' +
      '<label for="awq-profile-lic" style="display:block;font-size:13px;margin:14px 0 6px">LIC No.</label>' +
      '<input id="awq-profile-lic" name="licNo" type="text" placeholder="FOOL-881234" autocomplete="off" style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#111827;color:#fff;box-sizing:border-box">' +
      '<p id="awq-profile-licNo-error" role="alert" style="min-height:16px;color:#fda4af;margin:6px 0 0;font-size:12px"></p>' +
      '<label for="awq-profile-email" style="display:block;font-size:13px;margin:14px 0 6px">Email</label>' +
      '<input id="awq-profile-email" type="email" readonly style="width:100%;padding:12px;border-radius:8px;border:1px solid #475569;background:#1f2937;color:#9ca3af;box-sizing:border-box">' +
      '<p id="awq-profile-email-helper" style="color:#6b7280;margin:6px 0 14px;font-size:12px">Account email — used to sign in. It cannot be changed here.</p>' +
      '<p id="awq-profile-error" role="alert" style="min-height:20px;color:#fda4af;margin:14px 0 0;font-size:13px"></p>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px"><button id="awq-profile-cancel" type="button" style="padding:10px 14px;border:1px solid #475569;border-radius:8px;background:transparent;color:#cbd5e1;cursor:pointer">Cancel</button><button id="awq-profile-save" type="submit" disabled style="padding:10px 14px;border:0;border-radius:8px;background:#fb7185;color:#19040a;font-weight:800;cursor:pointer;opacity:0.5;pointer-events:none">Save</button></div></form>';
    document.body.appendChild(dialog);
    var form = document.getElementById('awq-profile-form');
    var nameInput = document.getElementById('awq-profile-name');
    var iaaInput = document.getElementById('awq-profile-iaa');
    var licInput = document.getElementById('awq-profile-lic');
    var emailInput = document.getElementById('awq-profile-email');
    var saveButton = document.getElementById('awq-profile-save');
    var errorSummary = document.getElementById('awq-profile-error');

    var currentUserProfile = authState.user && authState.user.profile ? {
      fullName: authState.user.profile.fullName || '',
      iaaId: authState.user.profile.iaaId || '',
      licNo: authState.user.profile.licNo || ''
    } : { fullName: '', iaaId: '', licNo: '' };

    nameInput.value = currentUserProfile.fullName || '';
    iaaInput.value = currentUserProfile.iaaId || '';
    licInput.value = currentUserProfile.licNo || '';
    emailInput.value = authState.user && authState.user.email ? authState.user.email : '';

    function validateField(name, value) {
      if (name === 'fullName') {
        var trimmed = (value || '').trim();
        if (trimmed.length > 100) return 'Name must not exceed 100 characters.';
        if (trimmed.indexOf('<') !== -1 || trimmed.indexOf('>') !== -1) return 'Name must not contain < or >.';
        return null;
      }
      if (name === 'iaaId') {
        var upper = String(value || '').toUpperCase().trim();
        if (!upper) return null;
        if (!/^IAA-[0-9]{1,20}$/i.test(upper)) return 'IAA ID must match IAA-12345 format.';
        return null;
      }
      if (name === 'licNo') {
        var upper = String(value || '').toUpperCase().trim();
        if (!upper) return null;
        if (!/^FOOL-[0-9]{1,20}$/i.test(upper)) return 'LIC No. must match FOOL-123456 format.';
        return null;
      }
      return 'Unknown field.';
    }

    function normalizedValues() {
      return {
        fullName: nameInput.value.trim(),
        iaaId: (iaaInput.value || '').toUpperCase().trim(),
        licNo: (licInput.value || '').toUpperCase().trim()
      };
    }

    function areValuesEqual(a, b) {
      return (a.fullName || '') === (b.fullName || '') &&
        (a.iaaId || '') === (b.iaaId || '') &&
        (a.licNo || '') === (b.licNo || '');
    }

    function updateSaveButtonState() {
      var nameErr = validateField('fullName', nameInput.value);
      var iaaErr = validateField('iaaId', iaaInput.value);
      var licErr = validateField('licNo', licInput.value);
      var anyInvalid = !!nameErr || !!iaaErr || !!licErr;
      var currentNorm = normalizedValues();
      var unchanged = areValuesEqual(currentNorm, currentUserProfile);
      saveButton.disabled = anyInvalid || unchanged;
      saveButton.style.opacity = anyInvalid || unchanged ? '0.5' : '1';
      saveButton.style.pointerEvents = anyInvalid || unchanged ? 'none' : 'auto';
    }

    function clearFieldErrors() {
      document.getElementById('awq-profile-fullName-error').textContent = '';
      document.getElementById('awq-profile-iaaId-error').textContent = '';
      document.getElementById('awq-profile-licNo-error').textContent = '';
      errorSummary.textContent = '';
    }

    nameInput.addEventListener('input', function () {
      var err = validateField('fullName', nameInput.value);
      document.getElementById('awq-profile-fullName-error').textContent = err || '';
      updateSaveButtonState();
    });

    iaaInput.addEventListener('input', function () {
      var err = validateField('iaaId', iaaInput.value);
      document.getElementById('awq-profile-iaaId-error').textContent = err || '';
      updateSaveButtonState();
    });

    licInput.addEventListener('input', function () {
      var err = validateField('licNo', licInput.value);
      document.getElementById('awq-profile-licNo-error').textContent = err || '';
      updateSaveButtonState();
    });

    document.getElementById('awq-profile-cancel').addEventListener('click', function () { dialog.remove(); });

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      clearFieldErrors();
      var nameErr = validateField('fullName', nameInput.value);
      var iaaErr = validateField('iaaId', iaaInput.value);
      var licErr = validateField('licNo', licInput.value);
      if (nameErr || iaaErr || licErr) {
        if (nameErr) document.getElementById('awq-profile-fullName-error').textContent = nameErr;
        if (iaaErr) document.getElementById('awq-profile-iaaId-error').textContent = iaaErr;
        if (licErr) document.getElementById('awq-profile-licNo-error').textContent = licErr;
        errorSummary.textContent = 'Please fix errors before saving.';
        return;
      }
      var payload = {
        fullName: nameInput.value.trim(),
        iaaId: normalizedValues().iaaId,
        licNo: normalizedValues().licNo
      };
      saveButton.textContent = 'Saving…';
      saveButton.disabled = true;
      saveButton.style.opacity = '0.5';
      saveButton.style.pointerEvents = 'none';
      try {
        var result = await callRpc('profileSave', [payload], false);
        authState.user.profile = result && result.profile ? result.profile : authState.user.profile;
        refreshAccountIdentity();
        dialog.remove();
      } catch (saveError) {
        var fields = saveError.fields || {};
        if (fields.fullName) document.getElementById('awq-profile-fullName-error').textContent = fields.fullName;
        if (fields.iaaId) document.getElementById('awq-profile-iaaId-error').textContent = fields.iaaId;
        if (fields.licNo) document.getElementById('awq-profile-licNo-error').textContent = fields.licNo;
        errorSummary.textContent = saveError.message || 'Could not save profile.';
        updateSaveButtonState();
      } finally {
        if (saveButton.textContent === 'Saving…') {
          saveButton.textContent = 'Save';
        }
      }
    });
  }

  async function callRpc(method, args, skipAuthWait) {
    if (!skipAuthWait && authReady) await authReady;
    var headers = { 'Content-Type': 'application/json' };
    if (!isAuthMethod(method)) headers['X-AWQ-CSRF'] = csrfToken();
    var response = await fetch('/api/rpc', { method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify({ method: method, args: args }) });
    var result = await response.json();
    if (!response.ok) {
      // Only the server's explicit AUTH_REQUIRED code means "the session is
      // gone"; a guard rejection (missing/bad Origin) must stay a plain error.
      if (response.status === 401 && result.code === 'AUTH_REQUIRED' && !isAuthMethod(method)) invalidateSession();
      var error = new Error(result.error || ('HTTP error! status: ' + response.status));
      error.status = response.status;
      if (result.fields) error.fields = result.fields;
      if (result.code) error.code = result.code;
      throw error;
    }
    return result.data;
  }

  authReady = callRpc('authMe', [], true).then(function (result) {
    authState.user = result && result.user ? { email: result.user, role: result.tier, mustChangePassword: result.mustChangePassword, profile: (result && result.profile) || null } : null;
    authState.loaded = true;
    if (!authState.user) showLogin();
    else { installUserBar(); publishAuthenticatedUser(); }
    return authState;
  }).catch(function () { authState.loaded = true; showLogin(); return authState; });

  function makeRunner(successHandler, failureHandler) {
    return new Proxy({}, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (callback) {
            return makeRunner(callback, failureHandler);
          };
        }
        if (prop === 'withFailureHandler') {
          return function (callback) {
            return makeRunner(successHandler, callback);
          };
        }

        // It's a backend function call (e.g. google.script.run.getFlights())
        // Capture handlers in closure — immune to parallel-call overwrite.
        var onSuccess = successHandler;
        var onFailure = failureHandler;
        return async function (...args) {
          try {
            console.log(`[Shim] Calling backend function: ${prop}`, args);
            const result = { data: await callRpc(prop, args, false) };

            if (result && Object.prototype.hasOwnProperty.call(result, 'error') && result.error) {
              if (onFailure) {
                onFailure(result.error);
              } else {
                console.error(`[Shim] Backend error from ${prop}:`, result.error);
              }
            } else {
              if (onSuccess) {
                onSuccess(result.data);
              }
            }
          } catch (err) {
            if (onFailure) {
              onFailure(err);
            } else {
              console.error(`[Shim] Network/Shim error for ${prop}:`, err);
            }
          }
        };
      }
    });
  }

  window.google.script.run = makeRunner(null, null);
  window.awqWhenAuthenticated = whenAuthenticated;
})();
