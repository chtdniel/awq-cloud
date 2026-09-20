# Crew Briefing reports in Google Sheets

Site layout: `/` is the public landing page (`public/index.html`, hand-written), the workspace itself is served at `/app` (built into `public/app/index.html` by `build.js`), and `/privacy` + `/terms` are the legal pages registered in the OAuth consent screen.

The Report page uses the selected flights and NOTAM analysis to populate `public/briefing-template.xlsx`, which matches `archive/Crew Briefing Report Form.xlsx`. Download XLSX and Create Google Sheet share the same report generator. Google Sheets imports this workbook as a native spreadsheet in the operator's own Google Drive and the app opens its edit URL. If the browser blocks the new tab, the report terminal also provides an Open Google Sheet link.

## One-time configuration

1. In Google Cloud Console, enable the Google Drive API and configure the OAuth consent screen.
2. Create an OAuth client of type **Web application**. Add the exact deployed application origin to **Authorized JavaScript origins**. For local development add `http://localhost:8788`. No redirect URI or client secret is needed for this browser token flow.
3. In Cloudflare Pages, set `GOOGLE_OAUTH_CLIENT_ID` to the public client ID ending in `.apps.googleusercontent.com` for the appropriate environment, then redeploy. For local development, set it in an untracked `.dev.vars` file.
4. Publish the OAuth consent screen to production. The app requests only the non-sensitive `drive.file` scope, so no verification review is required and any Google account can authorize it. See **Publishing the OAuth app** below. While the app is still in Testing, only accounts on the test-user list can authorize it.
5. Select flights, review/select NOTAMs in the analysis page, then click **Create Google Sheet** in Report. Grant the requested Drive permission. Each click creates a new report.

The browser requests only `https://www.googleapis.com/auth/drive.file`. Tokens are used for the current upload and are never saved in localStorage or sent to the application backend. XLSX download works without Google configuration. Missing configuration, denied permission, blocked sign-in, and failed generation/upload are shown in the report terminal. A successful local test with a mocked Google endpoint does not verify actual consent, Workspace policy, or Google's rendering of the converted workbook; verify those with the configured account before operational use.

## Publishing the OAuth app

The app requests exactly one Google scope, `https://www.googleapis.com/auth/drive.file`, which Google classifies as **non-sensitive**. That classification decides everything below, so verify it in the console rather than assuming it:

- Apps that request **only non-sensitive scopes are not required** to complete OAuth app verification ([verification help center](https://support.google.com/cloud/answer/9110914)).
- An **External** app whose publishing status is **In production** is available to *any user with a Google Account* ([Manage App Audience](https://support.google.com/cloud/answer/15549945)). Every registered operator can therefore create reports with their own Google account, with no per-user registration anywhere.
- The "unverified app" screen and the OAuth user cap apply only to *unapproved sensitive or restricted* scopes, so neither applies here.
- Status **Testing** is limited to at most 100 test users, shows a warning screen, and expires test-user authorizations after seven days. It is not an operational configuration.

Steps, in this order:

1. **Data Access** → *Add or remove scopes* → add `https://www.googleapis.com/auth/drive.file` → Update → Save. It must appear under **Your non-sensitive scopes**; that table is the console's own classification of the scope. (An empty Data Access page means nothing has been declared yet, and the declared list is the ceiling of what the app may request.)
2. **Branding** → fill the app domain: home page (`https://awq.christiandaniel.my.id/`), privacy policy (`https://awq.christiandaniel.my.id/privacy`) and terms of service (`https://awq.christiandaniel.my.id/terms`). All three must use the host that actually serves the site — the apex `christiandaniel.my.id` does not resolve, so pointing the home page there leaves Google unable to read it. These links are required for external production apps.
3. **Audience** → **Publish app** (Testing → In production).
4. Verify with at least two different accounts, one of them a consumer `@gmail.com`, in a private window.

Brand verification is **optional** and separate from scope verification: without it the consent screen shows only the application domain, not the app name — which is why Google's error pages name the domain instead of "AWQ Cloud Briefing". It is not required for the scope to work.

Current configuration: consent-screen project **AWQ Cloud Briefing**, project number **446216387962** (the prefix of `GOOGLE_OAUTH_CLIENT_ID`), scope `drive.file` only.

## Troubleshooting: Error 403 access_denied

Symptom — an operator sees:

```
Access blocked: christiandaniel.my.id has not completed the Google verification process
... The app is currently being tested, and can only be accessed by developer-approved testers.
Error 403: access_denied
```

This refusal happens **before the application is involved**: the browser requests the token directly from Google, so the consent screen rejects the account and no report code runs. In the app it surfaces as the generic terminal message "Google Drive permission was not granted", because the Google Identity Services callback reports `access_denied` both for a blocked account and for a cancelled prompt.

Work through this list in order:

1. **Wrong project.** Only the consent screen of the project that owns the client ID matters, and the client ID prefix *is* the project number: `446216387962-...` → project **446216387962**. Test users added to any other project have no effect.
2. **Client ID differs per environment.** Cloudflare Pages environment variables override `wrangler.toml`. Compare `https://<host>/api/google-sheets-config` with the client ID of the project you edited.
3. **The account was only added to this app's own user list.** Roles in D1 `auth_users` govern access to *this* application; they never grant Google OAuth consent. Only the Google Cloud test-user list, or a published app, does.
4. **Change not saved, or a typo.** The address must be listed in the Test users table after saving.
5. **Wrong Google session.** `initTokenClient` runs with `prompt: ''`, which reuses the browser's default Google session, so with several accounts signed in the wrong one can be used. Sign out of all accounts, or use a private window.
6. **User type `Internal`.** Internal apps only accept accounts inside the owning Workspace/Cloud Identity organisation; everyone else gets `org_internal`. A personal `@gmail.com` account can never be added.
7. **Corporate admin policy.** A Workspace account can be blocked by its own administrator ("This app is blocked"). The admin must trust or allow the app; an unverified app cannot be used by that organisation until then.

Fix in practice: publish the app to production (previous section). Adding users to `auth_users` is never the fix.

References: [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [Drive spreadsheet import](https://developers.google.com/workspace/drive/api/guides/manage-uploads#import_to_google_docs_types), [Drive scope sensitivity](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Manage App Audience](https://support.google.com/cloud/answer/15549945), [OAuth App Verification Help Center](https://support.google.com/cloud/answer/9110914), [When verification is not needed](https://support.google.com/cloud/answer/13464323).
