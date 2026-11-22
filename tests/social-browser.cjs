const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, extname } = require('node:path');
const { chromium } = require('playwright');

const fixtureHost = 'https://miniapp.example.test';
const testDirectory = resolve(__dirname, '../telegram-test');
const catalogId = '10000000-0000-4000-8000-000000000001';
const threadId = '10000000-0000-4000-8000-000000000002';
const requestId = '10000000-0000-4000-8000-000000000003';
const malicious = '<img src=x onerror="window.injected=true">';
const messageId = '10000000-0000-4000-8000-000000000004';
const shiftId = '10000000-0000-4000-8000-000000000005';
const applicationId = '10000000-0000-4000-8000-000000000006';

async function run() {
  const browser = await chromium.launch({
    executablePath: process.env.PODMENA_CHROMIUM || undefined,
    args: ['--no-sandbox']
  });
  try {
    const context = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const authed = await context.newPage();
    let settings = { visible: false, description: '', notifications_enabled: false };
    let blocked = false;
    let accepted = false;
    let sent = 0;
    let attemptId;
    let sendFailed = false;
    let expired = false;
    const expiresAt = new Date(Date.now() + 180_000).toISOString();
    const observed = [];
    await authed.route('https://telegram.org/**', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.Telegram={WebApp:{initData:"fixture",ready(){},expand(){}}};'
    }));
    await authed.route(fixtureHost + '/telegram-test/**', route => {
      const path = new URL(route.request().url()).pathname.split('/').at(-1) || 'index.html';
      const file = resolve(testDirectory, path);
      const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
      if (!existsSync(file)) return route.fulfill({status:404});
      return route.fulfill({contentType: types[extname(file)] || 'text/plain', body: readFileSync(file)});
    });
    await authed.route('https://*.supabase.co/functions/v1/**', route => {
      const request = route.request();
      const endpoint = new URL(request.url()).pathname.split('/').at(-1);
      const payload = request.postDataJSON() || {};
      const respond = (json, status = 200) => route.fulfill({ json, status });
      if (endpoint === 'telegram-auth-') {
        return respond({ userId: catalogId, sessionToken: 'a'.repeat(64), expiresAt });
      }
      if (request.headers().authorization !== 'Bearer ' + 'a'.repeat(64)) return respond({}, 401);
      if (endpoint === 'telegram-profiles') return respond({ worker: null, manager: null, contacts: null });
      if (endpoint === 'telegram-shifts') return respond({ items: payload.action === 'outgoing' ? [{
        id: shiftId, application_id: applicationId, application_status: 'pending', status: 'open',
        starts_at: '2027-01-01T10:00:00Z', ends_at: '2027-01-01T14:00:00Z', time_zone: 'Europe/Moscow',
        platform: 'ozon', city: 'Санкт-Петербург', pickup_point: 'Очень длинный адрес для проверки ширины экрана',
        pay_rubles: 3200
      }] : [] });
      assert.equal(endpoint, 'telegram-social');
      observed.push(payload);
      const { input } = payload;
      switch (payload.action) {
        case 'settings': return respond(settings);
        case 'save_settings': settings = { ...settings, ...input }; return respond(settings);
        case 'catalog': return respond({
          items: [{ catalog_id: catalogId, name: 'Тестовый сотрудник', description: malicious, city: 'Санкт-Петербург',
            district: 'Центральный', platforms: ['ozon'], experience: 'Без опыта', work_types: ['single'],
            completed_count: 2, average: 4.5, review_count: 2 }],
          has_more: false
        });
        case 'request_contact': return respond({ saved: input.catalog_id === catalogId });
        case 'connections': return respond({
          items: [{ request_id: requestId, name: 'Руководитель', direction: 'incoming', status: accepted ? 'accepted' : 'pending', thread_id: accepted ? threadId : null }],
          has_more: false
        });
        case 'decide_contact':
          assert.deepEqual(input, { request_id: requestId, decision: 'accept' });
          accepted = true;
          return respond({ saved: true, thread_id: threadId });
        case 'shift_thread':
          assert.deepEqual(input, { shift_id: shiftId, application_id: applicationId });
          return respond({ thread_id: threadId });
        case 'threads':
          return respond({ items: accepted ? [{ thread_id: threadId, name: 'Руководитель', unread_count: 1, blocked, blocked_by_me: blocked }] : [], has_more: false });
        case 'messages': return expired ? respond({ error: 'session_expired' }, 401)
          : respond({ items: [{ message_id: messageId, mine: false, body: malicious, created_at: '2026-09-01T10:00:00Z' }], blocked, blocked_by_me: blocked, has_more: false });
        case 'mark_read': return respond({ saved: true });
        case 'send_message':
          sent += 1;
          if (!sendFailed) {
            sendFailed = true;
            attemptId = input.request_id;
            return respond({ error: 'service_unavailable' }, 503);
          }
          assert.equal(input.request_id, attemptId);
          return respond({ saved: true, message_id: messageId });
        case 'block': blocked = true; return respond({ saved: true });
        case 'unblock': blocked = false; return respond({ saved: true });
        case 'report':
          assert.deepEqual(input, { thread_id: threadId, reason: 'Тестовая жалоба' });
          return respond({ saved: true });
        default: return respond({ error: 'invalid_request' }, 400);
      }
    });
    await authed.goto(fixtureHost + '/telegram-test/');
    await authed.locator('#telegramStatus').filter({ hasText: 'Вход через Telegram подтверждён' }).waitFor();
    await authed.getByRole('button', { name: /Ищу замену/ }).click();
    await authed.getByRole('button', { name: /Поиск/ }).click();
    await authed.getByText('Тестовый сотрудник', { exact: true }).waitFor();
    const filters = authed.locator('#pilotCatalogFilters');
    await filters.getByLabel('Город', { exact: true }).fill('Санкт');
    await filters.getByLabel('Район', { exact: true }).fill('Центральный');
    await filters.getByLabel('Площадка', { exact: true }).selectOption('ozon');
    await filters.getByLabel('Опыт на ПВЗ', { exact: true }).selectOption('Без опыта');
    await filters.getByLabel('Формат', { exact: true }).selectOption('single');
    await authed.getByRole('button', { name: 'Найти сотрудников' }).click();
    await authed.getByText('Тестовый сотрудник', { exact: true }).waitFor();
    assert.deepEqual(observed.filter(row => row.action === 'catalog').at(-1).input, {
      city: 'Санкт', district: 'Центральный', platform: 'ozon', experience: 'Без опыта', work_type: 'single', page: 0
    });
    assert.equal(await authed.getByText(malicious, { exact: true }).count(), 1);
    assert.equal(await authed.evaluate(() => window.injected), undefined);
    await authed.getByRole('button', { name: 'Запросить связь' }).click();
    await authed.getByRole('button', { name: 'Запрос отправлен' }).waitFor();

    await authed.getByRole('button', { name: /Профиль/ }).first().click();
    await authed.getByRole('button', { name: 'Сохранить настройки' }).waitFor();
    assert.equal(await authed.getByLabel('Показывать мою анкету в каталоге').isChecked(), false);
    await authed.getByLabel('Показывать мою анкету в каталоге').check();
    await authed.getByLabel('Уведомлять меня в Telegram').check();
    await authed.getByRole('button', { name: 'Сохранить настройки' }).click();
    await authed.getByText('Настройки сохранены.', { exact: true }).waitFor();
    assert.equal(settings.visible, true);
    assert.equal(settings.notifications_enabled, true);
    await authed.getByLabel('Уведомлять меня в Telegram').uncheck();
    await authed.getByRole('button', { name: 'Сохранить настройки' }).click();
    await authed.getByText('Настройки сохранены.', { exact: true }).waitFor();
    assert.deepEqual(observed.filter(row => row.action === 'save_settings').at(-1).input, { notifications_enabled: false });

    await authed.getByRole('button', { name: /Чаты/ }).click();
    await authed.getByRole('button', { name: 'Принять запрос' }).click();
    await authed.locator('#pilotChatHistory').getByText(malicious, { exact: true }).waitFor();
    assert.equal(await authed.evaluate(() => window.injected), undefined);
    const composer = authed.getByLabel('Сообщение', { exact: true });
    await composer.fill('Текст повторной отправки');
    await authed.getByRole('button', { name: 'Отправить' }).click();
    await authed.getByText('Сервис временно недоступен. Попробуйте ещё раз.', { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), 'Текст повторной отправки');
    await authed.getByRole('button', { name: 'Отправить' }).click();
    await authed.getByText('Сообщение отправлено.', { exact: true }).waitFor();
    assert.equal(sent, 2);
    await authed.getByRole('button', { name: 'Заблокировать' }).click();
    await authed.getByRole('button', { name: 'Разблокировать' }).waitFor();
    assert.equal(await composer.isDisabled(), true);
    await authed.getByRole('button', { name: 'Разблокировать' }).click();
    await authed.getByRole('button', { name: 'Заблокировать' }).waitFor();
    assert.equal(await composer.isEnabled(), true);
    assert.ok(observed.some(row => row.action === 'mark_read'));
    await authed.getByRole('button', { name: 'Пожаловаться', exact: true }).click();
    await authed.getByLabel('Причина жалобы').fill('Тестовая жалоба');
    await authed.getByRole('button', { name: 'Отправить жалобу' }).click();
    await authed.getByText('Жалоба отправлена.', { exact: true }).waitFor();
    await authed.getByRole('button', { name: /Смены/ }).click();
    await authed.getByRole('button', { name: 'Написать по смене', exact: true }).click();
    await authed.locator('#pilotChatHistory').getByText(malicious, { exact: true }).waitFor();
    assert.ok(await authed.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    expired = true;
    await authed.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await authed.locator('#telegramStatus').filter({ hasText: 'Сессия больше недействительна' }).waitFor();
    assert.equal(await authed.locator('#pilotChatHistory').getByText(malicious, { exact: true }).count(), 0);
    assert.equal(await authed.locator('#pilotConversation').isVisible(), false);
    console.log('Проверка браузера: каталог, настройки, связь, чат, XSS, блокировка и повтор отправки пройдены.');
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
