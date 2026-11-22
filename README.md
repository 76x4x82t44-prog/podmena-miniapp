# «ПОДМЕНА». Пилот Telegram Mini App

«ПОДМЕНА» помогает сотрудникам и руководителям ПВЗ договариваться о сменах. Тестовый интерфейс находится в `telegram-test/`. Корневой `index.html` обслуживает прежнюю демонстрационную версию.

## Проверить локально

Нужны Node.js 24 и npm. Тесты используют временную PostgreSQL через PGlite и подменяют Telegram и HTTP API.

```bash
npm ci --prefix tests
npx --prefix tests playwright install chromium
npm test --prefix tests
```

На Linux, где не установлены библиотеки браузера, используйте `npx --prefix tests playwright install --with-deps chromium`. Для просмотра деморежима откройте папку через статический HTTP-сервер, затем перейдите на `/telegram-test/`.

## Подготовить пилот

- [Результат и архитектура](docs/IMPLEMENTATION_SUMMARY_RU.md)
- [Тесты и ограничения проверки](docs/TEST_REPORT.md)
- [Установка, мониторинг и откат](docs/DEPLOY_RUNBOOK_RU.md)
- [Имена секретов](docs/REQUIRED_SECRETS.md)
- [Проверка безопасности](docs/SECURITY_REVIEW.md)
- [Чеклист владельца](docs/USER_ACCEPTANCE_TEST_RU.md)
- [Дизайн-токены](docs/DESIGN_TOKENS_RU.md)
- [Схема аналитики](docs/ANALYTICS_SCHEMA_RU.md)
