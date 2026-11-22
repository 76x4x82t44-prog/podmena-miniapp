# Установка и откат пилота «ПОДМЕНЫ»

Выполняйте эти шаги только после проверки ветки `feature/podmena-pilot-mvp`. Цель установки — существующий **PODMENA-TEST**, проект `regmhcxtnrsmauwlrffr`. Страница сайта публикуется из папки `telegram-test/`. Действующий бот — `@podmenaspb1_bot`.

## 1. Подготовьте возврат

1. Сохраните текущий коммит, из которого опубликован GitHub Pages, и версии трёх существующих Edge Functions. В репозитории исходной точкой был `90c24cf`.
2. Проверьте доступность резервного копирования или сделайте защищённую резервную копию средствами владельца. Не добавляйте дамп в ZIP или GitHub.
3. В **Supabase → SQL Editor** проверьте наличие `podmena.shift_dispute_events` и текущие права `podmena_shift_action`. Этот проект должен быть на этапе 3Ж до применения пилотных миграций.

   ```sql
   select to_regclass('podmena.shift_dispute_events') as dispute_table,
     has_function_privilege('anon', 'public.podmena_shift_action(text,text,jsonb)', 'execute') as anon_rpc,
     has_function_privilege('authenticated', 'public.podmena_shift_action(text,text,jsonb)', 'execute') as user_rpc,
     has_function_privilege('service_role', 'public.podmena_shift_action(text,text,jsonb)', 'execute') as server_rpc;
   ```

   Ожидается существующая таблица и значения `false`, `false`, `true`.

## 2. Примените миграции пилота

В SQL Editor выполните целиком каждый из следующих файлов отдельным запуском через **New query → Run**, по порядку:

1. `supabase/migrations/20261122095100_pilot_notifications.sql`
2. `supabase/migrations/20261122095200_pilot_social.sql`
3. `supabase/migrations/20261122095300_pilot_security.sql`

Старые файлы из архива нужны для локального воспроизведения исходной схемы. На проекте, где уже установлен 3Ж, начните с первого файла из списка выше. Оператору SQL Editor обработку ошибок нужно завершить до перехода к следующему файлу. При повторной установке сначала проверьте наличие таблиц и RPC. Уже успешно применённые файлы повторно выполнять не нужно.

После установки повторите проверку прав из шага 1. Анонимные или аутентифицированные роли Supabase не должны получать `EXECUTE` на новые служебные RPC. Права доступа к приватной схеме не расширяйте.

## 3. Настройте Edge Functions

1. Откройте **Edge Functions → Secrets**. Существующие `TELEGRAM_BOT_TOKEN` и `PODMENA_ALLOWED_ORIGIN` сохраните. Последний должен содержать origin сайта без пути, `https://76x4x82t44-prog.github.io`. `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` предоставляет Supabase.
2. Перед проверкой уведомлений добавьте `PODMENA_MINI_APP_URL` и `PODMENA_NOTIFICATION_WORKER_SECRET`. URL указывает на тестовую Mini App. Для воркера используйте независимо сгенерированное случайное значение длиной не менее 32 символов. Храните его в менеджере секретов. Не вставляйте значение в HTML, документацию или SQL, который попадёт в GitHub.
3. Обновите существующую **telegram-shifts → Code → index.ts → Deploy updates**. Используйте `supabase/functions/telegram-shifts/index.ts`. Сохраните прежний slug и конфигурацию. Исходники **telegram-auth-** и **telegram-profiles** приложены для воспроизведения и проверки. Развёртывать их заново для пилота не требуется.
4. Для **telegram-social** и **telegram-notifications** используйте **Edge Functions → Deploy a new function → Via Editor**. Имена должны точно совпасть. В каждую вставьте её собственный `index.ts` из архива. Для новых функций в **Details → Function configuration** выключите **Verify JWT with legacy secret** и нажмите **Save changes**. Это позволяет использовать существующий Telegram Bearer в социальной функции и отдельный секрет воркера. Обе функции проверяют свой секрет или сессию самостоятельно.
5. Через **Test** отправьте в `telegram-social` POST с заголовком `Content-Type: application/json` и телом `{"action":"settings","input":{}}`, без Telegram Bearer. Ожидается HTTP 401. Запуск воркера без правильного служебного заголовка также должен дать 401. Эта проверка ничего не отправляет в Telegram.

## 4. Опубликуйте страницу после независимой проверки

1. Проверьте Draft PR и результаты CI. Развёртывание из CI отсутствует.
2. По отдельному решению владельца опубликуйте подготовленную версию GitHub Pages. При ручной загрузке положите **все** файлы из `telegram-test/` в текущую одноимённую папку. Корневой `index.html` оставьте как есть.
3. Убедитесь, что @podmenaspb1_bot открывает прежний URL с `/telegram-test/`. Полностью закройте и откройте Mini App на iPhone и Android. Пройдите [приёмку владельца](USER_ACCEPTANCE_TEST_RU.md).

## 5. Включите доставку только по отдельному разрешению

1. До разрешения воркер и расписание оставьте выключенными. Для первого прогона с настоящим Bot API оба тестовых аккаунта должны начать диалог с ботом. Включите уведомления в Mini App только на согласованных тестовых аккаунтах.
2. В **Supabase → Integrations** включите **Cron** (`pg_cron`), **pg_net** и **Vault**, если они ещё выключены. В Vault сохраните полный HTTPS URL функции `telegram-notifications` под именем `podmena_notifications_url`. Продублируйте значение worker-секрета под именем `podmena_notification_worker_secret`. Заполняйте значения в защищённом интерфейсе.
3. В SQL Editor запустите следующий SQL. Этот запуск создаёт расписание с выполнением раз в минуту. Сам SQL содержит имена секретов.

   ```sql
   select cron.schedule(
     'podmena-pilot-notifications',
     '* * * * *',
     $job$
       select net.http_post(
         url := (select decrypted_secret from vault.decrypted_secrets where name='podmena_notifications_url'),
         headers := jsonb_build_object('Content-Type','application/json','x-podmena-worker-secret',
           (select decrypted_secret from vault.decrypted_secrets where name='podmena_notification_worker_secret')),
         body := '{}'::jsonb,
         timeout_milliseconds := 90000
       );
     $job$
   );
   ```

4. Для мониторинга смотрите **Edge Functions → telegram-notifications → Logs** и сводку в SQL Editor:

   ```sql
   select public.podmena_notification_counts();
   ```

   `unavailable` означает, что Telegram отклонил доставку, например бот заблокирован или чат не начат. `uncertain` означает, что результат отправки неизвестен. Такие записи автоматически не переотправляются. `pending` ждёт обработки или паузы после ошибки. Если число `pending` растёт без доставок, проверьте cron и конфигурацию. При отсутствии сети изменения в Mini App продолжают сохраняться независимо от очереди.

## 6. Откат с сохранением данных

1. В **Cron** выключите расписание `podmena-pilot-notifications` или выполните `select cron.unschedule('podmena-pilot-notifications');`. Если остановка срочная, одновременно поменяйте секрет воркера в Edge Functions и оставьте старое расписание выключенным. Уже начатую доставку это не отзовёт.
2. Откатите публикацию тестовой страницы одним проверенным коммитом или верните файлы папки `telegram-test` из прежнего коммита. Основной `index.html` не участвует в откате.
3. Функции входа и профилей остаются на прежних версиях. Базу автоматически не откатывайте. Сохраните новые таблицы с чатами, настройками, жалобами и очередью. Права на публичные RPC следует оставить закрытыми. Для остановки новых серверных операций можно временно отключить `telegram-social` через отзыв права `service_role` на её RPC, которое потребуется вернуть при повторном включении.
4. Если требуется откат всего интерфейса споров и связанной Edge Function, сначала проверьте зависимость от защищённого RPC этапа C. Старый клиент может не передавать идентификатор предложения. Для полного возврата используйте сохранённую версию `telegram-shifts` v4 и файлы тестовой страницы из прежнего коммита. Только по отдельному решению владельца примените `supabase/rollback/pilot_compatibility.sql`. Его RPC обращается к сохранённой функции 3Ж и оставляет все таблицы и записи. Эта процедура временно возвращает известный риск повторного ответа и принятия устаревшего предложения. Чтобы снова включить защиту, выполните `20261122095300_pilot_security.sql` и верните новую функцию и интерфейс.
5. После возврата проверьте вход, профили, существующую смену и её историю. Не очищайте очередь, диалоги, отзывы или споры ради отката.

- [Supabase — расписание Edge Functions и Vault](https://supabase.com/docs/guides/functions/schedule-functions)
- [Telegram Bot API — отправка сообщений](https://core.telegram.org/bots/api#sendmessage)
