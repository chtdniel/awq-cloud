(function () {
    let tokenClient = null;
    let setupError = '';
    let loading = true;
    const scope = 'https://www.googleapis.com/auth/drive.file';

    function reportMessage(message, type) {
        window.printReportTerminalLine(message, type);
    }

    window.updateGoogleReportButton = function () {
        const button = document.getElementById('btn-google-sheet');
        if (!button) return;
        const flights = window.getSelectedFlightObjects ? window.getSelectedFlightObjects() : [];
        button.disabled = loading || window.reportState.isBusy || flights.length === 0;
    };

    function finish() {
        window.reportState.isBusy = false;
        document.getElementById('btn-google-sheet').textContent = 'CREATE GOOGLE SHEET';
        window.reportState.lastHash = '';
        window.renderReportPreview();
    }

    async function uploadReport(accessToken, payload) {
        reportMessage('GOOGLE SHEETS: Generating report from selected NOTAM analysis...', 'info');
        const response = await fetch('/api/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'generateReportXlsx', args: [payload] })
        });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Report generation failed (HTTP ' + response.status + ').');
        }
        const workbook = await response.blob();
        const boundary = 'awq_' + crypto.randomUUID();
        const metadata = {
            name: 'Crew Briefing ' + payload.flights.join(' - ') + ' ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
            mimeType: 'application/vnd.google-apps.spreadsheet'
        };
        const body = new Blob([
            '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
            JSON.stringify(metadata),
            '\r\n--' + boundary + '\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
            workbook,
            '\r\n--' + boundary + '--\r\n'
        ], { type: 'multipart/related; boundary=' + boundary });
        reportMessage('GOOGLE SHEETS: Importing template report into your Google Drive...', 'info');
        const upload = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + accessToken },
            body
        });
        const result = await upload.json();
        if (!upload.ok) throw new Error(result.error && result.error.message || 'Google Drive upload failed.');
        if (!result.id || !/^[A-Za-z0-9_-]+$/.test(result.id)) throw new Error('Google Drive did not return a valid spreadsheet ID.');
        return 'https://docs.google.com/spreadsheets/d/' + result.id + '/edit';
    }

    window.createReportGoogleSheet = function () {
        if (window.reportState.isBusy || loading) return;
        if (!tokenClient) {
            reportMessage(setupError || 'Google Sheets is not ready. Reload the page and try again.', 'error');
            return;
        }
        const payload = window.getReportSheetPayload();
        if (payload.flights.length === 0) return;
        window.reportState.isBusy = true;
        ['btn-exec-cbr', 'btn-open-form', 'btn-download-sheet', 'btn-google-sheet'].forEach(function (id) {
            document.getElementById(id).disabled = true;
        });
        document.getElementById('btn-google-sheet').textContent = 'CONNECTING GOOGLE...';
        tokenClient.callback = async function (result) {
            if (result.error || !result.access_token || !google.accounts.oauth2.hasGrantedAllScopes(result, scope)) {
                finish();
                reportMessage('GOOGLE SHEETS: Google Drive permission was not granted. Please try again and allow access.', 'error');
                return;
            }
            const reportTab = window.open('about:blank', '_blank');
            if (reportTab) {
                reportTab.opener = null;
                reportTab.document.title = 'Preparing Crew Briefing Report';
                reportTab.document.body.textContent = 'Preparing your Crew Briefing Report in Google Sheets...';
            }
            try {
                const url = await uploadReport(result.access_token, payload);
                if (reportTab && !reportTab.closed) reportTab.location.replace(url);
                finish();
                const link = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">OPEN GOOGLE SHEET</a>';
                window.printReportTerminalLine('GOOGLE SHEETS: Report created. ' + link, 'success', { allowRawHtml: true });
            } catch (error) {
                if (reportTab && !reportTab.closed) reportTab.close();
                finish();
                reportMessage('GOOGLE SHEETS FAILED: ' + error.message, 'error');
            }
        };
        try {
            tokenClient.requestAccessToken({ prompt: '' });
        } catch (error) {
            finish();
            reportMessage('GOOGLE SHEETS: ' + error.message, 'error');
        }
    };

    async function initialize() {
        try {
            const response = await fetch('/api/google-sheets-config');
            if (!response.ok) throw new Error('Unable to load Google Sheets configuration. Reload the page to retry.');
            const config = await response.json();
            if (!config.clientId) throw new Error('Google Sheets belum dikonfigurasi. Atur GOOGLE_OAUTH_CLIENT_ID di Cloudflare Pages, lalu deploy ulang. Download XLSX tetap tersedia.');
            await new Promise(function (resolve, reject) {
                if (window.google && google.accounts && google.accounts.oauth2) return resolve();
                const script = document.createElement('script');
                script.src = 'https://accounts.google.com/gsi/client';
                script.async = true;
                script.onload = resolve;
                script.onerror = function () { reject(new Error('Google sign-in could not load. Check your connection and reload.')); };
                document.head.appendChild(script);
            });
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: config.clientId,
                scope,
                include_granted_scopes: false,
                callback: function () {},
                error_callback: function () {
                    finish();
                    reportMessage('GOOGLE SHEETS: Google sign-in was closed or blocked. Allow pop-ups and try again.', 'error');
                }
            });
        } catch (error) {
            setupError = error.message;
        } finally {
            loading = false;
            window.updateGoogleReportButton();
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
    else initialize();
})();
