# Crew Briefing reports in Google Sheets

The Report page uses the selected flights and NOTAM analysis to populate `public/briefing-template.xlsx`, which matches `archive/Crew Briefing Report Form.xlsx`. Download XLSX and Create Google Sheet share the same report generator. Google Sheets imports this workbook as a native spreadsheet in the operator's own Google Drive and the app opens its edit URL. If the browser blocks the new tab, the report terminal also provides an Open Google Sheet link.

## One-time configuration

1. In Google Cloud Console, enable the Google Drive API and configure the OAuth consent screen.
2. Create an OAuth client of type **Web application**. Add the exact deployed application origin to **Authorized JavaScript origins**. For local development add `http://localhost:8788`. No redirect URI or client secret is needed for this browser token flow.
3. In Cloudflare Pages, set `GOOGLE_OAUTH_CLIENT_ID` to the public client ID ending in `.apps.googleusercontent.com` for the appropriate environment, then redeploy. For local development, set it in an untracked `.dev.vars` file.
4. If the OAuth application is in Testing mode, add the operator's Google account as a test user. Workspace administrators may also need to allow the application.
5. Select flights, review/select NOTAMs in the analysis page, then click **Create Google Sheet** in Report. Grant the requested Drive permission. Each click creates a new report.

The browser requests only `https://www.googleapis.com/auth/drive.file`. Tokens are used for the current upload and are never saved in localStorage or sent to the application backend. XLSX download works without Google configuration. Missing configuration, denied permission, blocked sign-in, and failed generation/upload are shown in the report terminal. A successful local test with a mocked Google endpoint does not verify actual consent, Workspace policy, or Google's rendering of the converted workbook; verify those with the configured account before operational use.

References: [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [Drive spreadsheet import](https://developers.google.com/workspace/drive/api/guides/manage-uploads#import_to_google_docs_types).
