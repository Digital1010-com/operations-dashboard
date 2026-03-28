let projects = [];
let selectedProjectId = null;
let currentFilter = 'all';
let currentStatusFilter = null;
let currentClientFilter = null;
let currentSort = 'newest';
let searchTerm = '';
let currentLaneView = 'in-progress';
let listDensity = 'compact';
let visibleRowCount = 100;
let currentAgentFocus = null;
let centerMode = 'projects';
let fileBrowserStartPath = localStorage.getItem('fileBrowserStartPath') || '/Volumes/AI_Drive/';
let fileBrowserPath = fileBrowserStartPath;
let fileBrowserItems = [];
let selectedFilePath = null;
let fileBrowserError = '';
let fileBrowserLoading = false;
let controlTower = { workers: [], activity: [], kpis: {} };
let workerDirectory = {};
let selectedAgentWorkspace = null;
let projectDetailTab = 'details';
let projectEditMode = false;
let renderedActivityItems = [];
let settingsState = {
  subscriptionTier: 'standard',
  seatAllocation: 5,
  extraSeats: 0,
  seatLimit: 5,
  seatsUsed: 0,
  seatsAvailable: 5,
  integrations: { calendar: false, gmail: false, googleDrive: false, microsoft: false, slack: false },
  integrationAccounts: {},
  securityStatus: { authRequired: false, encryptionReady: false, providers: [] },
  byokProviders: [],
  staffingSummary: {},
  timezone: ''
};
let teamMembers = [];
let teamStaffing = [];
let activeTeamMemberEditorId = null;
let financeSortBy = 'profit-desc';
let financeShowExcluded = false;
let plSortBy = 'ltv-desc';
let plSnapshot = null;
let activeByokEditor = null;
let sessionContext = { username: '', role: '', authenticated: false };
let conversationsSnapshot = [];
let conversationCounts = { assigned: 0, needsReview: 0, unassigned: 0, filteredGeneral: 0 };
let conversationStatusFilter = 'all';
let conversationSearchTerm = '';
let selectedConversationIds = new Set();
let myAssignments = [];
let qualityReviewsByProject = {};
let qualityReviewLoadingByProject = {};
let realtimeAbortController = null;
let realtimeReconnectTimer = null;
let realtimeRefreshTimer = null;
let realtimeBuffer = '';
let suppressNextDetailPanelClose = false;

let data = {};

// Load data

// Agency detection for multi-tenancy
function getAgencyId() {
  // 1. Check URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  const urlAgency = urlParams.get('agency');
  if (urlAgency && /^[a-z0-9-]+$/i.test(urlAgency)) {
    localStorage.setItem('agencyId', urlAgency);
    return urlAgency;
  }
  
  // 2. Check localStorage
  const storedAgency = localStorage.getItem('agencyId');
  if (storedAgency && /^[a-z0-9-]+$/i.test(storedAgency)) {
    return storedAgency;
  }
  
  // 3. Default agency
  return 'default';
}

const currentAgencyId = getAgencyId();
console.log(' Agency:', currentAgencyId);
const SESSION_TOKEN_KEY = 'opsDashboardSessionToken';
const SESSION_EXPIRES_AT_KEY = 'opsDashboardSessionExpiresAt';
let authPromptInFlight = false;
let authPromptPromise = null;
let authLastSuccessAt = 0;

// Update API calls to include agency parameter
function apiUrl(endpoint) {
  const base = endpoint.startsWith('/') ? endpoint : `/api/${endpoint}`;
  return `${base}?agency=${currentAgencyId}`;
}

function getSessionToken() {
  return localStorage.getItem(SESSION_TOKEN_KEY) || '';
}

function getSessionExpiresAt() {
  return localStorage.getItem(SESSION_EXPIRES_AT_KEY) || '';
}

function setSessionToken(token, expiresAt = '') {
  if (!token) {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_EXPIRES_AT_KEY);
    return;
  }
  localStorage.setItem(SESSION_TOKEN_KEY, String(token));
  if (expiresAt) localStorage.setItem(SESSION_EXPIRES_AT_KEY, String(expiresAt));
}

async function promptForLoginAndStoreToken() {
  // Redirect to login page instead of using browser prompt()
  const currentPath = window.location.pathname + window.location.search;
  const returnTo = currentPath !== '/login' ? encodeURIComponent(currentPath) : '';
  window.location.assign('/login' + (returnTo ? '?returnTo=' + returnTo : ''));
  return false;
}

async function refreshSessionTokenIfNeeded() {
  const token = getSessionToken();
  if (!token) return false;
  const expiresAt = getSessionExpiresAt();
  if (!expiresAt) return false;
  const msLeft = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(msLeft) || msLeft > 20 * 60 * 1000) return false;
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.set('Authorization', `Bearer ${token}`);
  const response = await window.__rawFetch(apiUrl('/api/auth/refresh'), { method: 'POST', headers });
  if (!response.ok) {
    setSessionToken('');
    renderFooterMeta();
    return false;
  }
  const body = await response.json().catch(() => ({}));
  if (body.token) setSessionToken(body.token, body.expiresAt || '');
  renderFooterMeta();
  return true;
}

async function logoutSession() {
  const token = getSessionToken();
  if (token) {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` });
    await window.__rawFetch(apiUrl('/api/auth/logout'), { method: 'POST', headers }).catch(() => null);
  }
  setSessionToken('');
  renderFooterMeta();
  showNotification('Logged out.', 'info');
}

async function downloadAttachment(attachmentId, suggestedName) {
  const id = String(attachmentId || '').trim();
  if (!id) return;
  try {
    const response = await fetch(apiUrl(`/api/attachments/${encodeURIComponent(id)}/download`));
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Attachment download failed');
    }
    const blob = await response.blob();
    const objectUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = String(suggestedName || '').trim() || 'attachment';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    showNotification(error.message || 'Attachment download failed', 'error');
  }
}

function appendAgencyToApiUrl(url) {
  try {
    const parsed = new URL(String(url || ''), window.location.origin);
    if (!parsed.pathname.startsWith('/api/')) return url;
    if (!parsed.searchParams.has('agency')) {
      parsed.searchParams.set('agency', currentAgencyId);
    }
    if (/^https?:\/\//i.test(String(url || ''))) return parsed.toString();
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch (_) {
    return url;
  }
}

window.__rawFetch = window.fetch.bind(window);
window.fetch = async function wrappedFetch(input, init = {}) {
  const originalUrl = typeof input === 'string' ? input : String(input?.url || '');
  const normalizedUrl = typeof input === 'string' ? appendAgencyToApiUrl(originalUrl) : originalUrl;
  const isApiCall = normalizedUrl.includes('/api/');
  const isAuthEndpoint = /\/api\/auth\//.test(normalizedUrl);
  const headers = new Headers(init.headers || {});
  if (isApiCall) {
    if (!init.__skipSessionRefresh) {
      await refreshSessionTokenIfNeeded().catch(() => null);
    }
    const token = getSessionToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  const requestInput = typeof input === 'string' ? normalizedUrl : input;
  const response = await window.__rawFetch(requestInput, { ...init, headers });
  if (isApiCall && response.status === 401 && !init.__authRetry) {
    if (isAuthEndpoint) return response;
    if (Date.now() - authLastSuccessAt < 8000) return response;

    const ok = await promptForLoginAndStoreToken();
    if (!ok) return response;
    const retryHeaders = new Headers(init.headers || {});
    const retryToken = getSessionToken();
    if (retryToken) retryHeaders.set('Authorization', 'Bearer ' + retryToken);
    return window.__rawFetch(requestInput, { ...init, headers: retryHeaders, __authRetry: true });
  }
  return response;
};

function getBrandLogoSource() {
  const branding = data && data.branding ? data.branding : {};
  const url = branding.logoDataUrl || branding.logoUrl || '/public/d1010-logo.svg';
  if (url === 'd1010-logo.svg') return '/public/d1010-logo.svg';
  return url;
}

function getSubscriptionTier() {
  return String(settingsState?.subscriptionTier || data?.subscriptionTier || 'standard').toLowerCase();
}

function isPremiumTier() {
  return getSubscriptionTier() === 'premium';
}

function applyBranding() {
  const source = getBrandLogoSource();
  [
    { imgId: 'topBrandLogo', fallbackId: 'topBrandLogoFallback' },
    { imgId: 'headerBrandLogo', fallbackId: 'headerBrandLogoFallback' }
  ].forEach(binding => {
    const logo = document.getElementById(binding.imgId);
    if (!logo) return;
    logo.src = source;
    logo.onerror = () => {
      logo.src = '/public/d1010-logo.svg';
      const fallbackMark = document.getElementById(binding.fallbackId);
      if (fallbackMark) fallbackMark.style.display = 'block';
    };
    logo.onload = () => {
      const fallbackMark = document.getElementById(binding.fallbackId);
      if (fallbackMark) fallbackMark.style.display = 'none';
    };
  });
}

function renderSettingsBrandingBlock() {
  const block = document.getElementById('settingsBrandingBlockMain');
  if (!block) return;

  if (!isPremiumTier()) {
    block.innerHTML = `
      <div style="padding: 12px; border-radius: 10px; background: rgba(0,0,0,0.04); color: var(--text-secondary); font-size: 12px;">
        Upgrade to <strong>Premium</strong> to enable custom logos.
      </div>
    `;
    return;
  }

  block.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom: 10px;">
      <div style="width: 150px; height: 54px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
        <img src="${escapeForHtmlAttr(getBrandLogoSource())}" alt="Current logo" style="max-width: 138px; max-height: 42px; object-fit: contain;" />
      </div>
      <div style="font-size:11px; color: var(--text-secondary);">Current logo preview</div>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap;">
      <button class="btn" onclick="triggerLogoUpload()" style="padding:8px 12px;">Add Logo</button>
      <button class="btn" onclick="setLogoFromUrl()" style="padding:8px 12px;">Logo URL</button>
      <button class="btn" onclick="resetLogoBranding()" style="padding:8px 12px;">Reset</button>
    </div>
  `;
}

function openSettingsModal() {
  switchView('settings');
}

function closeSettingsModal() {
  // Legacy no-op
}

async function refreshSettingsState() {
  try {
    const [settingsRes, teamRes, staffingRes, securityRes, byokRes] = await Promise.all([
      fetch(apiUrl('/api/settings')),
      fetch(apiUrl('/api/team')),
      fetch(apiUrl('/api/team/staffing')),
      fetch(apiUrl('/api/security/status')),
      fetch(apiUrl('/api/byok/providers'))
    ]);
    const settingsBody = settingsRes.ok ? await settingsRes.json() : {};
    const teamBody = teamRes.ok ? await teamRes.json() : {};
    const staffingBody = staffingRes.ok ? await staffingRes.json() : {};
    const securityBody = securityRes.ok ? await securityRes.json() : {};
    const byokBody = byokRes.ok ? await byokRes.json() : {};
    settingsState = {
      ...settingsState,
      ...settingsBody,
      integrations: {
        ...settingsState.integrations,
        ...(settingsBody.integrations || {})
      },
      integrationAccounts: {
        ...(settingsState.integrationAccounts || {}),
        ...(settingsBody.integrationAccounts || {})
      },
      securityStatus: securityBody && typeof securityBody === 'object' ? securityBody : settingsState.securityStatus,
      byokProviders: Array.isArray(byokBody.providers) ? byokBody.providers : [],
      staffingSummary: staffingBody && typeof staffingBody.summary === 'object' ? staffingBody.summary : (settingsState.staffingSummary || {}),
      timezone: typeof settingsBody.timezone === 'string' ? settingsBody.timezone : (settingsState.timezone || '')
    };
    teamMembers = Array.isArray(teamBody.teamMembers) ? teamBody.teamMembers : [];
    teamStaffing = Array.isArray(staffingBody.teamMembers) ? staffingBody.teamMembers : [];
    renderFooterMeta();
  } catch (error) {
    console.error('Failed to refresh settings state:', error);
  }
}

function getByokProviderRecord(providerKey) {
  const list = Array.isArray(settingsState.byokProviders) ? settingsState.byokProviders : [];
  return list.find(p => p && p.provider === providerKey) || null;
}

function byokProviderConfigured(providerKey) {
  return Boolean(getByokProviderRecord(providerKey));
}

function getProviderSecurityStatus(providerKey) {
  const providers = Array.isArray(settingsState?.securityStatus?.providers) ? settingsState.securityStatus.providers : [];
  return providers.find(p => p && p.provider === providerKey) || { provider: providerKey, byok: false, managed: false };
}

function getByokPromptFields(providerKey) {
  const map = {
    google: ['clientId', 'clientSecret'],
    microsoft: ['clientId', 'clientSecret', 'tenantId'],
    slack: ['clientId', 'clientSecret'],
    openai: ['apiKey'],
    anthropic: ['apiKey'],
    openrouter: ['apiKey'],
    deepseek: ['apiKey']
  };
  return map[providerKey] || ['apiKey'];
}

function getByokFieldLabel(fieldKey) {
  const map = {
    clientId: 'Client ID',
    clientSecret: 'Client Secret',
    tenantId: 'Tenant ID',
    apiKey: 'API Key'
  };
  return map[fieldKey] || fieldKey;
}

function openByokEditor(providerKey) {
  activeByokEditor = providerKey;
  renderSettingsView();
}

function closeByokEditor() {
  activeByokEditor = null;
  renderSettingsView();
}

async function saveByokProviderFromForm(providerKey) {
  const fields = getByokPromptFields(providerKey);
  const credentials = {};
  for (const field of fields) {
    const input = document.getElementById(`byok-${providerKey}-${field}`);
    const cleaned = String(input?.value || '').trim();
    if (!cleaned) {
      showNotification(`${getByokFieldLabel(field)} is required.`, 'error');
      return;
    }
    credentials[field] = cleaned;
  }
  try {
    const response = await fetch(apiUrl(`/api/byok/providers/${encodeURIComponent(providerKey)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentials })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to save BYOK provider');
    activeByokEditor = null;
    await refreshSettingsState();
    if (String(activeTeamMemberEditorId || '') === String(memberId || '')) activeTeamMemberEditorId = null;
    renderSettingsView();
    showNotification(`${providerKey} BYOK credentials saved.`, 'success');
  } catch (error) {
    console.error('Failed to configure BYOK provider:', error);
    showNotification(error.message || 'Failed to configure BYOK provider', 'error');
  }
}

async function configureByokProvider(providerKey) {
  openByokEditor(providerKey);
}

async function rotateByokProvider(providerKey) {
  const fields = getByokPromptFields(providerKey);
  const credentials = {};
  for (const field of fields) {
    const value = prompt(`Rotate ${providerKey} ${field} (leave blank to keep current):`, '');
    if (value === null) return;
    const cleaned = String(value || '').trim();
    if (cleaned) credentials[field] = cleaned;
  }
  if (Object.keys(credentials).length === 0) {
    showNotification('No fields provided for rotation.', 'info');
    return;
  }
  try {
    const response = await fetch(apiUrl(`/api/byok/providers/${encodeURIComponent(providerKey)}/rotate`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentials })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to rotate BYOK provider');
    await refreshSettingsState();
    renderSettingsView();
    showNotification(`${providerKey} BYOK credentials rotated.`, 'success');
  } catch (error) {
    console.error('Failed to rotate BYOK provider:', error);
    showNotification(error.message || 'Failed to rotate BYOK provider', 'error');
  }
}

async function testByokProvider(providerKey) {
  try {
    const response = await fetch(apiUrl(`/api/byok/providers/${encodeURIComponent(providerKey)}/test`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Provider test failed');
    await refreshSettingsState();
    renderSettingsView();
    showNotification(body.detail || `${providerKey} connection verified.`, 'success');
  } catch (error) {
    console.error('Failed to verify provider:', error);
    showNotification(error.message || `Failed to verify ${providerKey}`, 'error');
  }
}

async function removeByokProvider(providerKey) {
  if (!confirm(`Remove stored ${providerKey} BYOK credentials for this workspace?`)) return;
  try {
    const response = await fetch(apiUrl(`/api/byok/providers/${encodeURIComponent(providerKey)}`), {
      method: 'DELETE'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to remove BYOK provider');
    await refreshSettingsState();
    renderSettingsView();
    showNotification(`${providerKey} BYOK credentials removed.`, 'success');
  } catch (error) {
    console.error('Failed to remove BYOK provider:', error);
    showNotification(error.message || 'Failed to remove BYOK provider', 'error');
  }
}

async function saveSubscriptionTier() {
  const tierEl = document.getElementById('settingsTierSelectMain');
  const tier = String(tierEl?.value || 'standard').toLowerCase();
  try {
    const response = await fetch(apiUrl('/api/settings'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionTier: tier })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to save subscription tier');
    data.subscriptionTier = body.subscriptionTier || tier;
    settingsState = {
      ...settingsState,
      ...body,
      integrations: {
        ...settingsState.integrations,
        ...(body.integrations || {})
      }
    };
    renderSettingsBrandingBlock();
    renderSettingsView();
    showNotification(`Tier updated to ${data.subscriptionTier}.`, 'success');
  } catch (error) {
    console.error('Failed to save subscription tier:', error);
    showNotification(error.message || 'Failed to save subscription tier', 'error');
  }
}

function getTimezoneOptions() {
  return [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'America/Anchorage',
    'Pacific/Honolulu',
    'Europe/London',
    'Europe/Paris',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Australia/Sydney'
  ];
}

async function saveWorkspaceTimezone() {
  const timezoneEl = document.getElementById('settingsTimezoneSelect');
  const timezone = String(timezoneEl?.value || '').trim();
  try {
    const response = await fetch(apiUrl('/api/settings'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to save timezone');
    settingsState = {
      ...settingsState,
      timezone: typeof body.timezone === 'string' ? body.timezone : timezone
    };
    updateHeaderDateTime();
    showNotification('Timezone updated.', 'success');
  } catch (error) {
    console.error('Failed to save timezone:', error);
    showNotification(error.message || 'Failed to save timezone', 'error');
  }
}

async function saveBranding(payload) {
  const response = await fetch(apiUrl('/api/branding'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Failed to update branding');
  data.branding = body.branding || {};
  applyBranding();
  renderSettingsBrandingBlock();
  renderSettingsView();
  return body;
}

async function toggleIntegration(key) {
  const current = Boolean(settingsState.integrations?.[key]);
  try {
    if (current) {
      const response = await fetch(apiUrl(`/api/integrations/${encodeURIComponent(key)}/disconnect`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Failed to disconnect integration');
      await refreshSettingsState();
      renderSettingsView();
      showNotification(`${key} disconnected.`, 'success');
      return;
    }

    const response = await fetch(apiUrl(`/api/integrations/${encodeURIComponent(key)}/connect`));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to start OAuth flow');
    if (!body.authorizationUrl) throw new Error('OAuth URL missing from server response');
    showNotification(`Redirecting to ${key} OAuth...`, 'info');
    window.location.assign(body.authorizationUrl);
  } catch (error) {
    console.error('Failed to toggle integration:', error);
    const msg = String(error?.message || 'Failed to connect integration');
    if (msg.includes('SECRET_ENCRYPTION_KEY') || msg.includes('Encryption is required')) {
      switchView('settings');
      showNotification('Set SECRET_ENCRYPTION_KEY on the server before connecting BYOK/OAuth providers.', 'error');
      return;
    }
    if (msg.toLowerCase().includes('insufficient permissions')) {
      switchView('settings');
      showNotification('This action requires org admin/manager access.', 'error');
      return;
    }
    if (msg.includes('OAuth is not configured')) {
      switchView('settings');
      showNotification('Quick Connect is not available for this provider yet. Use Settings > Advanced BYOK to add your app credentials.', 'error');
      return;
    }
    showNotification(msg, 'error');
  }
}

async function runIntegrationSync(key, opts = {}) {
  if (!key) return false;
  try {
    const response = await fetch(apiUrl(`/api/integrations/${encodeURIComponent(key)}/sync`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Sync failed');
    await refreshSettingsState();
    renderSettingsView();
    if (!opts.silent) showNotification(`${key} synced successfully.`, 'success');
    return true;
  } catch (error) {
    console.error('Integration sync failed:', error);
    if (!opts.silent) showNotification(error.message || `Failed to sync ${key}`, 'error');
    return false;
  }
}

async function handleOAuthReturnFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const oauth = params.get('oauth');
  if (!oauth) return;

  const integration = params.get('integration') || 'integration';
  const rawMessage = params.get('message');
  const message = rawMessage ? String(rawMessage) : '';
  const wizardActive = sessionStorage.getItem('setupWizardActive') === 'true';

  if (!wizardActive) switchView('settings');
  if (oauth === 'success') {
    showNotification(`${integration} connected successfully.`, 'success');
    await runIntegrationSync(integration, { silent: false });

    // Mark onboarding step as complete if wizard is active
    if (wizardActive && ['slack', 'gmail', 'calendar'].includes(integration)) {
      try {
        await fetch(apiUrl('/api/onboarding/step'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSessionToken()}` },
          body: JSON.stringify({ step: integration, action: 'complete' })
        });
        if (setupWizardState && setupWizardState.steps) {
          setupWizardState.steps[integration] = 'connected';
        }
      } catch (_) {}
      renderSetupWizard();
    }
  } else {
    showNotification(message || `${integration} connection failed.`, 'error');
    if (wizardActive) renderSetupWizard();
  }

  params.delete('oauth');
  params.delete('integration');
  params.delete('message');
  params.delete('view');
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}`;
  window.history.replaceState({}, '', nextUrl);
}

async function buyExtraSeatPack() {
  const seatsToAdd = 5;
  const next = Number(settingsState.extraSeats || 0) + seatsToAdd;
  try {
    const response = await fetch(apiUrl('/api/settings'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraSeats: next })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to add seats');
    settingsState = {
      ...settingsState,
      ...body,
      integrations: {
        ...settingsState.integrations,
        ...(body.integrations || {})
      }
    };
    renderSettingsView();
    showNotification(`Added ${seatsToAdd} extra seats.`, 'success');
  } catch (error) {
    console.error('Failed to add seats:', error);
    showNotification(error.message || 'Failed to add seats', 'error');
  }
}

async function addTeamMemberFromSettings(event) {
  event.preventDefault();
  const name = (document.getElementById('settingsMemberName')?.value || '').trim();
  const email = (document.getElementById('settingsMemberEmail')?.value || '').trim();
  const role = (document.getElementById('settingsMemberRole')?.value || 'member').trim();
  const access = (document.getElementById('settingsMemberAccess')?.value || 'assigned-only').trim();
  const assignedOwner = (document.getElementById('settingsMemberOwner')?.value || '').trim();
  const skills = (document.getElementById('settingsMemberSkills')?.value || '').trim();
  const clients = (document.getElementById('settingsMemberClients')?.value || '').trim();
  const availabilityStatus = (document.getElementById('settingsMemberAvailability')?.value || 'available').trim();
  const capacityHoursPerDay = Number(document.getElementById('settingsMemberCapacity')?.value || 6);
  const maxConcurrentAssignments = Number(document.getElementById('settingsMemberConcurrent')?.value || 5);
  const timezone = (document.getElementById('settingsMemberTimezone')?.value || settingsState.timezone || '').trim();
  const routingEnabled = Boolean(document.getElementById('settingsMemberRoutingEnabled')?.checked);

  if (!name || !email) {
    showNotification('Name and email are required.', 'error');
    return;
  }

  try {
    const response = await fetch(apiUrl('/api/team'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        role,
        access,
        assignedOwner,
        skills,
        clients,
        availabilityStatus,
        capacityHoursPerDay,
        maxConcurrentAssignments,
        timezone,
        routingEnabled
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to add user');
    await refreshSettingsState();
    renderSettingsView();
    showNotification('Team member added.', 'success');
  } catch (error) {
    console.error('Failed to add team member:', error);
    showNotification(error.message || 'Failed to add team member', 'error');
  }
}

async function removeTeamMemberFromSettings(memberId) {
  if (!memberId) return;
  if (!confirm('Remove this team member?')) return;
  try {
    const response = await fetch(apiUrl(`/api/team/${encodeURIComponent(memberId)}`), {
      method: 'DELETE'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to remove user');
    await refreshSettingsState();
    if (String(activeTeamMemberEditorId || '') === String(memberId || '')) activeTeamMemberEditorId = null;
    renderSettingsView();
    showNotification('Team member removed.', 'success');
  } catch (error) {
    console.error('Failed to remove team member:', error);
    showNotification(error.message || 'Failed to remove team member', 'error');
  }
}

function openTeamMemberEditor(memberId) {
  activeTeamMemberEditorId = String(memberId || '').trim() || null;
  renderSettingsView();
  requestAnimationFrame(() => {
    const editor = document.getElementById('settingsTeamMemberEditor');
    if (editor) {
      editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const firstField = document.getElementById('settingsEditMemberName');
      if (firstField) firstField.focus();
    }
  });
}

function closeTeamMemberEditor() {
  activeTeamMemberEditorId = null;
  renderSettingsView();
}

async function saveTeamMemberFromSettings(memberId) {
  const id = String(memberId || activeTeamMemberEditorId || '').trim();
  if (!id) return;
  const payload = {
    name: (document.getElementById('settingsEditMemberName')?.value || '').trim(),
    email: (document.getElementById('settingsEditMemberEmail')?.value || '').trim(),
    role: (document.getElementById('settingsEditMemberRole')?.value || '').trim(),
    access: (document.getElementById('settingsEditMemberAccess')?.value || '').trim(),
    assignedOwner: (document.getElementById('settingsEditMemberOwner')?.value || '').trim(),
    skills: (document.getElementById('settingsEditMemberSkills')?.value || '').trim(),
    secondarySkills: (document.getElementById('settingsEditMemberSecondarySkills')?.value || '').trim(),
    clients: (document.getElementById('settingsEditMemberClients')?.value || '').trim(),
    availabilityStatus: (document.getElementById('settingsEditMemberAvailability')?.value || 'available').trim(),
    capacityHoursPerDay: Number(document.getElementById('settingsEditMemberCapacity')?.value || 6),
    maxConcurrentAssignments: Number(document.getElementById('settingsEditMemberConcurrent')?.value || 5),
    timezone: (document.getElementById('settingsEditMemberTimezone')?.value || settingsState.timezone || '').trim(),
    workingHoursStart: (document.getElementById('settingsEditMemberHoursStart')?.value || '09:00').trim(),
    workingHoursEnd: (document.getElementById('settingsEditMemberHoursEnd')?.value || '17:00').trim(),
    oooUntil: (document.getElementById('settingsEditMemberOooUntil')?.value || '').trim() || null,
    backupAssigneeId: (document.getElementById('settingsEditMemberBackup')?.value || '').trim() || null,
    slackUserId: (document.getElementById('settingsEditMemberSlackUserId')?.value || '').trim() || null,
    routingEnabled: Boolean(document.getElementById('settingsEditMemberRoutingEnabled')?.checked),
    active: Boolean(document.getElementById('settingsEditMemberActive')?.checked)
  };

  if (!payload.name || !payload.email) {
    showNotification('Name and email are required.', 'error');
    return;
  }

  try {
    const response = await fetch(apiUrl('/api/team/' + encodeURIComponent(id)), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to save team member');
    await refreshSettingsState();
    activeTeamMemberEditorId = id;
    renderSettingsView();
    showNotification('Team member updated.', 'success');
  } catch (error) {
    console.error('Failed to save team member:', error);
    showNotification(error.message || 'Failed to save team member', 'error');
  }
}

function renderSettingsView() {
  const container = document.getElementById('settingsContainer');
  if (!container) return;

  const tier = String(settingsState.subscriptionTier || getSubscriptionTier());
  const clientsCount = Array.isArray(data.clients) ? data.clients.length : 0;
  const categoriesCount = Array.isArray(data.categories) ? data.categories.length : 0;
  const fileHubCount = (Array.isArray(data.fileHubLinks) ? data.fileHubLinks.length : 0) + 3;
  const agentsCount = Array.isArray(controlTower.workers) ? controlTower.workers.length : (Array.isArray(data.agents) ? data.agents.length : 0);
  const integrations = [
    { key: 'calendar', provider: 'google', name: 'Calendar', status: settingsState.integrations?.calendar ? 'connected' : 'disconnected', detail: 'Sync calendars & due dates' },
    { key: 'gmail', provider: 'google', name: 'Gmail', status: settingsState.integrations?.gmail ? 'connected' : 'disconnected', detail: 'Email ingestion for Joan intake' },
    { key: 'googleDrive', provider: 'google', name: 'Google Drive', status: settingsState.integrations?.googleDrive ? 'connected' : 'disconnected', detail: 'Files and docs integration' },
    { key: 'microsoft', provider: 'microsoft', name: 'Microsoft 365', status: settingsState.integrations?.microsoft ? 'connected' : 'disconnected', detail: 'Outlook/Teams/OneDrive sync' },
    { key: 'slack', provider: 'slack', name: 'Slack', status: settingsState.integrations?.slack ? 'connected' : 'disconnected', detail: 'Task intake and alerts' },
    { key: 'fileHub', name: 'File Hub', status: 'connected', detail: `${fileHubCount} sources` },
    { key: 'agents', name: 'Agent Control Tower', status: agentsCount > 0 ? 'connected' : 'degraded', detail: `${agentsCount} agents` }
  ];
  const security = settingsState.securityStatus || {};
  const byokProviders = ['google', 'microsoft', 'slack', 'openai', 'anthropic', 'openrouter', 'deepseek'];
  const selectedTimezone = String(settingsState.timezone || getResolvedDisplayTimezone());
  const timezoneOptionsHtml = getTimezoneOptions().map(zone => `<option value="${escapeForHtmlAttr(zone)}" ${zone === selectedTimezone ? 'selected' : ''}>${escapeForHtmlText(zone)}</option>`).join('');
  const byokHtml = byokProviders.map(provider => {
    const providerRecord = getByokProviderRecord(provider);
    const configured = Boolean(providerRecord);
    const fields = getByokPromptFields(provider);
    const editorOpen = activeByokEditor === provider;
    const formHtml = editorOpen ? `
      <div style="margin-top:8px; padding:10px; border:1px solid rgba(0,0,0,0.08); border-radius:10px; background:rgba(0,0,0,0.02); display:grid; gap:8px;">
        ${fields.map(field => `
          <input id="byok-${provider}-${field}" class="form-input" type="${field.toLowerCase().includes('secret') || field.toLowerCase().includes('key') ? 'password' : 'text'}" placeholder="${escapeForHtmlAttr(getByokFieldLabel(field))}" />
        `).join('')}
        <div style="display:flex; gap:8px;">
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="saveByokProviderFromForm('${provider}')">Save</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="closeByokEditor()">Cancel</button>
        </div>
      </div>
    ` : '';
    return `
      <div style="padding:10px 0; border-bottom:1px solid rgba(0,0,0,0.06);">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        <div>
          <div style="font-weight:600; text-transform: capitalize;">${escapeForHtmlText(provider)}</div>
          <div style="font-size:11px; color:var(--text-secondary);">
            ${configured ? 'Configured for this workspace' : 'Not configured'}
            ${providerRecord?.updatedAt ? `<span style="display:block; margin-top:2px;">Updated: ${escapeForHtmlText(new Date(providerRecord.updatedAt).toLocaleString())}</span>` : ''}
          </div>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="configureByokProvider('${provider}')">${configured ? 'Update' : 'Configure'}</button>
          ${configured ? `<button class="btn" style="padding:6px 10px; font-size:11px;" onclick="testByokProvider('${provider}')">Test</button><button class="btn" style="padding:6px 10px; font-size:11px;" onclick="rotateByokProvider('${provider}')">Rotate</button><button class="btn" style="padding:6px 10px; font-size:11px;" onclick="removeByokProvider('${provider}')">Remove</button>` : ''}
        </div>
        </div>
        ${formHtml}
      </div>
    `;
  }).join('');

  const integrationHtml = integrations.map(item => {
    const providerStatus = item.provider ? getProviderSecurityStatus(item.provider) : null;
    const hasOAuthSource = item.provider ? Boolean(providerStatus?.managed || providerStatus?.byok) : false;
    const authModeLabel = item.provider
      ? (providerStatus.byok && providerStatus.managed ? 'Quick Connect + BYOK available'
        : providerStatus.byok ? 'Using BYOK app credentials'
          : providerStatus.managed ? 'Quick Connect available'
            : 'OAuth app not configured yet')
      : '';
    const connectAction = item.status === 'connected'
      ? `toggleIntegration('${item.key}')`
      : (hasOAuthSource ? `toggleIntegration('${item.key}')` : (item.provider ? `openByokEditor('${item.provider}')` : ''));
    const connectLabel = item.status === 'connected'
      ? 'Disconnect'
      : (hasOAuthSource ? 'Connect (OAuth)' : 'Setup OAuth');
    return `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:10px 0; border-bottom:1px solid rgba(0,0,0,0.06);">
      <div>
        <div style="font-weight:600;">${escapeForHtmlText(item.name)}</div>
        <div style="font-size:11px; color:var(--text-secondary);">${escapeForHtmlText(item.detail)}</div>
        ${authModeLabel ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${escapeForHtmlText(authModeLabel)}</div>` : ''}
        ${settingsState.integrationAccounts?.[item.key]?.account ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Connected as: ${escapeForHtmlText(settingsState.integrationAccounts[item.key].account)}</div>` : ''}
        ${settingsState.integrationAccounts?.[item.key]?.lastSyncAt ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Last sync: ${escapeForHtmlText(new Date(settingsState.integrationAccounts[item.key].lastSyncAt).toLocaleString())}</div>` : ''}
        ${settingsState.integrationAccounts?.[item.key]?.lastSyncSummary ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${escapeForHtmlText(settingsState.integrationAccounts[item.key].lastSyncSummary)}</div>` : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:${item.status === 'connected' ? 'var(--status-green)' : 'var(--status-yellow)'};">
          ${escapeForHtmlText(item.status)}
        </div>
        ${['calendar','gmail','googleDrive','microsoft','slack'].includes(item.key) ? `<button class="btn" style="padding:6px 10px; font-size:11px;" onclick="${connectAction}">${connectLabel}</button>` : ''}
        ${['calendar','gmail','googleDrive','microsoft','slack'].includes(item.key) && item.status === 'connected' ? `<button class="btn" style="padding:6px 10px; font-size:11px;" onclick="runIntegrationSync('${item.key}')">Sync now</button>` : ''}
      </div>
    </div>
  `;
  }).join('');

  const staffingSummary = settingsState.staffingSummary || {};
  const staffingById = new Map((Array.isArray(teamStaffing) ? teamStaffing : []).map(member => [String(member.id || ''), member]));
  const availabilityTone = {
    available: 'var(--status-green)',
    busy: 'var(--status-yellow)',
    ooo: 'var(--status-red)',
    offline: 'var(--text-secondary)'
  };
  const teamRoster = teamMembers.map(member => {
    const staffing = staffingById.get(String(member.id || '')) || {};
    return {
      ...member,
      ...staffing,
      skills: Array.isArray(staffing.skills) ? staffing.skills : (Array.isArray(member.skills) ? member.skills : []),
      secondarySkills: Array.isArray(staffing.secondarySkills) ? staffing.secondarySkills : (Array.isArray(member.secondarySkills) ? member.secondarySkills : []),
      clients: Array.isArray(staffing.clients) ? staffing.clients : (Array.isArray(member.clients) ? member.clients : []),
      priorityRules: Array.isArray(staffing.priorityRules) ? staffing.priorityRules : (Array.isArray(member.priorityRules) ? member.priorityRules : []),
      effectiveAvailability: staffing.effectiveAvailability || member.availabilityStatus || 'available',
      activeAssignments: Number(staffing.activeAssignments || 0),
      blockedAssignments: Number(staffing.blockedAssignments || 0),
      completedAssignments: Number(staffing.completedAssignments || 0),
      activeHours: Number(staffing.activeHours || 0),
      capacityHoursRemaining: Number(staffing.capacityHoursRemaining ?? member.capacityHoursPerDay ?? 0),
      availableAssignmentSlots: Number(staffing.availableAssignmentSlots ?? member.maxConcurrentAssignments ?? 0),
      overloaded: Boolean(staffing.overloaded),
      routingEnabled: staffing.routingEnabled !== false && member.routingEnabled !== false
    };
  });
  const activeEditorMember = teamRoster.find(member => String(member.id || '') === String(activeTeamMemberEditorId || '')) || null;
  const formatDateInputValue = (value) => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toISOString().slice(0, 10);
  };
  const staffingMetricsHtml = [
    { label: 'Available', value: Number(staffingSummary.available || 0), tone: 'var(--status-green)' },
    { label: 'Busy', value: Number(staffingSummary.busy || 0), tone: 'var(--status-yellow)' },
    { label: 'OOO / Offline', value: Number(staffingSummary.ooo || 0) + Number(staffingSummary.offline || 0), tone: 'var(--status-red)' },
    { label: 'Overloaded', value: Number(staffingSummary.overloaded || 0), tone: 'var(--status-red)' },
    { label: 'Routing On', value: Number(staffingSummary.routingEnabled || 0), tone: 'var(--accent-blue, #3b82f6)' }
  ].map(card => `
    <div class="metric-card" style="min-width:0;">
      <div class="metric-value" style="color:${card.tone};">${card.value}</div>
      <div class="metric-label">${card.label}</div>
    </div>
  `).join('');
  const memberRows = teamRoster.map(member => {
    const memberId = String(member.id || '');
    const statusKey = String(member.effectiveAvailability || member.availabilityStatus || 'available').toLowerCase();
    const statusTone = availabilityTone[statusKey] || 'var(--text-secondary)';
    const skillsLabel = Array.isArray(member.skills) && member.skills.length ? member.skills.join(', ') : 'No skills tagged';
    const clientLabel = Array.isArray(member.clients) && member.clients.length ? member.clients.join(', ') : 'No client coverage';
    const loadLabel = `${member.activeAssignments} active / ${Number(member.maxConcurrentAssignments || 0)} max`;
    const hoursLabel = `${Number(member.activeHours || 0).toFixed(1)}h logged • ${Number(member.capacityHoursRemaining || 0).toFixed(1)}h left`;
    return `
      <div class="worklist-row" style="grid-template-columns: 1.25fr 0.95fr 1.25fr 1fr 1fr 0.9fr; align-items:start; ${activeEditorMember && String(activeEditorMember.id || '') === memberId ? "background:rgba(var(--accent-blue-rgb),0.08); border-color:rgba(var(--accent-blue-rgb),0.28);" : ""}">
        <div class="work-col title">
          <div style="font-weight:600;">${escapeForHtmlText(member.name || '-')}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${escapeForHtmlText(member.email || '-')}</div>
        </div>
        <div class="work-col owner">
          <div style="font-size:11px; font-weight:700; text-transform:uppercase;">${escapeForHtmlText(String(member.role || 'member'))}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${escapeForHtmlText(String(member.access || 'assigned-only'))}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Owner: ${escapeForHtmlText(member.assignedOwner || member.name || '-')}</div>
        </div>
        <div class="work-col client">
          <div style="font-size:12px;">${escapeForHtmlText(skillsLabel)}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">Clients: ${escapeForHtmlText(clientLabel)}</div>
        </div>
        <div class="work-col due">
          <div style="font-size:11px; font-weight:700; text-transform:uppercase; color:${statusTone};">${escapeForHtmlText(statusKey)}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${escapeForHtmlText(member.timezone || selectedTimezone)} • ${escapeForHtmlText(member.workingHoursStart || '09:00')}-${escapeForHtmlText(member.workingHoursEnd || '17:00')}</div>
          ${member.oooUntil ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">OOO until ${escapeForHtmlText(new Date(member.oooUntil).toLocaleDateString())}</div>` : ''}
        </div>
        <div class="work-col due">
          <div style="font-size:12px;">${escapeForHtmlText(loadLabel)}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${escapeForHtmlText(hoursLabel)}</div>
          <div style="font-size:11px; color:${member.overloaded ? 'var(--status-red)' : 'var(--text-secondary)'}; margin-top:2px;">${member.overloaded ? 'At or above capacity' : `${Number(member.availableAssignmentSlots || 0)} slots open`}</div>
        </div>
        <div class="work-col status">
          <div style="display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap;">
            <button class="btn" style="padding:5px 8px; font-size:11px;" onclick="openTeamMemberEditor('${escapeForJsString(memberId)}')">${activeEditorMember && String(activeEditorMember.id || '') === memberId ? 'Editing' : 'Edit'}</button>
            <button class="btn" style="padding:5px 8px; font-size:11px;" onclick="removeTeamMemberFromSettings('${escapeForJsString(memberId)}')">Remove</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
  const backupOptionsHtml = ['<option value="">No backup assignee</option>']
    .concat(teamRoster
      .filter(member => !activeEditorMember || String(member.id || '') !== String(activeEditorMember.id || ''))
      .map(member => `<option value="${escapeForHtmlAttr(String(member.id || ''))}" ${activeEditorMember && String(activeEditorMember.backupAssigneeId || '') === String(member.id || '') ? 'selected' : ''}>${escapeForHtmlText(member.name || member.email || member.id || 'Backup')}</option>`))
    .join('');
  const activeEditorHtml = activeEditorMember ? `
    <div id="settingsTeamMemberEditor" style="margin-bottom:14px; padding:14px; border:1px solid rgba(0,0,0,0.08); border-radius:12px; background:rgba(0,0,0,0.02); display:grid; gap:12px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
        <div>
          <div style="font-weight:700; font-size:14px;">Edit ${escapeForHtmlText(activeEditorMember.name || activeEditorMember.email || 'Team member')}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:3px;">These fields drive staffing visibility and future routing decisions.</div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn" style="padding:8px 12px;" onclick="saveTeamMemberFromSettings('${escapeForJsString(activeEditorMember.id || '')}')">Save Changes</button>
          <button class="btn" style="padding:8px 12px;" onclick="closeTeamMemberEditor()">Close</button>
        </div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:10px;">
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Name</span>
          <input id="settingsEditMemberName" class="form-input" value="${escapeForHtmlAttr(activeEditorMember.name || '')}" />
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Email</span>
          <input id="settingsEditMemberEmail" class="form-input" value="${escapeForHtmlAttr(activeEditorMember.email || '')}" />
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Role</span>
          <select id="settingsEditMemberRole" class="form-select">
            <option value="member" ${String(activeEditorMember.role || 'member') === 'member' ? 'selected' : ''}>Member</option>
            <option value="manager" ${String(activeEditorMember.role || '') === 'manager' ? 'selected' : ''}>Manager</option>
            <option value="admin" ${String(activeEditorMember.role || '') === 'admin' ? 'selected' : ''}>Admin</option>
          </select>
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Access</span>
          <select id="settingsEditMemberAccess" class="form-select">
            <option value="assigned-only" ${String(activeEditorMember.access || 'assigned-only') === 'assigned-only' ? 'selected' : ''}>Assigned Only</option>
            <option value="all-projects" ${String(activeEditorMember.access || '') === 'all-projects' ? 'selected' : ''}>All Projects</option>
          </select>
        </label>
        <label style="display:grid; gap:6px; grid-column: 1 / -1;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Assigned Owner Label</span>
          <input id="settingsEditMemberOwner" class="form-input" value="${escapeForHtmlAttr(activeEditorMember.assignedOwner || '')}" placeholder="Who this person appears as on assignments" />
        </label>
        <label style="display:grid; gap:6px; grid-column: 1 / -1;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Primary Skills</span>
          <input id="settingsEditMemberSkills" class="form-input" value="${escapeForHtmlAttr(Array.isArray(activeEditorMember.skills) ? activeEditorMember.skills.join(', ') : '')}" placeholder="Web, SEO, Automation" />
        </label>
        <label style="display:grid; gap:6px; grid-column: 1 / -1;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Secondary Skills</span>
          <input id="settingsEditMemberSecondarySkills" class="form-input" value="${escapeForHtmlAttr(Array.isArray(activeEditorMember.secondarySkills) ? activeEditorMember.secondarySkills.join(', ') : '')}" placeholder="Support skills or overflow coverage" />
        </label>
        <label style="display:grid; gap:6px; grid-column: 1 / -1;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Client Coverage</span>
          <input id="settingsEditMemberClients" class="form-input" value="${escapeForHtmlAttr(Array.isArray(activeEditorMember.clients) ? activeEditorMember.clients.join(', ') : '')}" placeholder="TFG, Digital 1010" />
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Availability</span>
          <select id="settingsEditMemberAvailability" class="form-select">
            <option value="available" ${String(activeEditorMember.effectiveAvailability || activeEditorMember.availabilityStatus || 'available') === 'available' ? 'selected' : ''}>Available</option>
            <option value="busy" ${String(activeEditorMember.effectiveAvailability || activeEditorMember.availabilityStatus || '') === 'busy' ? 'selected' : ''}>Busy</option>
            <option value="ooo" ${String(activeEditorMember.effectiveAvailability || activeEditorMember.availabilityStatus || '') === 'ooo' ? 'selected' : ''}>Out of Office</option>
            <option value="offline" ${String(activeEditorMember.effectiveAvailability || activeEditorMember.availabilityStatus || '') === 'offline' ? 'selected' : ''}>Offline</option>
          </select>
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Timezone</span>
          <select id="settingsEditMemberTimezone" class="form-select">${getTimezoneOptions().map(zone => `<option value="${escapeForHtmlAttr(zone)}" ${String(activeEditorMember.timezone || selectedTimezone) === zone ? 'selected' : ''}>${escapeForHtmlText(zone)}</option>`).join('')}</select>
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Capacity Hours / Day</span>
          <input id="settingsEditMemberCapacity" class="form-input" type="number" min="0" step="0.5" value="${escapeForHtmlAttr(String(activeEditorMember.capacityHoursPerDay ?? 6))}" />
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Max Concurrent Assignments</span>
          <input id="settingsEditMemberConcurrent" class="form-input" type="number" min="1" step="1" value="${escapeForHtmlAttr(String(activeEditorMember.maxConcurrentAssignments ?? 5))}" />
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Working Hours Start</span>
          <input id="settingsEditMemberHoursStart" class="form-input" type="time" value="${escapeForHtmlAttr(activeEditorMember.workingHoursStart || '09:00')}" />
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Working Hours End</span>
          <input id="settingsEditMemberHoursEnd" class="form-input" type="time" value="${escapeForHtmlAttr(activeEditorMember.workingHoursEnd || '17:00')}" />
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Out of Office Until</span>
          <input id="settingsEditMemberOooUntil" class="form-input" type="date" value="${escapeForHtmlAttr(formatDateInputValue(activeEditorMember.oooUntil))}" />
        </label>
        <label style="display:grid; gap:6px;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Backup Assignee</span>
          <select id="settingsEditMemberBackup" class="form-select">${backupOptionsHtml}</select>
        </label>
        <label style="display:grid; gap:6px; grid-column: 1 / -1;">
          <span style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.4px;">Slack User ID</span>
          <input id="settingsEditMemberSlackUserId" class="form-input" value="${escapeForHtmlAttr(activeEditorMember.slackUserId || '')}" placeholder="U01234567" />
        </label>
      </div>
      <div style="display:flex; gap:14px; flex-wrap:wrap; align-items:center;">
        <label style="display:flex; align-items:center; gap:8px; font-size:12px;">
          <input id="settingsEditMemberRoutingEnabled" type="checkbox" ${activeEditorMember.routingEnabled !== false ? 'checked' : ''} />
          Routing enabled
        </label>
        <label style="display:flex; align-items:center; gap:8px; font-size:12px;">
          <input id="settingsEditMemberActive" type="checkbox" ${activeEditorMember.active !== false ? 'checked' : ''} />
          Active team member
        </label>
      </div>
      <div style="font-size:11px; color:var(--text-secondary);">
        Live load: ${escapeForHtmlText(String(activeEditorMember.activeAssignments || 0))} active assignments, ${escapeForHtmlText(Number(activeEditorMember.activeHours || 0).toFixed(1))}h logged, ${escapeForHtmlText(String(activeEditorMember.availableAssignmentSlots || 0))} open slots.
      </div>
    </div>
  ` : `
    <div style="margin-top:14px; padding:14px; border:1px dashed rgba(0,0,0,0.12); border-radius:12px; font-size:12px; color:var(--text-secondary);">
      Select a team member to edit skills, availability, capacity, and routing coverage.
    </div>
  `;

  container.innerHTML = `
    <div class="worklist-toolbar">
      <div style="font-weight:700;">Workspace Settings</div>
      <div style="font-size:12px; color:var(--text-secondary);">Agency: ${escapeForHtmlText(currentAgencyId)}</div>
    </div>
    <div class="settings-metrics">
      <div class="metric-card"><div class="metric-value">${Number(settingsState.seatLimit || 0)}</div><div class="metric-label">Total Seats</div></div>
      <div class="metric-card"><div class="metric-value">${Number(settingsState.seatsUsed || teamMembers.length)}</div><div class="metric-label">Seats Used</div></div>
      <div class="metric-card"><div class="metric-value">${security.authRequired ? 'ON' : 'OFF'}</div><div class="metric-label">Auth Policy</div></div>
      <div class="metric-card"><div class="metric-value">${security.encryptionReady ? 'READY' : 'MISSING'}</div><div class="metric-label">Secret Encryption</div></div>
    </div>
    <div class="settings-grid" style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:16px; margin-top: 16px;">
      <div class="detail-section">
        <div class="detail-section-title">SUBSCRIPTION</div>
        <div class="detail-content">
          <div style="font-size:11px; color:var(--text-secondary); margin-bottom:10px;">Each tier has base seats. You can buy extra seats without changing tier.</div>
          <div style="display:grid; grid-template-columns: 1fr auto; gap:8px; margin-bottom: 10px;">
            <select id="settingsTierSelectMain" class="form-select" onchange="saveSubscriptionTier()">
              <option value="standard" ${tier === 'standard' ? 'selected' : ''}>Standard</option>
              <option value="premium" ${tier === 'premium' ? 'selected' : ''}>Premium</option>
            </select>
            <button class="btn" onclick="buyExtraSeatPack()" style="padding:8px 12px;">+5 Seats</button>
          </div>
          <div style="font-size:12px;"><strong>Base Seats:</strong> ${Number(settingsState.seatAllocation || (tier === 'premium' ? 20 : 5))}</div>
          <div style="font-size:12px;"><strong>Extra Seats:</strong> ${Number(settingsState.extraSeats || 0)}</div>
          <div style="font-size:12px;"><strong>Total Seats:</strong> ${Number(settingsState.seatLimit || 0)}</div>
          <div style="font-size:12px;"><strong>Used:</strong> ${Number(settingsState.seatsUsed || teamMembers.length)} • <strong>Available:</strong> ${Number(settingsState.seatsAvailable || 0)}</div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">WORKSPACE PROFILE</div>
        <div class="detail-content" style="display:grid; gap:6px;">
          <div style="font-size:12px;"><strong>Clients:</strong> ${clientsCount}</div>
          <div style="font-size:12px;"><strong>Categories:</strong> ${categoriesCount}</div>
          <div style="font-size:12px;"><strong>Agents:</strong> ${agentsCount}</div>
          <div style="font-size:12px;"><strong>Team Members:</strong> ${teamMembers.length}</div>
          <div style="font-size:12px;"><strong>Tier:</strong> ${escapeForHtmlText(tier.toUpperCase())}</div>
          <div style="margin-top:10px; display:grid; gap:8px;">
            <div style="font-size:11px; color:var(--text-secondary); text-transform: uppercase; letter-spacing: 0.4px;">Timezone</div>
            <div style="display:grid; grid-template-columns: 1fr auto; gap:8px;">
              <select id="settingsTimezoneSelect" class="form-select">${timezoneOptionsHtml}</select>
              <button class="btn" onclick="saveWorkspaceTimezone()" style="padding:8px 12px;">Save</button>
            </div>
          </div>
        </div>
      </div>
      <div class="detail-section" style="grid-column: 1 / -1;">
        <div class="detail-section-title">TEAM DIRECTORY & STAFFING</div>
        <div class="detail-content">
          <div style="font-size:11px; color:var(--text-secondary); margin-bottom:12px;">Capture who can take which work, how much room they have left, and who should cover when someone is out. This is the foundation for skill-based routing.</div>
          <div class="settings-metrics" style="margin-bottom:12px;">${staffingMetricsHtml}</div>
          <form onsubmit="addTeamMemberFromSettings(event)" style="display:grid; gap:10px; margin-bottom:12px;">
            <div style="display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:8px;">
              <input id="settingsMemberName" class="form-input" placeholder="Name" required />
              <input id="settingsMemberEmail" class="form-input" placeholder="Email" required />
              <select id="settingsMemberRole" class="form-select">
                <option value="member">Member</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
              <select id="settingsMemberAccess" class="form-select">
                <option value="assigned-only">Assigned Only</option>
                <option value="all-projects">All Projects</option>
              </select>
            </div>
            <div style="display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:8px;">
              <input id="settingsMemberOwner" class="form-input" placeholder="Assigned owner label" />
              <input id="settingsMemberSkills" class="form-input" placeholder="Primary skills" />
              <input id="settingsMemberClients" class="form-input" placeholder="Client coverage" />
              <select id="settingsMemberAvailability" class="form-select">
                <option value="available">Available</option>
                <option value="busy">Busy</option>
                <option value="ooo">Out of Office</option>
                <option value="offline">Offline</option>
              </select>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr auto; gap:8px; align-items:center;">
              <input id="settingsMemberCapacity" class="form-input" type="number" min="0" step="0.5" value="6" placeholder="Capacity hours/day" />
              <input id="settingsMemberConcurrent" class="form-input" type="number" min="1" step="1" value="5" placeholder="Max concurrent assignments" />
              <select id="settingsMemberTimezone" class="form-select">${timezoneOptionsHtml}</select>
              <label style="display:flex; align-items:center; gap:8px; font-size:12px; white-space:nowrap;">
                <input id="settingsMemberRoutingEnabled" type="checkbox" checked />
                Routing enabled
              </label>
            </div>
            <div style="display:flex; justify-content:flex-end;">
              <button class="btn" style="padding:8px 12px;">Add Team Member</button>
            </div>
          </form>
          ${activeEditorHtml}
          <div class="worklist-table compact">
            <div class="worklist-header" style="grid-template-columns: 1.25fr 0.95fr 1.25fr 1fr 1fr 0.9fr;">
              <div class="work-col title">TEAM MEMBER</div>
              <div class="work-col owner">ROLE & ACCESS</div>
              <div class="work-col client">SKILLS & CLIENTS</div>
              <div class="work-col due">AVAILABILITY</div>
              <div class="work-col due">CAPACITY</div>
              <div class="work-col status">ACTIONS</div>
            </div>
            <div class="worklist-body">${memberRows || '<div class="worklist-empty">No team members added yet.</div>'}</div>
          </div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">BRANDING</div>
        <div id="settingsBrandingBlockMain" class="detail-content"></div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">TOOLS & INTEGRATIONS</div>
        <div class="detail-content">${integrationHtml}</div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">SECURITY FOUNDATION</div>
        <div class="detail-content" style="display:grid; gap:6px;">
          <div style="font-size:12px;"><strong>Auth:</strong> ${security.authRequired ? 'Required' : 'Not Required'}</div>
          <div style="font-size:12px;"><strong>Encryption Policy:</strong> ${security.encryptionRequired ? 'Required' : 'Optional'}</div>
          <div style="font-size:12px;"><strong>Secret Encryption:</strong> ${security.encryptionReady ? 'Ready' : 'Not configured (set SECRET_ENCRYPTION_KEY)'}</div>
          <div style="font-size:12px;"><strong>Tenant:</strong> ${escapeForHtmlText(security.tenant || currentAgencyId)}</div>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">ADVANCED BYOK (OPTIONAL)</div>
        <div class="detail-content">
          <div style="font-size:12px; color:var(--text-secondary); margin-bottom:10px;">Most users should use <strong>Connect (OAuth)</strong> above. BYOK is for teams bringing their own app credentials.</div>
          ${security.encryptionReady ? '' : '<div style="font-size:12px; color:var(--status-red); margin-bottom:10px;">Encryption key missing. Set <strong>SECRET_ENCRYPTION_KEY</strong> on server before saving BYOK credentials.</div>'}
          <details ${activeByokEditor ? 'open' : ''}>
            <summary style="cursor:pointer; font-size:12px; font-weight:600; margin-bottom:8px;">Manage BYOK Providers</summary>
            ${byokHtml}
          </details>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">DATA SOURCES</div>
        <div class="detail-content">
          <div style="font-size:12px; margin-bottom:8px;">Connect and audit file systems and cloud drives.</div>
          <button class="btn" onclick="openManageFileHubModal()" style="padding:8px 12px;">Manage File Hub</button>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">GOVERNANCE</div>
        <div class="detail-content">
          <div style="font-size:12px; margin-bottom:8px;">Controls for auditing and operational quality.</div>
          <button class="btn" onclick="openManageClientsModal()" style="padding:8px 12px; margin-right:8px;">Manage Clients</button>
          <button class="btn" onclick="openManageCategoriesModal()" style="padding:8px 12px;">Manage Categories</button>
        </div>
      </div>
      <div class="detail-section">
        <div class="detail-section-title">PERMISSIONS MODEL</div>
        <div class="detail-content">
          <div style="font-size:12px; margin-bottom:6px;"><strong>assigned-only</strong>: user sees assigned owner projects only.</div>
          <div style="font-size:12px;"><strong>all-projects</strong>: user can view full workspace projects.</div>
        </div>
      </div>
    </div>
  `;

  renderSettingsBrandingBlock();
}

function triggerLogoUpload() {
  const input = document.getElementById('logoFileInput');
  if (input) input.click();
}

async function onLogoFileSelected(event) {
  if (!isPremiumTier()) {
    showNotification('Custom logo is Premium only.', 'error');
    event.target.value = '';
    return;
  }
  const file = event?.target?.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showNotification('Please select an image file.', 'error');
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    showNotification('Logo file must be under 2MB.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await saveBranding({ logoDataUrl: String(reader.result || ''), logoUrl: null });
      showNotification('Logo updated.', 'success');
    } catch (error) {
      console.error('Failed to save logo:', error);
      showNotification(error.message || 'Failed to save logo', 'error');
    }
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

async function setLogoFromUrl() {
  if (!isPremiumTier()) {
    showNotification('Custom logo is Premium only.', 'error');
    return;
  }
  const input = prompt('Enter logo URL (https://... or /public/path/logo.svg):', data?.branding?.logoUrl || '');
  if (input === null) return;
  const logoUrl = String(input || '').trim();
  if (!logoUrl) {
    showNotification('Logo URL cannot be empty.', 'error');
    return;
  }
  try {
    await saveBranding({ logoUrl, logoDataUrl: null });
    showNotification('Logo URL saved.', 'success');
  } catch (error) {
    console.error('Failed to save logo URL:', error);
    showNotification(error.message || 'Failed to save logo URL', 'error');
  }
}

async function resetLogoBranding() {
  if (!isPremiumTier()) {
    showNotification('Custom logo is Premium only.', 'error');
    return;
  }
  try {
    await saveBranding({ logoUrl: null, logoDataUrl: null });
    showNotification('Logo reset to default.', 'success');
  } catch (error) {
    console.error('Failed to reset logo:', error);
    showNotification(error.message || 'Failed to reset logo', 'error');
  }
}

async function loadData() {
  try {
    const [dataResponse, towerResponse] = await Promise.all([
      fetch(apiUrl('data')),
      fetch(apiUrl('control-tower')).catch(() => null)
    ]);
    data = await dataResponse.json();
    if (towerResponse && towerResponse.ok) {
      controlTower = await towerResponse.json();
    } else {
      controlTower = { workers: [], activity: [], kpis: {} };
    }
    projects = data.projects || [];
    data.subscriptionTier = String(data.subscriptionTier || 'standard').toLowerCase();
    await refreshSettingsState();
    await refreshAuthSessionContext();
    applyBranding();
    renderFooterMeta();
    await handleOAuthReturnFromUrl();

    // Check for incomplete onboarding and show banner
    if (settingsState.onboardingStatus && !settingsState.onboardingStatus.completed) {
      const steps = settingsState.onboardingStatus.steps || {};
      const done = Object.values(steps).filter(s => s === 'connected' || s === 'skipped').length;
      const total = Object.keys(steps).length || 4;
      if (done < total) renderSetupBanner(done, total);
      // Re-open wizard if returning from OAuth
      if (sessionStorage.getItem('setupWizardActive') === 'true') {
        setupWizardState = settingsState.onboardingStatus;
        renderSetupWizard();
      }
    }

    // Update agency display
    updateAgencyDisplay(data.agency || currentAgencyId);

    // DEBUG: Log project count and check TFG projects
    console.log(' Dashboard loaded', projects.length, 'projects');
    
    const tfgProjects = projects.filter(p => 
        p.id === 'D1010-OPS-198096' || 
        p.id === 'D1010-DEV-298967' ||
        (p.name && p.name.includes('TFG'))
    );
    
    console.log('TFG projects found:', tfgProjects.length);
    tfgProjects.forEach(p => {
        console.log('  -', p.id, ':', p.name);
        console.log('    Status:', p.status, 'Category:', p.category);
    });
    
    // Check if any filters are active
    console.log('Active filters:', {
        category: currentFilter,
        status: currentStatusFilter,
        client: currentClientFilter,
        search: searchTerm
    });

    
    // Ensure categories exist
    if (!data.categories) {
      data.categories = [
        { name: 'Marketing', emoji: '' },
        { name: 'Creative', emoji: '' },
        { name: 'Operations', emoji: '' },
        { name: 'Development', emoji: '' }
      ];
    }
    
    populateCategoryFilters();
    populateClientFilters();
    renderProjects();
    renderCalendarLaneNav();
    updateStats();
    renderFileHub();
    renderActivityFeed();
    renderAgents();
    if (currentView === 'agents') {
      renderAgentsWorkspace();
    }
    if (currentView === 'settings') {
      renderSettingsView();
    }
    if (currentView === 'conversations') {
      await loadConversations(true);
      await loadMyAssignments();
      renderConversationsView();
    }
    if (currentView === 'finance') {
      renderFinanceView();
    }
    if (currentView === 'pl') {
      renderPLView();
    }
    
    // Refresh calendar if it's active
    if (calendar && currentView === 'calendar') {
      calendar.refetchEvents();
      updateCalendarTitle();
    }
  } catch (error) {
    console.error('Failed to load data:', error);
  }
}

// Update agency display in UI
function updateAgencyDisplay(agencyId) {
  const agencyElement = document.getElementById('agencyName');
  const agencyIndicator = document.getElementById('agencyIndicator');

  if (agencyElement && agencyIndicator) {
    const displayName = agencyId === 'default'
      ? 'Digital1010'
      : agencyId.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    agencyElement.textContent = displayName;
    if (agencyId.startsWith('test-')) {
      agencyIndicator.querySelector('span:first-child').style.background = 'var(--status-yellow)';
    } else if (agencyId === 'default') {
      agencyIndicator.querySelector('span:first-child').style.background = 'var(--accent-purple)';
    } else {
      agencyIndicator.querySelector('span:first-child').style.background = 'var(--accent-blue)';
    }
  }
  renderFooterMeta();
}

function renderFooterMeta() {
  const versionEl = document.getElementById('footerVersion');
  const agencyEl = document.getElementById('footerAgency');
  const securityEl = document.getElementById('footerSecurity');
  const authEl = document.getElementById('footerAuth');
  const logoutBtn = document.getElementById('footerLogoutBtn');
  if (versionEl) versionEl.textContent = 'Mission Control v1.0.2';
  if (agencyEl) agencyEl.textContent = `Agency: ${currentAgencyId}`;
  if (securityEl) {
    const auth = settingsState.securityStatus?.authRequired ? 'auth on' : 'auth off';
    const enc = settingsState.securityStatus?.encryptionReady ? 'enc on' : 'enc off';
    securityEl.textContent = `Security: ${auth} | ${enc}`;
  }
  if (authEl) {
    const expiresAt = getSessionExpiresAt();
    if (!settingsState.securityStatus?.authRequired) {
      authEl.textContent = 'Session: open';
    } else if (getSessionToken() && expiresAt) {
      const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      const minutes = Math.floor(seconds / 60);
      authEl.textContent = `Session: ${minutes}m`;
    } else {
      authEl.textContent = 'Session: signed out';
    }
  }
  if (logoutBtn) {
    logoutBtn.style.display = settingsState.securityStatus?.authRequired && getSessionToken() ? 'inline-flex' : 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateAgencyDisplay(currentAgencyId);

  // Handle social sign-in auth token from redirect URL
  const urlParams = new URLSearchParams(window.location.search);
  const authToken = urlParams.get('authToken');
  if (authToken) {
    setSessionToken(authToken, urlParams.get('expiresAt') || '');
    // Clean token from URL
    urlParams.delete('authToken');
    urlParams.delete('expiresAt');
    const cleanUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
    window.history.replaceState({}, '', cleanUrl);
  }

  // Check if setup wizard should show
  const viewParam = new URLSearchParams(window.location.search).get('view');
  if (viewParam === 'setup') {
    setTimeout(() => showSetupWizard(), 500);
  }

  // main tabs fallback handler (guards against stale inline handlers)
  const tabs = document.getElementById('mainViewTabs');
  if (tabs) {
    tabs.addEventListener('click', (event) => {
      const btn = event.target.closest('.view-tab[data-view]');
      if (!btn) return;
      const view = String(btn.dataset.view || '').trim();
      if (!view) return;
      event.preventDefault();
      switchView(view);
    });
  }
});

// ─── Setup Wizard ──────────────────────────────────────────────────────────────
let setupWizardState = null;

async function showSetupWizard() {
  try {
    const res = await fetch(apiUrl('/api/onboarding/status'), { headers: { Authorization: `Bearer ${getSessionToken()}` } });
    if (res.ok) {
      setupWizardState = await res.json();
      if (setupWizardState.completed) return; // Already done
    } else {
      setupWizardState = { completed: false, steps: { slack: 'pending', gmail: 'pending', calendar: 'pending', team: 'pending' } };
    }
  } catch (_) {
    setupWizardState = { completed: false, steps: { slack: 'pending', gmail: 'pending', calendar: 'pending', team: 'pending' } };
  }
  renderSetupWizard();
}

function renderSetupWizard() {
  if (!setupWizardState || setupWizardState.completed) return;
  let existing = document.getElementById('setupWizardOverlay');
  if (existing) existing.remove();

  const steps = setupWizardState.steps || {};
  const stepDefs = [
    { key: 'slack', name: 'Slack', icon: '#', desc: 'Get task notifications and alerts in your Slack workspace.', action: 'connect' },
    { key: 'gmail', name: 'Gmail', icon: '@', desc: 'Import emails as tasks and sync your inbox.', action: 'connect' },
    { key: 'calendar', name: 'Calendar', icon: 'C', desc: 'Sync meetings and due dates automatically.', action: 'connect' },
    { key: 'team', name: 'Invite Team', icon: '+', desc: 'Add your team members to start collaborating.', action: 'team' }
  ];
  const doneCount = Object.values(steps).filter(s => s === 'connected' || s === 'skipped').length;
  const pct = Math.round((doneCount / stepDefs.length) * 100);

  const stepsHtml = stepDefs.map((s, i) => {
    const state = steps[s.key] || 'pending';
    const isDone = state === 'connected' || state === 'skipped';
    const statusBadge = state === 'connected' ? '<span style="color:#18794e; font-weight:600; font-size:12px;">Connected</span>'
      : state === 'skipped' ? '<span style="color:#8b8d94; font-size:12px;">Skipped</span>'
      : '';
    const connectBtn = isDone ? '' : (s.action === 'connect'
      ? `<button class="setup-btn setup-btn-primary" onclick="setupWizardConnect('${s.key}')">Connect ${s.name}</button><button class="setup-btn setup-btn-ghost" onclick="setupWizardSkip('${s.key}')">Skip</button>`
      : `<button class="setup-btn setup-btn-primary" onclick="setupWizardTeam()">Add Members</button><button class="setup-btn setup-btn-ghost" onclick="setupWizardSkip('${s.key}')">Skip</button>`);

    return `
      <div class="setup-step ${isDone ? 'setup-step-done' : ''}" style="--step-index: ${i};">
        <div class="setup-step-icon">${isDone ? '&#10003;' : s.icon}</div>
        <div class="setup-step-body">
          <div class="setup-step-title">${s.name} ${statusBadge}</div>
          <div class="setup-step-desc">${s.desc}</div>
          ${!isDone ? `<div class="setup-step-actions">${connectBtn}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  const overlay = document.createElement('div');
  overlay.id = 'setupWizardOverlay';
  overlay.innerHTML = `
    <style>
      #setupWizardOverlay {
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(18, 24, 38, 0.55); backdrop-filter: blur(4px);
        display: grid; place-items: center; padding: 24px;
        animation: setupFadeIn 0.25s ease;
      }
      @keyframes setupFadeIn { from { opacity: 0; } to { opacity: 1; } }
      .setup-card {
        width: min(520px, 100%); background: #fff; border-radius: 18px;
        padding: 32px; box-shadow: 0 24px 60px rgba(0,0,0,0.18);
        max-height: 90vh; overflow-y: auto;
      }
      .setup-card h2 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.02em; }
      .setup-card .setup-subtitle { color: #5b6473; font-size: 14px; margin-bottom: 20px; }
      .setup-progress { background: #e8ecf1; border-radius: 8px; height: 8px; margin-bottom: 24px; overflow: hidden; }
      .setup-progress-bar { height: 100%; border-radius: 8px; background: linear-gradient(90deg, #2f6ea4, #4a90d9); transition: width 0.4s ease; }
      .setup-step {
        display: flex; gap: 14px; padding: 16px 0;
        border-bottom: 1px solid #edf0f4;
        animation: setupStepIn 0.3s ease calc(var(--step-index) * 0.08s) both;
      }
      @keyframes setupStepIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .setup-step:last-child { border-bottom: none; }
      .setup-step-done { opacity: 0.6; }
      .setup-step-icon {
        width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
        background: #f0f4f8; display: grid; place-items: center;
        font-size: 18px; font-weight: 700; color: #2f6ea4;
      }
      .setup-step-done .setup-step-icon { background: #e8f5e9; color: #18794e; }
      .setup-step-body { flex: 1; min-width: 0; }
      .setup-step-title { font-weight: 600; font-size: 15px; margin-bottom: 2px; display: flex; align-items: center; gap: 8px; }
      .setup-step-desc { color: #5b6473; font-size: 13px; line-height: 1.4; }
      .setup-step-actions { margin-top: 10px; display: flex; gap: 8px; }
      .setup-btn {
        border: none; border-radius: 8px; padding: 8px 16px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        transition: background 0.15s, opacity 0.15s;
      }
      .setup-btn-primary { background: #2f6ea4; color: #fff; }
      .setup-btn-primary:hover { background: #245a88; }
      .setup-btn-ghost { background: transparent; color: #5b6473; }
      .setup-btn-ghost:hover { background: #f0f4f8; }
      .setup-footer {
        margin-top: 20px; display: flex; justify-content: space-between; align-items: center;
      }
      .setup-footer-skip { color: #5b6473; font-size: 13px; cursor: pointer; background: none; border: none; }
      .setup-footer-skip:hover { color: #2f6ea4; }
      .setup-footer-go {
        background: #18794e; color: #fff; border: none; border-radius: 10px;
        padding: 10px 22px; font-size: 14px; font-weight: 600; cursor: pointer;
      }
      .setup-footer-go:hover { background: #14653f; }
    </style>
    <div class="setup-card">
      <h2>Set up your workspace</h2>
      <div class="setup-subtitle">Connect your tools to get the most out of Mission Control.</div>
      <div class="setup-progress"><div class="setup-progress-bar" style="width: ${pct}%;"></div></div>
      ${stepsHtml}
      <div class="setup-footer">
        <button class="setup-footer-skip" onclick="dismissSetupWizard()">I'll do this later</button>
        <button class="setup-footer-go" onclick="completeSetupWizard()">Go to Dashboard</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function setupWizardConnect(integration) {
  try {
    const res = await fetch(apiUrl(`/api/integrations/${integration}/connect`), {
      headers: { Authorization: `Bearer ${getSessionToken()}` }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.authorizationUrl) {
      showNotification(body.error || `Failed to start ${integration} OAuth`, 'error');
      return;
    }
    // Store wizard state so we return to it after OAuth
    sessionStorage.setItem('setupWizardActive', 'true');
    window.location.assign(body.authorizationUrl);
  } catch (err) {
    showNotification(`Failed to connect ${integration}: ${err.message}`, 'error');
  }
}

async function setupWizardSkip(step) {
  try {
    await fetch(apiUrl('/api/onboarding/step'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSessionToken()}` },
      body: JSON.stringify({ step, action: 'skip' })
    });
    if (setupWizardState && setupWizardState.steps) {
      setupWizardState.steps[step] = 'skipped';
    }
    renderSetupWizard();
  } catch (_) {}
}

function setupWizardTeam() {
  dismissSetupWizard();
  switchView('settings');
  showNotification('Add team members in the Team section below.', 'info');
}

async function completeSetupWizard() {
  try {
    await fetch(apiUrl('/api/onboarding/complete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSessionToken()}` }
    });
  } catch (_) {}
  dismissSetupWizard();
}

function renderSetupBanner(done, total) {
  if (document.getElementById('setupBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'setupBanner';
  banner.style.cssText = 'position:fixed; bottom:16px; right:16px; z-index:9000; background:#fff; border:1px solid #d8e0ea; border-radius:12px; padding:12px 18px; box-shadow:0 8px 24px rgba(0,0,0,0.1); display:flex; align-items:center; gap:12px; font-size:13px; animation:setupFadeIn 0.3s ease;';
  banner.innerHTML = `
    <div style="font-weight:600;">Finish setup (${done}/${total})</div>
    <button onclick="showSetupWizard()" style="background:#2f6ea4; color:#fff; border:none; border-radius:8px; padding:6px 14px; font-size:12px; font-weight:600; cursor:pointer;">Continue</button>
    <button onclick="this.parentElement.remove()" style="background:none; border:none; color:#5b6473; cursor:pointer; font-size:16px; padding:0 4px;">&times;</button>
  `;
  document.body.appendChild(banner);
}

function dismissSetupWizard() {
  const overlay = document.getElementById('setupWizardOverlay');
  if (overlay) overlay.remove();
  sessionStorage.removeItem('setupWizardActive');
  // Clean view=setup from URL
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') === 'setup') {
    params.delete('view');
    const next = params.toString() ? `?${params.toString()}` : window.location.pathname;
    window.history.replaceState({}, '', next);
  }
}

// Populate category filters
function populateCategoryFilters() {
  const categories = (data.categories || [
    { name: 'Marketing', emoji: '' },
    { name: 'Creative', emoji: '' },
    { name: 'Operations', emoji: '' },
    { name: 'Development', emoji: '' }
  ]).sort((a, b) => a.name.localeCompare(b.name));
  
  const container = document.getElementById('categoryFilters');
  
  let html = '<button class="filter-btn active" data-filter="all"> All Projects</button>';
  
  html += categories.map(cat => 
    `<button class="filter-btn" data-filter="${cat.name}">${cat.emoji} ${cat.name}</button>`
  ).join('');
  
  container.innerHTML = html;
  
  // Add click handlers
  container.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderProjects();
    });
  });
  
  // Also populate task form category dropdown
  const taskCategorySelect = document.getElementById('taskCategory');
  if (taskCategorySelect) {
    taskCategorySelect.innerHTML = categories.map(cat => 
      `<option value="${cat.name}">${cat.emoji} ${cat.name}</option>`
    ).join('');
  }
}

// Populate client filters — uses canonical client registry
async function populateClientFilters() {
  const container = document.getElementById('clientFilters');
  if (!container) return;

  let clientList = [];
  try {
    const resp = await fetch(apiUrl('/api/clients'));
    if (resp.ok) {
      const body = await resp.json();
      clientList = body.clients || [];
    }
  } catch (e) { /* fallback below */ }

  // Fallback: derive from projects if API fails
  if (clientList.length === 0) {
    const names = [...new Set(projects.map(p => p.clientName).filter(Boolean))].sort();
    clientList = names.map(n => ({ name: n, activeCount: 0, isRegistered: false, status: 'unknown' }));
  }

  // Filter out empty/internal and sort: registered active first, then by active count
  const visible = clientList.filter(c => c.name && c.name !== 'Unassigned' && c.status !== 'internal');

  if (visible.length === 0) {
    container.innerHTML = '<div style="font-size: 12px; color: var(--text-secondary); padding: 8px;">No clients found</div>';
    return;
  }

  container.innerHTML = visible.map(client => {
    const badge = client.activeCount > 0
      ? `<span style="background:rgba(61,116,168,0.12);color:#3d74a8;padding:1px 6px;border-radius:6px;font-size:10px;font-weight:600;margin-left:auto;flex-shrink:0;">${client.activeCount}</span>`
      : '';
    const regDot = client.isRegistered
      ? ''
      : '<span style="width:6px;height:6px;border-radius:50%;background:#ff9500;flex-shrink:0;" title="Not in client registry"></span>';
    return `<button class="filter-btn" data-client="${client.name}" style="display:flex;align-items:center;gap:6px;width:100%;text-align:left;">${regDot}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${client.name}</span>${badge}</button>`;
  }).join('');

  // Add click handlers
  container.querySelectorAll('.filter-btn[data-client]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) {
        btn.classList.remove('active');
        currentClientFilter = null;
      } else {
        container.querySelectorAll('.filter-btn[data-client]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentClientFilter = btn.dataset.client;
      }
      renderProjects();
    });
  });

  // Also populate task form client dropdown
  const taskClientSelect = document.getElementById('taskClient');
  if (taskClientSelect) {
    taskClientSelect.innerHTML = '<option value="">Select Client</option>' +
      visible.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  }
}

// Update header stats
function updateStats() {
  // Stats removed from UI - keeping function for compatibility
}

function toDateSafe(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getPrimaryProjectDate(project) {
  // Primary sort date should represent project activity recency, not due date.
  return (
    toDateSafe(project.lastUpdated) ||
    toDateSafe(project.createdAt) ||
    toDateSafe(project.createdDate) ||
    toDateSafe(project.startDate) ||
    toDateSafe(project.dueDate) ||
    new Date(0)
  );
}

function getDueOrPrimaryDate(project) {
  return toDateSafe(project.dueDate) || getPrimaryProjectDate(project);
}

function getPriorityRank(priority) {
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return order[String(priority || '').toUpperCase()] ?? 9;
}

function formatDateShort(value) {
  const d = toDateSafe(value);
  if (!d) return 'No date';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'No heartbeat';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'No heartbeat';
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / (1000 * 60));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function relativeDueLabel(project) {
  const due = toDateSafe(project.dueDate);
  if (!due) return 'No due date';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const diff = Math.floor((dueDay - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  return `Due in ${diff}d`;
}

function getOperationalStatusRank(project) {
  const status = getEffectiveStatus(project);
  const due = toDateSafe(project.dueDate);
  const now = new Date();
  const isOverdue = due && due < now && status !== 'complete';
  const isUrgent = (String(project.priority || '').toUpperCase() === 'P0' || isOverdue) && status !== 'complete';

  if (isUrgent) return 0;
  if (status === 'new') return 1;
  if (status === 'in-progress') return 2;
  if (status === 'upcoming') return 3;
  if (status === 'blocked') return 4;
  if (status === 'complete') return 5;
  return 9;
}

function escapeForHtmlAttr(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeForHtmlText(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeForJsString(value) {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'");
}

function getEffectiveStatus(project) {
  const progress = Number(project.progress || 0);
  const now = new Date();
  const start = toDateSafe(project.startDate || project.createdAt || project.createdDate);
  const rawStatus = String(project.status || 'new').trim().toLowerCase().replace('_', '-');

  if (rawStatus === 'quality-review' || rawStatus === 'quality_review') return 'quality_review';
  if (rawStatus === 'blocked') return 'blocked';
  if (rawStatus === 'complete' || project.completedDate || progress >= 100) return 'complete';

  if ((rawStatus === 'upcoming' || (start && start > now && progress === 0)) && !project.completedDate) {
    return 'upcoming';
  }

  // Respect explicit in-progress state even when progress is still 0.
  if (rawStatus === 'in-progress' || rawStatus === 'in progress' || rawStatus === 'in_progress') {
    return 'in-progress';
  }

  if (project.deliveredDate || progress > 0) {
    return 'in-progress';
  }

  return 'new';
}

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getParentPath(pathValue) {
  if (!pathValue || pathValue === '/') return '/';
  if (pathValue === '/Volumes/' || pathValue === '/Volumes') return '/';
  if (pathValue === '/Users/ottomac/Library/CloudStorage/' || pathValue === '/Users/ottomac/Library/CloudStorage') return '/';
  const normalized = pathValue.endsWith('/') ? pathValue.slice(0, -1) : pathValue;
  const parent = normalized.substring(0, normalized.lastIndexOf('/')) || '/';
  const normalizedParent = parent.endsWith('/') ? parent : `${parent}/`;
  if (normalizedParent === '/Volumes/') return normalizedParent;
  if (normalizedParent === '/Users/ottomac/Library/CloudStorage/') return normalizedParent;
  if (!normalizedParent.startsWith('/Volumes/') && !normalizedParent.startsWith('/Users/ottomac/Library/CloudStorage/')) return '/';
  return normalizedParent;
}

function normalizeStartPath(pathValue) {
  const raw = String(pathValue || '').trim();
  if (!raw) return null;
  const normalized = raw.endsWith('/') ? raw : `${raw}/`;
  if (normalized === '/') return normalized;
  if (!normalized.startsWith('/Volumes/') && !normalized.startsWith('/Users/ottomac/Library/CloudStorage/')) return null;
  return normalized;
}

function showFilePreviewPlaceholder(title, subtitle = '') {
  const detailPanel = document.getElementById('detailPanel');
  if (!detailPanel) return;
  detailPanel.classList.remove('empty');
  detailPanel.classList.add('active');
  detailPanel.innerHTML = `
    <div style="padding: 18px;">
      <div style="font-size: 16px; font-weight: 700; margin-bottom: 8px;">${escapeForHtmlText(title)}</div>
      <div style="font-size: 12px; color: var(--text-secondary); white-space: pre-wrap;">${escapeForHtmlText(subtitle)}</div>
    </div>
  `;
}

function renderFileManager() {
  const container = document.getElementById('projectsContainer');
  if (!container) return;

  const folders = fileBrowserItems.filter(item => item.type === 'folder');
  const files = fileBrowserItems.filter(item => item.type === 'file');
  const parentPath = getParentPath(fileBrowserPath);

  const foldersHtml = folders.length
    ? folders.map(item => `
      <button class="worklist-row" style="width:100%; text-align:left; background:transparent; border:none; cursor:pointer;" onclick="openFileManagerPath('${escapeForJsString(item.path)}')">
        <div class="work-col id"></div>
        <div class="work-col title">${escapeForHtmlText(item.name)}</div>
        <div class="work-col owner">Folder</div>
        <div class="work-col due">${item.modified ? formatDateShort(item.modified) : '-'}</div>
        <div class="work-col priority">-</div>
        <div class="work-col status">Open</div>
      </button>
    `).join('')
    : '<div class="worklist-empty" style="padding:20px;">No folders</div>';

  const filesHtml = files.length
    ? files.map(item => {
      const active = selectedFilePath === item.path ? 'active' : '';
      return `
        <button class="worklist-row ${active}" style="width:100%; text-align:left; background:transparent; border:none; cursor:pointer;" onclick="openFileFromManager('${escapeForJsString(item.path)}')">
          <div class="work-col id">${escapeForHtmlText(item.icon || '')}</div>
          <div class="work-col title">${escapeForHtmlText(item.name)}</div>
          <div class="work-col owner">${escapeForHtmlText((item.path.split('.').pop() || '').toUpperCase() || 'FILE')}</div>
          <div class="work-col due">${item.modified ? formatDateShort(item.modified) : '-'}</div>
          <div class="work-col priority">${formatFileSize(item.size)}</div>
          <div class="work-col status">Preview</div>
        </button>
      `;
    }).join('')
    : '<div class="worklist-empty" style="padding:20px;">No files</div>';

  const errorHtml = fileBrowserError
    ? `<div style="margin:10px 0; color: var(--status-red); font-size: 12px;">${escapeForHtmlText(fileBrowserError)}</div>`
    : '';

  container.innerHTML = `
    <div class="worklist-shell">
      <div class="worklist-toolbar">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn" onclick="openFileManagerPath('${escapeForJsString(parentPath)}')" style="padding:7px 10px;"> Up</button>
          <button class="btn" onclick="refreshFileManager()" style="padding:7px 10px;">Refresh</button>
          <button class="btn" onclick="exitFileManager()" style="padding:7px 10px;">Back To Jobs</button>
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeForHtmlText(fileBrowserPath)}</div>
      </div>
      ${errorHtml}
      <div class="worklist-meta">Folders: <strong>${folders.length}</strong> • Files: <strong>${files.length}</strong></div>
      <div class="worklist-table ${listDensity}">
        <div class="worklist-header">
          <div class="work-col id">Type</div>
          <div class="work-col title">Name</div>
          <div class="work-col owner">Kind</div>
          <div class="work-col due">Modified</div>
          <div class="work-col priority">Size</div>
          <div class="work-col status">Action</div>
        </div>
        <div class="worklist-body">
          <details open style="border-bottom:1px solid rgba(0,0,0,0.08);">
            <summary style="padding:12px 10px; cursor:pointer; font-weight:700;">Folders (${folders.length})</summary>
            ${foldersHtml}
          </details>
          <details open>
            <summary style="padding:12px 10px; cursor:pointer; font-weight:700;">Files (${files.length})</summary>
            ${filesHtml}
          </details>
        </div>
      </div>
      ${fileBrowserLoading ? '<div class="worklist-meta">Loading...</div>' : ''}
    </div>
  `;
}

async function openFileManagerPath(pathValue) {
  centerMode = 'files';
  selectedProjectId = null;
  selectedFilePath = null;
  fileBrowserError = '';
  fileBrowserLoading = true;
  fileBrowserPath = pathValue || fileBrowserPath || fileBrowserStartPath || '/Volumes/';
  switchView('projects');
  showFilePreviewPlaceholder('File Preview', 'Select a file from the center panel to preview it here.');
  renderProjects();

  try {
    const response = await fetch(`/api/files/list?path=${encodeURIComponent(fileBrowserPath)}`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to list files');
    }
    const payload = await response.json();
    fileBrowserPath = payload.path || fileBrowserPath;
    fileBrowserItems = payload.items || [];
  } catch (error) {
    console.error('File manager list failed:', error);
    fileBrowserItems = [];
    fileBrowserError = error.message || 'Failed to load folder';
    showNotification(fileBrowserError, 'error');
  } finally {
    fileBrowserLoading = false;
    renderProjects();
  }
}

function refreshFileManager() {
  openFileManagerPath(fileBrowserPath);
}

function setCurrentAsFileStart() {
  if (!fileBrowserPath) return;
  const normalized = normalizeStartPath(fileBrowserPath);
  if (!normalized) {
    showNotification('Start path must be under /Volumes.', 'error');
    return;
  }
  fileBrowserStartPath = normalized;
  localStorage.setItem('fileBrowserStartPath', fileBrowserStartPath);
  renderFileHub();
  showNotification(`Start folder set: ${fileBrowserStartPath}`, 'success');
}

function chooseCustomFileStart() {
  const entered = prompt('Enter start folder path (must be under /Volumes):', fileBrowserStartPath || '/Volumes/');
  if (!entered) return;
  const normalized = normalizeStartPath(entered);
  if (!normalized) {
    showNotification('Invalid path. Use a folder under /Volumes.', 'error');
    return;
  }
  fileBrowserStartPath = normalized;
  localStorage.setItem('fileBrowserStartPath', fileBrowserStartPath);
  openFileManagerPath(fileBrowserStartPath);
  renderFileHub();
}

function exitFileManager() {
  centerMode = 'projects';
  fileBrowserError = '';
  fileBrowserLoading = false;
  fileBrowserItems = [];
  renderProjects();
  const detailPanel = document.getElementById('detailPanel');
  if (detailPanel) {
    detailPanel.classList.add('empty');
    detailPanel.innerHTML = '<div> Select a project to view details</div>';
  }
}

async function openFileFromManager(filePath) {
  if (!filePath) return;
  selectedFilePath = filePath;
  showFilePreviewPlaceholder('Loading file...', filePath);
  renderProjects();

  try {
    const response = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to read file');
    }
    const file = await response.json();
    const detailPanel = document.getElementById('detailPanel');
    if (!detailPanel) return;
    detailPanel.classList.remove('empty');
    detailPanel.classList.add('active');
    const content = String(file.content || '');
    const preview = content.length > 200000 ? `${content.slice(0, 200000)}\n\n... file truncated for preview ...` : content;
    detailPanel.innerHTML = `
      <div style="padding: 16px 16px 8px;">
        <div style="font-size: 16px; font-weight: 700; margin-bottom: 6px;">${escapeForHtmlText(file.name || 'File')}</div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 8px;">${escapeForHtmlText(file.path || filePath)}</div>
        <div style="font-size: 11px; color: var(--text-secondary);">Size: ${formatFileSize(file.size)} • Modified: ${escapeForHtmlText(formatDateShort(file.modified))}</div>
      </div>
      <div style="padding: 0 16px 16px;">
        <pre style="background: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; padding: 12px; max-height: calc(100vh - 330px); overflow: auto; font-size: 12px; line-height: 1.45; white-space: pre-wrap;">${escapeForHtmlText(preview)}</pre>
      </div>
    `;
  } catch (error) {
    console.error('File manager read failed:', error);
    showFilePreviewPlaceholder('Could not open file', error.message || 'Read failed');
    showNotification(error.message || 'Failed to read file', 'error');
  }
}

// Sort projects
function sortProjects(projectsList, sortBy) {
  const sorted = [...projectsList];
  
  switch(sortBy) {
    case 'newest':
      return sorted.sort((a, b) => getPrimaryProjectDate(b) - getPrimaryProjectDate(a));
    
    case 'oldest':
      return sorted.sort((a, b) => getPrimaryProjectDate(a) - getPrimaryProjectDate(b));
    
    case 'priority':
      // Sort by priority (P0 > P1 > P2)
      const priorityOrder = { 'P0': 0, 'P1': 1, 'P2': 2, 'P3': 3 };
      return sorted.sort((a, b) => {
        const aPriority = priorityOrder[a.priority] ?? 999;
        const bPriority = priorityOrder[b.priority] ?? 999;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return getPrimaryProjectDate(a) - getPrimaryProjectDate(b);
      });
    
    case 'alpha':
      // Sort by name alphabetically
      return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    case 'id-desc':
      return sorted.sort((a, b) => String(b.id || '').localeCompare(String(a.id || '')));

    case 'id-asc':
      return sorted.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));

    case 'name-asc':
      return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    case 'name-desc':
      return sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));

    case 'due-asc':
      return sorted.sort((a, b) => getDueOrPrimaryDate(a) - getDueOrPrimaryDate(b));

    case 'due-desc':
      return sorted.sort((a, b) => getDueOrPrimaryDate(b) - getDueOrPrimaryDate(a));

    case 'status-focus':
      return sorted.sort((a, b) => {
        const ar = getOperationalStatusRank(a);
        const br = getOperationalStatusRank(b);
        if (ar !== br) return ar - br;
        return getDueOrPrimaryDate(a) - getDueOrPrimaryDate(b);
      });
    
    default:
      return sorted;
  }
}

// Clear all active project filters
function clearAllProjectFilters() {
  currentFilter = 'all';
  currentStatusFilter = null;
  currentClientFilter = null;
  currentAgentFocus = null;
  searchTerm = '';

  const searchBox = document.getElementById('searchBox');
  if (searchBox) searchBox.value = '';

  document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === 'all');
  });

  document.querySelectorAll('.filter-btn[data-status]').forEach(btn => {
    btn.classList.remove('active');
  });

  document.querySelectorAll('.filter-btn[data-client]').forEach(btn => {
    btn.classList.remove('active');
  });
}

function getFilteredProjects() {
  let filtered = projects;

  if (currentFilter !== 'all') {
    filtered = filtered.filter(p => p.category === currentFilter);
  }

  if (currentStatusFilter) {
    filtered = filtered.filter(p => getEffectiveStatus(p) === currentStatusFilter);
  }

  if (currentClientFilter) {
    filtered = filtered.filter(p => p.clientName === currentClientFilter);
  }

  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = filtered.filter(p =>
      (p.name || '').toLowerCase().includes(term) ||
      (p.clientName || '').toLowerCase().includes(term) ||
      (p.owner || '').toLowerCase().includes(term) ||
      (p.id || '').toLowerCase().includes(term)
    );
  }

  if (currentAgentFocus) {
    filtered = filtered.filter(project => projectMatchesAgent(project, currentAgentFocus));
  }

  // Briefing drill-down filters (transient — cleared after first use)
  if (window._briefingDrillDown) {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
    filtered = filtered.filter(p => {
      const s = String(p.status || '').toLowerCase();
      if (s === 'complete' || s === 'completed' || s === 'archived' || s === 'delivered') return false;
      // New prospects check doesn't need dueDate
      if (window._briefingDrillDown === 'newProspects') return p.isNewProspect || (Array.isArray(p.tags) && p.tags.includes('new-prospect'));
      if (!p.dueDate) return false;
      const dStr = new Date(p.dueDate).toISOString().slice(0, 10);
      if (window._briefingDrillDown === 'overdue') return dStr < todayStr;
      if (window._briefingDrillDown === 'dueToday') return dStr === todayStr;
      if (window._briefingDrillDown === 'dueThisWeek') { const d = new Date(p.dueDate); return d >= now && d <= weekEnd; }
      return true;
    });
    delete window._briefingDrillDown;
  }

  if (window._briefingPriorityFilter) {
    const pf = window._briefingPriorityFilter;
    filtered = filtered.filter(p => {
      const s = String(p.status || '').toLowerCase();
      if (s === 'complete' || s === 'completed' || s === 'archived' || s === 'delivered') return false;
      return String(p.priority || 'P1').toUpperCase() === pf;
    });
    delete window._briefingPriorityFilter;
  }

  if (window._briefingOwnerFilter) {
    const of2 = window._briefingOwnerFilter;
    filtered = filtered.filter(p => {
      const s = String(p.status || '').toLowerCase();
      if (s === 'complete' || s === 'completed' || s === 'archived' || s === 'delivered') return false;
      if (of2 === 'Unassigned') return !p.owner || p.owner.trim() === '' || p.owner.toLowerCase() === 'unassigned';
      return String(p.owner || '').toLowerCase().includes(of2.toLowerCase());
    });
    delete window._briefingOwnerFilter;
  }

  return sortProjects(filtered, currentSort);
}

function projectMatchesAgent(project, agentName) {
  const target = String(agentName || '').trim().toLowerCase();
  if (!target) return true;
  const fields = [
    project.owner,
    project.createdBy,
    project.assignedTo,
    project.agent,
    project.lastUpdatedBy
  ].map(v => String(v || '').toLowerCase());
  if (fields.some(v => v === target || v.includes(target))) return true;

  if (Array.isArray(project.comments)) {
    const hasCommentMatch = project.comments.some(c => {
      const author = String(c.author || '').toLowerCase();
      return author === target || author.includes(target);
    });
    if (hasCommentMatch) return true;
  }

  if (Array.isArray(project.activityLog)) {
    const hasLogMatch = project.activityLog.some(item => {
      const actor = String(item.agent || item.author || '').toLowerCase();
      return actor === target || actor.includes(target);
    });
    if (hasLogMatch) return true;
  }

  return false;
}

function getOwnerOptions(currentOwner = '') {
  const fromProjects = (projects || []).map(p => p.owner).filter(Boolean);
  const fromAgents = ((data && data.agents) || []).map(a => a.name).filter(Boolean);
  const explicit = (data && Array.isArray(data.owners)) ? data.owners : [];
  const options = [...new Set([...explicit, ...fromProjects, ...fromAgents, currentOwner].filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  return options;
}

function buildStatusBuckets(filteredProjects) {
  const statuses = {
    'upcoming': { label: ' UPCOMING', emoji: '', projects: [], color: 'var(--accent-purple)' },
    'new': { label: ' NEW', emoji: '', projects: [], color: 'var(--accent-blue)' },
    'in-progress': { label: ' IN PROGRESS', emoji: '', projects: [], color: 'var(--status-yellow)' },
    'quality_review': { label: ' IN REVIEW', emoji: '', projects: [], color: 'var(--accent-blue)' },
    'blocked': { label: ' BLOCKED', emoji: '', projects: [], color: 'var(--status-gray)' },
    'complete': { label: ' COMPLETE', emoji: '', projects: [], color: 'var(--status-green)' },
    'urgent': { label: ' URGENT', emoji: '', projects: [], color: 'var(--status-red)' }
  };

  filteredProjects.forEach(project => {
    const status = getEffectiveStatus(project);
    if (statuses[status]) {
      statuses[status].projects.push(project);
    } else {
      statuses['new'].projects.push(project);
    }
  });

  // Keep lane order aligned with global sort selection from sortProjects().

  return statuses;
}

// Render projects
function renderProjects() {
  const container = document.getElementById('projectsContainer');
  if (centerMode === 'files') {
    renderFileManager();
    return;
  }
  
  const filtered = getFilteredProjects();
  const statuses = buildStatusBuckets(filtered);
  
  if (!statuses[currentLaneView]) currentLaneView = 'in-progress';

  const laneOrder = ['new', 'in-progress', 'quality_review', 'upcoming', 'blocked', 'complete'];
  const laneButtons = laneOrder.map(key => {
    const lane = statuses[key];
    const active = currentLaneView === key ? 'active' : '';
    return `<button class="lane-chip ${active}" onclick="setLaneView('${key}')">${lane.label.replace(/^.\s/, '')}<span>${lane.projects.length}</span></button>`;
  }).join('');

  const laneProjects = statuses[currentLaneView].projects;
  const totalInLane = laneProjects.length;
  const visible = laneProjects.slice(0, visibleRowCount);

  let rowsHtml = '';
  if (visible.length === 0) {
    rowsHtml = `<div class="worklist-empty">${currentAgentFocus ? `No jobs for ${escapeForHtmlText(currentAgentFocus)} in this lane.` : 'No jobs in this lane.'}</div>`;
  } else {
    rowsHtml = visible.map(project => {
      const isActive = project.id === selectedProjectId ? 'active' : '';
      const status = getEffectiveStatus(project);
      const dueText = relativeDueLabel(project);
      const dueClass = dueText.includes('overdue') ? 'overdue' : (dueText === 'Due today' ? 'today' : '');
      const statusLabel = getStatusLabel(status);
      return `
        <div class="worklist-row ${isActive}" onclick="selectProject('${project.id}')">
          <div class="work-col id">${project.id}</div>
          <div class="work-col client">${project.clientName || 'Unassigned'}</div>
          <div class="work-col title">${project.name || 'Untitled'}</div>
          <div class="work-col owner">${project.owner || 'Unassigned'}</div>
          <div class="work-col due ${dueClass}">${formatDateShort(project.dueDate)} · ${dueText}</div>
          <div class="work-col priority">${project.priority || 'P2'}</div>
          <div class="work-col status status-${status}">${statusLabel}</div>
        </div>
      `;
    }).join('');
  }

  const canLoadMore = totalInLane > visible.length;
  const agentFocusBanner = currentAgentFocus
    ? `<div class="worklist-meta" style="margin-top: 8px;">
         Agent focus: <strong>${escapeForHtmlText(currentAgentFocus)}</strong>
         <button class="btn" style="margin-left:8px; padding:4px 10px; font-size:11px;" onclick="clearAgentFocus()">Clear</button>
       </div>`
    : '';
  let html = `
    <div class="worklist-shell">
      <div class="worklist-toolbar">
        <div class="lane-chips">${laneButtons}</div>
        <div style="display:flex; align-items:center; gap:8px;">
          <select onchange="setTopSort(this.value)" style="padding: 7px 10px; border-radius: 10px; border: 1px solid rgba(0,0,0,0.12); font-size: 12px;">
            <option value="newest" ${currentSort === 'newest' ? 'selected' : ''}>Sort: Newest</option>
            <option value="oldest" ${currentSort === 'oldest' ? 'selected' : ''}>Sort: Oldest</option>
            <option value="id-desc" ${currentSort === 'id-desc' ? 'selected' : ''}>Sort: ID (Z-A)</option>
            <option value="id-asc" ${currentSort === 'id-asc' ? 'selected' : ''}>Sort: ID (A-Z)</option>
            <option value="name-asc" ${currentSort === 'name-asc' ? 'selected' : ''}>Sort: Name (A-Z)</option>
            <option value="name-desc" ${currentSort === 'name-desc' ? 'selected' : ''}>Sort: Name (Z-A)</option>
            <option value="due-asc" ${currentSort === 'due-asc' ? 'selected' : ''}>Sort: Due (Soonest)</option>
            <option value="due-desc" ${currentSort === 'due-desc' ? 'selected' : ''}>Sort: Due (Latest)</option>
            <option value="priority" ${currentSort === 'priority' ? 'selected' : ''}>Sort: Priority</option>
          </select>
          <div class="density-toggle">
            <button class="${listDensity === 'compact' ? 'active' : ''}" onclick="setListDensity('compact')">Compact</button>
            <button class="${listDensity === 'comfortable' ? 'active' : ''}" onclick="setListDensity('comfortable')">Comfortable</button>
          </div>
        </div>
      </div>
      ${agentFocusBanner}
      <div class="worklist-meta">
        Showing <strong>${visible.length}</strong> of <strong>${totalInLane}</strong> jobs in <strong>${statuses[currentLaneView].label.replace(/^.\s/, '')}</strong>
      </div>
      <div class="worklist-table ${listDensity}">
        <div class="worklist-header">
          <div class="work-col id">ID</div>
          <div class="work-col client">CLIENT</div>
          <div class="work-col title">TITLE</div>
          <div class="work-col owner">OWNER</div>
          <div class="work-col due">DUE</div>
          <div class="work-col priority">PRIORITY</div>
          <div class="work-col status">STATUS</div>
        </div>
        <div class="worklist-body">${rowsHtml}</div>
      </div>
      ${canLoadMore ? `<button class="worklist-load-more" onclick="loadMoreProjects()">Load 100 More</button>` : ''}
    </div>
  `;
  
  if (filtered.length === 0) {
    const filtersActive = currentFilter !== 'all' || !!currentStatusFilter || !!currentClientFilter || !!searchTerm;
    html = filtersActive
      ? '<div style="padding: 40px; text-align: center; color: var(--text-secondary);">' +
          '<div style="font-weight: 600; margin-bottom: 8px;">No projects match current filters</div>' +
          '<button class="btn btn-primary" onclick="clearAllProjectFilters(); renderProjects();">Clear Filters</button>' +
        '</div>'
      : '<div style="padding: 40px; text-align: center; color: var(--text-secondary);">No projects found</div>';
  }
  
  container.innerHTML = html;
}

function setLaneView(lane) {
  currentLaneView = lane;
  currentStatusFilter = null;
  document.querySelectorAll('.filter-btn[data-status]').forEach(btn => btn.classList.remove('active'));
  visibleRowCount = 100;
  renderProjects();
  renderCalendarLaneNav();
  if (calendar) {
    calendar.refetchEvents();
    ensureCalendarLaneHasVisibleEvents();
    updateCalendarTitle();
  }
}

function setListDensity(density) {
  listDensity = density;
  renderProjects();
}

function setTopSort(sortBy) {
  if (sortBy === 'status-focus') sortBy = 'newest';
  currentSort = sortBy;
  visibleRowCount = 100;
  renderProjects();
  renderCalendarLaneNav();
  if (calendar && currentView === 'calendar') {
    calendar.refetchEvents();
    updateCalendarTitle();
  }
}

function loadMoreProjects() {
  visibleRowCount += 100;
  renderProjects();
}

function focusAgentProjects(agentName) {
  if (!agentName) return;
  currentAgentFocus = agentName;
  visibleRowCount = 100;
  centerMode = 'projects';
  switchView('projects');
  renderProjects();

  const agent = workerDirectory[agentName] || (data.agents || []).find(a => a.name === agentName);
  const detailPanel = document.getElementById('detailPanel');
  if (detailPanel && agent) {
    detailPanel.classList.remove('empty');
    detailPanel.classList.add('active');
    detailPanel.innerHTML = `
      <div style="padding:18px;">
        <div style="font-size:16px; font-weight:700; margin-bottom:8px;">${escapeForHtmlText(agent.name || agentName)}</div>
        <div style="font-size:12px; color: var(--text-secondary); margin-bottom:8px;">
          Status: ${escapeForHtmlText(agent.status || 'idle')} • Model: ${escapeForHtmlText(agent.model || 'unreported')}
        </div>
        <div style="font-size:12px; color: var(--text-secondary); margin-bottom:6px;">
          Heartbeat: ${escapeForHtmlText(formatRelativeTime(agent.lastHeartbeatAt))}
        </div>
        ${agent.blockedReason ? `<div style="font-size:12px; color: var(--status-red);">Blocker: ${escapeForHtmlText(agent.blockedReason)}</div>` : ''}
        <div style="margin-top:12px; font-size:12px;">Select a project in the middle column to open full details.</div>
      </div>
    `;
  }
}

function showAgentProjectsInWorkspace(agentName) {
  if (!agentName) return;
  selectedAgentWorkspace = agentName;
  if (currentView !== 'agents') {
    switchView('agents');
  }
  renderAgentsWorkspace();
}

function clearAgentFocus() {
  currentAgentFocus = null;
  renderProjects();
}

function getCalendarBaseProjects() {
  // Calendar lane tabs should reflect all projects, not transient list filters.
  const all = Array.isArray(projects) ? projects.slice() : [];
  return sortProjects(all, currentSort);
}

function renderCalendarLaneNav() {
  const nav = document.getElementById('calendarLaneNav');
  if (!nav) return;
  const statuses = buildStatusBuckets(getCalendarBaseProjects());
  const laneOrder = ['new', 'in-progress', 'quality_review', 'upcoming', 'blocked', 'complete'];
  nav.innerHTML = laneOrder.map(key => {
    const lane = statuses[key];
    const active = currentLaneView === key ? 'active' : '';
    return `<button class="lane-chip ${active}" onclick="setLaneView('${key}')">${lane.label.replace(/^.\s/, '')}<span>${lane.projects.length}</span></button>`;
  }).join('');
}

// Get category emoji helper
function getCategoryEmoji(category) {
  const categoryMap = {
    'Marketing': '',
    'Creative': '',
    'Operations': '',
    'Development': ''
  };
  return categoryMap[category] || '';
}

// Drag and drop handlers
let draggedProjectId = null;
let isDragging = false;

function handleDragStart(event) {
  // Get the project card element (might be called on child)
  const card = event.target.closest('.project-card');
  if (!card) return;
  
  isDragging = true;
  draggedProjectId = card.dataset.projectId;
  card.style.opacity = '0.4';
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedProjectId);
}

function handleDragEnd(event) {
  const card = event.target.closest('.project-card');
  if (card) {
    card.style.opacity = '1';
  }
  
  // Delay to prevent click from firing
  setTimeout(() => {
    isDragging = false;
    draggedProjectId = null;
  }, 100);
  
  // Clean up all drag-over classes
  document.querySelectorAll('.drag-over').forEach(el => {
    el.classList.remove('drag-over');
  });
}

function setupDropZones() {
  const dropZones = document.querySelectorAll('.status-bucket-content');
  
  dropZones.forEach(zone => {
    // Remove old listeners to prevent duplicates
    zone.removeEventListener('dragover', handleDragOver);
    zone.removeEventListener('drop', handleDrop);
    zone.removeEventListener('dragenter', handleDragEnter);
    zone.removeEventListener('dragleave', handleDragLeave);
    
    // Add new listeners
    zone.addEventListener('dragover', handleDragOver);
    zone.addEventListener('drop', handleDrop);
    zone.addEventListener('dragenter', handleDragEnter);
    zone.addEventListener('dragleave', handleDragLeave);
  });
}

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDragEnter(event) {
  const dropZone = event.target.closest('.status-bucket-content');
  if (dropZone) {
    dropZone.classList.add('drag-over');
  }
}

function handleDragLeave(event) {
  const dropZone = event.target.closest('.status-bucket-content');
  if (dropZone && !dropZone.contains(event.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
}

async function handleDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  
  const dropZone = event.target.closest('.status-bucket-content');
  if (!dropZone) return false;
  
  dropZone.classList.remove('drag-over');
  
  const newStatus = dropZone.dataset.status;
  const project = projects.find(p => p.id === draggedProjectId);
  
  if (project && project.status !== newStatus) {
    // Update project status
    project.status = newStatus;
    project.lastUpdated = new Date().toISOString();
    
    // Save to backend
    try {
      await fetch(apiUrl(`/api/projects/${encodeURIComponent(project.id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: newStatus,
          lastUpdated: project.lastUpdated
        })
      });
      
      // Add activity log
      if (!data.activityFeed) data.activityFeed = [];
      data.activityFeed.unshift({
        id: `activity-${Date.now()}`,
        emoji: '',
        text: `${project.name} moved to ${getStatusLabel(newStatus)}`,
        timestamp: new Date().toISOString()
      });
      
      // Re-render
      renderProjects();
      renderActivityFeed();
      
    } catch (error) {
      console.error('Failed to update project status:', error);
      alert('Failed to update project status');
    }
  }
  
  return false;
}

function getStatusLabel(status) {
  const labels = {
    'upcoming': 'UPCOMING',
    'new': 'NEW',
    'in-progress': 'IN PROGRESS',
    'quality_review': 'IN REVIEW',
    'blocked': 'BLOCKED',
    'complete': 'COMPLETE',
    'urgent': 'URGENT'
  };
  return labels[status] || status;
}

// Select project and show detail
function selectProject(projectId) {
  // Don't select if we're dragging
  if (isDragging) return;

  const wasDifferentProject = selectedProjectId !== projectId;
  selectedProjectId = projectId;
  if (wasDifferentProject) {
    projectDetailTab = 'details';
    projectEditMode = false;
  }
  const project = projects.find(p => p.id === projectId);
  
  if (!project) return;
  if (!Object.prototype.hasOwnProperty.call(qualityReviewsByProject, project.id)) {
    loadProjectQualityReviews(project.id).then(() => {
      if (selectedProjectId === project.id) selectProject(project.id);
    }).catch(() => null);
  }
  
  const detailPanel = document.getElementById('detailPanel');
  detailPanel.classList.remove('empty');
  detailPanel.classList.add('active'); // For mobile slide-in

  const worker = findWorkerForProject(project);
  const dueDisplay = project.dueDate ? formatDateShort(project.dueDate) : 'No date';
  const heartbeatDisplay = worker ? formatRelativeTime(worker.lastHeartbeatAt) : 'No heartbeat';
  const trackingModel = worker?.model || project.model || 'unreported';
  const trackingStatus = worker?.status || 'unassigned';
  let html = `
    <div class="detail-header" style="position:relative;">
      <button class="btn" onclick="closeProjectDetailPanel()" style="position:absolute; top:0; right:0; padding:4px 8px; font-size:12px; line-height:1;">×</button>
      <div class="detail-id">${project.id}</div>
      ${project.clientName ? `<div class="project-client" style="margin-bottom: 8px;"> ${project.clientName}</div>` : ''}
      <div class="detail-title">${project.name}</div>
    </div>
    
    <div class="info-grid">
      <div class="info-item">
        <div class="info-label">OWNER</div>
        <div class="info-value">${project.owner}</div>
      </div>
      <div class="info-item">
        <div class="info-label">PRIORITY</div>
        <div class="info-value">${project.priority || 'N/A'}</div>
      </div>
      <div class="info-item">
        <div class="info-label">STATUS</div>
        <div class="info-value">${getStatusBadge(project)}</div>
      </div>
      <div class="info-item">
        <div class="info-label">DUE DATE</div>
        <div class="info-value">${dueDisplay}</div>
      </div>
      <div class="info-item">
        <div class="info-label">ASSIGNED AGENT</div>
        <div class="info-value">${worker?.name || project.owner || 'Unassigned'}</div>
      </div>
      <div class="info-item">
        <div class="info-label">MODEL</div>
        <div class="info-value">${trackingModel}</div>
      </div>
      <div class="info-item">
        <div class="info-label">TRACKING</div>
        <div class="info-value">${trackingStatus} • ${heartbeatDisplay}</div>
      </div>
    </div>
    <div style="display:flex; gap:8px; margin: 10px 0 16px;">
      <button class="btn ${projectDetailTab === 'details' ? 'btn-primary' : ''}" onclick="setProjectDetailTab('details')" style="${projectDetailTab === 'details' ? '' : 'background: rgba(0,0,0,0.06); color: var(--text-primary);'}">Project Details</button>
      <button class="btn ${projectDetailTab === 'financials' ? 'btn-primary' : ''}" onclick="setProjectDetailTab('financials')" style="${projectDetailTab === 'financials' ? '' : 'background: rgba(0,0,0,0.06); color: var(--text-primary);'}">Project Financials</button>
      <button class="btn" onclick="assignTaskToSelectedProject()" style="background: rgba(0,0,0,0.06); color: var(--text-primary);">Assign Task</button>
      <button class="btn" onclick="recalculateSelectedProjectAssignees()" style="background: rgba(0,0,0,0.06); color: var(--text-primary);">Recalculate Routing</button>
      <button class="btn" onclick="toggleProjectEditMode()" style="margin-left:auto; background: rgba(0,0,0,0.06); color: var(--text-primary);">${projectEditMode ? 'Done Editing' : 'Edit Project'}</button>
    </div>
  `;

  const editDueDate = project.dueDate ? new Date(project.dueDate).toISOString().slice(0, 10) : '';

  if (projectDetailTab === 'details') {
    if (projectEditMode) {
      html += `
        <div class="detail-section">
          <div class="detail-section-title">EDIT PROJECT</div>
          <div class="detail-content">
            <div style="display:grid; gap:10px;">
              <div><div class="info-label">JOB TITLE</div><input id="editJobTitle" class="form-input" type="text" value="${escapeForHtmlAttr(project.name || '')}" placeholder="Project title" /></div>
              <div><div class="info-label">DESCRIPTION</div><textarea id="editJobDescription" class="form-textarea" style="min-height:90px;" placeholder="What this job is and what done looks like">${escapeForHtmlText(project.notes || '')}</textarea></div>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                <div>
                  <div class="info-label">OWNER</div>
                  <div style="display:flex; gap:8px; align-items:center;">
                    <select id="editJobOwner" class="form-select" style="flex:1;">
                      ${getOwnerOptions(project.owner || '').map(owner => `<option value="${escapeForHtmlAttr(owner)}" ${owner === (project.owner || '') ? 'selected' : ''}>${escapeForHtmlText(owner)}</option>`).join('')}
                    </select>
                    <button type="button" class="btn" style="padding:8px 10px; font-size:11px;" onclick="addNewOwnerFromEdit()">+ Add New Owner</button>
                  </div>
                </div>
                <div><div class="info-label">CLIENT</div><input id="editJobClient" class="form-input" type="text" value="${escapeForHtmlAttr(project.clientName || '')}" placeholder="Client" /></div>
              </div>
              <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px;">
                <div><div class="info-label">HOURS</div><input id="editJobHours" class="form-input" type="number" min="0" step="0.5" value="${Number(project.actualHours || 0)}" /></div>
                <div><div class="info-label">RATE</div><input id="editJobRate" class="form-input" type="number" min="0" step="1" value="${Number(project.hourlyRate || 150)}" /></div>
                <div><div class="info-label">PROGRESS %</div><input id="editJobProgress" class="form-input" type="number" min="0" max="100" step="1" value="${Number(project.progress || 0)}" /></div>
              </div>
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                <div><div class="info-label">DUE DATE</div><input id="editJobDueDate" class="form-input" type="date" value="${editDueDate}" /></div>
                <div><div class="info-label">PRIORITY</div><select id="editJobPriority" class="form-select">
                  <option value="P0" ${project.priority === 'P0' ? 'selected' : ''}>P0</option>
                  <option value="P1" ${project.priority === 'P1' ? 'selected' : ''}>P1</option>
                  <option value="P2" ${project.priority === 'P2' ? 'selected' : ''}>P2</option>
                  <option value="P3" ${project.priority === 'P3' ? 'selected' : ''}>P3</option>
                </select></div>
              </div>
              <button class="btn" style="background: var(--accent-blue); color: white;" onclick="saveProjectEdits()"> Save Project Details</button>
            </div>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="detail-section">
          <div class="detail-section-title">PROJECT DESCRIPTION</div>
          <div class="detail-content">${escapeForHtmlText(project.notes || 'No description provided yet.')}</div>
        </div>
      `;
    }

    if (project.rationale) {
      html += `
        <div class="detail-section">
          <div class="detail-section-title">RATIONALE</div>
          <div class="detail-content">${escapeForHtmlText(project.rationale)}</div>
        </div>
      `;
    }
    
    if (project.nextActions?.length) {
      html += `
        <div class="detail-section">
          <div class="detail-section-title">NEXT ACTIONS</div>
          <div class="detail-content">
            <ul style="margin-left: 20px;">
              ${project.nextActions.map(action => `<li>${escapeForHtmlText(action)}</li>`).join('')}
            </ul>
          </div>
        </div>
      `;
    }
    
    const dependencies = Array.isArray(project.dependencies) ? project.dependencies : [];
    html += `
      <div class="detail-section">
        <div class="detail-section-title">DEPENDENCIES (${dependencies.length})</div>
        <div class="detail-content">
          ${dependencies.length ? dependencies.map(dep => `
            <div style="display:flex; gap:8px; justify-content:space-between; align-items:flex-start; margin-bottom:8px; padding:8px; background: rgba(0,0,0,0.03); border-radius:8px;">
              <div>
                ${(Array.isArray(data.projects) && data.projects.some((p) => String(p.id || '') === String(dep.projectId || dep.id || '')))
                  ? `<button class="btn" style="padding:0; border:0; background:none; color:var(--accent-blue); font-weight:600; text-align:left;" onclick="switchView('projects'); selectProject('${escapeForJsString(String(dep.projectId || dep.id || ''))}')">${escapeForHtmlText(dep.name || dep.projectId || dep.id || 'Untitled dependency')}</button>`
                  : `<div style="font-weight:600;">${escapeForHtmlText(dep.name || 'Untitled dependency')}</div>`}
                ${dep.notes ? `<div style="font-size:12px; color:var(--text-secondary);">${escapeForHtmlText(dep.notes)}</div>` : ''}
                <div style="font-size:11px; color:var(--text-secondary); text-transform:uppercase; margin-top:4px;">${escapeForHtmlText(dep.status || 'pending')}</div>
              </div>
              ${projectEditMode ? `<button class="btn" style="padding:6px 8px; font-size:11px;" onclick="removeDependency('${project.id}', '${dep.id}')">Remove</button>` : ''}
            </div>
          `).join('') : `<div style="color: var(--text-secondary); font-size: 12px;">No dependencies added.</div>`}
          ${projectEditMode ? `
            <div style="display:grid; gap:8px; margin-top:10px;">
              <input id="dependencyNameInput" class="form-input" type="text" placeholder="Dependency name (e.g. Client assets, API key, legal approval)" />
              <input id="dependencyNotesInput" class="form-input" type="text" placeholder="Notes (optional)" />
              <select id="dependencyStatusInput" class="form-select">
                <option value="pending">Pending</option>
                <option value="in-progress">In Progress</option>
                <option value="resolved">Resolved</option>
              </select>
              <button class="btn" style="background: var(--accent-blue); color: white;" onclick="addDependency()">+ Add Dependency</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    const hasDocumentsArray = Array.isArray(project.documents) && project.documents.length > 0;
    const documents = hasDocumentsArray
      ? project.documents
      : (Array.isArray(project.deliverables) ? project.deliverables : []);
    html += `
      <div class="detail-section">
        <div class="detail-section-title">DOCUMENTS (${documents.length})</div>
        <div class="detail-content">
          ${documents.length ? documents.map(doc => `
            <div style="display:flex; gap:8px; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
              <a href="#" onclick="openFile(decodeURIComponent('${encodeURIComponent(doc.url || '')}')); return false;" style="color: var(--accent-blue); text-decoration: none;">
                 ${escapeForHtmlText(doc.name || 'Untitled document')}
              </a>
              ${projectEditMode && hasDocumentsArray && doc.id ? `<button class="btn" style="padding:6px 8px; font-size:11px;" onclick="removeDocument('${project.id}', '${doc.id}')">Remove</button>` : ''}
            </div>
          `).join('') : `<div style="color: var(--text-secondary); font-size: 12px;">No documents attached.</div>`}
          ${projectEditMode ? `
            <div style="display:grid; gap:8px; margin-top:10px;">
              <input id="documentNameInput" class="form-input" type="text" placeholder="Document title" />
              <input id="documentPathInput" class="form-input" type="text" placeholder="/Volumes/.../file.pdf" />
              <button class="btn" style="background: var(--accent-blue); color: white;" onclick="addDocument()">+ Add Document</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    // Project context + source requests + task checklist
    const requests = (Array.isArray(data.requests) ? data.requests : []).filter(r => r.projectId === project.id);
    const projectAttachments = (Array.isArray(data.attachments) ? data.attachments : []).filter(a => a.projectId === project.id);
    const assignments = (Array.isArray(data.assignments) ? data.assignments : []).filter(a => a.projectId === project.id);
    const activeAssignments = assignments.filter(a => String(a.status || '').toLowerCase() !== 'done');
    const completedAssignments = assignments.filter(a => String(a.status || '').toLowerCase() === 'done');
    const requestGroups = groupRequestsBySection(requests);
    html += `
      <div class="detail-section" id="project-context-section">
        <div class="detail-section-title">PROJECT CONTEXT</div>
        <div class="detail-content">
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:8px;">
            <div style="padding:10px; border-radius:8px; background:rgba(0,0,0,0.03);">
              <div class="info-label">SOURCE REQUESTS</div>
              <div style="font-size:18px; font-weight:700;">${requests.length}</div>
            </div>
            <div style="padding:10px; border-radius:8px; background:rgba(0,0,0,0.03);">
              <div class="info-label">SOURCE FILES</div>
              <div style="font-size:18px; font-weight:700;">${projectAttachments.length}</div>
            </div>
            <div style="padding:10px; border-radius:8px; background:rgba(0,0,0,0.03);">
              <div class="info-label">TASKS</div>
              <div style="font-size:18px; font-weight:700;">${assignments.length}</div>
            </div>
          </div>
          <div style="margin-top:10px; font-size:12px; color:var(--text-secondary);">Client notes, source requests, and attachments stay here at the project level. The task checklist below is for individual execution only.</div>
        </div>
      </div>
      <div class="detail-section" id="source-files-section">
        <div class="detail-section-title">SOURCE FILES (${projectAttachments.length})</div>
        <div class="detail-content">
          ${renderProjectAttachmentCards(projectAttachments)}
        </div>
      </div>
      <div class="detail-section" id="source-requests-section">
        <div class="detail-section-title">SOURCE REQUESTS (${requests.length})</div>
        <div class="detail-content">
          ${requests.length ? requestGroups.map((group) => `
            <div style="margin-bottom:12px; border:1px solid rgba(15,23,42,0.08); border-radius:10px; overflow:hidden;">
              <div style="padding:10px 12px; background:rgba(15,23,42,0.04); font-size:12px; font-weight:700; letter-spacing:0.04em;">${escapeForHtmlText(group.label)} <span style="color:var(--text-secondary); font-weight:600;">(${group.items.length})</span></div>
              <div style="padding:10px;">
                ${group.items.map((request) => {
                  const confidenceMeta = getConversationConfidenceMeta(request.confidence);
                  const linkedAttachments = projectAttachments.filter((attachment) => Array.isArray(request.attachmentIds) && request.attachmentIds.includes(attachment.id));
                  const linkedAssignmentIds = Array.isArray(request.assignmentIds) ? request.assignmentIds.filter(Boolean) : [];
                  const primaryAssignmentId = linkedAssignmentIds[0] || '';
                  const routingNeedsReview = isRequestRoutingInReview(request);
                  const routingStatusLabel = getRequestRoutingStatusLabel(request);
                  const routingConfidence = Number.isFinite(Number(request.routingConfidence)) ? Math.round(Number(request.routingConfidence) * 100) : null;
                  const routingStatusBg = routingNeedsReview ? 'rgba(245, 158, 11, 0.16)' : 'rgba(16, 185, 129, 0.14)';
                  const routingStatusColor = routingNeedsReview ? '#92400e' : '#047857';
                  return `
                    <div data-request-id="${escapeForHtmlAttr(request.id || '')}" style="margin-bottom:8px; padding:10px; background: rgba(0,0,0,0.03); border-radius:8px; display:grid; gap:6px;">
                      <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
                        <div>
                          <button class="btn" style="padding:0; border:0; background:none; font-weight:600; color:var(--accent-blue); text-align:left;" onclick="navigateToProjectDetail('${escapeForJsString(project.id || '')}', '[data-request-id=&quot;${escapeForJsString(request.id || '')}&quot;]')">${escapeForHtmlText(request.title || 'Untitled request')}</button>
                          <div style="font-size:12px; color:var(--text-secondary); margin-top:3px;">${escapeForHtmlText(request.detail || '')}</div>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
                          <span class="conversation-pill" style="background:${confidenceMeta.bg}; color:${confidenceMeta.color}; border:none;">${escapeForHtmlText(confidenceMeta.label + ' ' + Math.round(Number(request.confidence || 0) * 100) + '%')}</span>
                          <span class="conversation-pill" style="background:${routingStatusBg}; color:${routingStatusColor}; border:none;">${escapeForHtmlText(routingStatusLabel + (routingConfidence !== null ? ' • ' + routingConfidence + '%' : ''))}</span>
                        </div>
                      </div>
                      <div style="display:flex; gap:8px; flex-wrap:wrap; font-size:11px; color:var(--text-secondary);">
                        <span>Status: ${escapeForHtmlText(request.status || 'new')}</span>
                        <span>Type: ${escapeForHtmlText(request.workType || 'general')}</span>
                        <span>Route: ${escapeForHtmlText(request.routeLabel || 'Joan')}${routingConfidence !== null ? ' • ' + routingConfidence + '% confidence' : ''}</span>
                        <span>Source: ${escapeForHtmlText(request.extractionSource || 'email')}</span>
                      </div>
                      <div style="font-size:11px; color:var(--text-secondary);">Tasks: ${linkedAssignmentIds.length} • Files: ${linkedAttachments.length}${request.routeReason ? ' • ' + escapeForHtmlText(request.routeReason) : ''}</div>
                      ${linkedAttachments.length ? `<div style="font-size:11px; color:var(--text-secondary);">Files: ${linkedAttachments.map((attachment) => escapeForHtmlText(attachment.filename || 'attachment')).join(', ')}</div>` : ''}
                      <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        ${primaryAssignmentId ? `<button class="btn" style="padding:4px 8px; font-size:11px;" onclick="openSourceRequestTask('${escapeForJsString(project.id || '')}', '${escapeForJsString(request.id || '')}')">${linkedAssignmentIds.length === 1 ? 'Open Task' : 'View Tasks'}</button>` : ''}
                        ${linkedAttachments.length ? `<button class="btn" style="padding:4px 8px; font-size:11px;" onclick="navigateToProjectDetail('${escapeForJsString(project.id || '')}', '#source-files-section')">View Files</button>` : ''}
                        ${canManageRoutingReview() && routingNeedsReview ? `<button class="btn" style="padding:4px 8px; font-size:11px;" onclick="acceptRequestRouting('${escapeForJsString(request.id || '')}', '${escapeForJsString(project.id || '')}', '${escapeForJsString(request.routeLabel || '')}')">Accept Route</button>` : ''}
                        ${canManageRoutingReview() ? `<button class="btn" style="padding:4px 8px; font-size:11px;" onclick="reassignRequestRouting('${escapeForJsString(request.id || '')}', '${escapeForJsString(project.id || '')}', '${escapeForJsString(request.routeLabel || '')}')">${routingNeedsReview ? 'Assign Owner' : 'Reassign Owner'}</button>` : ''}
                        ${canManageRoutingReview() ? `<button class="btn" style="padding:4px 8px; font-size:11px;" onclick="recalculateProjectRouting('${escapeForJsString(project.id || '')}')">Recalculate</button>` : ''}
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          `).join('') : '<div style="color:var(--text-secondary); font-size:12px;">No extracted requests yet.</div>'}
        </div>
      </div>
    `;
    const qualityReviews = getProjectQualityReviews(project.id);
    const inReview = getEffectiveStatus(project) === 'quality_review';
    const canReview = canCurrentUserReviewQuality();
    html += `
      <div class="detail-section" id="task-checklist-section">
        <div class="detail-section-title">TASK CHECKLIST (${activeAssignments.length} OPEN${completedAssignments.length ? ' • ' + completedAssignments.length + ' DONE' : ''})</div>
        <div class="detail-content">
          ${activeAssignments.length ? activeAssignments.slice(0, 18).map(a => `
            <div data-assignment-id="${escapeForHtmlAttr(a.id || '')}" style="display:flex; justify-content:space-between; gap:10px; margin-bottom:8px; padding:10px; background: rgba(0,0,0,0.03); border-radius:8px;">
              <div style="display:flex; gap:10px; align-items:flex-start; flex:1; min-width:0;">
                <input type="checkbox" aria-label="Mark task done" onchange="toggleAssignmentCompletion('${escapeForJsString(a.id || '')}', this.checked)" style="margin-top:4px; width:16px; height:16px; accent-color: var(--accent-blue);" />
                <div style="min-width:0;">
                  <button class="btn" style="padding:0; border:0; background:none; font-weight:600; color:var(--accent-blue); text-align:left;" onclick="openAssignmentWorkspace('${escapeForJsString(a.id || '')}')">${escapeForHtmlText(a.title || 'Untitled task')}</button>
                  <div style="font-size:11px; color:var(--text-secondary);">@${escapeForHtmlText(a.assigneeName || a.assigneeEmail || 'unassigned')} • ${escapeForHtmlText(a.status || 'open')} • ${Number(a.loggedHours || 0).toFixed(2)}h${getAssignmentSubtaskMeta(a)}</div>
                </div>
              </div>
              <div style="display:flex; gap:6px; align-items:flex-start;">
                ${String(a.status || '').toLowerCase() === 'in_progress' ? '' : `<button class="btn" style="padding:4px 8px; font-size:11px;" onclick="updateAssignmentStatus('${escapeForJsString(a.id || '')}', 'in_progress')">Start</button>`}
                <button class="btn" style="padding:4px 8px; font-size:11px;" onclick="openAssignmentWorkspace('${escapeForJsString(a.id || '')}')">Task</button>
              </div>
            </div>
          `).join('') : '<div style="color:var(--text-secondary); font-size:12px;">No open tasks.</div>'}
          ${completedAssignments.length ? `<div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(0,0,0,0.08);">${completedAssignments.slice(0, 12).map(a => `
            <div data-assignment-id="${escapeForHtmlAttr(a.id || '')}" style="display:flex; justify-content:space-between; gap:10px; margin-bottom:8px; padding:10px; background: rgba(0,128,0,0.06); border-radius:8px; opacity:0.92;">
              <div style="display:flex; gap:10px; align-items:flex-start; flex:1; min-width:0;">
                <input type="checkbox" checked aria-label="Reopen task" onchange="toggleAssignmentCompletion('${escapeForJsString(a.id || '')}', this.checked)" style="margin-top:4px; width:16px; height:16px; accent-color: var(--accent-blue);" />
                <div style="min-width:0;">
                  <button class="btn" style="padding:0; border:0; background:none; font-weight:600; color:var(--text-secondary); text-align:left; text-decoration:line-through;" onclick="openAssignmentWorkspace('${escapeForJsString(a.id || '')}')">${escapeForHtmlText(a.title || 'Untitled task')}</button>
                  <div style="font-size:11px; color:var(--text-secondary);">@${escapeForHtmlText(a.assigneeName || a.assigneeEmail || 'unassigned')} • done • ${Number(a.loggedHours || 0).toFixed(2)}h${getAssignmentSubtaskMeta(a)}</div>
                </div>
              </div>
              <div style="display:flex; gap:6px; align-items:flex-start;"><button class="btn" style="padding:4px 8px; font-size:11px;" onclick="openAssignmentWorkspace('${escapeForJsString(a.id || '')}')">View</button></div>
            </div>
          `).join('')}</div>` : ''}
        </div>
      </div>
    `;
    html += `
      <div class="detail-section">
        <div class="detail-section-title">QUALITY REVIEWS (${qualityReviews.length})</div>
        <div class="detail-content">
          ${qualityReviews.length ? qualityReviews.slice(0, 8).map(r => `
            <div style="display:flex; justify-content:space-between; gap:10px; margin-bottom:8px; padding:8px; background: rgba(0,0,0,0.03); border-radius:8px;">
              <div>
                <div style="font-weight:600;">${escapeForHtmlText((r.decision || '').replace('_', ' ').toUpperCase())}</div>
                <div style="font-size:12px; color:var(--text-secondary);">@${escapeForHtmlText(r.reviewer || 'reviewer')} • ${formatTime(r.createdAt)}</div>
                ${r.summary ? `<div style="font-size:12px; margin-top:4px;">${escapeForHtmlText(r.summary)}</div>` : ''}
              </div>
            </div>
          `).join('') : '<div style="color:var(--text-secondary); font-size:12px;">No quality reviews yet.</div>'}
          ${inReview && !canReview ? '<div style="font-size:12px; color:var(--text-secondary); margin-top:8px;">Awaiting manager/admin review decision.</div>' : ''}
        </div>
      </div>
    `;

    const comments = project.comments || [];

    const currentUser = getCurrentUser();
    html += `
      <div class="detail-section">
        <div class="detail-section-title">COMMENTS (${comments.length})</div>
        ${comments.map(comment => `
          <div class="comment">
            <div class="comment-header">
              <span class="comment-author">${escapeForHtmlText(comment.author || 'Unknown')}</span>
              <span class="comment-time">${formatTime(comment.timestamp)}</span>
              ${comment.author === currentUser ? `<button class="btn-delete-comment" onclick="deleteComment('${project.id}', '${comment.id}')" title="Delete comment"></button>` : ''}
            </div>
            <div>${escapeForHtmlText(comment.text)}</div>
          </div>
        `).join('')}
        <div class="comment-form">
          <input type="text" class="comment-input" id="commentInput" placeholder="Add a comment...">
          <button class="btn btn-primary" onclick="addComment()">Send</button>
        </div>
      </div>
    `;
  }

  // Timeline Section
  let startDate = project.startDate || project.createdAt;
  if (!startDate && project.id) {
    const match = project.id.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) startDate = match[1];
  }
  if (!startDate) startDate = project.lastUpdated;
  
  if (startDate && projectDetailTab === 'details') {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">TIMELINE</div>
        <div class="detail-content">
    `;
    
    const start = new Date(startDate);
    html += `<div style="margin-bottom: 8px;"> <strong>Started:</strong> ${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>`;
    
    if (project.deliveredDate) {
      const delivered = new Date(project.deliveredDate);
      const workDays = Math.floor((delivered - start) / (1000 * 60 * 60 * 24));
      html += `<div style="margin-bottom: 8px;"> <strong>Delivered:</strong> ${delivered.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} <em style="color: var(--text-secondary);">(${workDays}d work time)</em></div>`;
      
      if (project.actualHours) {
        html += `<div style="margin-bottom: 8px;"> <strong>Actual Hours:</strong> ${project.actualHours}h</div>`;
      }
    }
    
    if (project.completedDate) {
      const completed = new Date(project.completedDate);
      if (project.deliveredDate) {
        const approvalDays = Math.floor((completed - new Date(project.deliveredDate)) / (1000 * 60 * 60 * 24));
        html += `<div style="margin-bottom: 8px;"> <strong>Completed:</strong> ${completed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} <em style="color: var(--text-secondary);">(${approvalDays}d approval wait)</em></div>`;
      } else {
        html += `<div style="margin-bottom: 8px;"> <strong>Completed:</strong> ${completed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>`;
      }
      
      const totalDays = Math.floor((completed - start) / (1000 * 60 * 60 * 24));
      html += `<div style="margin-top: 12px; padding: 10px; background: rgba(var(--accent-blue-rgb), 0.1); border-radius: 8px;"><strong>Total Duration:</strong> ${totalDays} days</div>`;
    }
    
    html += `
        </div>
      </div>
    `;
  }
  
  // Financial Section
  if (projectDetailTab === 'financials' && (project.revenue !== undefined || project.cost !== undefined || project.actualHours !== undefined)) {
    const currentHours = Number(project.actualHours || 0);
    const currentRate = Number(project.hourlyRate || 150);
    const currentRevenue = Number(project.revenue || (currentHours * currentRate));
    const currentCost = Number(project.cost || 0);
    const currentProfit = Number(project.profit || (currentRevenue - currentCost));
    const currentMargin = currentRevenue > 0 ? (currentProfit / currentRevenue) * 100 : 0;
    html += `
      <div class="detail-section">
        <div class="detail-section-title">FINANCIAL SUMMARY</div>
        <div class="detail-content">
          <div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-bottom:12px;">
            <div><div class="info-label">REVENUE</div><div class="info-value">$${currentRevenue.toFixed(2)}</div></div>
            <div><div class="info-label">COST</div><div class="info-value">$${currentCost.toFixed(2)}</div></div>
            <div><div class="info-label">PROFIT</div><div class="info-value" style="color:${currentProfit >= 0 ? 'var(--status-green)' : 'var(--status-red)'}">$${currentProfit.toFixed(2)}</div></div>
            <div><div class="info-label">MARGIN</div><div class="info-value">${currentMargin.toFixed(2)}%</div></div>
          </div>
          ${projectEditMode ? `
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
            <input id="financialHoursInput" type="number" min="0" step="0.5" value="${currentHours}" class="form-input" placeholder="Hours" />
            <input id="financialRateInput" type="number" min="0" step="1" value="${currentRate}" class="form-input" placeholder="Hourly Rate" />
          </div>
          <button class="btn" style="background: var(--accent-blue); color: white; margin-bottom: 12px;" onclick="saveFinancialDetails()"> Save Hours & Rate</button>
          ` : '<div style="font-size:12px; color: var(--text-secondary);">Click <strong>Edit Project</strong> to update hours and rate.</div>'}
        </div>
      </div>
    `;
  }

  // Action buttons
  html += `
    <div class="action-buttons">
  `;
  
  if (!project.deliveredDate && project.status !== 'complete') {
    html += `<button class="btn" style="background: var(--accent-blue); color: white;" onclick="markAsDelivered()"> Mark as Delivered</button>`;
  }
  
  if (!project.completedDate) {
    html += `<button class="btn" style="background: var(--status-green); color: white;" onclick="completeProject()">✓ Complete</button>`;
  }
  if (getEffectiveStatus(project) !== 'quality_review' && project.status !== 'complete') {
    html += `<button class="btn" style="background: var(--accent-blue); color: white;" onclick="requestQualityReview()">Request Review</button>`;
  }
  if (getEffectiveStatus(project) === 'quality_review' && canCurrentUserReviewQuality()) {
    html += `<button class="btn" style="background: var(--status-green); color: white;" onclick="submitQualityReview('approved')">Approve</button>`;
    html += `<button class="btn" style="background: var(--status-yellow); color: white;" onclick="submitQualityReview('changes_requested')">Request Changes</button>`;
  }
  
  html += `
      <button class="btn" style="background: var(--status-yellow); color: white;" onclick="requestChanges()">Changes</button>
      <button class="btn" style="background: var(--status-red); color: white;" onclick="blockProject()"> Block</button>
    </div>
  `;
  
  detailPanel.innerHTML = html;
  renderProjects(); // Re-render to update active state
  syncProjectFocusLayout();
}

function findWorkerForProject(project) {
  const candidates = Array.isArray(controlTower.workers) ? controlTower.workers : [];
  if (!project) return null;
  const owner = String(project.owner || '').toLowerCase();
  if (!owner) return null;
  return candidates.find(worker => String(worker.name || '').toLowerCase() === owner) || null;
}

function toggleProjectEditMode() {
  projectEditMode = !projectEditMode;
  if (selectedProjectId) selectProject(selectedProjectId);
  syncProjectFocusLayout();
}

function setProjectDetailTab(tab) {
  projectDetailTab = tab === 'financials' ? 'financials' : 'details';
  if (selectedProjectId) selectProject(selectedProjectId);
}

async function addNewOwnerFromEdit() {
  const name = prompt('Enter new owner name:');
  if (!name) return;
  const trimmed = String(name).trim();
  if (!trimmed) return;

  try {
    const response = await fetch('/api/owners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(payload.error || 'Failed to add owner', 'error');
      return;
    }

    if (!Array.isArray(data.owners)) data.owners = [];
    if (!data.owners.includes(trimmed)) data.owners.push(trimmed);
    data.owners.sort((a, b) => String(a).localeCompare(String(b)));

    projectEditMode = true;
    if (selectedProjectId) {
      selectProject(selectedProjectId);
      const ownerSelect = document.getElementById('editJobOwner');
      if (ownerSelect) ownerSelect.value = trimmed;
    }
    showNotification(`Owner added: ${trimmed}`, 'success');
  } catch (error) {
    console.error('Failed to add owner:', error);
    showNotification('Failed to add owner', 'error');
  }
}

// Status badge helper
function getStatusBadge(project) {
  const status = getEffectiveStatus(project);

  // Check if delivered but not complete
  if (project.deliveredDate && !project.completedDate) {
    return '<span class="status-badge" style="background: var(--accent-blue); color: white;"> Delivered (awaiting approval)</span>';
  }
  
  const statusMap = {
    'complete': '<span class="status-badge status-complete">COMPLETE</span>',
    'in-progress': '<span class="status-badge status-in-progress">IN PROGRESS</span>',
    'quality_review': '<span class="status-badge" style="background: var(--accent-blue); color: white;">IN REVIEW</span>',
    'new': '<span class="status-badge" style="background: var(--accent-blue); color: white;">NEW</span>',
    'upcoming': '<span class="status-badge" style="background: var(--accent-purple); color: white;">UPCOMING</span>',
    'blocked': '<span class="status-badge status-blocked">BLOCKED</span>'
  };
  return statusMap[status] || '<span class="status-badge status-other">Other</span>';
}

// Format project timeline
function formatTimeline(project) {
  let startDate = project.startDate || project.createdAt;
  
  // Try to extract date from ID (format: YYYY-MM-DD-*)
  if (!startDate && project.id) {
    const match = project.id.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      startDate = match[1];
    }
  }
  
  // Fall back to lastUpdated
  if (!startDate) {
    startDate = project.lastUpdated;
  }
  
  if (!startDate) return '';
  
  const start = new Date(startDate);
  
  // If delivered, show delivery timeline
  if (project.deliveredDate) {
    const delivered = new Date(project.deliveredDate);
    const workDays = Math.floor((delivered - start) / (1000 * 60 * 60 * 24));
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const deliveredStr = `${monthNames[delivered.getMonth()]} ${delivered.getDate()}`;
    
    if (project.completedDate) {
      return `Delivered ${deliveredStr} • ${workDays}d work • `;
    } else {
      return `Delivered ${deliveredStr} • ${workDays}d work • `;
    }
  }
  
  // Otherwise show work in progress
  const now = new Date();
  const diffMs = now - start;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const startStr = `${monthNames[start.getMonth()]} ${start.getDate()}`;
  
  const durationStr = diffDays === 0 ? 'today' : `${diffDays}d`;
  
  const effectiveStatus = getEffectiveStatus(project);
  const icon = effectiveStatus === 'complete' ? '' :
               effectiveStatus === 'blocked' ? '' :
               effectiveStatus === 'upcoming' ? '' : '';
  
  return `Started ${startStr} • ${durationStr} • ${icon}`;
}

// Format timestamp
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function refreshAuthSessionContext() {
  try {
    const response = await fetch(apiUrl('/api/auth/session'), { __skipSessionRefresh: true });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body && body.authenticated) {
      sessionContext = {
        username: String(body.username || '').trim(),
        role: String(body.role || '').trim(),
        authenticated: true
      };
      return;
    }
  } catch (_) {
    // fallback below
  }
  sessionContext = { username: '', role: '', authenticated: false };
}

// Get current user from auth session when available.
function getCurrentUser() {
  const sessionUser = String(sessionContext?.username || '').trim();
  if (sessionUser) return sessionUser;

  let user = localStorage.getItem('dashboardUser');
  if (!user) {
    user = 'Otto';
    localStorage.setItem('dashboardUser', user);
  }
  return user;
}

function canCurrentUserReviewQuality() {
  const role = String(sessionContext?.role || '').trim().toLowerCase();
  return role === 'org_admin' || role === 'manager';
}

function getProjectQualityReviews(projectId) {
  return Array.isArray(qualityReviewsByProject[projectId]) ? qualityReviewsByProject[projectId] : [];
}

async function loadProjectQualityReviews(projectId, force = false) {
  const id = String(projectId || '').trim();
  if (!id) return [];
  if (!force && Array.isArray(qualityReviewsByProject[id])) return qualityReviewsByProject[id];
  if (qualityReviewLoadingByProject[id]) return qualityReviewLoadingByProject[id];
  qualityReviewLoadingByProject[id] = (async () => {
    try {
      const response = await fetch(apiUrl('/api/quality-review') + '&projectId=' + encodeURIComponent(id));
      const payload = await response.json().catch(() => ({}));
      const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
      qualityReviewsByProject[id] = reviews;
      return reviews;
    } catch (error) {
      console.error('Failed to load quality reviews:', error);
      return [];
    } finally {
      delete qualityReviewLoadingByProject[id];
    }
  })();
  return qualityReviewLoadingByProject[id];
}

function scheduleRealtimeRefresh(reason = 'sse') {
  if (realtimeRefreshTimer) return;
  realtimeRefreshTimer = setTimeout(async () => {
    realtimeRefreshTimer = null;
    try {
      await loadData();
      if (selectedProjectId) selectProject(selectedProjectId);
    } catch (error) {
      console.error('Realtime refresh failed (' + reason + '):', error);
    }
  }, 700);
}

function handleRealtimeEvent(eventName, payload) {
  if (eventName === 'connected' || eventName === 'heartbeat') return;
  if (payload && payload.projectId) {
    loadProjectQualityReviews(payload.projectId, true).catch(() => null);
  }
  if (eventName === 'quality.review_requested' || eventName === 'quality.review_completed' || eventName === 'data.update') {
    scheduleRealtimeRefresh(eventName);
  }
}

function processRealtimeBuffer() {
  while (true) {
    const boundary = realtimeBuffer.indexOf('\\n\\n');
    if (boundary === -1) break;
    const block = realtimeBuffer.slice(0, boundary);
    realtimeBuffer = realtimeBuffer.slice(boundary + 2);
    if (!block.trim()) continue;
    let eventName = 'message';
    const dataLines = [];
    block.split('\\n').forEach((line) => {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    });
    let payload = {};
    const dataText = dataLines.join('\\n').trim();
    if (dataText) {
      try {
        payload = JSON.parse(dataText);
      } catch (_) {
        payload = { raw: dataText };
      }
    }
    handleRealtimeEvent(eventName, payload);
  }
}

function scheduleRealtimeReconnect() {
  if (realtimeReconnectTimer) return;
  realtimeReconnectTimer = setTimeout(() => {
    realtimeReconnectTimer = null;
    startRealtimeStream().catch(() => null);
  }, 4000);
}

async function startRealtimeStream() {
  if (realtimeAbortController) return;
  realtimeAbortController = new AbortController();
  try {
    const response = await fetch(apiUrl('/api/events'), {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: realtimeAbortController.signal,
      __skipSessionRefresh: true
    });
    if (!response.ok || !response.body) throw new Error('SSE unavailable (' + response.status + ')');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    realtimeBuffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      realtimeBuffer += decoder.decode(chunk.value, { stream: true });
      processRealtimeBuffer();
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.warn('Realtime stream disconnected:', error?.message || error);
    }
  } finally {
    realtimeAbortController = null;
    scheduleRealtimeReconnect();
  }
}

function stopRealtimeStream() {
  if (realtimeReconnectTimer) {
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }
  if (realtimeRefreshTimer) {
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = null;
  }
  if (realtimeAbortController) {
    realtimeAbortController.abort();
    realtimeAbortController = null;
  }
}

// Delete comment
async function deleteComment(projectId, commentId) {
  const currentUser = getCurrentUser();
  
  if (!confirm('Delete this comment?')) {
    return;
  }
  
  try {
    const response = await fetch(`/api/projects/${projectId}/comments/${commentId}?author=${encodeURIComponent(currentUser)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: currentUser })
    });
    
    if (!response.ok) {
      const error = await response.json();
      alert(error.error || 'Failed to delete comment');
      return;
    }
    
    await loadData();
    selectProject(projectId); // Refresh detail view
  } catch (error) {
    console.error('Failed to delete comment:', error);
    alert('Failed to delete comment');
  }
}

// Add comment
async function addComment() {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  
  if (!text || !selectedProjectId) return;
  
  const comment = {
    author: getCurrentUser(),
    text,
    timestamp: new Date().toISOString()
  };
  
  try {
    await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}/comments`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(comment)
    });
    
    input.value = '';
    await loadData();
    selectProject(selectedProjectId); // Refresh detail view
  } catch (error) {
    console.error('Failed to add comment:', error);
  }
}

// Open file
async function openFile(url) {
  if (!url) return;
  
  try {
    await fetch('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: url.replace('file://', '') })
    });
  } catch (error) {
    console.error('Failed to open file:', error);
  }
}

async function addDependency() {
  if (!selectedProjectId) return;
  const name = (document.getElementById('dependencyNameInput')?.value || '').trim();
  const notes = (document.getElementById('dependencyNotesInput')?.value || '').trim();
  const status = (document.getElementById('dependencyStatusInput')?.value || 'pending').trim();

  if (!name) {
    showNotification('Dependency name is required.', 'error');
    return;
  }

  try {
    const response = await fetch(apiUrl(`projects/${selectedProjectId}/dependencies`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, notes, status })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(payload.error || 'Failed to add dependency', 'error');
      return;
    }

    await loadData();
    selectProject(selectedProjectId);
    showNotification('Dependency added.', 'success');
  } catch (error) {
    console.error('Failed to add dependency:', error);
    showNotification('Failed to add dependency', 'error');
  }
}

async function removeDependency(projectId, dependencyId) {
  if (!projectId || !dependencyId) return;
  try {
    const response = await fetch(apiUrl(`projects/${projectId}/dependencies/${encodeURIComponent(dependencyId)}`), {
      method: 'DELETE'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(payload.error || 'Failed to remove dependency', 'error');
      return;
    }

    await loadData();
    selectProject(projectId);
    showNotification('Dependency removed.', 'success');
  } catch (error) {
    console.error('Failed to remove dependency:', error);
    showNotification('Failed to remove dependency', 'error');
  }
}

async function addDocument() {
  if (!selectedProjectId) return;
  const name = (document.getElementById('documentNameInput')?.value || '').trim();
  const url = (document.getElementById('documentPathInput')?.value || '').trim();

  if (!name || !url) {
    showNotification('Document title and path are required.', 'error');
    return;
  }

  try {
    const response = await fetch(apiUrl(`projects/${selectedProjectId}/documents`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, type: 'document' })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(payload.error || 'Failed to add document', 'error');
      return;
    }

    await loadData();
    selectProject(selectedProjectId);
    showNotification('Document added.', 'success');
  } catch (error) {
    console.error('Failed to add document:', error);
    showNotification('Failed to add document', 'error');
  }
}

async function removeDocument(projectId, documentId) {
  if (!projectId || !documentId) return;
  try {
    const response = await fetch(apiUrl(`projects/${projectId}/documents/${encodeURIComponent(documentId)}`), {
      method: 'DELETE'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(payload.error || 'Failed to remove document', 'error');
      return;
    }

    await loadData();
    selectProject(projectId);
    showNotification('Document removed.', 'success');
  } catch (error) {
    console.error('Failed to remove document:', error);
    showNotification('Failed to remove document', 'error');
  }
}

// Project actions
async function saveProjectEdits() {
  if (!selectedProjectId) return;

  const title = (document.getElementById('editJobTitle')?.value || '').trim();
  const notes = (document.getElementById('editJobDescription')?.value || '').trim();
  const owner = (document.getElementById('editJobOwner')?.value || '').trim();
  const clientName = (document.getElementById('editJobClient')?.value || '').trim();
  const actualHours = Number(document.getElementById('editJobHours')?.value || 0);
  const hourlyRate = Number(document.getElementById('editJobRate')?.value || 0);
  const progress = Math.min(100, Math.max(0, Number(document.getElementById('editJobProgress')?.value || 0)));
  const priority = document.getElementById('editJobPriority')?.value || 'P2';
  const dueDateValue = document.getElementById('editJobDueDate')?.value || '';

  if (!title) {
    showNotification('Job title is required.', 'error');
    return;
  }

  const revenue = actualHours * hourlyRate;
  const cost = actualHours * hourlyRate;
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const dueDate = dueDateValue ? new Date(`${dueDateValue}T12:00:00`).toISOString() : null;

  const payload = {
    name: title,
    notes,
    owner,
    clientName,
    actualHours,
    hourlyRate,
    progress,
    priority,
    dueDate,
    revenue,
    cost,
    profit,
    margin,
    lastUpdated: new Date().toISOString()
  };

  if (progress >= 100) {
    payload.status = 'complete';
    payload.completedDate = new Date().toISOString();
  }

  try {
    await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    await loadData();
    selectProject(selectedProjectId);
    renderCalendarLaneNav();
    if (calendar) {
      calendar.refetchEvents();
      updateCalendarTitle();
    }
    showNotification('Job details saved.', 'success');
  } catch (error) {
    console.error('Failed to save job edits:', error);
    showNotification('Failed to save job details', 'error');
  }
}

async function saveFinancialDetails() {
  if (!selectedProjectId) return;

  const hoursInput = document.getElementById('financialHoursInput');
  const rateInput = document.getElementById('financialRateInput');
  const actualHours = Number(hoursInput?.value || 0);
  const hourlyRate = Number(rateInput?.value || 0);

  if (actualHours < 0 || hourlyRate <= 0) {
    showNotification('Enter valid hours and hourly rate first.', 'error');
    return;
  }

  const revenue = actualHours * hourlyRate;
  const cost = actualHours * hourlyRate;
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  try {
    await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actualHours,
        hourlyRate,
        revenue,
        cost,
        profit,
        margin,
        lastUpdated: new Date().toISOString()
      })
    });

    await loadData();
    selectProject(selectedProjectId);
    showNotification('Financial details saved.', 'success');
  } catch (error) {
    console.error('Failed to save financial details:', error);
    showNotification('Failed to save financial details', 'error');
  }
}

async function markAsDelivered() {
  if (!selectedProjectId) return;
  
  // Get current project data
  const project = data.projects.find(p => p.id === selectedProjectId);
  if (!project) return;
  
  // Check if financial data is entered
  if (!project.actualHours || project.actualHours <= 0) {
    showNotification('Please enter hours in the Financial section before marking as delivered', 'error');
    return;
  }
  
  if (!project.hourlyRate || project.hourlyRate <= 0) {
    showNotification('Please enter hourly rate in the Financial section before marking as delivered', 'error');
    return;
  }
  
  // Calculate financials if not already calculated
  const actualHours = project.actualHours || 0;
  const hourlyRate = project.hourlyRate || 150;
  const revenue = project.revenue || (actualHours * hourlyRate);
  const cost = project.cost || (actualHours * hourlyRate);
  const profit = revenue - cost;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  
  try {
    await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliveredDate: new Date().toISOString(),
        actualHours: actualHours,
        revenue: revenue,
        hourlyRate: hourlyRate,
        cost: cost,
        profit: profit,
        margin: margin,
        lastUpdated: new Date().toISOString()
      })
    });
    
    await loadData();
    selectProject(selectedProjectId);
    showNotification('Project marked as delivered! Financial data saved from inline editing.', 'success');
  } catch (error) {
    console.error('Failed to mark as delivered:', error);
    showNotification('Failed to mark as delivered', 'error');
  }
}

async function completeProject() {
  if (!selectedProjectId) return;

  const nowIso = new Date().toISOString();
  const laneBeforeComplete = currentLaneView;
  const project = data.projects.find(p => p.id === selectedProjectId);
  if (project) {
    // Optimistic UI update so it moves to Complete immediately.
    project.status = 'complete';
    project.completedDate = nowIso;
    project.progress = Math.max(Number(project.progress || 0), 100);
    project.lastUpdated = nowIso;
  }

  // Keep the user in their current lane; do not force-jump to COMPLETE.
  currentLaneView = laneBeforeComplete;
  renderProjects();
  renderCalendarLaneNav();
  if (calendar) calendar.refetchEvents();

  try {
    await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'complete',
        progress: 100,
        completedDate: nowIso,
        lastUpdated: nowIso
      })
    });
    
    await loadData();
    selectProject(selectedProjectId);
    showNotification('Moved to Complete.', 'success');
  } catch (error) {
    console.error('Failed to complete project:', error);
    showNotification('Failed to complete project - refreshing data.', 'error');
    await loadData();
  }
}

async function forceRefreshDashboard() {
  await loadData();
  renderCalendarLaneNav();
  if (calendar) {
    calendar.refetchEvents();
    updateCalendarTitle();
  }
  showNotification('Dashboard refreshed.', 'success');
}

async function blockProject() {
  if (!selectedProjectId) return;
  await updateProjectStatus('blocked');
}

async function requestChanges() {
  if (!selectedProjectId) return;
  const project = projects.find(p => p.id === selectedProjectId);
  if (project && getEffectiveStatus(project) === 'quality_review' && canCurrentUserReviewQuality()) {
    await submitQualityReview('changes_requested');
    return;
  }
  
  // Clear delivered date if changes requested (back to work)
  try {
    await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deliveredDate: null,
        actualHours: null,
        lastUpdated: new Date().toISOString()
      })
    });
  } catch (error) {
    console.error('Failed to clear delivery:', error);
  }
  
  const comment = {
    author: 'Otto',
    text: 'Changes requested. Please review and update.',
    timestamp: new Date().toISOString(),
    type: 'change-request'
  };
  
  await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}/comments`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(comment)
  });
  
  await loadData();
  selectProject(selectedProjectId);
}

async function requestQualityReview() {
  if (!selectedProjectId) return;
  const note = prompt('Optional note for reviewer:', '') || '';
  try {
    const response = await fetch(apiUrl('/api/projects/' + selectedProjectId + '/request-quality-review'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Failed to request review');
    await Promise.all([loadData(), loadProjectQualityReviews(selectedProjectId, true)]);
    selectProject(selectedProjectId);
    showNotification('Quality review requested.', 'success');
  } catch (error) {
    console.error('Failed to request quality review:', error);
    showNotification(error.message || 'Failed to request quality review', 'error');
  }
}

async function submitQualityReview(decision) {
  if (!selectedProjectId) return;
  if (!canCurrentUserReviewQuality()) {
    showNotification('Manager or org admin role required.', 'error');
    return;
  }
  const normalized = String(decision || '').trim().toLowerCase();
  if (!['approved', 'changes_requested'].includes(normalized)) {
    showNotification('Invalid quality decision.', 'error');
    return;
  }
  const summaryPrompt = normalized === 'approved'
    ? 'Approval summary (optional):'
    : 'Changes requested summary:';
  const summary = prompt(summaryPrompt, '') || '';
  try {
    const response = await fetch(apiUrl('/api/projects/' + selectedProjectId + '/quality-review'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: normalized, summary })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Failed to submit review');
    await Promise.all([loadData(), loadProjectQualityReviews(selectedProjectId, true)]);
    selectProject(selectedProjectId);
    showNotification(normalized === 'approved' ? 'Quality review approved.' : 'Changes requested.', 'success');
  } catch (error) {
    console.error('Failed to submit quality review:', error);
    showNotification(error.message || 'Failed to submit quality review', 'error');
  }
}

async function updateProjectStatus(status) {
  try {
    await fetch(apiUrl(`/api/projects/${encodeURIComponent(selectedProjectId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, lastUpdated: new Date().toISOString() })
    });
    
    await loadData();
    selectProject(selectedProjectId);
  } catch (error) {
    console.error('Failed to update project:', error);
  }
}

// Theme toggle
function toggleTheme() {
  const html = document.documentElement;
  const currentTheme = html.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  html.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  
  // Update icon
  document.getElementById('themeIcon').textContent = newTheme === 'dark' ? '☀︎' : '☾';
}

// Load saved theme
function loadTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  document.getElementById('themeIcon').textContent = savedTheme === 'dark' ? '☀︎' : '☾';
}

// Filters
document.addEventListener('DOMContentLoaded', () => {
  loadTheme();
  // Sort buttons
  document.querySelectorAll('.filter-btn[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-sort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      renderProjects();
    });
  });
  
  // Category filters
  document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderProjects();
    });
  });
  
  // Status filters
  document.querySelectorAll('.filter-btn[data-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) {
        btn.classList.remove('active');
        currentStatusFilter = null;
      } else {
        document.querySelectorAll('.filter-btn[data-status]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentStatusFilter = btn.dataset.status;
        currentLaneView = btn.dataset.status;
        visibleRowCount = 100;
      }
      renderProjects();
    });
  });
  
  // Search
  document.getElementById('searchBox').addEventListener('input', (e) => {
    searchTerm = e.target.value;
    renderProjects();
  });
  
  loadData();
  startRealtimeStream().catch(() => null);
  loadMyAssignments();
  syncProjectFocusLayout();
  setInterval(() => {
    loadData();
  }, 15000);
});

function closeProjectDetailPanel() {
  selectedProjectId = null;
  const detailPanel = document.getElementById('detailPanel');
  if (detailPanel) {
    detailPanel.classList.remove('active');
    detailPanel.classList.add('empty');
    detailPanel.innerHTML = '<div> Select a project to view details</div>';
    if (currentView === 'calendar') {
      detailPanel.style.display = '';
    }
  }
  syncProjectFocusLayout();
}

// New task modal
function openNewTaskModal() {
  document.getElementById('newTaskModal').classList.add('active');
}

function closeNewTaskModal() {
  document.getElementById('newTaskModal').classList.remove('active');
  document.getElementById('newTaskForm').reset();
}

async function createNewTask(event) {
  event.preventDefault();
  
  const name = document.getElementById('taskName').value;
  const clientName = document.getElementById('taskClient').value;
  const category = document.getElementById('taskCategory').value;
  const owner = document.getElementById('taskOwner').value;
  const priority = document.getElementById('taskPriority').value;
  const description = document.getElementById('taskDescription').value;
  
  const timestampSuffix = Date.now().toString().slice(-6);
  const taskId = `${new Date().toISOString().split('T')[0]}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 30)}-${timestampSuffix}`;
  
  const nowIso = new Date().toISOString();
  const defaultDue = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString();

  const newProject = {
    id: taskId,
    name,
    clientName,
    category,
    owner,
    priority,
    status: 'new',
    progress: 0,
    statusColor: 'blue',
    notes: description,
    createdBy: 'Manual',
    deliverables: [],
    comments: [],
    createdDate: nowIso.split('T')[0],
    startDate: nowIso,
    dueDate: defaultDue
  };
  
  try {
    const response = await fetch(apiUrl('/api/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newProject)
    });
    
    if (response.ok) {
      closeNewTaskModal();
      clearAllProjectFilters();
      switchView('projects');
      await loadData();
      selectProject(taskId);
    }
  } catch (error) {
    console.error('Failed to create task:', error);
    alert('Failed to create task. Please try again.');
  }
}

// Close detail panel on mobile overlay click
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 1400) {
    if (suppressNextDetailPanelClose) {
      suppressNextDetailPanelClose = false;
      return;
    }
    const detailPanel = document.getElementById('detailPanel');
    if (detailPanel.classList.contains('active') && !detailPanel.contains(e.target) && !e.target.closest('.project-card') && !e.target.closest('.worklist-row')) {
      detailPanel.classList.remove('active');
    }
  }
});

// Render activity feed
function renderActivityFeed() {
  console.log('renderActivityFeed called');
  const runtime = Array.isArray(controlTower.activity) ? controlTower.activity : [];
  const fallback = Array.isArray(data.activityFeed) ? data.activityFeed : [];
  const activities = (runtime.length > 0 ? runtime : fallback).slice(0, 14);
  renderedActivityItems = activities;
  const container = document.getElementById('activityFeed');
  console.log('Activity container found:', !!container, 'Activities count:', activities.length);
  
  if (!container) {
    console.error('Activity feed container not found!');
    return;
  }
  
  if (activities.length === 0) {
    container.innerHTML = '<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">No recent activity</div>';
    return;
  }
  
  container.innerHTML = activities.map((activity, index) => {
    const clickable = `style="cursor:pointer;" onclick="handleActivityClick(${index})"`;
    return `
    <div class="activity-item" ${clickable}>
      <div class="activity-emoji">${getActivityEmoji(activity.type)}</div>
      <div class="activity-content">
        <div><strong>${activity.agent || 'System'}</strong> ${activity.action || 'updated'} <strong>${truncate(activity.target || '', 42)}</strong></div>
        <div class="activity-time">${formatTime(activity.timestamp)}</div>
      </div>
    </div>
  `;
  }).join('');
  console.log('Activity feed rendered successfully');
}

// Get activity emoji
function getActivityEmoji(type) {
  const emojiMap = {
    'build': '',
    'comment': '',
    'complete': '',
    'start': '',
    'update': '',
    'error': '',
    'financial': ''
  };
  return emojiMap[type] || '';
}

function resolveActivityProjectId(activity) {
  const directId = String(activity?.projectId || activity?.details?.projectId || '').trim();
  if (directId) return directId;
  const target = String(activity?.target || '').trim();
  if (!target) return '';
  const byId = (projects || []).find(p => String(p.id || '').trim() === target);
  if (byId?.id) return byId.id;
  const byName = (projects || [])
    .filter(p => String(p.name || '').trim() === target)
    .sort((a, b) => new Date(b.lastUpdated || b.createdDate || 0) - new Date(a.lastUpdated || a.createdDate || 0));
  return byName[0]?.id || '';
}

function handleActivityClick(index) {
  const activity = renderedActivityItems[index];
  if (!activity) return;
  const projectId = resolveActivityProjectId(activity);
  const agentName = resolveActivityAgentName(activity);
  openActivityTarget(projectId, agentName);
}

function openActivityTarget(projectId, agentName) {
  if (projectId) {
    switchView('projects');
    selectProject(projectId);
    return;
  }
  if (agentName) {
    openAgentsWorkspace(agentName);
  }
}

function isActivityForAgent(activity, agentName) {
  const target = String(agentName || '').trim().toLowerCase();
  if (!target) return false;
  const actor = String(activity?.agent || '').toLowerCase();
  return actor === target || actor.endsWith(`/${target}`) || actor.includes(target);
}

function getAgentActivity(agentName, limit = 12) {
  const runtime = Array.isArray(controlTower.activity) ? controlTower.activity : [];
  const fallback = Array.isArray(data.activityFeed) ? data.activityFeed : [];
  const pool = runtime.length > 0 ? runtime : fallback;
  return pool
    .filter(item => isActivityForAgent(item, agentName))
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, limit);
}

function resolveActivityAgentName(activity) {
  const raw = String(activity?.agent || '').trim();
  if (!raw) return '';
  const workers = Array.isArray(controlTower.workers) ? controlTower.workers : [];
  const direct = workers.find(w => String(w.name || '').toLowerCase() === raw.toLowerCase());
  if (direct) return String(direct.name || raw);
  const byTail = workers.find(w => raw.toLowerCase().endsWith(`/${String(w.name || '').toLowerCase()}`));
  if (byTail) return String(byTail.name || raw);
  return raw.includes('/') ? raw.split('/').pop().trim() : raw;
}

// Render agents
function renderAgents() {
  console.log('renderAgents called');
  const telemetryAgents = Array.isArray(controlTower.workers) ? controlTower.workers : [];
  const fallbackAgents = data.agents || [];
  const agents = telemetryAgents.length > 0
    ? telemetryAgents
    : fallbackAgents.map(a => ({
      id: `configured/${a.name || 'agent'}`,
      name: a.name,
      status: a.status === 'active' ? 'active' : 'idle',
      currentTask: a.currentTask,
      model: a.model || 'unreported',
      tasksCompleted: a.tasksCompleted || 0,
      tasksAssigned: a.tasksAssigned || 0,
      lastHeartbeatAt: null,
      blockedReason: null,
      workflowId: null
    }));
  const container = document.getElementById('agentsGrid');
  console.log('Agents container found:', !!container, 'Agents count:', agents.length);
  
  if (!container) {
    console.error('Agents container not found!');
    return;
  }
  
  workerDirectory = {};
  agents.forEach(agent => {
    workerDirectory[agent.name] = agent;
  });

  const workingAgents = agents.filter(agent => {
    const status = String(agent.status || '').toLowerCase();
    return status === 'active' || status === 'blocked' || status === 'stale';
  });

  if (workingAgents.length === 0) {
    container.innerHTML = '<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">No agents working</div>';
    return;
  }

  container.innerHTML = workingAgents.map(agent => {
    const status = String(agent.status || 'idle').toLowerCase();
    const statusEmoji = status === 'blocked' ? '' : status === 'stale' ? '' : '';
    const icon = agent.emoji || (agent.workerType === 'human' ? '' : '');
    const isFocused = currentAgentFocus && String(currentAgentFocus).toLowerCase() === String(agent.name || '').toLowerCase();
    return `
    <div class="agent-card" style="cursor:pointer; ${isFocused ? 'border: 1px solid var(--accent-blue); box-shadow: 0 0 0 2px rgba(0,122,255,0.12);' : ''}" onclick="showAgentDetails('${(agent.name || '').replace(/'/g, "\\'")}')">
      <div class="agent-emoji">${icon}</div>
      <div class="agent-info">
        <div class="agent-name">${statusEmoji} ${agent.name}</div>
      </div>
    </div>
  `; }).join('');
  console.log('Agents rendered successfully');
}

function showAgentDetails(agentName) {
  openAgentsWorkspace(agentName);
}

async function renderAgentsWorkspace() {
  const container = document.getElementById('agentsCenterContainer');
  if (!container) return;
  const workers = Array.isArray(controlTower.workers) ? controlTower.workers : [];

  if (workers.length === 0) {
    container.innerHTML = '<div class="worklist-shell"><div class="worklist-empty">No agent telemetry available.</div></div>';
    return;
  }

  const selectedWorker = selectedAgentWorkspace
    ? workers.find(worker => String(worker.name || '').toLowerCase() === String(selectedAgentWorkspace || '').toLowerCase())
    : null;

  if (selectedWorker) {
    const resp = await fetch(`/api/agents/runtime?agent=${encodeURIComponent(selectedWorker.name || '')}`).catch(() => null);
    const runtime = resp && resp.ok ? await resp.json() : { processes: [] };
    const procs = runtime.processes || [];
    const agentProjects = (projects || [])
      .filter(project => projectMatchesAgent(project, selectedWorker.name))
      .sort((a, b) => getDueOrPrimaryDate(a) - getDueOrPrimaryDate(b));
    const status = String(selectedWorker.status || 'idle').toLowerCase();
    const statusEmoji = status === 'blocked' ? '' : status === 'stale' ? '' : status === 'active' ? '' : '';
    const taskText = selectedWorker.currentTask || 'No active task';
    const agentActivity = getAgentActivity(selectedWorker.name, 12);

    const projectsHtml = agentProjects.length
      ? agentProjects.map(project => `
          <div class="worklist-row" onclick="switchView('projects'); selectProject('${escapeForJsString(project.id || '')}')" style="cursor:pointer;">
            <div class="work-col id">${escapeForHtmlText(project.id || '-')}</div>
            <div class="work-col title">${escapeForHtmlText(project.name || 'Untitled')}</div>
            <div class="work-col status status-${getEffectiveStatus(project)}">${getStatusLabel(getEffectiveStatus(project))}</div>
            <div class="work-col due">${formatDateShort(project.dueDate)}</div>
          </div>
        `).join('')
      : '<div class="worklist-empty">No projects currently matched to this agent.</div>';

    const processHtml = procs.length
      ? procs.map(proc => `
          <div style="font-size:12px; color: var(--text-secondary); margin-top:6px;">
            PID ${proc.pid} • ${escapeForHtmlText(truncate(proc.command, 140))}
            <button class="btn" style="padding:2px 7px; font-size:10px; margin-left:8px; background: var(--status-red); color:#fff;" onclick="killAgentProcess('${(selectedWorker.name || '').replace(/'/g, "\\'")}', ${proc.pid})">Kill PID</button>
          </div>
        `).join('')
      : '<div style="font-size:12px; color: var(--text-secondary);">No runtime processes detected.</div>';

    const activityHtml = agentActivity.length
      ? agentActivity.map(item => {
          const activityProjectId = resolveActivityProjectId(item);
          const activityAgentName = resolveActivityAgentName(item) || selectedWorker.name || '';
          return `
          <div class="activity-item" style="margin-bottom:8px; cursor:pointer;" onclick="openActivityTarget('${escapeForJsString(activityProjectId)}','${escapeForJsString(activityAgentName)}')">
            <div class="activity-emoji">${getActivityEmoji(item.type)}</div>
            <div class="activity-content">
              <div><strong>${escapeForHtmlText(item.action || 'update')}</strong> ${escapeForHtmlText(truncate(item.target || '', 72))}</div>
              <div class="activity-time">${formatTime(item.timestamp)}</div>
            </div>
          </div>
        `;
        }).join('')
      : '<div style="font-size:12px; color: var(--text-secondary);">No recent activity for this agent yet.</div>';

    container.innerHTML = `
      <div class="worklist-shell">
        <div class="worklist-toolbar">
          <div style="font-weight:700;">${escapeForHtmlText(selectedWorker.name || 'Agent')} Workspace</div>
          <div style="display:flex; gap:8px;">
            <button class="btn" onclick="selectedAgentWorkspace=null; renderAgentsWorkspace()" style="padding:7px 10px;">All Agents</button>
            <button class="btn" onclick="showAgentProjectsInWorkspace('${(selectedWorker.name || '').replace(/'/g, "\\'")}')" style="padding:7px 10px;">Agent Projects</button>
            <button class="btn" onclick="spawnAgentConversation('${(selectedWorker.name || '').replace(/'/g, "\\'")}')" style="padding:7px 10px;">New Conversation</button>
            <button class="btn" onclick="killAgentProcess('${(selectedWorker.name || '').replace(/'/g, "\\'")}')" style="padding:7px 10px; background: var(--status-red); color:#fff;">Kill Process</button>
            <button class="btn" onclick="renderAgentsWorkspace()" style="padding:7px 10px;">Refresh</button>
          </div>
        </div>
        <div class="info-grid" style="margin-bottom:14px;">
          <div class="info-item"><div class="info-label">STATUS</div><div class="info-value">${statusEmoji} ${escapeForHtmlText(getStatusLabel(status))}</div></div>
          <div class="info-item"><div class="info-label">MODEL</div><div class="info-value">${escapeForHtmlText(selectedWorker.model || 'unreported')}</div></div>
          <div class="info-item"><div class="info-label">HEARTBEAT</div><div class="info-value">${escapeForHtmlText(formatRelativeTime(selectedWorker.lastHeartbeatAt))}</div></div>
          <div class="info-item"><div class="info-label">TASK</div><div class="info-value">${escapeForHtmlText(truncate(taskText, 64))}</div></div>
        </div>
        <div class="detail-section" style="margin-bottom:14px;">
          <div class="detail-section-title">RUNTIME PROCESSES (${procs.length})</div>
          <div class="detail-content">${processHtml}</div>
        </div>
        <div class="detail-section" style="margin-bottom:14px;">
          <div class="detail-section-title">AGENT ACTIVITY (${agentActivity.length})</div>
          <div class="detail-content">${activityHtml}</div>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">PROJECTS (${agentProjects.length})</div>
          <div class="worklist-table compact">
            <div class="worklist-header">
              <div class="work-col id">ID</div>
              <div class="work-col title">TITLE</div>
              <div class="work-col status">STATUS</div>
              <div class="work-col due">DUE</div>
            </div>
            <div class="worklist-body">${projectsHtml}</div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const rows = await Promise.all(workers.map(async worker => {
    const resp = await fetch(`/api/agents/runtime?agent=${encodeURIComponent(worker.name || '')}`).catch(() => null);
    const runtime = resp && resp.ok ? await resp.json() : { processes: [] };
    const procs = (runtime.processes || []).slice(0, 5);
    const selected = selectedAgentWorkspace && selectedAgentWorkspace === worker.name ? 'active' : '';
    return `
      <div class="worklist-row ${selected}" style="grid-template-columns: 1.2fr 1.2fr 1.8fr 1.2fr 1fr 1fr 1fr; cursor: default;">
        <div class="work-col id">${escapeForHtmlText(worker.name || 'Agent')}</div>
        <div class="work-col client">${escapeForHtmlText(worker.status || 'idle')}</div>
        <div class="work-col title">${escapeForHtmlText(truncate(worker.currentTask || 'No active task', 48))}</div>
        <div class="work-col owner">${escapeForHtmlText(worker.model || 'unreported')}</div>
        <div class="work-col due">${escapeForHtmlText(formatRelativeTime(worker.lastHeartbeatAt))}</div>
        <div class="work-col priority">
          <button class="btn" style="padding:4px 8px; font-size:11px; margin-right:6px;" onclick="openAgentsWorkspace('${(worker.name || '').replace(/'/g, "\\'")}')">Details</button>
          <button class="btn" style="padding:4px 8px; font-size:11px;" onclick="spawnAgentConversation('${(worker.name || '').replace(/'/g, "\\'")}')">New Conversation</button>
        </div>
        <div class="work-col status">
          <button class="btn" style="padding:4px 8px; font-size:11px; background: var(--status-red); color:white;" onclick="killAgentProcess('${(worker.name || '').replace(/'/g, "\\'")}')">Kill</button>
        </div>
      </div>
      ${procs.length > 0 ? `
        <div style="padding: 0 12px 10px 12px; border-bottom:1px solid rgba(0,0,0,0.06);">
          ${procs.map(proc => `<div style="font-size:11px; color: var(--text-secondary); margin-top:4px;">PID ${proc.pid} • ${escapeForHtmlText(truncate(proc.command, 120))} <button class="btn" style="padding:2px 6px; font-size:10px; margin-left:6px; background: var(--status-red); color:#fff;" onclick="killAgentProcess('${(worker.name || '').replace(/'/g, "\\'")}', ${proc.pid})">Kill PID</button></div>`).join('')}
        </div>
      ` : ''}
    `;
  }));

  container.innerHTML = `
    <div class="worklist-shell">
      <div class="worklist-toolbar">
        <div style="font-weight:700;">Agent Command Center</div>
        <div style="display:flex; gap:8px;">
          <button class="btn" onclick="switchView('projects')" style="padding:7px 10px;">Back To Projects</button>
          <button class="btn" onclick="renderAgentsWorkspace()" style="padding:7px 10px;">Refresh</button>
        </div>
      </div>
      <div class="worklist-meta">Select an agent action: spawn a conversation, kill a hung process, or jump to project list.</div>
      <div class="worklist-table compact">
        <div class="worklist-header" style="grid-template-columns: 1.2fr 1.2fr 1.8fr 1.2fr 1fr 1fr 1fr;">
          <div class="work-col id">Agent</div>
          <div class="work-col client">Status</div>
          <div class="work-col title">Current Task</div>
          <div class="work-col owner">Model</div>
          <div class="work-col due">Heartbeat</div>
          <div class="work-col priority">Conversation</div>
          <div class="work-col status">Process</div>
        </div>
        <div class="worklist-body">${rows.join('')}</div>
      </div>
    </div>
  `;
}

function openAgentsWorkspace(agentName = null) {
  selectedAgentWorkspace = agentName || null;
  switchView('agents');
  renderAgentsWorkspace();
}

async function spawnAgentConversation(agentName) {
  const promptText = prompt(`New conversation for ${agentName}:\n\nWhat should this agent work on?`);
  if (!promptText) return;
  const title = prompt(`Optional title for this conversation ticket:`, `Conversation with ${agentName}`) || `Conversation with ${agentName}`;
  try {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentName)}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, prompt: promptText })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Failed to spawn conversation');
    showNotification(`Conversation spawned for ${agentName}.`, 'success');
    await loadData();
    showAgentProjectsInWorkspace(agentName);
  } catch (error) {
    console.error('Failed to spawn conversation:', error);
    showNotification(error.message || 'Failed to spawn conversation', 'error');
  }
}

async function killAgentProcess(agentName, pid = null) {
  const ok = confirm(pid
    ? `Kill process PID ${pid} for ${agentName}?`
    : `Kill running process(es) for ${agentName}?`);
  if (!ok) return;
  try {
    const response = await fetch('/api/agents/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName, pid })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Failed to kill process');
    showNotification(`Killed ${payload.killed?.length || 0} process(es) for ${agentName}.`, 'success');
    await loadData();
    renderAgentsWorkspace();
  } catch (error) {
    console.error('Failed to kill process:', error);
    showNotification(error.message || 'Failed to kill process', 'error');
  }
}

// Render daily logs
async function renderDailyLogs() {
  console.log('renderDailyLogs called');
  const container = document.getElementById('dailyLogs');
  console.log('Daily logs container found:', !!container);
  
  if (!container) {
    console.error('Daily logs container not found!');
    return;
  }
  
  try {
    const response = await fetch(apiUrl('/api/logs'));
    const data = await response.json();
    const logs = data.logs || [];
    console.log('Logs fetched:', logs.length);
    
    if (!logs || logs.length === 0) {
      container.innerHTML = '<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">No recent logs</div>';
      return;
    }
    
    container.innerHTML = logs.map(log => `
      <div class="activity-item" style="cursor: pointer;" onclick="openLog('${(log.path || '').replace(/'/g, "\\'")}')">
        <div class="activity-emoji"></div>
        <div class="activity-content">
          <div><strong>${log.label || log.date || log.file}</strong></div>
          <div class="activity-time">${log.summary || (log.size ? Math.round(log.size / 100) + ' lines' : 'Empty')}</div>
        </div>
      </div>
    `).join('');
    console.log('Daily logs rendered successfully');
  } catch (error) {
    console.error('Failed to load logs:', error);
    container.innerHTML = '<div style="padding: 8px; color: var(--text-secondary); font-size: 11px;">Failed to load logs</div>';
  }
}

// Open log file
async function openLog(filePath) {
  if (!filePath) return;

  try {
    const response = await fetch('/api/open-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath })
    });
    
    if (!response.ok) {
      throw new Error('Failed to open file');
    }
  } catch (error) {
    console.error('Failed to open log:', error);
    alert('Failed to open log file');
  }
}

async function renderFileHub() {
  const container = document.getElementById('fileHubLinks');
  if (!container) return;

  const defaultLinks = [
    { label: 'AI_Drive', path: '/Volumes/AI_Drive/' },
    { label: 'D1010_Archives', path: '/Volumes/AI_Drive/ARCHIVE/' },
    { label: 'Daily Logs', path: '/Volumes/AI_Drive/AI_WORKING/memory/' }
  ];

  const customLinks = Array.isArray(data.fileHubLinks) ? data.fileHubLinks : [];
  const links = [...defaultLinks, ...customLinks];

  container.innerHTML = links.map(link =>
    `<button class="filter-btn" onclick="openFileManagerPath('${link.path.replace(/'/g, "\\'")}')">${link.label}</button>`
  ).join('');
}

async function openWorkspacePath(path) {
  openFileManagerPath(path);
}

function openManageFileHubModal() {
  document.getElementById('manageFileHubModal').classList.add('active');
  renderFileHubConnectionsList();
}

function closeManageFileHubModal() {
  document.getElementById('manageFileHubModal').classList.remove('active');
  document.getElementById('addFileHubForm').reset();
}

function getFileHubTypeIcon(type) {
  const map = {
    external: '',
    google: '',
    microsoft: '',
    dropbox: '',
    other: ''
  };
  return map[String(type || '').toLowerCase()] || '';
}

function renderFileHubConnectionsList() {
  const container = document.getElementById('fileHubConnectionsList');
  if (!container) return;

  const defaults = [
    { label: 'AI_Drive', path: '/Volumes/AI_Drive/', type: 'default' },
    { label: 'D1010_Archives', path: '/Volumes/AI_Drive/ARCHIVE/', type: 'default' },
    { label: 'Daily Logs', path: '/Volumes/AI_Drive/AI_WORKING/memory/', type: 'default' }
  ];
  const custom = Array.isArray(data.fileHubLinks) ? data.fileHubLinks : [];
  const links = [...defaults, ...custom];

  if (links.length === 0) {
    container.innerHTML = '<div style="padding: 12px; color: var(--text-secondary); text-align: center;">No sources connected</div>';
    return;
  }

  container.innerHTML = links.map(link => `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255, 255, 255, 0.5); border-radius: 8px; margin-bottom: 6px; gap: 10px;">
      <div style="min-width: 0;">
        <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${getFileHubTypeIcon(link.type)} ${escapeForHtmlText(link.label || 'Source')}</div>
        <div style="font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeForHtmlText(link.path || '')}</div>
      </div>
      ${link.type === 'default' ? '<span style="font-size: 11px; color: var(--text-secondary);">Default</span>' : `<button onclick="removeFileHubLink('${(link.id || '').replace(/'/g, "\\'")}')" class="btn" style="background: var(--status-red); color: white; padding: 6px 12px; font-size: 11px;">Remove</button>`}
    </div>
  `).join('');
}

async function addFileHubLink(event) {
  event.preventDefault();

  const labelInput = document.getElementById('newFileHubLabel');
  const typeInput = document.getElementById('newFileHubType');
  const pathInput = document.getElementById('newFileHubPath');
  const type = (typeInput?.value || 'external').trim();
  const rawPath = (pathInput?.value || '').trim();
  const normalized = normalizeStartPath(rawPath);
  if (!normalized) {
    showNotification('Path must be under /Volumes or /Users/ottomac/Library/CloudStorage', 'error');
    return;
  }

  const label = (labelInput?.value || '').trim() || `${type[0].toUpperCase()}${type.slice(1)} Asset`;

  try {
    const response = await fetch('/api/file-hub-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, type, path: normalized })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(payload.error || 'Failed to connect asset', 'error');
      return;
    }

    await loadData();
    renderFileHubConnectionsList();
    renderFileHub();
    document.getElementById('addFileHubForm').reset();
    showNotification('Asset source connected.', 'success');
  } catch (error) {
    console.error('Failed to add file hub link:', error);
    showNotification('Failed to connect asset', 'error');
  }
}

async function removeFileHubLink(linkId) {
  if (!linkId) return;
  if (!confirm('Remove this connected source?')) return;

  try {
    const response = await fetch(`/api/file-hub-links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      showNotification('Failed to remove source', 'error');
      return;
    }
    await loadData();
    renderFileHubConnectionsList();
    renderFileHub();
    showNotification('Connected source removed.', 'success');
  } catch (error) {
    console.error('Failed to remove file hub link:', error);
    showNotification('Failed to remove source', 'error');
  }
}

// Truncate text helper
function truncate(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

// Manage Clients Modal
function openManageClientsModal() {
  document.getElementById('manageClientsModal').classList.add('active');
  renderClientsList();
}

function closeManageClientsModal() {
  document.getElementById('manageClientsModal').classList.remove('active');
  document.getElementById('addClientForm').reset();
}

function renderClientsList() {
  const clients = data.clients || [...new Set(projects
    .map(p => p.clientName)
    .filter(Boolean)
    .sort())];
  
  const container = document.getElementById('clientsList');
  
  if (clients.length === 0) {
    container.innerHTML = '<div style="padding: 12px; color: var(--text-secondary); text-align: center;">No clients yet</div>';
    return;
  }
  
  container.innerHTML = clients.map(client => `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255, 255, 255, 0.5); border-radius: 8px; margin-bottom: 6px;">
      <span style="font-size: 13px;"> ${client}</span>
      <button onclick="removeClient('${client.replace(/'/g, "\\'")}');" class="btn" style="background: var(--status-red); color: white; padding: 6px 12px; font-size: 11px;">Remove</button>
    </div>
  `).join('');
}

async function addClient(event) {
  event.preventDefault();
  
  const clientName = document.getElementById('newClientName').value.trim();
  
  if (!clientName) return;
  
  const clients = data.clients || [...new Set(projects
    .map(p => p.clientName)
    .filter(Boolean))];
  
  if (clients.includes(clientName)) {
    alert('Client already exists');
    return;
  }
  
  try {
    const response = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: clientName })
    });
    
    if (response.ok) {
      document.getElementById('newClientName').value = '';
      await loadData();
      renderClientsList();
    } else {
      alert('Failed to add client');
    }
  } catch (error) {
    console.error('Failed to add client:', error);
    alert('Failed to add client');
  }
}

async function removeClient(clientName) {
  const projectsWithClient = projects.filter(p => p.clientName === clientName).length;
  
  if (projectsWithClient > 0) {
    if (!confirm(`This client has ${projectsWithClient} project(s). Remove anyway? Projects will not be deleted.`)) {
      return;
    }
  } else {
    if (!confirm(`Remove "${clientName}"?`)) {
      return;
    }
  }
  
  try {
    const response = await fetch(`/api/clients/${encodeURIComponent(clientName)}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      await loadData();
      renderClientsList();
    } else {
      alert('Failed to remove client');
    }
  } catch (error) {
    console.error('Failed to remove client:', error);
    alert('Failed to remove client');
  }
}

// Manage Categories Modal
function openManageCategoriesModal() {
  document.getElementById('manageCategoriesModal').classList.add('active');
  renderCategoriesList();
}

function closeManageCategoriesModal() {
  document.getElementById('manageCategoriesModal').classList.remove('active');
  document.getElementById('addCategoryForm').reset();
}

function renderCategoriesList() {
  const categories = (data.categories || [
    { name: 'Marketing', emoji: '' },
    { name: 'Creative', emoji: '' },
    { name: 'Operations', emoji: '' },
    { name: 'Development', emoji: '' }
  ]).sort((a, b) => a.name.localeCompare(b.name));
  
  const container = document.getElementById('categoriesList');
  
  if (categories.length === 0) {
    container.innerHTML = '<div style="padding: 12px; color: var(--text-secondary); text-align: center;">No categories yet</div>';
    return;
  }
  
  container.innerHTML = categories.map(cat => `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(255, 255, 255, 0.5); border-radius: 8px; margin-bottom: 6px;">
      <span style="font-size: 13px;">${cat.emoji} ${cat.name}</span>
      <button onclick="removeCategory('${cat.name.replace(/'/g, "\\'")}');" class="btn" style="background: var(--status-red); color: white; padding: 6px 12px; font-size: 11px;">Remove</button>
    </div>
  `).join('');
}

function suggestCategoryEmoji(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return '📁';
  if (/host|server|infra|devops|dns/.test(key)) return '🖥️';
  if (/market|ads|seo/.test(key)) return '📢';
  if (/design|creative|brand/.test(key)) return '🎨';
  if (/develop|engineer|code|app|web/.test(key)) return '💻';
  if (/support|help|ticket/.test(key)) return '🛠️';
  if (/finance|billing|invoice/.test(key)) return '💰';
  if (/ops|operation/.test(key)) return '⚙️';
  return '📁';
}

async function addCategory(event) {
  event.preventDefault();

  const name = document.getElementById('newCategoryName').value.trim();
  const rawEmoji = document.getElementById('newCategoryEmoji').value.trim();
  if (!name) return;

  const emoji = rawEmoji || suggestCategoryEmoji(name);
  const categories = data.categories || [];

  if (categories.find(c => String(c.name || '').toLowerCase() === name.toLowerCase())) {
    showNotification('Category already exists', 'error');
    return;
  }

  try {
    const response = await fetch(apiUrl('/api/categories'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, emoji })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to add category');
    }

    document.getElementById('newCategoryName').value = '';
    document.getElementById('newCategoryEmoji').value = '';
    await loadData();
    renderCategoriesList();
    showNotification('Category added.', 'success');
  } catch (error) {
    console.error('Failed to add category:', error);
    showNotification(error.message || 'Failed to add category', 'error');
  }
}

async function removeCategory(categoryName) {
  const projectsInCategory = projects.filter(p => p.category === categoryName).length;
  
  if (projectsInCategory > 0) {
    if (!confirm(`This category has ${projectsInCategory} project(s). Remove anyway? Projects will not be deleted.`)) {
      return;
    }
  } else {
    if (!confirm(`Remove category "${categoryName}"?`)) {
      return;
    }
  }
  
  try {
    const response = await fetch(`/api/categories/${encodeURIComponent(categoryName)}`, {
      method: 'DELETE'
    });
    
    if (response.ok) {
      await loadData();
      renderCategoriesList();
    } else {
      alert('Failed to remove category');
    }
  } catch (error) {
    console.error('Failed to remove category:', error);
    alert('Failed to remove category');
  }
}

function getResolvedDisplayTimezone() {
  const configured = String(settingsState?.timezone || '').trim();
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!configured) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured }).format(new Date());
    return configured;
  } catch (error) {
    return fallback;
  }
}

// Update header date/time
function updateHeaderDateTime() {
  const now = new Date();
  const timeZone = getResolvedDisplayTimezone();

  const dateStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone
  }).format(now).toUpperCase();

  const timeStr = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone
  }).format(now);

  const dateEl = document.getElementById('headerDate');
  const timeEl = document.getElementById('headerTime');

  if (dateEl) dateEl.textContent = dateStr;
  if (timeEl) timeEl.textContent = timeStr;
}

// Update time every second
setInterval(updateHeaderDateTime, 1000);
updateHeaderDateTime(); // Initial call
setInterval(renderFooterMeta, 30000);

// Calendar View Functions
let calendar = null;
let currentView = 'projects';

function syncProjectFocusLayout() {
  const main = document.querySelector('.main-content');
  if (!main) return;
  const supportsDetailOverlay = currentView === 'projects' || currentView === 'calendar';
  const shouldFocus = supportsDetailOverlay && Boolean(selectedProjectId);
  main.classList.toggle('project-focus', shouldFocus);
}


// Switch between Projects and Calendar view
function switchView(view) {
  console.log(`switchView called: ${view}`);
  currentView = view;
  
  // Update tabs
  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  
  const activeTab = document.querySelector(`.view-tab[data-view="${view}"]`);
  if (activeTab) {
    activeTab.classList.add('active');
  }
  
  // Update content
  document.querySelectorAll('.view-content').forEach(content => {
    content.style.display = 'none';
  });
  
  const activeContent = document.getElementById(`${view}View`);
  if (activeContent) {
    activeContent.style.display = 'block';
  }
  
  // Initialize calendar if switching to calendar view
  if (view === 'calendar' && !calendar) {
    renderCalendarLaneNav();
    setTimeout(initCalendar, 100); // Small delay to ensure DOM is ready
  }
  
  // Refresh calendar if already initialized
  if (view === 'calendar' && calendar) {
    renderCalendarLaneNav();
    calendar.refetchEvents();
    updateCalendarTitle();
  }

  const detailPanel = document.getElementById('detailPanel');
  if (detailPanel) {
    detailPanel.style.display = (view === 'projects' || view === 'calendar') ? '' : 'none';
  }

  if (view !== 'projects' && view !== 'calendar') {
    selectedProjectId = null;
  }
  syncProjectFocusLayout();

  if (view === 'agents') {
    renderAgentsWorkspace();
  }
  if (view === 'conversations') {
    loadConversations(true);
    loadMyAssignments().then(() => renderConversationsView());
    renderConversationsView();
  }
  if (view === 'settings') {
    renderSettingsView();
  }
  if (view === 'briefing') {
    renderBriefingView();
  }
  if (view === 'client-portal') {
    renderClientPortalView();
  }
  if (view === 'intake') {
    renderIntakeView();
  }
  if (view === 'finance') {
    renderFinanceView();
  }
  if (view === 'pl') {
    renderPLView();
  }
}


async function loadMyAssignments() {
  try {
    const response = await fetch(apiUrl('/api/assignments?mine=true'));
    const body = response.ok ? await response.json() : {};
    myAssignments = Array.isArray(body.assignments) ? body.assignments : [];
  } catch (error) {
    console.error('Failed to load assignments:', error);
    myAssignments = [];
  }
}

function closeAssignmentWorkspaceModal() {
  const modal = document.getElementById('assignmentWorkspaceModal');
  if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
}

function openAssignmentWorkspace(assignmentId) {
  const id = String(assignmentId || '').trim();
  if (!id) return;
  const assignment = (Array.isArray(data.assignments) ? data.assignments : []).find((a) => String(a.id || '') === id)
    || (Array.isArray(myAssignments) ? myAssignments.find((a) => String(a.id || '') === id) : null);
  if (!assignment) {
    showNotification('Assignment not found.', 'error');
    return;
  }

  closeAssignmentWorkspaceModal();
  const wrapper = document.createElement('div');
  wrapper.id = 'assignmentWorkspaceModal';
  wrapper.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:9999; display:flex; align-items:center; justify-content:center; padding:16px;';

  const due = String(assignment.dueAt || '').slice(0, 10);
  const project = (Array.isArray(data.projects) ? data.projects : []).find((item) => String(item.id || '') === String(assignment.projectId || '')) || null;
  const subtasks = Array.isArray(assignment.subtasks) ? assignment.subtasks : [];
  const doneSubtasks = subtasks.filter((item) => Boolean(item.done)).length;
  const subtaskSummary = getAssignmentSubtaskMeta(assignment);
  const taskDescription = String(assignment.description || '').trim();
  const taskDescriptionHtml = taskDescription
    ? '<div style="padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:10px; background:rgba(15,23,42,0.03); display:grid; gap:6px;">' +
        '<div style="font-size:11px; color:#6b7280; letter-spacing:0.04em; font-weight:700;">TASK BRIEF</div>' +
        '<div style="font-size:12px; color:#4b5563; white-space:pre-wrap;">' + escapeForHtmlText(taskDescription) + '</div>' +
      '</div>'
    : '';
  const subtasksHtml = `<div style="padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:10px; background:rgba(15,23,42,0.03); display:grid; gap:8px;">
    <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; flex-wrap:wrap;">
      <div style="font-size:11px; color:#6b7280; letter-spacing:0.04em; font-weight:700;">SUBTASKS</div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <div style="font-size:11px; color:#6b7280;">${doneSubtasks}/${subtasks.length} done</div>
        <button type="button" class="btn" style="padding:4px 8px; font-size:11px;" onclick="generateAssignmentSubtasks('${escapeForJsString(id)}')">${subtasks.length ? 'Generate More' : 'Generate Steps'}</button>
      </div>
    </div>
    ${subtasks.length ? subtasks.map((subtask) => `
      <label style="display:flex; gap:8px; align-items:flex-start; margin-bottom:0; padding:8px; background:#fff; border:1px solid rgba(0,0,0,0.06); border-radius:8px;">
        <input type="checkbox" ${subtask.done ? 'checked' : ''} onchange="toggleAssignmentSubtask('${escapeForJsString(id)}', '${escapeForJsString(subtask.id || '')}', this.checked)" style="margin-top:3px; width:16px; height:16px; accent-color: var(--accent-blue);" />
        <span style="flex:1; font-size:12px; line-height:1.4; ${subtask.done ? 'text-decoration:line-through; color:#6b7280;' : 'color:#111827;'}">${escapeForHtmlText(subtask.title || 'Untitled step')}</span>
        <button type="button" class="btn" style="padding:4px 8px; font-size:11px;" onclick="deleteAssignmentSubtask('${escapeForJsString(id)}', '${escapeForJsString(subtask.id || '')}')">Remove</button>
      </label>
    `).join('') : '<div style="font-size:12px; color:#6b7280;">No subtasks yet. Generate from the task brief or add the checklist manually.</div>'}
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <input id="assignmentSubtaskInput" class="form-input" type="text" placeholder="Add a subtask for this task" style="flex:1; min-width:220px;" onkeydown="if(event.key==='Enter'){event.preventDefault(); addAssignmentSubtask('${escapeForJsString(id)}');}" />
      <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="addAssignmentSubtask('${escapeForJsString(id)}')">Add Step</button>
    </div>
  </div>`;
  const projectContextHtml = project
    ? '<div style="padding:10px 12px; border:1px solid rgba(0,0,0,0.08); border-radius:10px; background:rgba(15,23,42,0.03); display:flex; justify-content:space-between; gap:10px; align-items:center;">' +
        '<div>' +
          '<div style="font-size:11px; color:#6b7280; letter-spacing:0.04em; font-weight:700;">PROJECT CONTEXT</div>' +
          '<div style="font-weight:600; font-size:13px;">' + escapeForHtmlText(project.name || 'Project') + '</div>' +
          '<div style="font-size:12px; color:#4b5563;">Source requests, client notes, and attachments live in Project Details.</div>' +
        '</div>' +
        '<button class="btn" onclick="openProjectDetailsForAssignment(\'' + escapeForJsString(project.id || '') + '\')" style="padding:6px 10px; font-size:11px; white-space:nowrap;">Open Project Details</button>' +
      '</div>'
    : '<div style="padding:10px 12px; border:1px dashed rgba(0,0,0,0.12); border-radius:10px; font-size:12px; color:#6b7280;">Project context is not available for this task.</div>';
  const html =
    '<div style="width:min(640px, 100%); max-height:90vh; background:#fff; border-radius:12px; box-shadow:0 18px 45px rgba(0,0,0,0.25); overflow:hidden; display:flex; flex-direction:column;">' +
      '<div style="padding:12px 14px; border-bottom:1px solid rgba(0,0,0,0.08); display:flex; justify-content:space-between; align-items:center; gap:10px;">' +
        '<div>' +
          '<div style="font-size:12px; color:#6b7280;">Task Workspace</div>' +
          '<div style="font-weight:700; font-size:14px;">' + escapeForHtmlText(assignment.title || 'Untitled') + '</div>' +
          '<div style="font-size:11px; color:#6b7280;">' + escapeForHtmlText(assignment.id || '') + ' • @' + escapeForHtmlText(assignment.assigneeName || assignment.assigneeEmail || 'unassigned') + ' • ' + escapeForHtmlText(project?.name || 'No project linked') + subtaskSummary + '</div>' +
        '</div>' +
        '<button class="btn" onclick="closeAssignmentWorkspaceModal()" style="padding:4px 8px;">Close</button>' +
      '</div>' +
      '<div style="padding:14px; display:grid; gap:10px; overflow:auto;">' +
        projectContextHtml +
        taskDescriptionHtml +
        subtasksHtml +
        '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:8px;">' +
          '<div>' +
            '<label style="display:block; font-size:11px; color:#6b7280; margin-bottom:4px;">Status</label>' +
            '<select id="assignmentWorkspaceStatus" class="form-select">' +
              '<option value="open" ' + (String(assignment.status || '').toLowerCase()==='open' ? 'selected' : '') + '>Open</option>' +
              '<option value="in_progress" ' + (String(assignment.status || '').toLowerCase()==='in_progress' ? 'selected' : '') + '>In Progress</option>' +
              '<option value="blocked" ' + (String(assignment.status || '').toLowerCase()==='blocked' ? 'selected' : '') + '>Blocked</option>' +
              '<option value="done" ' + (String(assignment.status || '').toLowerCase()==='done' ? 'selected' : '') + '>Done</option>' +
            '</select>' +
          '</div>' +
          '<div>' +
            '<label style="display:block; font-size:11px; color:#6b7280; margin-bottom:4px;">Hours</label>' +
            '<input id="assignmentWorkspaceHours" class="form-input" type="number" min="0" step="0.25" value="' + Number(assignment.loggedHours || 0) + '" />' +
          '</div>' +
          '<div>' +
            '<label style="display:block; font-size:11px; color:#6b7280; margin-bottom:4px;">Due Date</label>' +
            '<input id="assignmentWorkspaceDueAt" class="form-input" type="date" value="' + escapeForHtmlAttr(due) + '" />' +
          '</div>' +
        '</div>' +
        '<div>' +
          '<label style="display:block; font-size:11px; color:#6b7280; margin-bottom:4px;">Work Notes</label>' +
          '<textarea id="assignmentWorkspaceNote" class="comment-input" style="width:100%; min-height:100px;" placeholder="What was done, blockers, links, handoff notes..."></textarea>' +
        '</div>' +
        '<div style="display:flex; justify-content:flex-end; gap:8px;">' +
          '<button class="btn" onclick="closeAssignmentWorkspaceModal()">Cancel</button>' +
          '<button id="assignmentWorkspaceSaveBtn" class="btn btn-primary">Save Update</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  wrapper.innerHTML = html;
  const saveBtn = wrapper.querySelector('#assignmentWorkspaceSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveAssignmentWorkspace(id));
  wrapper.addEventListener('click', (event) => {
    if (event.target === wrapper) closeAssignmentWorkspaceModal();
  });
  document.body.appendChild(wrapper);
}

async function saveAssignmentWorkspace(assignmentId) {
  const id = String(assignmentId || '').trim();
  const statusEl = document.getElementById('assignmentWorkspaceStatus');
  const hoursEl = document.getElementById('assignmentWorkspaceHours');
  const noteEl = document.getElementById('assignmentWorkspaceNote');
  const dueEl = document.getElementById('assignmentWorkspaceDueAt');

  const status = String(statusEl?.value || '').trim().toLowerCase();
  if (!['open', 'in_progress', 'blocked', 'done'].includes(status)) {
    showNotification('Invalid status value.', 'error');
    return;
  }
  const parsedHours = Number(String(hoursEl?.value || '').trim() || '0');
  if (!Number.isFinite(parsedHours) || parsedHours < 0) {
    showNotification('Hours must be a non-negative number.', 'error');
    return;
  }

  const payload = {
    status,
    hours: Math.round(parsedHours * 100) / 100,
    note: String(noteEl?.value || '').trim(),
    dueAt: String(dueEl?.value || '').trim() || null
  };

  try {
    const response = await fetch(apiUrl('/api/assignments/' + encodeURIComponent(id)), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to update assignment');
    closeAssignmentWorkspaceModal();
    showNotification('Assignment workspace updated.', 'success');
    await loadMyAssignments();
    await loadData();
    if (selectedProjectId) selectProject(selectedProjectId);
    if (currentView === 'conversations') renderConversationsView();
  } catch (error) {
    console.error('Failed to save assignment workspace:', error);
    showNotification(error.message || 'Failed to update assignment', 'error');
  }
}

async function updateAssignmentStatus(assignmentId, status) {
  try {
    const response = await fetch(apiUrl('/api/assignments/' + encodeURIComponent(assignmentId)), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to update assignment');
    showNotification('Assignment updated.', 'success');
    await loadMyAssignments();
    await loadData();
    if (selectedProjectId) selectProject(selectedProjectId);
    if (currentView === 'conversations') renderConversationsView();
  } catch (error) {
    console.error('Failed to update assignment status:', error);
    showNotification(error.message || 'Failed to update assignment', 'error');
  }
}

async function refreshAssignmentUi(assignmentId, reopenModal = false) {
  await loadMyAssignments();
  await loadData();
  if (selectedProjectId) selectProject(selectedProjectId);
  if (currentView === 'conversations') renderConversationsView();
  if (reopenModal) openAssignmentWorkspace(assignmentId);
}

async function generateAssignmentSubtasks(assignmentId) {
  const id = String(assignmentId || '').trim();
  if (!id) return;
  try {
    const response = await fetch(apiUrl('/api/assignments/' + encodeURIComponent(id) + '/subtasks/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to generate subtasks');
    const generatedCount = Number(body.generatedCount || (Array.isArray(body.generated) ? body.generated.length : 0) || 0);
    if (generatedCount > 0) {
      showNotification('Generated ' + generatedCount + ' step' + (generatedCount === 1 ? '' : 's') + ' from the ' + formatSubtaskGenerationSource(body.source) + '.', 'success');
      await refreshAssignmentUi(id, true);
      return;
    }
    if (String(body.reason || '').trim() === 'insufficient_multi_step_signal') {
      showNotification('No clear multi-step checklist was found in the task brief or source request yet.', 'info');
      return;
    }
    if (String(body.reason || '').trim() === 'no_unique_steps') {
      showNotification('This task already has the available checklist steps.', 'info');
      return;
    }
    showNotification('No new subtasks were generated for this task.', 'info');
  } catch (error) {
    console.error('Failed to generate subtasks:', error);
    showNotification(error.message || 'Failed to generate subtasks', 'error');
  }
}

async function addAssignmentSubtask(assignmentId) {
  const id = String(assignmentId || '').trim();
  const input = document.getElementById('assignmentSubtaskInput');
  const title = String(input?.value || '').trim();
  if (!id || !title) {
    showNotification('Enter a subtask title first.', 'error');
    return;
  }
  try {
    const response = await fetch(apiUrl('/api/assignments/' + encodeURIComponent(id) + '/subtasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to add subtask');
    showNotification('Subtask added.', 'success');
    await refreshAssignmentUi(id, true);
  } catch (error) {
    console.error('Failed to add subtask:', error);
    showNotification(error.message || 'Failed to add subtask', 'error');
  }
}

async function toggleAssignmentSubtask(assignmentId, subtaskId, done) {
  const assignmentKey = String(assignmentId || '').trim();
  const subtaskKey = String(subtaskId || '').trim();
  if (!assignmentKey || !subtaskKey) return;
  try {
    const response = await fetch(apiUrl('/api/assignments/' + encodeURIComponent(assignmentKey) + '/subtasks/' + encodeURIComponent(subtaskKey)), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: Boolean(done) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to update subtask');
    await refreshAssignmentUi(assignmentKey, true);
  } catch (error) {
    console.error('Failed to update subtask:', error);
    showNotification(error.message || 'Failed to update subtask', 'error');
  }
}

async function deleteAssignmentSubtask(assignmentId, subtaskId) {
  const assignmentKey = String(assignmentId || '').trim();
  const subtaskKey = String(subtaskId || '').trim();
  if (!assignmentKey || !subtaskKey) return;
  if (!confirm('Remove this subtask?')) return;
  try {
    const response = await fetch(apiUrl('/api/assignments/' + encodeURIComponent(assignmentKey) + '/subtasks/' + encodeURIComponent(subtaskKey)), {
      method: 'DELETE'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to remove subtask');
    showNotification('Subtask removed.', 'success');
    await refreshAssignmentUi(assignmentKey, true);
  } catch (error) {
    console.error('Failed to remove subtask:', error);
    showNotification(error.message || 'Failed to remove subtask', 'error');
  }
}

async function assignTaskToSelectedProject() {
  if (!selectedProjectId) {
    showNotification('Select a project first.', 'error');
    return;
  }
  const assignee = prompt('Assign to (name, email, or team user id):', '');
  if (assignee === null) return;
  const title = prompt('Task title:', 'Follow up with client');
  if (title === null) return;
  const description = prompt('Task details (optional):', '');
  if (!String(assignee || '').trim() || !String(title || '').trim()) {
    showNotification('Assignee and title are required.', 'error');
    return;
  }
  try {
    const response = await fetch(apiUrl('/api/projects/' + encodeURIComponent(selectedProjectId) + '/assignments'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assigneeName: String(assignee || '').trim(),
        title: String(title || '').trim(),
        description: String(description || '').trim(),
        notifyChannels: ['dashboard', 'slack']
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to create assignment');
    showNotification('Task assigned.', 'success');
    await loadMyAssignments();
    await loadData();
    if (selectedProjectId) selectProject(selectedProjectId);
  } catch (error) {
    console.error('Failed to assign task:', error);
    showNotification(error.message || 'Failed to assign task', 'error');
  }
}

async function recalculateProjectRouting(projectId, options = {}) {
  const id = String(projectId || '').trim();
  if (!id) {
    showNotification('Select a project first.', 'error');
    return;
  }
  if (options.confirm !== false && !confirm('Recalculate routing for the open tasks on this project?')) return;
  try {
    const response = await fetch(apiUrl('/api/projects/' + encodeURIComponent(id) + '/recalculate-assignees'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeDone: false })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to recalculate routing');
    await loadMyAssignments();
    await loadData();
    if (currentView === 'projects' && String(selectedProjectId || '') === id) selectProject(id);
    if (currentView === 'conversations') renderConversationsView();
    showNotification('Routing updated: ' + Number(body.reassignedCount || 0) + ' task' + (Number(body.reassignedCount || 0) === 1 ? '' : 's') + ' reassigned, ' + Number(body.updatedRequests || 0) + ' request' + (Number(body.updatedRequests || 0) === 1 ? '' : 's') + ' refreshed.', 'success');
    return body;
  } catch (error) {
    console.error('Failed to recalculate routing:', error);
    showNotification(error.message || 'Failed to recalculate routing', 'error');
    throw error;
  }
}

async function recalculateSelectedProjectAssignees() {
  if (!selectedProjectId) {
    showNotification('Select a project first.', 'error');
    return;
  }
  return recalculateProjectRouting(selectedProjectId, { confirm: true });
}

function canManageRoutingReview() {
  const role = String(sessionContext.role || '').trim().toLowerCase();
  return role === 'org_admin' || role === 'manager';
}

function isRequestRoutingInReview(request) {
  const explicitStatus = String(request?.routingStatus || '').trim().toLowerCase();
  if (explicitStatus === 'reviewed' || explicitStatus === 'auto_routed') return false;
  if (explicitStatus === 'needs_review' || explicitStatus === 'pending') return true;
  const strategy = String(request?.routingStrategy || '').trim().toLowerCase();
  const confidence = Number(request?.routingConfidence);
  if (strategy === 'manual_override' || strategy === 'manual_accept' || strategy === 'explicit_override') return false;
  if (strategy === 'manual_review_fallback' || strategy === 'legacy_commercial_fallback') return true;
  return Number.isFinite(confidence) && confidence < 0.77;
}

function getRequestRoutingStatusLabel(request) {
  const status = String(request?.routingStatus || '').trim().toLowerCase();
  if (status === 'reviewed') return 'Reviewed';
  if (status === 'auto_routed') return 'Auto-routed';
  if (status === 'needs_review') return 'Needs Review';
  if (status === 'pending') return 'Pending';
  if (String(request?.routingStrategy || '').trim().toLowerCase() === 'manual_override') return 'Reviewed';
  return isRequestRoutingInReview(request) ? 'Needs Review' : 'Auto-routed';
}

function getRoutingReviewRequests() {
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];
  const projectMap = new Map((Array.isArray(data.projects) ? data.projects : []).map((project) => [String(project.id || ''), project]));
  return requests
    .map((request) => {
      const projectId = String(request.projectId || '').trim();
      const project = projectMap.get(projectId) || null;
      const linkedAssignmentIds = Array.isArray(request.assignmentIds) ? request.assignmentIds.map((value) => String(value || '').trim()).filter(Boolean) : [];
      const linkedAssignments = assignments.filter((assignment) => String(assignment.requestId || '') === String(request.id || '') || linkedAssignmentIds.includes(String(assignment.id || '')));
      const activeAssignments = linkedAssignments.filter((assignment) => String(assignment.status || '').trim().toLowerCase() !== 'done');
      return {
        request,
        project,
        projectId,
        linkedAssignments,
        activeAssignments
      };
    })
    .filter((row) => row.project && getEffectiveStatus(row.project) !== 'complete' && isRequestRoutingInReview(row.request))
    .sort((left, right) => {
      const leftConfidence = Number.isFinite(Number(left.request.routingConfidence)) ? Number(left.request.routingConfidence) : 0;
      const rightConfidence = Number.isFinite(Number(right.request.routingConfidence)) ? Number(right.request.routingConfidence) : 0;
      if (leftConfidence !== rightConfidence) return leftConfidence - rightConfidence;
      return new Date(String(right.request.updatedAt || right.request.createdAt || 0)).getTime() - new Date(String(left.request.updatedAt || left.request.createdAt || 0)).getTime();
    });
}

async function updateRequestRouting(requestId, assignee, projectId, options = {}) {
  const id = String(requestId || '').trim();
  const projectKey = String(projectId || '').trim();
  const assigneeValue = String(assignee || '').trim();
  if (!id || !assigneeValue) {
    showNotification('Request and assignee are required.', 'error');
    return;
  }
  try {
    const response = await fetch(apiUrl('/api/requests/' + encodeURIComponent(id) + '/routing'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assignee: assigneeValue,
        reason: String(options.reason || '').trim(),
        mode: String(options.mode || 'manual_override').trim()
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to update routing');
    await loadMyAssignments();
    await loadData();
    if (currentView === 'projects' && projectKey && String(selectedProjectId || '') === projectKey) selectProject(projectKey);
    if (currentView === 'conversations') renderConversationsView();
    showNotification('Routing saved for request.', 'success');
    return body;
  } catch (error) {
    console.error('Failed to update request routing:', error);
    showNotification(error.message || 'Failed to update routing', 'error');
  }
}

async function acceptRequestRouting(requestId, projectId, currentAssignee) {
  const assigneeValue = String(currentAssignee || '').trim();
  if (!assigneeValue) {
    showNotification('No suggested assignee found for this request.', 'error');
    return;
  }
  return updateRequestRouting(requestId, assigneeValue, projectId, {
    reason: 'Manager accepted suggested route',
    mode: 'accept'
  });
}

async function reassignRequestRouting(requestId, projectId, currentAssignee = '') {
  const assignee = prompt('Assign this request to (name, email, or team user id):', currentAssignee || '');
  if (assignee === null) return;
  const trimmedAssignee = String(assignee || '').trim();
  if (!trimmedAssignee) {
    showNotification('Assignee is required.', 'error');
    return;
  }
  const reason = prompt('Reason for routing override:', 'Manual routing override from dashboard');
  if (reason === null) return;
  return updateRequestRouting(requestId, trimmedAssignee, projectId, {
    reason: String(reason || '').trim(),
    mode: 'manual_override'
  });
}

function normalizeConversationStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return 'unassigned';
  return value;
}

function formatConversationStatus(status) {
  const value = normalizeConversationStatus(status);
  if (value === 'needs_review') return 'Needs Review';
  if (value === 'filtered_general') return 'General';
  if (value === 'unassigned') return 'Unassigned';
  if (value === 'assigned') return 'Assigned';
  return value.replace(/_/g, ' ');
}

function escapeConversationAttr(value) {
  return escapeForJsString(value);
}

function toggleConversationSelection(conversationId, checked) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  if (checked) selectedConversationIds.add(id);
  else selectedConversationIds.delete(id);
  renderConversationsView();
}

function toggleConversationSelectionAll(checked) {
  const rows = getVisibleConversations();
  rows.forEach((row) => {
    const id = String(row.conversationId || '').trim();
    if (!id) return;
    if (checked) selectedConversationIds.add(id);
    else selectedConversationIds.delete(id);
  });
  renderConversationsView();
}

function clearConversationSelection() {
  selectedConversationIds = new Set();
}

async function runConversationBulkAction(action) {
  const ids = Array.from(selectedConversationIds);
  if (ids.length === 0) {
    showNotification('Select at least one conversation first.', 'error');
    return;
  }
  let payload = { action, conversationIds: ids };
  if (action === 'assign_project') {
    const projectIds = (data.projects || []).map((p) => String(p.id || '')).filter(Boolean);
    const pick = prompt('Assign selected conversations to project ID:', projectIds[0] || '');
    if (pick === null) return;
    const projectId = String(pick || '').trim();
    if (!projectId) {
      showNotification('Project ID is required.', 'error');
      return;
    }
    payload.projectId = projectId;
  }
  try {
    const response = await fetch(apiUrl('/api/conversations/bulk'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Bulk action failed');
    showNotification('Bulk update complete (' + Number(body.updated || 0) + ').', 'success');
    clearConversationSelection();
    await loadConversations(true);
    await loadData();
  } catch (error) {
    console.error('Conversation bulk action failed:', error);
    showNotification(error.message || 'Bulk action failed', 'error');
  }
}

function getVisibleConversations() {
  let rows = Array.isArray(conversationsSnapshot) ? [...conversationsSnapshot] : [];
  if (conversationStatusFilter !== 'all') {
    rows = rows.filter(row => normalizeConversationStatus(row.status) === conversationStatusFilter);
  }
  if (conversationSearchTerm) {
    const needle = conversationSearchTerm.toLowerCase();
    rows = rows.filter(row => {
      const hay = [
        row.conversationId,
        row.title,
        row.preview,
        row.projectId,
        row.channel,
        row.source,
        row.category
      ].map(v => String(v || '').toLowerCase()).join(' ');
      return hay.includes(needle);
    });
  }
  return rows;
}

async function loadConversations(force = false) {
  if (!force && currentView !== 'conversations' && conversationsSnapshot.length > 0) return;
  try {
    const response = await fetch(apiUrl('/api/conversations'));
    const body = response.ok ? await response.json() : {};
    conversationsSnapshot = Array.isArray(body.conversations) ? body.conversations : [];
    conversationCounts = body.counts && typeof body.counts === 'object'
      ? body.counts
      : {
          assigned: conversationsSnapshot.filter(r => normalizeConversationStatus(r.status) === 'assigned').length,
          needsReview: conversationsSnapshot.filter(r => normalizeConversationStatus(r.status) === 'needs_review').length,
          unassigned: conversationsSnapshot.filter(r => normalizeConversationStatus(r.status) === 'unassigned').length,
          filteredGeneral: conversationsSnapshot.filter(r => normalizeConversationStatus(r.status) === 'filtered_general').length
        };
    if (currentView === 'conversations') renderConversationsView();
  } catch (error) {
    console.error('Failed to load conversations:', error);
    if (currentView === 'conversations') {
      const container = document.getElementById('conversationsContainer');
      if (container) {
        container.innerHTML = '<div class="detail-section"><div class="detail-title">Conversations</div><div class="detail-content">Failed to load conversation pipeline data.</div></div>';
      }
    }
  }
}

function setConversationFilter(status) {
  conversationStatusFilter = String(status || 'all');
  clearConversationSelection();
  renderConversationsView();
}

function onConversationSearch(value) {
  conversationSearchTerm = String(value || '').trim();
  clearConversationSelection();
  renderConversationsView();
}

function formatConversationPreview(value) {
  const raw = String(value || '').replace(/\r/g, '\n');
  if (!raw) return '';
  const signatureMarkers = [
    /^best,?$/i,
    /^best regards,?$/i,
    /^regards,?$/i,
    /^thanks,?$/i,
    /^thank you,?$/i,
    /^sincerely,?$/i,
    /^sent from my iphone$/i,
    /^sent from my ipad$/i,
    /^janice areskog$/i,
    /^the facilities group$/i
  ];
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const cleaned = [];
  for (const line of lines) {
    if (/^from:\s|^sent:\s|^to:\s|^subject:\s/i.test(line)) break;
    if (/^>/.test(line)) continue;
    if (/^on .+wrote:$/i.test(line)) break;
    if (signatureMarkers.some((pattern) => pattern.test(line))) break;
    cleaned.push(line);
    if (cleaned.length >= 4) break;
  }
  return (cleaned.join(' ') || raw).replace(/\s+/g, ' ').trim().slice(0, 280);
}

function formatConversationReason(reason) {
  const key = String(reason || '').trim().toLowerCase();
  if (!key) return 'No routing reason yet';
  const labels = {
    explicit_project_id: 'Explicit project match',
    project_code_match: 'Project code detected',
    unassigned: 'No project match yet',
    filtered_social: 'Filtered as general chatter',
    filtered_announcement: 'Filtered as announcement',
    filtered_ops_internal: 'Filtered as internal conversation',
    filtered_unknown: 'Filtered as non-project conversation',
    dashboard_manual_reassign: 'Moved manually from dashboard',
    bulk_mark_general: 'Marked as general in bulk',
    bulk_mark_review: 'Sent to review in bulk',
    bulk_assign_project: 'Assigned to project in bulk',
    create_project_from_conversation: 'New project created from conversation',
    mark_general_from_dashboard: 'Marked as general from dashboard',
    mark_review_from_dashboard: 'Sent to review from dashboard'
  };
  return labels[key] || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function getConversationConfidenceMeta(value) {
  const score = Number(value || 0);
  if (score >= 0.9) return { label: 'High', color: '#166534', bg: 'rgba(34, 197, 94, 0.14)' };
  if (score >= 0.75) return { label: 'Medium', color: '#92400e', bg: 'rgba(245, 158, 11, 0.16)' };
  return { label: 'Low', color: '#991b1b', bg: 'rgba(239, 68, 68, 0.14)' };
}

function groupRequestsBySection(requests) {
  const groups = [];
  const map = new Map();
  (Array.isArray(requests) ? requests : []).forEach((request) => {
    const key = String(request.sectionKey || request.sectionLabel || 'general').trim() || 'general';
    const label = String(request.sectionLabel || 'General').trim() || 'General';
    if (!map.has(key)) {
      const group = { key, label, items: [] };
      map.set(key, group);
      groups.push(group);
    }
    map.get(key).items.push(request);
  });
  return groups;
}

function renderProjectAttachmentCards(attachments) {
  const rows = (Array.isArray(attachments) ? attachments : []).map((attachment) => {
    const excerpt = String(attachment.textExcerpt || '').trim();
    const canDownload = String(attachment.source || '').trim().toLowerCase() === 'gmail'
      && String(attachment.attachmentId || '').trim()
      && String(attachment.emailMessageId || attachment.sourceId || '').trim();
    const linkedCount = Array.isArray(attachment.linkedRequestIds) ? attachment.linkedRequestIds.length : 0;
    const downloadButton = canDownload
      ? `<button class="btn" style="padding:4px 8px; font-size:11px; white-space:nowrap;" onclick="downloadAttachment('${escapeForJsString(attachment.id || '')}', '${escapeForJsString(attachment.filename || 'attachment')}')">Download</button>`
      : '';
    return `
      <div style="margin-bottom:8px; padding:10px; background: rgba(0,0,0,0.03); border-radius:8px; display:grid; gap:6px;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
          <div style="min-width:0;">
            <div style="font-weight:600; font-size:12px;">${escapeForHtmlText(attachment.filename || 'attachment')}</div>
            <div style="font-size:11px; color:var(--text-secondary);">${escapeForHtmlText(attachment.mimeType || 'file')} • ${escapeForHtmlText(attachment.extractionStatus || 'tracked')}</div>
          </div>
          ${downloadButton}
        </div>
        <div style="font-size:11px; color:var(--text-secondary);">Linked requests: ${linkedCount}${attachment.extractionError ? ' • ' + escapeForHtmlText(attachment.extractionError) : ''}</div>
        ${excerpt ? `<div style="font-size:11px; color:var(--text-secondary); white-space:pre-wrap;">${escapeForHtmlText(excerpt)}</div>` : '<div style="font-size:11px; color:var(--text-secondary);">No extracted preview available yet.</div>'}
      </div>
    `;
  });
  return rows.length
    ? rows.join('')
    : '<div style="color:var(--text-secondary); font-size:12px;">No source files tracked yet.</div>';
}

function getAssignmentSubtaskMeta(assignment) {
  const subtasks = Array.isArray(assignment?.subtasks) ? assignment.subtasks : [];
  if (!subtasks.length) return '';
  const done = subtasks.filter((item) => Boolean(item.done)).length;
  return ' • ' + done + '/' + subtasks.length + ' subtasks';
}

function formatSubtaskGenerationSource(source) {
  const key = String(source || '').trim().toLowerCase();
  if (key === 'assignment_description') return 'task brief';
  if (key === 'assignment_title') return 'task title';
  if (key === 'request_detail') return 'source request';
  if (key === 'request_title') return 'request title';
  if (key === 'web_execution_template') return 'web execution template';
  if (key === 'content_execution_template') return 'content execution template';
  if (key === 'design_execution_template') return 'design execution template';
  if (key === 'plugin_execution_template') return 'plugin update template';
  if (key === 'after_hours_execution_template') return 'after-hours execution template';
  return 'task context';
}

function flashDetailPanelTarget(target) {
  if (!target) return;
  target.style.outline = '2px solid rgba(61, 116, 168, 0.55)';
  target.style.background = 'rgba(61, 116, 168, 0.08)';
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    target.style.outline = '';
    target.style.background = '';
  }, 2200);
}

function navigateToProjectDetail(projectId, selector) {
  const id = String(projectId || '').trim();
  if (!id) return;
  projectDetailTab = 'details';
  if (typeof switchView === 'function' && currentView !== 'projects') {
    switchView('projects');
  }
  selectProject(id);
  if (!selector) return;
  setTimeout(() => {
    const panel = document.getElementById('detailPanel');
    if (!panel) return;
    const target = panel.querySelector(selector);
    if (target) flashDetailPanelTarget(target);
  }, 120);
}

function focusProjectAssignmentCard(projectId, assignmentId, openModal = false) {
  const assignmentKey = String(assignmentId || '').trim();
  if (!assignmentKey) return;
  navigateToProjectDetail(projectId, `[data-assignment-id="${escapeForJsString(assignmentKey)}"]`);
  if (openModal) {
    setTimeout(() => openAssignmentWorkspace(assignmentKey), 150);
  }
}

function openSourceRequestTask(projectId, requestId) {
  const request = (Array.isArray(data.requests) ? data.requests : []).find((item) => String(item.id || '') === String(requestId || '').trim());
  const assignmentIds = Array.isArray(request?.assignmentIds) ? request.assignmentIds.filter(Boolean) : [];
  if (!assignmentIds.length) {
    navigateToProjectDetail(projectId, `[data-request-id="${escapeForJsString(String(requestId || ''))}"]`);
    return;
  }
  focusProjectAssignmentCard(projectId, assignmentIds[0], assignmentIds.length === 1);
}

function openProjectDetailsForAssignment(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return;
  suppressNextDetailPanelClose = true;
  closeAssignmentWorkspaceModal();
  navigateToProjectDetail(id, '#source-requests-section');
}

async function toggleAssignmentCompletion(assignmentId, checked) {
  await updateAssignmentStatus(assignmentId, checked ? 'done' : 'open');
}

async function updateConversationStatus(conversationId, status, options = {}) {
  const id = String(conversationId || '').trim();
  const nextStatus = String(status || '').trim().toLowerCase();
  if (!id || !nextStatus) return;

  const payload = {
    status: nextStatus,
    reason: String(options.reason || 'dashboard_status_update').trim()
  };
  if (options.projectId) payload.projectId = String(options.projectId).trim();
  if (options.clearProject === true) payload.clearProject = true;

  try {
    const response = await fetch(apiUrl('/api/conversations/' + encodeURIComponent(id) + '/status'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to update conversation');
    showNotification('Conversation updated.', 'success');
    await loadConversations(true);
    await loadData();
  } catch (error) {
    console.error('Failed to update conversation status:', error);
    showNotification(error.message || 'Failed to update conversation', 'error');
  }
}

async function createProjectFromConversation(conversationId) {
  const id = String(conversationId || '').trim();
  const row = (conversationsSnapshot || []).find((item) => String(item.conversationId || '') === id);
  if (!row) {
    showNotification('Conversation not found.', 'error');
    return;
  }

  const suggestedName = String(row.title || row.preview || 'New Client Request').trim().slice(0, 120);
  const projectName = prompt('Create new project from this conversation.\n\nProject name:', suggestedName);
  if (projectName === null) return;
  const trimmedName = String(projectName || '').trim();
  if (!trimmedName) {
    showNotification('Project name is required.', 'error');
    return;
  }

  try {
    const createResponse = await fetch(apiUrl('/api/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: trimmedName,
        category: 'Operations',
        status: 'new',
        priority: 'P1',
        owner: 'Joan',
        notes: row.preview || '',
        originalRequest: row.preview || row.title || '',
        clientEmail: Array.isArray(row.participants) ? String(row.participants[0] || '') : '',
        startDate: new Date().toISOString(),
        createdBy: 'Joan'
      })
    });
    const project = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok || !project.id) {
      throw new Error(project.error || 'Failed to create project');
    }

    await updateConversationStatus(id, 'assigned', {
      projectId: project.id,
      reason: 'create_project_from_conversation'
    });

    switchView('projects');
    selectProject(project.id);
  } catch (error) {
    console.error('Failed to create project from conversation:', error);
    showNotification(error.message || 'Failed to create project', 'error');
  }
}

async function reassignConversation(conversationId, currentProjectId = '') {
  const projectIds = (data.projects || []).map(p => String(p.id || '')).filter(Boolean);
  const hint = projectIds.slice(0, 12).join(', ');
  const target = prompt(
    'Move conversation to project ID:\n\nExamples: ' + hint,
    currentProjectId || projectIds[0] || ''
  );
  if (target === null) return;
  const trimmed = String(target || '').trim();
  if (!trimmed) {
    showNotification('Project ID is required.', 'error');
    return;
  }
  try {
    const response = await fetch(apiUrl('/api/conversations/' + encodeURIComponent(conversationId) + '/reassign'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: trimmed, reason: 'dashboard_manual_reassign' })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to reassign conversation');
    showNotification('Conversation reassigned.', 'success');
    await loadConversations(true);
    await loadData();
  } catch (error) {
    console.error('Failed to reassign conversation:', error);
    showNotification(error.message || 'Failed to reassign conversation', 'error');
  }
}

async function openConversationProject(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const row = (conversationsSnapshot || []).find((item) => String(item.conversationId || '') === id);
  if (!row) {
    showNotification('Conversation not found in current view.', 'error');
    return;
  }
  const projectId = String(row.projectId || '').trim();
  if (!projectId) {
    showNotification('This conversation is not assigned to a project yet.', 'error');
    return;
  }

  switchView('projects');
  selectedProjectId = projectId;
  selectProject(projectId);

  // Best-effort comment focus/highlight by matching conversation hints.
  setTimeout(() => {
    const panel = document.getElementById('detailPanel');
    if (!panel) return;
    const hintA = String(row.sourceId || '').trim().toLowerCase();
    const hintB = String(row.title || '').trim().toLowerCase();
    const comments = Array.from(panel.querySelectorAll('.comment'));
    const target = comments.find((el) => {
      const text = String(el.textContent || '').toLowerCase();
      return (hintA && text.includes(hintA)) || (hintB && text.includes(hintB));
    });
    if (target) {
      target.style.outline = '2px solid rgba(61, 116, 168, 0.55)';
      target.style.background = 'rgba(61, 116, 168, 0.08)';
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        target.style.outline = '';
        target.style.background = '';
      }, 2500);
    }
  }, 120);
}

function openRoutingReviewRequest(projectId, requestId) {
  const projectKey = String(projectId || '').trim();
  const requestKey = String(requestId || '').trim();
  if (!projectKey || !requestKey) return;
  navigateToProjectDetail(projectKey, `[data-request-id="${escapeForJsString(requestKey)}"]`);
}

function renderRoutingReviewCards(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return '<div style="font-size:12px; color:var(--text-secondary);">No requests currently need routing review.</div>';
  }
  return list.slice(0, 8).map((row) => {
    const request = row.request || {};
    const project = row.project || {};
    const projectId = String(project.id || row.projectId || '').trim();
    const requestId = String(request.id || '').trim();
    const routeLabel = String(request.routeLabel || '').trim();
    const confidence = Number.isFinite(Number(request.routingConfidence)) ? Math.round(Number(request.routingConfidence) * 100) : 0;
    const statusLabel = getRequestRoutingStatusLabel(request);
    return `
      <div style="padding:12px; border:1px solid rgba(245, 158, 11, 0.22); border-radius:12px; background:rgba(255,255,255,0.96); display:grid; gap:8px;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
          <div>
            <div style="font-weight:700; font-size:13px;">${escapeForHtmlText(request.title || 'Untitled request')}</div>
            <div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">${escapeForHtmlText(request.detail || '')}</div>
          </div>
          <span class="conversation-pill" style="background:rgba(245, 158, 11, 0.16); color:#92400e; border:none;">${escapeForHtmlText(statusLabel + (confidence ? ' • ' + confidence + '%' : ''))}</span>
        </div>
        <div style="font-size:11px; color:var(--text-secondary);">Project: ${escapeForHtmlText(projectId || '—')} • Current route: ${escapeForHtmlText(routeLabel || 'Joan')}</div>
        <div style="font-size:11px; color:var(--text-secondary);">Reason: ${escapeForHtmlText(request.routeReason || 'Low-confidence routing match')} • Tasks: ${row.activeAssignments.length}/${row.linkedAssignments.length} open</div>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="openRoutingReviewRequest('${escapeForJsString(projectId)}', '${escapeForJsString(requestId)}')">Open Request</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="acceptRequestRouting('${escapeForJsString(requestId)}', '${escapeForJsString(projectId)}', '${escapeForJsString(routeLabel)}')">Accept Route</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="reassignRequestRouting('${escapeForJsString(requestId)}', '${escapeForJsString(projectId)}', '${escapeForJsString(routeLabel)}')">Assign Owner</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="recalculateProjectRouting('${escapeForJsString(projectId)}')">Recalculate</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderConversationsView() {
  const container = document.getElementById('conversationsContainer');
  if (!container) return;

  const rows = getVisibleConversations();
  const canManageRouting = canManageRoutingReview();
  const routingReviewRows = canManageRouting ? getRoutingReviewRequests() : [];
  const generalRows = rows.filter((row) => normalizeConversationStatus(row.status) === 'filtered_general');
  const reviewRows = rows.filter((row) => {
    const status = normalizeConversationStatus(row.status);
    return status === 'needs_review' || status === 'unassigned';
  });
  const allSelected = rows.length > 0 && rows.every((row) => selectedConversationIds.has(String(row.conversationId || '')));
  const filters = [
    { id: 'all', label: 'All' },
    { id: 'needs_review', label: 'Needs Review' },
    { id: 'unassigned', label: 'Unassigned' },
    { id: 'filtered_general', label: 'General' },
    { id: 'assigned', label: 'Assigned' }
  ];

  const filterHtml = filters.map((filter) => {
    const active = conversationStatusFilter === filter.id ? 'active' : '';
    return `<button class="filter-btn ${active}" onclick="setConversationFilter('${escapeForJsString(filter.id)}')">${escapeForHtmlText(filter.label)}</button>`;
  }).join('');

  const rowsHtml = rows.length ? rows.map((row) => {
    const rowId = String(row.conversationId || '');
    const isChecked = selectedConversationIds.has(rowId);
    const status = normalizeConversationStatus(row.status);
    const category = String(row.category || 'unknown').toLowerCase();
    const updated = row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '-';
    const confidenceMeta = getConversationConfidenceMeta(row.confidence);
    const reasonLabel = formatConversationReason(row.mappingReason);
    const confidencePercent = Math.round(Number(row.confidence || 0) * 100);
    return `
      <tr onclick="openConversationProject('${escapeForJsString(rowId)}')" style="cursor:pointer;">
        <td><input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleConversationSelection('${escapeForJsString(rowId)}', this.checked)" /></td>
        <td>
          <div style="font-weight:600;">${escapeForHtmlText(row.title || row.conversationId || 'Untitled')}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:3px;">${escapeForHtmlText(formatConversationPreview(row.preview || ''))}</div>
          <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
            <span class="conversation-pill" style="background:${confidenceMeta.bg}; color:${confidenceMeta.color}; border:none;">${escapeForHtmlText(confidenceMeta.label + ' ' + confidencePercent + '%')}</span>
            <span class="conversation-pill" style="border:none; background:rgba(15, 23, 42, 0.06); color:#475569;">${escapeForHtmlText(reasonLabel)}</span>
          </div>
        </td>
        <td><span class="conversation-pill">${escapeForHtmlText(formatConversationStatus(status))}</span></td>
        <td><span class="conversation-pill ${status === 'filtered_general' ? 'general' : ''}">${escapeForHtmlText(category)}</span></td>
        <td>${escapeForHtmlText(row.projectId || '—')}</td>
        <td>${escapeForHtmlText(row.source || '—')}</td>
        <td>${escapeForHtmlText(updated)}</td>
        <td style="display:flex; gap:6px; flex-wrap:wrap;" onclick="event.stopPropagation()">
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="openConversationProject('${escapeForJsString(rowId)}')">Open</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="reassignConversation('${escapeForJsString(rowId)}', '${escapeForJsString(row.projectId || '')}')">Assign</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="updateConversationStatus('${escapeForJsString(rowId)}', 'filtered_general', { reason: 'mark_general_from_dashboard', clearProject: true })">General</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="createProjectFromConversation('${escapeForJsString(rowId)}')">New Project</button>
        </td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="8" style="text-align:center; color:var(--text-secondary); padding:18px;">No conversations match this filter.</td></tr>';

  const reviewCardsHtml = reviewRows.length ? reviewRows.slice(0, 6).map((row) => {
    const status = normalizeConversationStatus(row.status);
    const confidenceMeta = getConversationConfidenceMeta(row.confidence);
    const confidencePercent = Math.round(Number(row.confidence || 0) * 100);
    return `
      <div style="padding:12px; border:1px solid rgba(15, 23, 42, 0.08); border-radius:12px; background:#fff; display:grid; gap:8px;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
          <div>
            <div style="font-weight:700; font-size:13px;">${escapeForHtmlText(row.title || row.conversationId || 'Untitled conversation')}</div>
            <div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">${escapeForHtmlText(formatConversationPreview(row.preview || ''))}</div>
          </div>
          <span class="conversation-pill" style="background:${confidenceMeta.bg}; color:${confidenceMeta.color}; border:none;">${escapeForHtmlText(confidenceMeta.label + ' ' + confidencePercent + '%')}</span>
        </div>
        <div style="font-size:11px; color:var(--text-secondary);">Status: ${escapeForHtmlText(formatConversationStatus(status))} • Reason: ${escapeForHtmlText(formatConversationReason(row.mappingReason))}</div>
        <div style="font-size:11px; color:var(--text-secondary);">Project: ${escapeForHtmlText(row.projectId || 'Not assigned yet')} • Source: ${escapeForHtmlText(row.source || '—')}</div>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="reassignConversation('${escapeForJsString(row.conversationId || '')}', '${escapeForJsString(row.projectId || '')}')">Assign Project</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="createProjectFromConversation('${escapeForJsString(row.conversationId || '')}')">Create Project</button>
          <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="updateConversationStatus('${escapeForJsString(row.conversationId || '')}', 'filtered_general', { reason: 'mark_general_from_dashboard', clearProject: true })">Mark General</button>
        </div>
      </div>
    `;
  }).join('') : '<div style="font-size:12px; color:var(--text-secondary);">No conversations currently need routing review.</div>';

  const myOpenCount = myAssignments.filter((assignment) => String(assignment.status || '').toLowerCase() !== 'done').length;
  const routingReviewCardsHtml = canManageRouting ? renderRoutingReviewCards(routingReviewRows) : '';
  const myTasksHtml = myAssignments.length ? myAssignments.slice(0, 8).map((assignment) => {
    const done = String(assignment.status || '').toLowerCase() === 'done';
    const inProgress = String(assignment.status || '').toLowerCase() === 'in_progress';
    return `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; opacity:${done ? '0.72' : '1'};">
        <div>
          <div style="font-weight:600; ${done ? 'text-decoration:line-through;' : ''}">${escapeForHtmlText(assignment.title || 'Untitled task')}</div>
          <div style="font-size:11px; color:var(--text-secondary);">
            ${assignment.projectId ? `<button class="btn" style="padding:0; border:0; background:none; color:var(--accent-blue); font-size:11px;" onclick="switchView('projects'); selectProject('${escapeForJsString(assignment.projectId || '')}')">${escapeForHtmlText(assignment.projectId || '')}</button>` : '—'}
            • ${escapeForHtmlText(assignment.status || 'open')}
          </div>
        </div>
        <div style="display:flex; gap:6px;">
          ${done ? '' : (inProgress ? '' : `<button class="btn" style="padding:4px 8px; font-size:11px;" onclick="updateAssignmentStatus('${escapeForJsString(assignment.id || '')}', 'in_progress')">Start</button>`) + `<button class="btn" style="padding:4px 8px; font-size:11px;" onclick="updateAssignmentStatus('${escapeForJsString(assignment.id || '')}', 'done')">Done</button>`}
        </div>
      </div>
    `;
  }).join('') : '<div style="font-size:12px; color:var(--text-secondary);">No tasks assigned to you yet.</div>';

  container.innerHTML = `
    <div class="conversation-summary">
      <div class="metric-card"><div class="metric-value">${Number(myOpenCount || 0)}</div><div class="metric-label">My Open Tasks</div></div>
      <div class="metric-card"><div class="metric-value">${Number(conversationCounts.assigned || 0)}</div><div class="metric-label">Assigned</div></div>
      <div class="metric-card"><div class="metric-value">${Number(conversationCounts.needsReview || 0)}</div><div class="metric-label">Needs Review</div></div>
      <div class="metric-card"><div class="metric-value">${Number(conversationCounts.unassigned || 0)}</div><div class="metric-label">Unassigned</div></div>
      <div class="metric-card"><div class="metric-value">${Number(conversationCounts.filteredGeneral || 0)}</div><div class="metric-label">General</div></div>
      ${canManageRouting ? `<div class="metric-card"><div class="metric-value">${Number(routingReviewRows.length || 0)}</div><div class="metric-label">Routing Queue</div></div>` : ''}
    </div>
    <div class="conversation-toolbar">
      <div class="conversation-filters">${filterHtml}</div>
      <input class="search-box" style="max-width:320px;" placeholder="Search conversations..." value="${escapeForHtmlAttr(conversationSearchTerm)}" oninput="onConversationSearch(this.value)" />
    </div>
    <div class="conversation-toolbar" style="margin-top:-2px;">
      <div style="font-size:12px; color:var(--text-secondary);">Selected: ${selectedConversationIds.size} • General in view: ${generalRows.length}</div>
      <div class="conversation-filters">
        <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="runConversationBulkAction('mark_general')">Mark General</button>
        <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="runConversationBulkAction('mark_review')">Needs Review</button>
        <button class="btn" style="padding:6px 10px; font-size:11px;" onclick="runConversationBulkAction('assign_project')">Assign Project</button>
      </div>
    </div>
    ${canManageRouting ? `<div class="detail-section" style="margin-bottom:12px;"><div class="detail-section-title">REQUEST ROUTING REVIEW (${routingReviewRows.length})</div><div class="detail-content" style="display:grid; gap:10px;">${routingReviewCardsHtml}</div></div>` : ''}
    <div class="detail-section" style="margin-bottom:12px;">
      <div class="detail-section-title">INTAKE REVIEW (${reviewRows.length})</div>
      <div class="detail-content" style="display:grid; gap:10px;">${reviewCardsHtml}</div>
    </div>
    <div class="detail-section" style="margin-bottom:12px;">
      <div class="detail-section-title">MY TASKS (${myAssignments.length})</div>
      <div class="detail-content">${myTasksHtml}</div>
    </div>
    <div class="worklist-shell" style="background:transparent; border:none; box-shadow:none; padding:0;">
      <table class="conversation-table">
        <thead><tr><th><input type="checkbox" ${allSelected ? 'checked' : ''} onchange="toggleConversationSelectionAll(this.checked)" /></th><th>Conversation</th><th>Status</th><th>Category</th><th>Project</th><th>Source</th><th>Updated</th><th>Action</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function getFinanceJobType(project) {
  return String(project?.jobType || project?.type || project?.category || 'General');
}

function sortFinanceProjects(projectList, sortBy) {
  const list = [...projectList];
  switch (sortBy) {
    case 'client-asc':
      return list.sort((a, b) => String(a.clientName || '').localeCompare(String(b.clientName || '')));
    case 'job-asc':
      return list.sort((a, b) => String(a.name || a.id || '').localeCompare(String(b.name || b.id || '')));
    case 'type-asc':
      return list.sort((a, b) => getFinanceJobType(a).localeCompare(getFinanceJobType(b)));
    case 'margin-desc':
      return list.sort((a, b) => Number(b.margin || 0) - Number(a.margin || 0));
    case 'profit-desc':
    default:
      return list.sort((a, b) => {
        const ap = Number.isFinite(Number(a.profit)) ? Number(a.profit) : (Number(a.revenue || 0) - Number(a.cost || 0));
        const bp = Number.isFinite(Number(b.profit)) ? Number(b.profit) : (Number(b.revenue || 0) - Number(b.cost || 0));
        return bp - ap;
      });
  }
}

async function toggleFinanceTracking(projectId) {
  if (!projectId) return;
  const project = (data.projects || []).find(p => p.id === projectId);
  if (!project) return;
  const nextExcluded = !Boolean(project.excludeFromFinance);

  try {
    const response = await fetch(apiUrl(`/api/projects/${encodeURIComponent(projectId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excludeFromFinance: nextExcluded })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to update finance tracking');
    project.excludeFromFinance = nextExcluded;
    renderFinanceView();
    showNotification(nextExcluded ? 'Job excluded from finance tracking.' : 'Job included in finance tracking.', 'success');
  } catch (error) {
    console.error('Failed to toggle finance tracking:', error);
    showNotification(error.message || 'Failed to update finance tracking', 'error');
  }
}

function renderFinanceView() {
  const container = document.getElementById('financeCenterContainer');
  if (!container) return;
  const allProjects = Array.isArray(data.projects) ? data.projects : [];
  const trackedProjects = allProjects.filter(p => !Boolean(p.excludeFromFinance));
  const visibleProjects = financeShowExcluded ? allProjects : trackedProjects;

  const totals = trackedProjects.reduce((acc, p) => {
    const revenue = Number(p.revenue || 0);
    const cost = Number(p.cost || 0);
    const hours = Number(p.actualHours || 0);
    acc.revenue += Number.isFinite(revenue) ? revenue : 0;
    acc.cost += Number.isFinite(cost) ? cost : 0;
    acc.hours += Number.isFinite(hours) ? hours : 0;
    return acc;
  }, { revenue: 0, cost: 0, hours: 0 });

  const profit = totals.revenue - totals.cost;
  const margin = totals.revenue > 0 ? (profit / totals.revenue) * 100 : 0;
  const profitableCount = trackedProjects.filter(p => Number(p.profit || (Number(p.revenue || 0) - Number(p.cost || 0))) > 0).length;
  const lossCount = trackedProjects.length - profitableCount;
  const excludedCount = allProjects.length - trackedProjects.length;

  // Group by client for summary
  const clientFinancials = {};
  trackedProjects.forEach(p => {
    const client = String(p.clientName || 'Unassigned').trim();
    if (!clientFinancials[client]) clientFinancials[client] = { revenue: 0, cost: 0, profit: 0, count: 0, hours: 0 };
    const r = Number(p.revenue || 0);
    const c = Number(p.cost || 0);
    clientFinancials[client].revenue += r;
    clientFinancials[client].cost += c;
    clientFinancials[client].profit += (r - c);
    clientFinancials[client].hours += Number(p.actualHours || 0);
    clientFinancials[client].count += 1;
  });
  const clientRows = Object.entries(clientFinancials)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 15);

  const fmtCurrency = (v) => {
    const n = Math.abs(v);
    return (v < 0 ? '-' : '') + '$' + (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n.toFixed(0));
  };

  const projectRows = sortFinanceProjects(visibleProjects, financeSortBy)
    .slice(0, 300)
    .map((p) => {
      const revenue = Number(p.revenue || 0);
      const cost = Number(p.cost || 0);
      const projectProfit = Number.isFinite(Number(p.profit)) ? Number(p.profit) : (revenue - cost);
      const projectMargin = revenue > 0 ? (projectProfit / revenue) * 100 : 0;
      const excluded = Boolean(p.excludeFromFinance);
      const profitColor = projectProfit < 0 ? '#ff3b30' : projectProfit > 0 ? '#34c759' : 'var(--text-secondary)';
      return `
      <tr style="cursor:pointer;opacity:${excluded ? '0.5' : '1'};" onclick="switchView('projects'); selectProject('${escapeForJsString(p.id || '')}')">
        <td style="padding:10px 12px;font-weight:500;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeForHtmlText(p.name || p.id || '-')}</td>
        <td style="padding:10px 8px;color:var(--text-secondary);">${escapeForHtmlText(p.clientName || '-')}</td>
        <td style="padding:10px 8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtCurrency(revenue)}</td>
        <td style="padding:10px 8px;text-align:right;font-variant-numeric:tabular-nums;">${fmtCurrency(cost)}</td>
        <td style="padding:10px 8px;text-align:right;font-weight:600;color:${profitColor};font-variant-numeric:tabular-nums;">${fmtCurrency(projectProfit)}</td>
        <td style="padding:10px 8px;text-align:right;">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${projectMargin < 0 ? 'rgba(255,59,48,0.1)' : 'rgba(52,199,89,0.1)'};color:${projectMargin < 0 ? '#ff3b30' : '#34c759'};">${projectMargin.toFixed(0)}%</span>
        </td>
        <td style="padding:10px 8px;text-align:center;">
          <button style="padding:3px 8px;font-size:10px;border:1px solid var(--glass-border,#ddd);border-radius:4px;background:transparent;cursor:pointer;color:var(--text-secondary);" onclick="event.stopPropagation(); toggleFinanceTracking('${escapeForJsString(p.id || '')}')">${excluded ? '+ Include' : '- Exclude'}</button>
        </td>
      </tr>`;
    })
    .join('');

  container.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;">
      <!-- Header -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <div>
          <h2 style="font-size:20px;font-weight:700;letter-spacing:-0.02em;margin:0;">Financial Overview</h2>
          <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">${trackedProjects.length} tracked projects${excludedCount > 0 ? ' (' + excludedCount + ' excluded)' : ''}</p>
        </div>
        <div style="display:flex;gap:8px;">
          <select onchange="financeSortBy=this.value; renderFinanceView();" style="padding:8px 12px;border-radius:8px;border:1px solid var(--glass-border,#ddd);font-size:12px;background:var(--glass-bg,#fff);color:var(--text-primary);">
            <option value="profit-desc" ${financeSortBy === 'profit-desc' ? 'selected' : ''}>Sort: Profit</option>
            <option value="client-asc" ${financeSortBy === 'client-asc' ? 'selected' : ''}>Sort: Client</option>
            <option value="margin-desc" ${financeSortBy === 'margin-desc' ? 'selected' : ''}>Sort: Margin</option>
          </select>
          <button onclick="financeShowExcluded=!financeShowExcluded; renderFinanceView();" style="padding:8px 12px;border-radius:8px;border:1px solid var(--glass-border,#ddd);font-size:12px;background:transparent;cursor:pointer;color:var(--text-primary);">${financeShowExcluded ? 'Hide Excluded' : 'Show Excluded'}</button>
        </div>
      </div>

      <!-- KPI Cards (4 big ones) -->
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:24px;">
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:6px;">Revenue</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;">$${totals.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:6px;">Cost</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;">$${totals.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:6px;">Profit</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:${profit < 0 ? '#ff3b30' : '#34c759'};">$${Math.abs(profit).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:6px;">Margin</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:${margin < 0 ? '#ff3b30' : '#34c759'};">${margin.toFixed(1)}%</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">${totals.hours.toFixed(1)}h tracked &middot; ${profitableCount} profitable / ${lossCount} at loss</div>
        </div>
      </div>

      <!-- Client Summary -->
      ${clientRows.length > 1 ? `
      <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;margin-bottom:20px;">
        <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">By Client</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:10px;">
          ${clientRows.map(([name, c]) => {
            const cMargin = c.revenue > 0 ? (c.profit / c.revenue * 100) : 0;
            return `
            <div style="padding:10px 12px;background:rgba(0,0,0,0.02);border-radius:8px;">
              <div style="font-size:13px;font-weight:600;margin-bottom:4px;">${escapeForHtmlText(name)}</div>
              <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);">
                <span>${fmtCurrency(c.revenue)} rev</span>
                <span style="color:${c.profit < 0 ? '#ff3b30' : '#34c759'};font-weight:600;">${fmtCurrency(c.profit)} (${cMargin.toFixed(0)}%)</span>
              </div>
              <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${c.count} project${c.count !== 1 ? 's' : ''} &middot; ${c.hours.toFixed(1)}h</div>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      <!-- Project Table -->
      <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--glass-border);">
              <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Project</th>
              <th style="padding:12px 8px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Client</th>
              <th style="padding:12px 8px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Revenue</th>
              <th style="padding:12px 8px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Cost</th>
              <th style="padding:12px 8px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Profit</th>
              <th style="padding:12px 8px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Margin</th>
              <th style="padding:12px 8px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);width:80px;">Track</th>
            </tr>
          </thead>
          <tbody>
            ${projectRows || '<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text-secondary);">No financial records yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function sortPlOrganizations(orgRows, sortBy) {
  const rows = [...orgRows];
  switch (sortBy) {
    case 'name-asc':
      return rows.sort((a, b) => String(a.organizationName || '').localeCompare(String(b.organizationName || '')));
    case 'signups-desc':
      return rows.sort((a, b) => Number(b.signups || 0) - Number(a.signups || 0));
    case 'revenue-desc':
      return rows.sort((a, b) => Number(b.revenue30d || 0) - Number(a.revenue30d || 0));
    case 'ltv-desc':
    default:
      return rows.sort((a, b) => Number(b.ltv || 0) - Number(a.ltv || 0));
  }
}

function formatPlCurrency(value) {
  const numeric = Number(value || 0);
  return `$${Number.isFinite(numeric) ? numeric.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '0'}`;
}

function renderPlSignupsSeries(signupsByWeek) {
  const rows = Array.isArray(signupsByWeek) ? signupsByWeek : [];
  const maxValue = rows.reduce((acc, row) => Math.max(acc, Number(row.count || 0)), 0) || 1;
  return rows.map(row => {
    const count = Number(row.count || 0);
    const width = Math.max(6, Math.round((count / maxValue) * 100));
    return `
      <div style="display:grid; grid-template-columns: 92px 1fr 40px; align-items:center; gap:10px; margin-bottom:8px;">
        <div style="font-size:11px; color:var(--text-secondary);">${escapeForHtmlText(String(row.weekLabel || '-'))}</div>
        <div style="height:7px; border-radius:999px; background: rgba(15,23,42,0.08); overflow:hidden;">
          <div style="height:100%; width:${width}%; border-radius:999px; background: var(--accent-blue);"></div>
        </div>
        <div style="font-size:11px; font-weight:600; text-align:right; color: var(--text-primary);">${count}</div>
      </div>`;
  }).join('');
}

async function renderPLView() {
  const container = document.getElementById('plCenterContainer');
  if (!container) return;

  container.innerHTML = '<div style="padding:18px; color:var(--text-secondary);">Loading P&L data...</div>';
  try {
    const response = await fetch(apiUrl('/api/pl/summary'));
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to load P&L summary');

    plSnapshot = body;
    const summary = body.summary || {};
    const organizations = Array.isArray(body.organizations) ? body.organizations : [];
    const signupsByWeek = Array.isArray(body.signupsByWeek) ? body.signupsByWeek : [];

    const scopedLabel = body.scope === 'global' ? 'Global system view' : `Agency: ${escapeForHtmlText(currentAgencyId)}`;
    const signupSourceLabel = body.signupSource === 'signup_ledger' ? 'Live signup ledger' : 'Legacy organization fallback';

    const activeOrgs = organizations.filter(o => String(o.status || '').toLowerCase() !== 'churned');
    const churnedOrgs = organizations.filter(o => String(o.status || '').toLowerCase() === 'churned');
    const churnRate = organizations.length > 0 ? (churnedOrgs.length / organizations.length * 100) : 0;

    const orgRows = sortPlOrganizations(organizations, plSortBy)
      .slice(0, 300)
      .map((org) => {
        const isChurned = String(org.status || '').toLowerCase() === 'churned';
        const statusColor = isChurned ? '#ff3b30' : '#34c759';
        const statusBg = isChurned ? 'rgba(255,59,48,0.1)' : 'rgba(52,199,89,0.1)';
        return `
        <tr style="opacity:${isChurned ? '0.6' : '1'};">
          <td style="padding:10px 12px;font-weight:500;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeForHtmlText(org.organizationName || org.agencyId || '-')}</td>
          <td style="padding:10px 8px;color:var(--text-secondary);">${escapeForHtmlText(org.agencyId || '-')}</td>
          <td style="padding:10px 8px;text-align:right;font-variant-numeric:tabular-nums;">${formatPlCurrency(org.revenue30d || 0)}</td>
          <td style="padding:10px 8px;text-align:right;font-variant-numeric:tabular-nums;">${formatPlCurrency(org.arpa || 0)}</td>
          <td style="padding:10px 8px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${formatPlCurrency(org.ltv || 0)}</td>
          <td style="padding:10px 8px;text-align:center;">
            <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${statusBg};color:${statusColor};">${escapeForHtmlText(String(org.status || 'active').toUpperCase())}</span>
          </td>
        </tr>`;
      })
      .join('');

    container.innerHTML = `
    <div style="max-width:1100px;margin:0 auto;">
      <!-- Header -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <div>
          <h2 style="font-size:20px;font-weight:700;letter-spacing:-0.02em;margin:0;">P&L Overview</h2>
          <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 0;">${scopedLabel} &middot; ${organizations.length} organization${organizations.length !== 1 ? 's' : ''}</p>
        </div>
        <div style="display:flex;gap:8px;">
          <select onchange="plSortBy=this.value; renderPLView();" style="padding:8px 12px;border-radius:8px;border:1px solid var(--glass-border,#ddd);font-size:12px;background:var(--glass-bg,#fff);color:var(--text-primary);">
            <option value="ltv-desc" ${plSortBy === 'ltv-desc' ? 'selected' : ''}>Sort: LTV</option>
            <option value="revenue-desc" ${plSortBy === 'revenue-desc' ? 'selected' : ''}>Sort: Revenue (30d)</option>
            <option value="signups-desc" ${plSortBy === 'signups-desc' ? 'selected' : ''}>Sort: Signups</option>
            <option value="name-asc" ${plSortBy === 'name-asc' ? 'selected' : ''}>Sort: Organization</option>
          </select>
          <button onclick="renderPLView();" style="padding:8px 12px;border-radius:8px;border:1px solid var(--glass-border,#ddd);font-size:12px;background:transparent;cursor:pointer;color:var(--text-primary);">Refresh</button>
        </div>
      </div>

      <!-- KPI Cards — top row: revenue metrics -->
      <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:12px;margin-bottom:12px;">
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:6px;">MRR (30d)</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;">${formatPlCurrency(summary.mrr || 0)}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:6px;">ARPA</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;">${formatPlCurrency(summary.arpa || 0)}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:6px;">Modeled LTV</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;">${formatPlCurrency(summary.ltv || 0)}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:6px;">Churn Rate</div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:${churnRate > 10 ? '#ff3b30' : churnRate > 5 ? '#ff9500' : '#34c759'};">${churnRate.toFixed(1)}%</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">${churnedOrgs.length} churned / ${organizations.length} total</div>
        </div>
      </div>

      <!-- KPI Cards — bottom row: signup & conversion metrics -->
      <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:12px;margin-bottom:24px;">
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:4px;">Total Signups</div>
          <div style="font-size:22px;font-weight:700;">${Number(summary.totalSignups || 0)}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:4px;">Signups (30d)</div>
          <div style="font-size:22px;font-weight:700;">${Number(summary.signups30d || 0)}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:4px;">Activated</div>
          <div style="font-size:22px;font-weight:700;">${Number(summary.completedSignups || 0)}</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:4px;">Activation Rate</div>
          <div style="font-size:22px;font-weight:700;color:${Number(summary.activationRatePct || 0) > 50 ? '#34c759' : '#ff9500'};">${Number(summary.activationRatePct || 0).toFixed(1)}%</div>
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin-bottom:4px;">Paid Conversion</div>
          <div style="font-size:22px;font-weight:700;color:${Number(summary.paidConversionRatePct || 0) > 20 ? '#34c759' : '#ff9500'};">${Number(summary.paidConversionRatePct || 0).toFixed(1)}%</div>
        </div>
      </div>

      <!-- Signup Velocity + Model Notes side by side -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">Signup Velocity (12 Weeks)</h3>
          ${renderPlSignupsSeries(signupsByWeek) || '<div style="font-size:12px; color:var(--text-secondary);">No signup data yet.</div>'}
        </div>
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">Model Notes</h3>
          <div style="font-size:12px;line-height:1.6;color:var(--text-secondary);">
            <div><strong>LTV</strong> = ARPA / monthly churn. If churn is zero, fallback uses 24-month ARPA.</div>
            <div style="margin-top:8px;"><strong>MRR</strong> uses trailing 30-day recognized project revenue from tracked work.</div>
            <div style="margin-top:8px;"><strong>Signups source:</strong> ${escapeForHtmlText(signupSourceLabel)}</div>
          </div>
        </div>
      </div>

      <!-- Organization Table -->
      <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;overflow:hidden;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:2px solid var(--glass-border);">
              <th style="padding:12px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Organization</th>
              <th style="padding:12px 8px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Agency</th>
              <th style="padding:12px 8px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Rev (30d)</th>
              <th style="padding:12px 8px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">ARPA</th>
              <th style="padding:12px 8px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">LTV</th>
              <th style="padding:12px 8px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);">Status</th>
            </tr>
          </thead>
          <tbody>
            ${orgRows || '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--text-secondary);">No organization metrics yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    `;
  } catch (error) {
    console.error('Failed to render P&L view:', error);
    container.innerHTML = `<div style="padding:16px; color: var(--status-red);">${escapeForHtmlText(error.message || 'Failed to load P&L data')}</div>`;
  }
}

// Initialize FullCalendar
function initCalendar() {
  console.log('initCalendar called');
  const calendarEl = document.getElementById('calendarContainer');
  if (!calendarEl) {
    console.error('Calendar container not found!');
    return;
  }
  
  console.log('Calendar container found, checking FullCalendar...');
  
  // Load FullCalendar if not already loaded
  if (typeof FullCalendar === 'undefined') {
    console.log('FullCalendar not loaded, loading now...');
    loadFullCalendar();
    return;
  }
  
  console.log('FullCalendar is loaded, creating calendar...');
  
  calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: 'dayGridMonth',
    headerToolbar: false, // Using custom controls
    themeSystem: 'standard',
    events: function(_fetchInfo, successCallback) {
      successCallback(generateCalendarEvents());
    },
    eventClick: function(info) {
      showCalendarEventDetails(info.event);
    },
    eventDidMount: function(info) {
      // Add tooltip with all project details
      const project = data.projects.find(p => p.id === info.event.id);
      if (project) {
        const startDate = project.startDate ? new Date(project.startDate).toLocaleDateString() : 'Not set';
        const dueDate = project.dueDate ? new Date(project.dueDate).toLocaleDateString() : 'Not set';
        const duration = project.startDate && project.dueDate 
          ? Math.ceil((new Date(project.dueDate) - new Date(project.startDate)) / (1000 * 60 * 60 * 24)) + ' days'
          : 'Not set';
        
        info.el.title = `${project.name}\n` +
                       `Priority: ${project.priority}\n` +
                       `Status: ${project.status}\n` +
                       `Progress: ${project.progress}%\n` +
                       `Owner: ${project.owner}\n` +
                       `Start: ${startDate}\n` +
                       `Due: ${dueDate}\n` +
                       `Duration: ${duration}`;
      }
      
      // Style for better visibility
      info.el.style.fontSize = '12px';
      info.el.style.padding = '4px 8px';
      info.el.style.borderRadius = '6px';
      info.el.style.margin = '2px 0';
      info.el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
    },
    height: 'auto',
    contentHeight: 'auto',
    dayMaxEvents: 3, // Limit events per day to prevent clutter
    dayMaxEventRows: true, // Allow more events with "+X more"
    eventTimeFormat: { // 24-hour time
      hour: '2-digit',
      minute: '2-digit',
      meridiem: false
    },
    businessHours: {
      daysOfWeek: [1, 2, 3, 4, 5], // Monday - Friday
      startTime: '09:00',
      endTime: '18:00'
    },
    nowIndicator: true,
    editable: true,
    eventDrop: function(info) {
      updateProjectDueDate(info.event.id, info.event.start);
    },
    // No eventResize since we're using single-day events
    eventDisplay: 'block',
    eventOrder: function(eventA, eventB) {
      // Custom sorting: P0 first, then P1, then P2, then others
      const priorityOrder = { 'P0': 0, 'P1': 1, 'P2': 2 };
      const aPriority = eventA.extendedProps.priority || 'P9';
      const bPriority = eventB.extendedProps.priority || 'P9';
      
      const aOrder = priorityOrder[aPriority] !== undefined ? priorityOrder[aPriority] : 99;
      const bOrder = priorityOrder[bPriority] !== undefined ? priorityOrder[bPriority] : 99;
      
      return aOrder - bOrder;
    },
    eventOrderStrict: true
  });

  calendar.render();
  updateCalendarTitle();
}

// Load FullCalendar dynamically
function loadFullCalendar() {
  // Check if already loaded
  if (document.querySelector('link[href*="fullcalendar"]')) {
    initCalendar();
    return;
  }
  
  // Load CSS
  const link = document.createElement('link');
  link.href = 'https://cdn.jsdelivr.net/npm/fullcalendar@5.11.3/main.min.css';
  link.rel = 'stylesheet';
  document.head.appendChild(link);
  
  // Load JS
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/fullcalendar@5.11.3/main.min.js';
  script.onload = initCalendar;
  document.head.appendChild(script);
}

// Generate calendar events from projects
function generateCalendarEvents() {
  if (!data || !data.projects) return [];
  
  const events = [];
  const statuses = buildStatusBuckets(getCalendarBaseProjects());
  const calendarProjects = statuses[currentLaneView]?.projects || [];

  calendarProjects.forEach(project => {
    // Prefer dueDate; fallback to startDate/createdDate so new tasks still appear.
    const dateSource = project.dueDate || project.startDate || project.createdDate;
    if (!dateSource) return;

    const dueDate = new Date(dateSource);
    if (Number.isNaN(dueDate.getTime())) return;
    
    // Determine event color based on priority and status
    let backgroundColor = '#3b82f6'; // Default blue
    let borderColor = '#3b82f6';
    let display = 'auto'; // Default display
    
    if (project.priority === 'P0') {
      backgroundColor = '#ef4444'; // Red for P0
      borderColor = '#dc2626';
    } else if (project.priority === 'P1') {
      backgroundColor = '#f59e0b'; // Yellow for P1
      borderColor = '#d97706';
    } else if (getEffectiveStatus(project) === 'complete' || project.progress === 100) {
      backgroundColor = '#10b981'; // Green for complete
      borderColor = '#059669';
      display = 'background'; // Show as background for completed
    } else if (project.priority === 'P2') {
      backgroundColor = '#3b82f6'; // Blue for P2
      borderColor = '#2563eb';
    }
    
    // Create event title with priority indicator
    let title = project.name;
    if (project.priority === 'P0') title = ' ' + title;
    else if (project.priority === 'P1') title = ' ' + title;
    else if (project.priority === 'P2') title = ' ' + title;
    
    // Truncate long titles
    if (title.length > 40) {
      title = title.substring(0, 37) + '...';
    }
    
    events.push({
      id: project.id,
      title: title,
      start: dueDate, // Single day event on due date
      allDay: true,
      backgroundColor: backgroundColor,
      borderColor: borderColor,
      textColor: '#ffffff', // White text for better contrast
      display: display,
      extendedProps: {
        source: 'project',
        client: project.clientName,
        owner: project.owner,
        status: getEffectiveStatus(project),
        progress: project.progress,
        priority: project.priority,
        notes: project.notes,
        actualHours: project.actualHours,
        hourlyRate: project.hourlyRate,
        revenue: project.revenue,
        cost: project.cost,
        profit: project.profit,
        margin: project.margin,
        startDate: project.startDate,
        dueDate: project.dueDate
      }
    });
  });

  const externalEvents = Array.isArray(settingsState?.integrationAccounts?.calendar?.syncedCalendarEvents)
    ? settingsState.integrationAccounts.calendar.syncedCalendarEvents
    : [];

  externalEvents.forEach((item, idx) => {
    const startValue = item?.start;
    if (!startValue) return;
    const startDate = new Date(startValue);
    if (Number.isNaN(startDate.getTime())) return;
    const endValue = item?.end ? new Date(item.end) : null;
    const isAllDay = Boolean(item?.allDay);
    const title = String(item?.title || 'Calendar Event');
    events.push({
      id: `ext-cal-${String(item?.id || idx)}`,
      title: title.length > 42 ? `${title.slice(0, 39)}...` : title,
      start: startDate,
      end: endValue && !Number.isNaN(endValue.getTime()) ? endValue : undefined,
      allDay: isAllDay,
      editable: false,
      backgroundColor: '#6b7280',
      borderColor: '#4b5563',
      textColor: '#ffffff',
      extendedProps: {
        source: 'external-calendar',
        provider: 'google',
        status: String(item?.status || ''),
        htmlLink: String(item?.htmlLink || '')
      }
    });
  });
  
  return events;
}

// Update project due date when event is moved
async function ensureCalendarLaneHasVisibleEvents() {
  if (!calendar) return;
  const laneEvents = generateCalendarEvents().filter((evt) => {
    const source = String(evt?.extendedProps?.source || 'project').trim().toLowerCase();
    return source === 'project';
  });
  if (!laneEvents.length) return;

  const viewStart = calendar.view?.activeStart || calendar.view?.currentStart;
  const viewEnd = calendar.view?.activeEnd || calendar.view?.currentEnd;
  if (!viewStart || !viewEnd) return;

  const inView = laneEvents.some((evt) => {
    const dt = new Date(evt.start);
    return !Number.isNaN(dt.getTime()) && dt >= viewStart && dt < viewEnd;
  });
  if (inView) return;

  const now = Date.now();
  let bestEvent = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  laneEvents.forEach((evt) => {
    const dt = new Date(evt.start);
    if (Number.isNaN(dt.getTime())) return;
    const diff = Math.abs(dt.getTime() - now);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestEvent = evt;
    }
  });

  if (bestEvent?.start) {
    calendar.gotoDate(bestEvent.start);
    updateCalendarTitle();
  }
}

async function updateProjectDueDate(projectId, newDate) {
  if (!projectId || String(projectId).startsWith('ext-cal-')) return;
  try {
    const response = await fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dueDate: newDate.toISOString(),
        updatedBy: 'Calendar'
      })
    });
    
    if (response.ok) {
      showNotification('Due date updated', 'success');
      await loadData(); // Reload projects
    } else {
      throw new Error('Failed to update due date');
    }
  } catch (error) {
    console.error('Error updating due date:', error);
    showNotification('Error updating due date', 'error');
    if (calendar) calendar.refetchEvents(); // Revert calendar display
  }
}

// Show calendar event details
function showCalendarEventDetails(event) {
  const props = event.extendedProps;
  if (props?.source === 'external-calendar') {
    if (props.htmlLink) {
      window.open(props.htmlLink, '_blank', 'noopener');
      showNotification(`Opened external calendar event: ${event.title}`, 'info');
      return;
    }
    showNotification(`External calendar event: ${event.title}`, 'info');
    return;
  }

  const projectId = String(event?.id || '').trim();
  if (!projectId) {
    showNotification('Project link is missing for this calendar item.', 'error');
    return;
  }

  const exists = Array.isArray(data?.projects) && data.projects.some((p) => String(p?.id || '') === projectId);
  if (!exists) {
    showNotification('Project not found for this calendar item.', 'error');
    return;
  }

  // Keep calendar visible; open detail panel as overlay/context panel.
  const detailPanel = document.getElementById('detailPanel');
  if (detailPanel) {
    detailPanel.style.display = '';
  }

  setTimeout(() => {
    selectProject(projectId);
    syncProjectFocusLayout();
  }, 0);

  showNotification(`Opening project: ${event.title}`, 'info');
}

// Calendar navigation
function calendarPrev() {
  if (calendar) {
    calendar.prev();
    updateCalendarTitle();
  }
}

function calendarNext() {
  if (calendar) {
    calendar.next();
    updateCalendarTitle();
  }
}

function calendarToday() {
  if (calendar) {
    calendar.today();
    updateCalendarTitle();
  }
}

function changeCalendarView(view) {
  if (calendar) {
    let fcView = 'dayGridMonth';
    if (view === 'week') fcView = 'timeGridWeek';
    if (view === 'day') fcView = 'timeGridDay';
    
    calendar.changeView(fcView);
    updateCalendarTitle();
  }
}

// Update calendar title
function updateCalendarTitle() {
  if (!calendar) return;
  
  const titleEl = document.getElementById('calendarTitle');
  if (titleEl) {
    const view = calendar.view;
    const date = view.currentStart;
    
    let title = '';
    if (view.type === 'dayGridMonth') {
      title = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    } else if (view.type === 'timeGridWeek') {
      const end = new Date(date);
      end.setDate(end.getDate() + 6);
      title = `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else if (view.type === 'timeGridDay') {
      title = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    
    titleEl.textContent = title;
  }
}

// Show notification
function showNotification(message, type = 'info') {
  // Remove existing notifications
  document.querySelectorAll('.notification').forEach(n => n.remove());
  
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
    color: white;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    z-index: 10000;
    animation: slideIn 0.3s ease;
  `;
  
  document.body.appendChild(notification);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Add CSS animations for notifications
if (!document.querySelector('#notification-styles')) {
  const style = document.createElement('style');
  style.id = 'notification-styles';
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
      from { transform: translateX(0); opacity: 1; }
      to { transform: translateX(100%); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}


// ─── Intake / Peg Queue View ──────────────────────────────────────────────────

let intakeData = [];
let intakeFilter = '';
let intakeUsage = null;

async function renderIntakeView() {
  const container = document.getElementById('intakeContainer');
  if (!container) return;

  container.innerHTML = '<div style="padding:24px; color:var(--text-secondary);">Loading intake queue...</div>';

  try {
    const [queueRes, statsRes, usageRes] = await Promise.all([
      fetch(apiUrl('/api/peg/queue?limit=100')),
      fetch(apiUrl('/api/peg/queue/stats')),
      fetch(apiUrl('/api/agents/usage?days=30')),
    ]);
    const queueBody = queueRes.ok ? await queueRes.json() : { items: [] };
    const statsBody = statsRes.ok ? await statsRes.json() : { stats: {} };
    const usageBody = usageRes.ok ? await usageRes.json() : {};

    intakeData = Array.isArray(queueBody.items) ? queueBody.items : [];
    intakeUsage = usageBody;
    const stats = statsBody.stats || {};

    container.innerHTML = `
      <div style="padding:20px 24px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px;">
          <div>
            <h2 style="margin:0; font-size:18px; font-weight:600;">Intake Queue</h2>
            <p style="margin:4px 0 0; font-size:13px; color:var(--text-secondary);">Joan classifies → Peg verifies → Console approves → Execute</p>
          </div>
          <div style="display:flex; gap:8px;">
            <select id="intakeStatusFilter" onchange="filterIntakeQueue(this.value)" style="padding:6px 10px; border-radius:6px; border:1px solid var(--border); background:var(--bg-secondary); color:var(--text-primary); font-size:13px;">
              <option value="">All (${stats.total || 0})</option>
              <option value="pending_review">Pending Review (${stats.pending_review || 0})</option>
              <option value="peg_verified">Peg Verified (${stats.peg_verified || 0})</option>
              <option value="console_approved">Approved (${stats.console_approved || 0})</option>
              <option value="executed">Executed (${stats.executed || 0})</option>
              <option value="rejected">Rejected (${stats.rejected || 0})</option>
            </select>
            <button class="btn" onclick="renderIntakeView()" style="padding:6px 12px; font-size:13px;">Refresh</button>
          </div>
        </div>

        <!-- Stats Bar -->
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin-bottom:20px;">
          ${renderIntakeStatCard('Pending', stats.pending_review || 0, '#f59e0b')}
          ${renderIntakeStatCard('Verified', stats.peg_verified || 0, '#3b82f6')}
          ${renderIntakeStatCard('Approved', stats.console_approved || 0, '#8b5cf6')}
          ${renderIntakeStatCard('Executed', stats.executed || 0, '#10b981')}
          ${renderIntakeStatCard('Rejected', stats.rejected || 0, '#ef4444')}
          ${renderIntakeStatCard('LLM Calls (30d)', usageBody.totalCalls || 0, '#6366f1', '$' + (usageBody.totalCostUsd || 0).toFixed(4))}
        </div>

        <!-- Queue Items -->
        <div id="intakeQueueList">
          ${renderIntakeQueueItems(intakeData)}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div style="padding:24px; color:var(--error);">Failed to load intake queue: ${escapeForHtmlText(err.message)}</div>`;
  }
}

function renderIntakeStatCard(label, value, color, subtitle) {
  return `
    <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:14px 16px;">
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-secondary); margin-bottom:4px;">${label}</div>
      <div style="font-size:22px; font-weight:700; color:${color};">${value}</div>
      ${subtitle ? `<div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${subtitle}</div>` : ''}
    </div>`;
}

function renderIntakeQueueItems(items) {
  if (!items.length) {
    return '<div style="padding:40px; text-align:center; color:var(--text-secondary); font-size:14px;">No items in queue. Run a Gmail backfill to populate.</div>';
  }

  return items.map(item => {
    const cls = item.joanClassification || {};
    const statusColors = {
      pending_review: '#f59e0b',
      peg_verified: '#3b82f6',
      console_approved: '#8b5cf6',
      executed: '#10b981',
      rejected: '#ef4444'
    };
    const statusLabels = {
      pending_review: 'Pending Review',
      peg_verified: 'Peg Verified',
      console_approved: 'Approved',
      executed: 'Executed',
      rejected: 'Rejected'
    };
    const priorityColors = { High: '#ef4444', Medium: '#f59e0b', Low: '#6b7280' };
    const categoryIcons = { Urgent: '🔴', 'Action Required': '🟡', FYI: '🔵', Trash: '⚫' };

    const actions = [];
    if (item.status === 'pending_review') {
      actions.push(`<button class="btn" onclick="pegVerify('${escapeForJsString(item.id)}', true)" style="padding:4px 10px; font-size:12px; background:#3b82f6; color:#fff; border:0; border-radius:4px;">Verify</button>`);
      actions.push(`<button class="btn" onclick="pegVerify('${escapeForJsString(item.id)}', false)" style="padding:4px 10px; font-size:12px; background:var(--bg-tertiary); color:var(--text-secondary); border:1px solid var(--border); border-radius:4px;">Reject</button>`);
    } else if (item.status === 'peg_verified') {
      actions.push(`<button class="btn" onclick="pegApprove('${escapeForJsString(item.id)}', true)" style="padding:4px 10px; font-size:12px; background:#8b5cf6; color:#fff; border:0; border-radius:4px;">Approve</button>`);
      actions.push(`<button class="btn" onclick="pegApprove('${escapeForJsString(item.id)}', false)" style="padding:4px 10px; font-size:12px; background:var(--bg-tertiary); color:var(--text-secondary); border:1px solid var(--border); border-radius:4px;">Reject</button>`);
    } else if (item.status === 'console_approved') {
      actions.push(`<button class="btn" onclick="pegExecute('${escapeForJsString(item.id)}')" style="padding:4px 10px; font-size:12px; background:#10b981; color:#fff; border:0; border-radius:4px;">Execute</button>`);
    }

    return `
      <div style="background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:10px;">
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
              <span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; background:${statusColors[item.status] || '#6b7280'}22; color:${statusColors[item.status] || '#6b7280'};">${statusLabels[item.status] || item.status}</span>
              <span style="font-size:12px; color:${priorityColors[cls.priority] || '#6b7280'}; font-weight:600;">${cls.priority || '—'}</span>
              <span style="font-size:12px;">${categoryIcons[cls.category] || ''} ${escapeForHtmlText(cls.category || '')}</span>
            </div>
            <div style="font-weight:600; font-size:14px; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeForHtmlText(item.email?.subject || '(No subject)')}</div>
            <div style="font-size:12px; color:var(--text-secondary); margin-bottom:6px;">
              From: ${escapeForHtmlText(item.email?.from || '—')} ${cls.company ? '(' + escapeForHtmlText(cls.company) + ')' : ''}
              <span style="margin-left:8px;">${item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</span>
            </div>
            ${cls.summary && cls.summary.length ? `<div style="font-size:12px; color:var(--text-secondary); margin-bottom:6px;">${cls.summary.map(s => '• ' + escapeForHtmlText(s)).join('<br>')}</div>` : ''}
            ${cls.requestedOutcome ? `<div style="font-size:12px; margin-bottom:4px;"><strong>Outcome:</strong> ${escapeForHtmlText(cls.requestedOutcome)}</div>` : ''}
            ${cls.recommendedOwner ? `<div style="font-size:12px; color:var(--text-secondary);">Owner: <strong>${escapeForHtmlText(cls.recommendedOwner)}</strong></div>` : ''}
            ${cls.draftResponse ? `<div style="font-size:12px; margin-top:6px; padding:8px; background:var(--bg-tertiary); border-radius:4px; color:var(--text-secondary);"><strong>Draft:</strong> ${escapeForHtmlText(cls.draftResponse)}</div>` : ''}
            ${item.llmMeta?.model ? `<div style="font-size:10px; color:var(--text-tertiary); margin-top:4px;">Model: ${escapeForHtmlText(item.llmMeta.model)} | Tokens: ${(item.llmMeta.tokens?.input || 0) + (item.llmMeta.tokens?.output || 0)} | Cost: $${(item.llmMeta.costUsd || 0).toFixed(5)}</div>` : ''}
          </div>
          <div style="display:flex; flex-direction:column; gap:4px; flex-shrink:0;">
            ${actions.join('')}
          </div>
        </div>
        ${item.pegVerification ? `<div style="font-size:11px; margin-top:8px; padding:6px 8px; background:var(--bg-tertiary); border-radius:4px;">Verified by ${escapeForHtmlText(item.pegVerification.verifiedBy || '—')} at ${item.pegVerification.verifiedAt ? new Date(item.pegVerification.verifiedAt).toLocaleString() : '—'}${item.pegVerification.notes ? ' — ' + escapeForHtmlText(item.pegVerification.notes) : ''}</div>` : ''}
        ${item.consoleApproval ? `<div style="font-size:11px; margin-top:4px; padding:6px 8px; background:var(--bg-tertiary); border-radius:4px;">Approved by ${escapeForHtmlText(item.consoleApproval.approvedBy || '—')} at ${item.consoleApproval.approvedAt ? new Date(item.consoleApproval.approvedAt).toLocaleString() : '—'}${item.consoleApproval.notes ? ' — ' + escapeForHtmlText(item.consoleApproval.notes) : ''}</div>` : ''}
      </div>`;
  }).join('');
}

function filterIntakeQueue(status) {
  intakeFilter = status;
  const listEl = document.getElementById('intakeQueueList');
  if (!listEl) return;
  const filtered = status ? intakeData.filter(i => i.status === status) : intakeData;
  listEl.innerHTML = renderIntakeQueueItems(filtered);
}

async function pegVerify(entryId, verified) {
  const notes = verified ? '' : (prompt('Rejection reason (optional):') || '');
  try {
    const res = await fetch(apiUrl('/api/peg/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: entryId, verified, notes })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Verify failed: ' + (err.error || res.statusText));
      return;
    }
    renderIntakeView();
  } catch (err) {
    alert('Verify failed: ' + err.message);
  }
}

async function pegApprove(entryId, approved) {
  const notes = approved ? '' : (prompt('Rejection reason (optional):') || '');
  try {
    const res = await fetch(apiUrl('/api/peg/approve'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: entryId, approved, notes })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Approve failed: ' + (err.error || res.statusText));
      return;
    }
    renderIntakeView();
  } catch (err) {
    alert('Approve failed: ' + err.message);
  }
}

async function pegExecute(entryId) {
  if (!confirm('Execute this intake item? This will create a project and assignments.')) return;
  try {
    const res = await fetch(apiUrl('/api/peg/execute'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: entryId })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Execute failed: ' + (err.error || res.statusText));
      return;
    }
    renderIntakeView();
  } catch (err) {
    alert('Execute failed: ' + err.message);
  }
}

Object.assign(window, {
  switchView,
  forceRefreshDashboard,
  logoutSession,
  openAgentsWorkspace,
  calendarPrev,
  calendarNext,
  calendarToday,
  setConversationFilter,
  onConversationSearch,
  reassignConversation,
  toggleConversationSelection,
  toggleConversationSelectionAll,
  runConversationBulkAction,
  updateAssignmentStatus,
  assignTaskToSelectedProject,
  recalculateProjectRouting,
  recalculateSelectedProjectAssignees,
  acceptRequestRouting,
  reassignRequestRouting,
  openRoutingReviewRequest,
  openConversationProject,
  filterIntakeQueue,
  pegVerify,
  pegApprove,
  pegExecute,
  renderIntakeView,
  renderBriefingView
});

window.addEventListener('beforeunload', stopRealtimeStream);

// ─── Morning Briefing View ──────────────────────────────────────────────────

async function renderBriefingView() {
  const container = document.getElementById('briefingView');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">Loading briefing...</div>';

  try {
    const response = await fetch(apiUrl('/api/briefing'));
    if (!response.ok) throw new Error('Failed to load briefing');
    const data = await response.json();
    const s = data.summary;
    const now = new Date();
    const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';

    container.innerHTML = `
      <div style="max-width:1100px;margin:0 auto;padding:8px 0;">
        <div style="margin-bottom:24px;">
          <h2 style="font-size:22px;font-weight:700;letter-spacing:-0.02em;margin:0 0 4px;">${greeting}</h2>
          <p style="color:var(--text-secondary);font-size:13px;margin:0;">Here's what needs your attention today — ${new Date(data.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        </div>

        <!-- KPI Cards -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:12px;margin-bottom:24px;">
          ${briefingKpiCard(s.activeProjects, 'Active', '#3d74a8', `switchView('projects');currentStatusFilter=null;currentFilter='all';renderProjectList();`)}
          ${briefingKpiCard(s.overdueProjects, 'Overdue', s.overdueProjects > 0 ? '#ff3b30' : '#34c759', `briefingDrillDown('overdue')`)}
          ${briefingKpiCard(s.dueToday, 'Due Today', s.dueToday > 0 ? '#ff9500' : '#34c759', `briefingDrillDown('dueToday')`)}
          ${briefingKpiCard(s.dueThisWeek, 'Due This Week', '#60789a', `briefingDrillDown('dueThisWeek')`)}
          ${briefingKpiCard(s.openAssignments, 'Open Tasks', '#3d74a8', `switchView('projects');currentStatusFilter='in-progress';renderProjectList();`)}
          ${briefingKpiCard(s.pendingApprovals, 'Approvals', s.pendingApprovals > 0 ? '#ff9500' : '#8e8e93', `switchView('intake');`)}
          ${briefingKpiCard(s.blockedProjects, 'Blocked', s.blockedProjects > 0 ? '#ff3b30' : '#34c759', `switchView('projects');currentStatusFilter='blocked';renderProjectList();`)}
          ${s.newProspects > 0 ? briefingKpiCard(s.newProspects, 'New Leads', '#9b59b6', `briefingDrillDown('newProspects')`) : ''}
        </div>

        <!-- Priority Breakdown -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
          <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
            <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">Priority Breakdown</h3>
            <div style="display:flex;gap:16px;">
              ${briefingPriorityBar('P0', data.priorities.P0, '#ff3b30', `briefingFilterByPriority('P0')`)}
              ${briefingPriorityBar('P1', data.priorities.P1, '#ff9500', `briefingFilterByPriority('P1')`)}
              ${briefingPriorityBar('P2', data.priorities.P2, '#3d74a8', `briefingFilterByPriority('P2')`)}
              ${briefingPriorityBar('P3', data.priorities.P3, '#8e8e93', `briefingFilterByPriority('P3')`)}
            </div>
          </div>

          <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
            <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">Client Load</h3>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${(data.topClients || []).map(c => `
                <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;cursor:pointer;padding:4px 6px;border-radius:6px;transition:background 0.15s;" onclick="briefingFilterByClient('${escapeHtml(c.name)}')" onmouseenter="this.style.background='rgba(61,116,168,0.06)'" onmouseleave="this.style.background='transparent'">
                  <span style="font-weight:500;">${escapeHtml(c.name)}</span>
                  <span style="background:rgba(61,116,168,0.12);color:#3d74a8;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;">${c.activeProjects}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- New Prospects / Leads -->
        ${(data.newProspects || []).length > 0 ? `
        <div style="background:linear-gradient(135deg, rgba(155,89,182,0.06), rgba(155,89,182,0.02));border:1px solid rgba(155,89,182,0.2);border-radius:12px;padding:16px;margin-bottom:24px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:#9b59b6;margin:0 0 12px;">
            New Leads & Prospects (${data.newProspects.length})
          </h3>
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${data.newProspects.map(p => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--glass-bg);border-radius:8px;cursor:pointer;transition:background 0.15s;" onclick="switchView('projects');setTimeout(()=>selectProject('${p.id}'),100);" onmouseenter="this.style.background='rgba(155,89,182,0.08)'" onmouseleave="this.style.background='var(--glass-bg)'">
                <div>
                  <div style="font-size:13px;font-weight:600;">${escapeHtml(p.name)}</div>
                  <div style="font-size:11px;color:var(--text-secondary);">${escapeHtml(p.client || 'Unknown')} ${p.owner ? '— ' + escapeHtml(p.owner) : ''}</div>
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                  <span style="background:rgba(155,89,182,0.15);color:#9b59b6;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;">NEW LEAD</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}

        <!-- Recently Created (last 48h) -->
        ${(data.recentlyCreated || []).length > 0 ? `
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;margin-bottom:24px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--accent-blue);margin:0 0 12px;">
            New Intake — Last 48 Hours (${data.recentlyCreated.length})
          </h3>
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${data.recentlyCreated.map(p => {
              const priorityColors2 = { P0: '#ff3b30', P1: '#ff9500', P2: '#3d74a8', P3: '#8e8e93' };
              const pc2 = priorityColors2[p.priority] || '#8e8e93';
              const ago = p.createdDate ? Math.round((Date.now() - new Date(p.createdDate).getTime()) / 3600000) : 0;
              const agoLabel = ago < 1 ? 'just now' : ago < 24 ? ago + 'h ago' : Math.round(ago/24) + 'd ago';
              return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid var(--glass-border);cursor:pointer;border-radius:6px;transition:background 0.15s;" onclick="switchView(\\\'projects\\\');setTimeout(()=>selectProject(\\\'' + p.id + '\\\'),100);" onmouseenter="this.style.background=\\\'rgba(61,116,168,0.04)\\\'" onmouseleave="this.style.background=\\\'transparent\\\'">' +
                '<div>' +
                  '<div style="font-size:13px;font-weight:500;">' + escapeHtml(p.name) + '</div>' +
                  '<div style="font-size:11px;color:var(--text-secondary);">' + escapeHtml(p.client || '') + (p.owner ? ' — ' + escapeHtml(p.owner) : '') + '</div>' +
                '</div>' +
                '<div style="display:flex;align-items:center;gap:6px;">' +
                  '<span style="font-size:10px;color:var(--text-secondary);">' + agoLabel + '</span>' +
                  (!p.dueDate ? '<span style="background:rgba(255,149,0,0.12);color:#ff9500;padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;">NO DATE</span>' : '') +
                  '<span style="background:' + pc2 + ';color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;">' + (p.priority || 'P1') + '</span>' +
                '</div>' +
              '</div>';
            }).join('')}
          </div>
        </div>
        ` : ''}

        <!-- Action Lists -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
          <!-- Overdue -->
          <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
            <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:${s.overdueProjects > 0 ? '#ff3b30' : 'var(--text-secondary)'};margin:0 0 12px;">
              Overdue ${s.overdueProjects > 0 ? '(' + s.overdueProjects + ')' : ''}
            </h3>
            ${data.overdue.length === 0 ? '<p style="color:var(--text-secondary);font-size:13px;margin:0;">All clear</p>' : ''}
            ${(data.overdue || []).map(p => briefingProjectRow(p, true)).join('')}
          </div>

          <!-- Due Today -->
          <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
            <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">
              Due Today ${s.dueToday > 0 ? '(' + s.dueToday + ')' : ''}
            </h3>
            ${data.dueToday.length === 0 ? '<p style="color:var(--text-secondary);font-size:13px;margin:0;">Nothing due today</p>' : ''}
            ${(data.dueToday || []).map(p => briefingProjectRow(p, false)).join('')}
          </div>
        </div>

        <!-- Team Workload -->
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;margin-bottom:24px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">Team Workload</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px;">
            ${(data.teamWorkload || []).map(t => `
              <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(0,0,0,0.02);border-radius:8px;cursor:pointer;transition:background 0.15s;" onclick="briefingFilterByOwner('${escapeHtml(t.name)}')" onmouseenter="this.style.background='rgba(61,116,168,0.08)'" onmouseleave="this.style.background='rgba(0,0,0,0.02)'">
                <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#3d74a8,#60789a);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;">${escapeHtml(t.name.charAt(0))}</div>
                <div>
                  <div style="font-size:13px;font-weight:600;">${escapeHtml(t.name)}</div>
                  <div style="font-size:11px;color:var(--text-secondary);">${t.inProgress} active, ${t.open} queued</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- Recent Activity -->
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">Last 24 Hours</h3>
          ${(data.recentActivity || []).length === 0 ? '<p style="color:var(--text-secondary);font-size:13px;margin:0;">No recent activity</p>' : ''}
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${(data.recentActivity || []).map(a => `
              <div style="display:flex;gap:8px;align-items:baseline;font-size:12px;padding:4px 0;border-bottom:1px solid var(--glass-border);${a.projectId ? 'cursor:pointer;' : ''}" ${a.projectId ? `onclick="switchView('projects');setTimeout(()=>selectProject('${a.projectId}'),100);" onmouseenter="this.style.background='rgba(61,116,168,0.04)'" onmouseleave="this.style.background='transparent'"` : ''}>
                <span style="color:var(--text-secondary);flex-shrink:0;width:48px;">${new Date(a.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>
                <span style="font-weight:600;color:var(--accent-blue);flex-shrink:0;">${escapeHtml(String(a.agent || ''))}</span>
                <span style="color:var(--text-primary);">${escapeHtml(String(a.action || ''))} ${escapeHtml(String(a.target || ''))}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#ff3b30;">Failed to load briefing: ' + escapeHtml(err.message) + '</div>';
  }
}

function briefingKpiCard(value, label, color, onclick) {
  const clickable = onclick ? `cursor:pointer;` : '';
  const clickAttr = onclick ? `onclick="${onclick}" onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)'" onmouseleave="this.style.transform='';this.style.boxShadow=''"` : '';
  return `
    <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:14px 16px;text-align:center;transition:transform 0.15s,box-shadow 0.15s;${clickable}" ${clickAttr}>
      <div style="font-size:28px;font-weight:700;color:${color};letter-spacing:-0.02em;">${value}</div>
      <div style="font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin-top:2px;">${label}</div>
    </div>
  `;
}

function briefingPriorityBar(label, count, color, onclick) {
  const maxHeight = 60;
  const height = Math.max(4, Math.min(maxHeight, count * 8));
  const clickAttr = onclick ? `onclick="${onclick}" style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;cursor:pointer;padding:4px;border-radius:6px;transition:background 0.15s;" onmouseenter="this.style.background='rgba(0,0,0,0.04)'" onmouseleave="this.style.background='transparent'"` : `style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;"`;
  return `
    <div ${clickAttr}>
      <div style="font-size:16px;font-weight:700;color:${color};">${count}</div>
      <div style="width:100%;height:${height}px;background:${color};border-radius:4px;opacity:0.7;"></div>
      <div style="font-size:10px;font-weight:600;color:var(--text-secondary);">${label}</div>
    </div>
  `;
}

// Briefing drill-down navigation helpers
function briefingDrillDown(listType) {
  // Switch to projects view with appropriate filters pre-applied
  switchView('projects');
  // Reset filters first
  currentFilter = 'all';
  currentStatusFilter = null;
  currentClientFilter = null;
  searchTerm = '';
  // Apply drill-down specific filter via search
  if (listType === 'overdue') {
    // Filter to overdue projects by searching
    currentStatusFilter = null;
    searchTerm = '';
    // Use a custom transient filter
    window._briefingDrillDown = listType;
  } else if (listType === 'dueToday') {
    window._briefingDrillDown = listType;
  } else if (listType === 'dueThisWeek') {
    window._briefingDrillDown = listType;
  }
  renderProjectList();
}

function briefingFilterByPriority(priority) {
  switchView('projects');
  currentFilter = 'all';
  currentStatusFilter = null;
  currentClientFilter = null;
  searchTerm = '';
  window._briefingPriorityFilter = priority;
  renderProjectList();
}

function briefingFilterByClient(clientName) {
  switchView('projects');
  currentFilter = 'all';
  currentStatusFilter = null;
  currentClientFilter = clientName;
  searchTerm = '';
  renderProjectList();
}

function briefingFilterByOwner(ownerName) {
  switchView('projects');
  currentFilter = 'all';
  currentStatusFilter = null;
  currentClientFilter = null;
  searchTerm = ownerName === 'Unassigned' ? '' : ownerName;
  if (ownerName === 'Unassigned') {
    window._briefingOwnerFilter = 'Unassigned';
  } else {
    window._briefingOwnerFilter = ownerName;
  }
  renderProjectList();
}

function briefingProjectRow(p, showDueDate) {
  const priorityColors = { P0: '#ff3b30', P1: '#ff9500', P2: '#3d74a8', P3: '#8e8e93' };
  const color = priorityColors[p.priority] || '#8e8e93';
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--glass-border);cursor:pointer;" onclick="switchView('projects');setTimeout(()=>selectProject('${p.id}'),100);">
      <div>
        <div style="font-size:13px;font-weight:500;">${escapeHtml(p.name)}</div>
        <div style="font-size:11px;color:var(--text-secondary);">${escapeHtml(p.client || '')} ${p.owner ? '— ' + escapeHtml(p.owner) : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${showDueDate && p.dueDate ? '<span style="font-size:10px;color:#ff3b30;font-weight:600;">' + new Date(p.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</span>' : ''}
        <span style="background:${color};color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;">${p.priority || 'P1'}</span>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}

// ─── Client Portal View ─────────────────────────────────────────────────────

async function renderClientPortalView() {
  const container = document.getElementById('client-portalView');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">Loading client portal...</div>';

  try {
    const response = await fetch(apiUrl('/api/client-portal/projects'));
    if (!response.ok) throw new Error('Failed to load');
    const data = await response.json();

    const statusColors = {
      'new': '#3d74a8', 'in-progress': '#ff9500', 'in_progress': '#ff9500',
      'complete': '#34c759', 'completed': '#34c759', 'blocked': '#ff3b30',
      'delivered': '#34c759', 'archived': '#8e8e93',
    };

    container.innerHTML = `
      <div style="max-width:900px;margin:0 auto;padding:8px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
          <div>
            <h2 style="font-size:22px;font-weight:700;letter-spacing:-0.02em;margin:0 0 4px;">${escapeHtml(data.client)} — Client Portal</h2>
            <p style="color:var(--text-secondary);font-size:13px;margin:0;">${data.active} active project${data.active !== 1 ? 's' : ''} of ${data.total} total</p>
          </div>
          <button onclick="showNewTicketForm()" style="padding:10px 18px;background:var(--accent-blue,#3d74a8);color:#fff;border:0;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;">New Request</button>
        </div>

        <!-- New Ticket Form (hidden) -->
        <div id="newTicketForm" style="display:none;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:20px;margin-bottom:20px;">
          <h3 style="font-size:15px;font-weight:700;margin:0 0 16px;">Submit a Request</h3>
          <div style="display:grid;gap:12px;">
            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px;">Title</label>
              <input id="ticketTitle" type="text" placeholder="What do you need help with?" style="width:100%;padding:10px 12px;border:1px solid var(--glass-border);border-radius:8px;font-size:14px;background:transparent;color:var(--text-primary);" />
            </div>
            <div>
              <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px;">Description</label>
              <textarea id="ticketDescription" rows="4" placeholder="Provide details about your request..." style="width:100%;padding:10px 12px;border:1px solid var(--glass-border);border-radius:8px;font-size:14px;background:transparent;color:var(--text-primary);resize:vertical;font-family:inherit;"></textarea>
            </div>
            <div style="display:flex;gap:12px;">
              <div style="flex:1;">
                <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px;">Priority</label>
                <select id="ticketPriority" style="width:100%;padding:10px 12px;border:1px solid var(--glass-border);border-radius:8px;font-size:14px;background:transparent;color:var(--text-primary);">
                  <option value="low">Low</option>
                  <option value="medium" selected>Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
              <div style="flex:1;">
                <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px;">Category</label>
                <select id="ticketCategory" style="width:100%;padding:10px 12px;border:1px solid var(--glass-border);border-radius:8px;font-size:14px;background:transparent;color:var(--text-primary);">
                  <option value="general">General</option>
                  <option value="web">Website</option>
                  <option value="seo">SEO</option>
                  <option value="content">Content</option>
                  <option value="design">Design</option>
                  <option value="ads">Advertising</option>
                  <option value="automation">Automation</option>
                </select>
              </div>
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
              <button onclick="hideNewTicketForm()" style="padding:8px 16px;background:transparent;border:1px solid var(--glass-border);border-radius:8px;font-size:13px;cursor:pointer;color:var(--text-secondary);">Cancel</button>
              <button onclick="submitTicket()" id="submitTicketBtn" style="padding:8px 16px;background:var(--accent-blue,#3d74a8);color:#fff;border:0;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;">Submit</button>
            </div>
            <div id="ticketError" style="color:#ff3b30;font-size:13px;"></div>
            <div id="ticketSuccess" style="color:#34c759;font-size:13px;"></div>
          </div>
        </div>

        <!-- Project Cards -->
        <div style="display:flex;flex-direction:column;gap:10px;">
          ${data.projects.length === 0 ? '<p style="text-align:center;color:var(--text-secondary);padding:40px;">No projects found</p>' : ''}
          ${data.projects.map(p => {
            const sColor = statusColors[String(p.status || '').toLowerCase()] || '#8e8e93';
            const progressWidth = Math.min(100, Math.max(0, p.progress || 0));
            return `
              <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;cursor:pointer;" onclick="showClientProjectDetail('${p.id}')">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                  <div>
                    <div style="font-size:14px;font-weight:600;">${escapeHtml(p.name)}</div>
                    <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(p.id)} — ${escapeHtml(p.category || '')}</div>
                  </div>
                  <span style="background:${sColor};color:#fff;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;text-transform:uppercase;">${escapeHtml(String(p.status || 'new').replace(/-|_/g, ' '))}</span>
                </div>
                <div style="display:flex;align-items:center;gap:12px;">
                  <div style="flex:1;height:6px;background:rgba(0,0,0,0.06);border-radius:3px;overflow:hidden;">
                    <div style="height:100%;width:${progressWidth}%;background:${sColor};border-radius:3px;transition:width 0.3s;"></div>
                  </div>
                  <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;">${progressWidth}%</span>
                  <span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;">${p.openTasks} open task${p.openTasks !== 1 ? 's' : ''}</span>
                </div>
                ${p.dueDate ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:6px;">Due: ' + new Date(p.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</div>' : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#ff3b30;">Failed to load portal: ' + escapeHtml(err.message) + '</div>';
  }
}

function showNewTicketForm() {
  const form = document.getElementById('newTicketForm');
  if (form) form.style.display = 'block';
}

function hideNewTicketForm() {
  const form = document.getElementById('newTicketForm');
  if (form) form.style.display = 'none';
}

async function submitTicket() {
  const title = document.getElementById('ticketTitle')?.value?.trim();
  const description = document.getElementById('ticketDescription')?.value?.trim();
  const priority = document.getElementById('ticketPriority')?.value;
  const category = document.getElementById('ticketCategory')?.value;
  const errorEl = document.getElementById('ticketError');
  const successEl = document.getElementById('ticketSuccess');
  const btn = document.getElementById('submitTicketBtn');

  if (errorEl) errorEl.textContent = '';
  if (successEl) successEl.textContent = '';

  if (!title) { if (errorEl) errorEl.textContent = 'Title is required'; return; }

  if (btn) btn.disabled = true;
  try {
    const response = await fetch(apiUrl('/api/client-portal/tickets'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSessionToken()}` },
      body: JSON.stringify({ title, description, priority, category }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to submit');
    if (successEl) successEl.textContent = 'Request submitted! Ticket ID: ' + data.ticket.id;
    if (document.getElementById('ticketTitle')) document.getElementById('ticketTitle').value = '';
    if (document.getElementById('ticketDescription')) document.getElementById('ticketDescription').value = '';
    setTimeout(() => renderClientPortalView(), 2000);
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function showClientProjectDetail(projectId) {
  const container = document.getElementById('client-portalView');
  if (!container) return;

  try {
    const response = await fetch(apiUrl(`/api/client-portal/projects/${encodeURIComponent(projectId)}`));
    if (!response.ok) throw new Error('Failed to load project');
    const p = await response.json();

    const statusColors = {
      'new': '#3d74a8', 'in-progress': '#ff9500', 'in_progress': '#ff9500',
      'complete': '#34c759', 'completed': '#34c759', 'blocked': '#ff3b30',
    };
    const sColor = statusColors[String(p.status || '').toLowerCase()] || '#8e8e93';

    container.innerHTML = `
      <div style="max-width:800px;margin:0 auto;padding:8px 0;">
        <button onclick="renderClientPortalView()" style="background:none;border:0;color:var(--accent-blue,#3d74a8);font-size:13px;cursor:pointer;margin-bottom:16px;font-weight:500;">← Back to projects</button>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h2 style="font-size:20px;font-weight:700;margin:0;">${escapeHtml(p.name)}</h2>
          <span style="background:${sColor};color:#fff;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:600;text-transform:uppercase;">${escapeHtml(String(p.status || '').replace(/-|_/g, ' '))}</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px;">
          <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:22px;font-weight:700;color:${sColor};">${p.progress || 0}%</div>
            <div style="font-size:11px;color:var(--text-secondary);">Progress</div>
          </div>
          <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:22px;font-weight:700;">${(p.tasks || []).length}</div>
            <div style="font-size:11px;color:var(--text-secondary);">Tasks</div>
          </div>
          <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:14px;font-weight:600;margin-top:4px;">${p.dueDate ? new Date(p.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No date'}</div>
            <div style="font-size:11px;color:var(--text-secondary);">Due Date</div>
          </div>
        </div>

        <!-- Tasks -->
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;margin-bottom:20px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">Tasks</h3>
          ${(p.tasks || []).length === 0 ? '<p style="color:var(--text-secondary);font-size:13px;">No tasks yet</p>' : ''}
          ${(p.tasks || []).map(t => {
            const taskDone = t.status === 'complete' || t.status === 'completed';
            return `
              <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--glass-border);font-size:13px;">
                <span style="color:${taskDone ? '#34c759' : '#ff9500'};font-size:14px;">${taskDone ? '✓' : '○'}</span>
                <span style="${taskDone ? 'text-decoration:line-through;color:var(--text-secondary);' : ''}">${escapeHtml(t.title)}</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-secondary);">${escapeHtml(t.assignee || '')}</span>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Updates -->
        <div style="background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px;padding:16px;">
          <h3 style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-secondary);margin:0 0 12px;">Updates</h3>
          ${(p.updates || []).length === 0 ? '<p style="color:var(--text-secondary);font-size:13px;">No updates yet</p>' : ''}
          ${(p.updates || []).map(u => `
            <div style="padding:8px 0;border-bottom:1px solid var(--glass-border);">
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);margin-bottom:2px;">
                <span style="font-weight:600;">${escapeHtml(u.author || '')}</span>
                <span>${u.date ? new Date(u.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </div>
              <div style="font-size:13px;">${escapeHtml(u.text || '')}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#ff3b30;">Failed to load project</div>';
  }
}

// ─── Command Palette (Cmd+K / Ctrl+K) ──────────────────────────────────────

(function initCommandPalette() {
  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    .cmd-overlay { position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:none;align-items:flex-start;justify-content:center;padding-top:min(20vh,160px);backdrop-filter:blur(4px); }
    .cmd-overlay.open { display:flex; }
    .cmd-dialog { width:min(580px,90vw);background:var(--glass-bg,#fff);border:1px solid var(--glass-border,#ddd);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,0.25);overflow:hidden; }
    .cmd-input-wrap { padding:14px 16px;border-bottom:1px solid var(--glass-border,#eee); }
    .cmd-input { width:100%;border:0;outline:0;font-size:15px;background:transparent;color:var(--text-primary,#111);font-family:inherit; }
    .cmd-input::placeholder { color:var(--text-secondary,#888); }
    .cmd-results { max-height:320px;overflow-y:auto;padding:6px 0; }
    .cmd-item { display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer;font-size:13px;transition:background 0.1s; }
    .cmd-item:hover,.cmd-item.active { background:rgba(61,116,168,0.1); }
    .cmd-item-icon { width:20px;text-align:center;color:var(--text-secondary,#888);font-size:14px;flex-shrink:0; }
    .cmd-item-label { flex:1;font-weight:500; }
    .cmd-item-hint { font-size:11px;color:var(--text-secondary,#888); }
    .cmd-empty { padding:24px 16px;text-align:center;color:var(--text-secondary,#888);font-size:13px; }
    .cmd-footer { padding:6px 16px;border-top:1px solid var(--glass-border,#eee);font-size:10px;color:var(--text-secondary,#888);display:flex;gap:12px;justify-content:flex-end; }
    .cmd-footer kbd { background:rgba(0,0,0,0.06);padding:1px 5px;border-radius:3px;font-family:inherit; }
  `;
  document.head.appendChild(style);

  // Inject HTML
  const overlay = document.createElement('div');
  overlay.className = 'cmd-overlay';
  overlay.id = 'cmdPalette';
  overlay.innerHTML = `
    <div class="cmd-dialog">
      <div class="cmd-input-wrap">
        <input class="cmd-input" id="cmdInput" placeholder="Search projects, clients, navigate..." autocomplete="off" spellcheck="false" />
      </div>
      <div class="cmd-results" id="cmdResults"></div>
      <div class="cmd-footer"><kbd>esc</kbd> close &nbsp; <kbd>enter</kbd> select &nbsp; <kbd>↑↓</kbd> navigate</div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById('cmdInput');
  const results = document.getElementById('cmdResults');
  let activeIndex = -1;
  let filteredItems = [];

  function getCommandItems() {
    const items = [
      // Navigation
      { icon: '📋', label: 'Briefing', hint: 'Morning overview', action: () => switchView('briefing') },
      { icon: '📁', label: 'Projects', hint: 'Project list', action: () => switchView('projects') },
      { icon: '📅', label: 'Calendar', hint: 'Calendar view', action: () => switchView('calendar') },
      { icon: '🤖', label: 'Agents', hint: 'Agent workspace', action: () => switchView('agents') },
      { icon: '💬', label: 'Conversations', hint: 'Message threads', action: () => switchView('conversations') },
      { icon: '📥', label: 'Intake', hint: 'Peg approval queue', action: () => switchView('intake') },
      { icon: '💰', label: 'Finance', hint: 'Financial overview', action: () => switchView('finance') },
      { icon: '⚙️', label: 'Settings', hint: 'Workspace settings', action: () => switchView('settings') },
      // Actions
      { icon: '+', label: 'New Project', hint: 'Create a project', action: () => { closePalette(); document.querySelector('[onclick*="addProject"]')?.click(); } },
      { icon: '🔓', label: 'Logout', hint: 'Sign out', action: () => logoutSession() },
    ];

    // Add projects as searchable items
    if (Array.isArray(projects)) {
      projects.forEach(p => {
        items.push({
          icon: '→',
          label: p.name || p.id,
          hint: p.clientName ? p.clientName + ' — ' + (p.status || '') : (p.status || ''),
          action: () => { switchView('projects'); setTimeout(() => selectProject(p.id), 100); }
        });
      });
    }

    return items;
  }

  function renderResults() {
    const query = input.value.trim().toLowerCase();
    const allItems = getCommandItems();
    filteredItems = query
      ? allItems.filter(i => (i.label + ' ' + i.hint).toLowerCase().includes(query))
      : allItems.slice(0, 10); // Show nav items by default

    activeIndex = filteredItems.length > 0 ? 0 : -1;

    if (filteredItems.length === 0) {
      results.innerHTML = '<div class="cmd-empty">No results found</div>';
      return;
    }

    results.innerHTML = filteredItems.map((item, i) => `
      <div class="cmd-item${i === activeIndex ? ' active' : ''}" data-index="${i}">
        <span class="cmd-item-icon">${item.icon}</span>
        <span class="cmd-item-label">${escapeHtml(item.label)}</span>
        <span class="cmd-item-hint">${escapeHtml(item.hint)}</span>
      </div>
    `).join('');
  }

  function executeItem(index) {
    if (index >= 0 && index < filteredItems.length) {
      closePalette();
      filteredItems[index].action();
    }
  }

  function openPalette() {
    overlay.classList.add('open');
    input.value = '';
    renderResults();
    input.focus();
  }

  function closePalette() {
    overlay.classList.remove('open');
    input.value = '';
  }

  // Event listeners
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePalette();
    const item = e.target.closest('.cmd-item');
    if (item) executeItem(Number(item.dataset.index));
  });

  input.addEventListener('input', () => renderResults());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePalette(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filteredItems.length - 1);
      updateActiveItem();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActiveItem();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      executeItem(activeIndex);
      return;
    }
  });

  function updateActiveItem() {
    results.querySelectorAll('.cmd-item').forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
      if (i === activeIndex) el.scrollIntoView({ block: 'nearest' });
    });
  }

  // Global keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (overlay.classList.contains('open')) closePalette();
      else openPalette();
    }
  });

  // Expose for button usage
  window.openCommandPalette = openPalette;
})();
