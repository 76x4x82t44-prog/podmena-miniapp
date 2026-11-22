# Событийная схема пилота

Аналитика в поставке выключена. Проект PostHog для ПОДМЕНЫ и его настройки не подтверждены. Сайт не загружает клиент PostHog и не отправляет аналитику по этой схеме автоматически.

## Минимальный контракт

| Событие | Когда учитывать | Разрешённые поля |
| --- | --- | --- |
| `app_open` | Тестовая страница успешно отрисована | `mode` = `demo` / `telegram`, `release` |
| `navigation_view` | Участник переключил вкладку | `tab` = `home` / `search` / `shifts` / `chat` / `profile` |
| `catalog_query_complete` | Каталог вернул ответ | `outcome` = `ok` / `empty` / `error` |
| `connection_request_complete` | Получен ответ об отправке запроса | `outcome` = `ok` / `rate_limited` / `error` |
| `chat_send_complete` | Получен ответ об отправке сообщения | `outcome` = `ok` / `rate_limited` / `error` |
| `notification_setting_complete` | Получен ответ на изменение настройки | `outcome` = `ok` / `error` |
| `shift_completion_complete` | Получен ответ на подтверждение смены | `outcome` = `ok` / `error` |

Значения `tab`, `outcome`, `mode` берутся из перечислений перед отправкой. `release` — фиксированный номер сборки без содержимого адресной строки. На старте достаточно суммарных счётчиков по событиям. Не используйте `identify` и не создавайте постоянный идентификатор. Если проекту необходим технический идентификатор, он должен быть случайным только на один запуск, без сохранения между запусками и без связи с профилем.

Никогда не добавляйте в payload Telegram ID, внутренние ID пользователей, имена, контакты, координаты, адреса, тексты чатов и отзывов, причины споров, initData, session token, секреты, URL, заголовки запросов и сырые ошибки. Аналитический транспорт также может передавать метаданные соединения. До включения отдельно проверьте сетевой payload, IP и настройки проекта с владельцем и согласуйте уведомление участникам.

## Пример выключенной конфигурации

Этот JSON описывает настройки будущего адаптера. Он не является исполняемым вызовом SDK.

```json
{
  "enabled": false,
  "provider": "posthog",
  "projectKey": "",
  "ingestionHost": "",
  "capturePageview": false,
  "autocapture": false,
  "sessionRecording": false,
  "personProfiles": false,
  "persistence": "memory",
  "allowedEvents": [
    "app_open",
    "navigation_view",
    "catalog_query_complete",
    "connection_request_complete",
    "chat_send_complete",
    "notification_setting_complete",
    "shift_completion_complete"
  ]
}
```

Включение требует подтверждённого проекта, проверки SDK и приёмника, allowlist по каждому событию и проверки в панели Network. Выключенное состояние должно блокировать инициализацию SDK и все запросы аналитики.
