from playwright.sync_api import sync_playwright


BASE_URL = 'http://127.0.0.1:8788'
SECRET = 'local-auth-bootstrap-secret'
EMAIL = 'admin@example.com'
PASSWORD = 'correct horse battery staple'


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(BASE_URL)
    page.wait_for_load_state('networkidle')
    page.wait_for_selector('#awq-login-gate')

    bootstrap = page.request.post(BASE_URL + '/api/rpc', data={
        'method': 'authBootstrap',
        'args': [SECRET, EMAIL, PASSWORD],
    }, headers={'Origin': BASE_URL})
    assert bootstrap.status == 200, bootstrap.text()

    page.get_by_label('Email').fill(EMAIL)
    page.get_by_label('Password').fill(PASSWORD)
    page.get_by_role('button', name='Sign in').click()
    page.wait_for_selector('#awq-user-bar')
    assert page.locator('#awq-user-bar').inner_text().startswith('ADMIN')

    page.screenshot(path='test-results/auth-admin-logged-in.png', full_page=True)
    page.get_by_role('button', name='Logout').click()
    page.wait_for_selector('#awq-login-gate')
    page.screenshot(path='test-results/auth-logged-out.png', full_page=True)
    browser.close()

print('Browser auth smoke test passed: bootstrap, login, account bar, logout, and login gate.')
