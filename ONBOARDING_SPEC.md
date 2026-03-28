# Onboarding Flow — One-Click Setup Spec

## Goal
Make signup and integration setup so easy a non-technical user can go from zero to fully connected in under 2 minutes.

---

## Flow Overview

```
┌─────────────────────────────────────────────────┐
│  SIGNUP PAGE  (/signup)                         │
│                                                 │
│  ┌─────────────────────────────────────┐        │
│  │  🔵 Continue with Google            │        │
│  └─────────────────────────────────────┘        │
│  ┌─────────────────────────────────────┐        │
│  │  🔵 Continue with LinkedIn          │        │
│  └─────────────────────────────────────┘        │
│                                                 │
│  ───────── or ─────────                         │
│                                                 │
│  [ Organization ] [ Name ] [ Email ]            │
│  [ Password ]     [ Plan ]                      │
│  [ Create workspace ]                           │
└─────────────────────────────────────────────────┘
        │
        ▼ (auto-login, redirect to setup wizard)
┌─────────────────────────────────────────────────┐
│  SETUP WIZARD  (/?agency=xxx&view=setup)        │
│                                                 │
│  Step 1 of 4                                    │
│  ████████░░░░░░░░  25%                          │
│                                                 │
│  ┌─ STEP 1: Connect Slack ──────────────┐       │
│  │  One click to connect your workspace │       │
│  │  [ Connect Slack ]                   │       │
│  │  [ Skip for now ]                    │       │
│  └──────────────────────────────────────┘       │
│                                                 │
│  ┌─ STEP 2: Connect Gmail ──────────────┐       │
│  │  Import emails as tasks              │       │
│  │  [ Connect Gmail ]                   │       │
│  │  [ Skip for now ]                    │       │
│  └──────────────────────────────────────┘       │
│                                                 │
│  ┌─ STEP 3: Connect Calendar ───────────┐       │
│  │  Sync due dates & meetings           │       │
│  │  [ Connect Calendar ]                │       │
│  │  [ Skip for now ]                    │       │
│  └──────────────────────────────────────┘       │
│                                                 │
│  ┌─ STEP 4: Invite Team ───────────────┐        │
│  │  Add team members by email           │       │
│  │  [ email input ] [ Invite ]          │       │
│  │  [ Skip for now ]                    │       │
│  └──────────────────────────────────────┘       │
│                                                 │
│  [ Go to Dashboard → ]                          │
└─────────────────────────────────────────────────┘
```

---

## Part 1: Social Sign-In

### Google Sign-In
- Uses existing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- New redirect URI: `https://app.digital1010.tech/api/auth/google/callback`
- Scopes: `openid email profile`
- Server endpoint: `GET /api/auth/google` → redirects to Google consent
- Callback: `GET /api/auth/google/callback` → exchanges code, creates user/org, returns session
- If email matches existing user → log them in (no duplicate account)
- If new email → auto-create org from Google profile name, create user with `authProvider: 'google'`

### LinkedIn Sign-In
- Requires LinkedIn OAuth 2.0 app (Sign In with LinkedIn using OpenID Connect)
- New env vars: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`
- Redirect URI: `https://app.digital1010.tech/api/auth/linkedin/callback`
- Scopes: `openid profile email`
- Same logic: existing email → login, new email → create org + user

### UI Changes to signup.html
- Add social buttons above the form
- "or" divider between social and manual
- Social buttons styled as full-width, branded

---

## Part 2: Post-Signup Setup Wizard

### Data Model
Add `onboardingStatus` to agency data:
```json
{
  "onboardingStatus": {
    "completed": false,
    "completedAt": null,
    "steps": {
      "slack": "pending",       // pending | connected | skipped
      "gmail": "pending",
      "calendar": "pending",
      "team": "pending"
    },
    "skippedAt": null
  }
}
```

### Wizard Behavior
1. After signup (social or manual), redirect includes `&view=setup`
2. `app.js` detects `view=setup` and renders the setup wizard overlay
3. Each step has a "Connect" button that triggers the existing `toggleIntegration()` flow
4. After OAuth callback returns with `?oauth=success`, wizard auto-advances to next step
5. "Skip for now" marks step as skipped, advances
6. "Go to Dashboard" at bottom saves onboarding status and dismisses wizard
7. If user hasn't completed setup, show a subtle banner on dashboard: "Finish setup (2 of 4 done)"

### Server Endpoints
- `GET /api/onboarding/status` — returns current onboarding state
- `POST /api/onboarding/step` — `{ step: 'slack', action: 'skip' | 'complete' }`
- `POST /api/onboarding/complete` — marks onboarding as done

### Return-from-OAuth Handling
The existing `handleOAuthReturnFromUrl()` already handles `?oauth=success`.
We just need to:
1. Check if wizard is active
2. If so, mark that integration step as "connected"
3. Re-render wizard with updated state

---

## Part 3: Implementation Order

1. **Google Sign-In** — fastest, credentials already exist
2. **Setup Wizard UI** — post-signup guided flow
3. **LinkedIn Sign-In** — needs new OAuth app creation
4. **Completion banner** — gentle nudge for incomplete setup

---

## Security Notes
- Social sign-in creates session tokens identical to manual login
- No password stored for social auth users (authProvider field distinguishes)
- OAuth state tokens use same CSRF-safe mechanism as integration OAuth
- Rate limiting applies to social auth callback endpoints
