begin;

do $$
declare
  owner_id uuid := gen_random_uuid();
  worker_id uuid := gen_random_uuid();
  outsider_id uuid := gen_random_uuid();
  other_worker_id uuid := gen_random_uuid();
  owner_token text := repeat('a',64);
  worker_token text := repeat('b',64);
  outsider_token text := repeat('c',64);
  expired_token text := repeat('d',64);
  catalog_id uuid;
  contact_id uuid;
  chat_id uuid;
  shift_chat_id uuid;
  message_id uuid;
  shift_id uuid;
  app_id uuid;
  key_id uuid := gen_random_uuid();
  res jsonb;
begin
  insert into podmena.telegram_users(id,telegram_id) values
    (owner_id,91111001),(worker_id,91111002),(outsider_id,91111003),(other_worker_id,91111004);
  insert into podmena.telegram_sessions(user_id,token_hash,telegram_hash,expires_at) values
    (owner_id,decode(owner_token,'hex'),decode(repeat('e',64),'hex'),now()+interval '10 minutes'),
    (worker_id,decode(worker_token,'hex'),decode(repeat('f',64),'hex'),now()+interval '10 minutes'),
    (outsider_id,decode(outsider_token,'hex'),decode(repeat('0',64),'hex'),now()+interval '10 minutes'),
    (other_worker_id,decode(expired_token,'hex'),decode(repeat('1',64),'hex'),now()-interval '1 second');
  insert into podmena.manager_profiles(user_id,name,city,pickup_point,platform,district) values
    (owner_id,'Проверка Р','СПб','ПВЗ тест','ozon','Центральный'),
    (outsider_id,'Проверка Ч','СПб','ПВЗ тест 2','ozon','Центральный');
  insert into podmena.worker_profiles(user_id,name,city,district,platforms,experience,accepts_single_shifts,about) values
    (worker_id,'Проверка С @test_private','СПб','Центральный',array['ozon']::podmena.platform[],'Год',true,'Не для каталога'),
    (other_worker_id,'Проверка Д','СПб','Центральный',array['ozon']::podmena.platform[],'Год',true,'Закрыто');
  insert into podmena.private_contacts(user_id,worker_phone) values(worker_id,'synthetic-secret');

  if has_function_privilege('anon','public.podmena_social_action(text,text,jsonb)','execute')
    or has_function_privilege('authenticated','public.podmena_social_action(text,text,jsonb)','execute')
    or not has_function_privilege('service_role','public.podmena_social_action(text,text,jsonb)','execute')
    or has_table_privilege('service_role','podmena.chat_messages','select') then
    raise exception 'social ACL';
  end if;
  begin
    perform public.podmena_social_action(expired_token,'settings','{}');
    raise exception 'expired session accepted';
  exception when sqlstate 'PT401' then null; end;
  begin
    perform public.podmena_social_action(worker_token,'catalog','{}');
    raise exception 'worker can browse catalog';
  exception when sqlstate 'PT403' then null; end;

  res := public.podmena_social_action(owner_token,'catalog','{}');
  if jsonb_array_length(res->'items')<>0 then raise exception 'catalog is not off by default'; end if;
  perform public.podmena_social_action(worker_token,'save_settings','{"visible":true,"description":"Обучение — пишите в @test_handle","notifications_enabled":true}');
  res := public.podmena_social_action(owner_token,'catalog','{"city":"СПб","district":"Цент","platform":"ozon","experience":"Год","work_type":"single","page":0}');
  if jsonb_array_length(res->'items')<>1
    or res::text like '%synthetic-secret%' or res::text like '%'||worker_id||'%'
    or res::text like '%test_handle%' or res::text like '%test_private%'
    or res::text like '%Не для каталога%'
    or res->'items'->0->'work_types' <> '["single"]'::jsonb then
    raise exception 'catalog filtering or projection: %',res;
  end if;
  catalog_id := (res->'items'->0->>'catalog_id')::uuid;
  res := public.podmena_social_action(owner_token,'catalog','{"platform":"wildberries"}');
  if jsonb_array_length(res->'items')<>0 then raise exception 'catalog platform filter'; end if;
  res := public.podmena_social_action(owner_token,'catalog','{"work_type":"permanent"}');
  if jsonb_array_length(res->'items')<>0 then raise exception 'catalog format filter'; end if;

  perform public.podmena_social_action(owner_token,'request_contact',jsonb_build_object('catalog_id',catalog_id,'actor_id',outsider_id));
  perform public.podmena_social_action(owner_token,'request_contact',jsonb_build_object('catalog_id',catalog_id));
  res := public.podmena_social_action(worker_token,'connections','{}');
  if jsonb_array_length(res->'items')<>1 or res->'items'->0->>'direction'<>'incoming' then raise exception 'duplicate connection request'; end if;
  contact_id := (res->'items'->0->>'request_id')::uuid;
  res := public.podmena_social_action(owner_token,'threads','{}');
  if jsonb_array_length(res->'items')<>0 then raise exception 'chat opened before consent'; end if;
  begin
    perform public.podmena_social_action(owner_token,'decide_contact',jsonb_build_object('request_id',contact_id,'decision','accept'));
    raise exception 'sender accepted own request';
  exception when sqlstate 'PT404' then null; end;
  res := public.podmena_social_action(worker_token,'decide_contact',jsonb_build_object('request_id',contact_id,'decision','accept'));
  chat_id := (res->>'thread_id')::uuid;
  if chat_id is null then raise exception 'request not accepted'; end if;
  begin
    perform public.podmena_social_action(outsider_token,'messages',jsonb_build_object('thread_id',chat_id,'actor_id',worker_id));
    raise exception 'outsider read messages';
  exception when sqlstate 'PT404' then null; end;
  begin
    perform public.podmena_social_action(outsider_token,'send_message',jsonb_build_object('thread_id',chat_id,'body','подмена','request_id',key_id));
    raise exception 'outsider sent a message';
  exception when sqlstate 'PT404' then null; end;

  res := public.podmena_social_action(owner_token,'send_message',jsonb_build_object(
    'thread_id',chat_id,'body','<img src=x onerror=alert(1)>','request_id',key_id));
  message_id := (res->>'message_id')::uuid;
  res := public.podmena_social_action(owner_token,'send_message',jsonb_build_object(
    'thread_id',chat_id,'body','<img src=x onerror=alert(1)>','request_id',key_id));
  if (res->>'message_id')::uuid<>message_id or not (res->>'replayed')::boolean then raise exception 'message replay'; end if;
  begin
    perform public.podmena_social_action(owner_token,'send_message',jsonb_build_object(
      'thread_id',chat_id,'body','изменённый текст','request_id',key_id));
    raise exception 'request_id reused for another text';
  exception when sqlstate 'PT409' then null; end;
  if (select count(*) from podmena.notification_outbox q where q.event_kind='chat_message' and q.recipient_id=worker_id)<>1
    or (select count(*) from podmena.notification_outbox q where q.event_kind='connection_request' and q.recipient_id=worker_id)<>1 then
    raise exception 'outbox deduplication or recipient';
  end if;
  res := public.podmena_social_action(worker_token,'messages',jsonb_build_object('thread_id',chat_id));
  if res->'items'->0->>'body'<>'<img src=x onerror=alert(1)>' or (res->'items'->0->>'mine')::boolean then
    raise exception 'message was not stored as ordinary text';
  end if;
  res := public.podmena_social_action(worker_token,'threads','{}');
  if (res->'items'->0->>'unread_count')::integer<>1 then raise exception 'missing unread count'; end if;
  perform public.podmena_social_action(worker_token,'mark_read',jsonb_build_object('thread_id',chat_id,'message_id',message_id));
  res := public.podmena_social_action(worker_token,'threads','{}');
  if (res->'items'->0->>'unread_count')::integer<>0 then raise exception 'mark_read failed'; end if;

  perform public.podmena_social_action(worker_token,'block',jsonb_build_object('thread_id',chat_id));
  begin
    perform public.podmena_social_action(owner_token,'send_message',jsonb_build_object('thread_id',chat_id,'body','заблокировано','request_id',gen_random_uuid()));
    raise exception 'block bypassed';
  exception when sqlstate 'PT409' then null; end;
  res := public.podmena_social_action(owner_token,'catalog','{}');
  if jsonb_array_length(res->'items')<>0 then raise exception 'blocked user visible in catalog'; end if;
  perform public.podmena_social_action(worker_token,'report',jsonb_build_object('thread_id',chat_id,'reason','Проверка жалобы'));
  perform public.podmena_social_action(worker_token,'report',jsonb_build_object('thread_id',chat_id,'reason','Повтор'));
  if (select count(*) from podmena.chat_reports r where r.reporter_id=worker_id)<>1 then raise exception 'duplicate reports'; end if;
  perform public.podmena_social_action(worker_token,'unblock',jsonb_build_object('thread_id',chat_id));
  for counter in 1..5 loop
    perform public.podmena_social_action(owner_token,'send_message',jsonb_build_object(
      'thread_id',chat_id,'body','Текст проверки '||counter,'request_id',gen_random_uuid()));
  end loop;
  begin
    perform public.podmena_social_action(owner_token,'send_message',jsonb_build_object('thread_id',chat_id,'body','лимит','request_id',gen_random_uuid()));
    raise exception 'rate limit bypassed';
  exception when sqlstate 'PT429' then null; end;
  perform public.podmena_social_action(worker_token,'save_settings','{"visible":false}');
  begin
    perform public.podmena_social_action(outsider_token,'request_contact',jsonb_build_object('catalog_id',catalog_id));
    raise exception 'old catalog link bypassed opt out';
  exception when sqlstate 'PT404' then null; end;

  insert into podmena.shifts(manager_id,platform,city,district,pickup_point,starts_at,ends_at,pay_rubles) values
    (outsider_id,'ozon','СПб','Центральный','ПВЗ тест',now()+interval '1 day',now()+interval '2 days',0) returning id into shift_id;
  insert into podmena.shift_applications(shift_id,worker_id) values(shift_id,worker_id) returning id into app_id;
  begin
    perform public.podmena_social_action(owner_token,'shift_thread',jsonb_build_object('shift_id',shift_id,'application_id',app_id));
    raise exception 'opened foreign shift conversation';
  exception when sqlstate 'PT404' then null; end;
  res := public.podmena_social_action(worker_token,'shift_thread',jsonb_build_object('shift_id',shift_id,'application_id',app_id));
  shift_chat_id := (res->>'thread_id')::uuid;
  res := public.podmena_social_action(outsider_token,'shift_thread',jsonb_build_object('shift_id',shift_id,'application_id',app_id));
  if (res->>'thread_id')::uuid<>shift_chat_id or shift_chat_id=chat_id then raise exception 'shift chat identity'; end if;
  perform public.podmena_social_action(outsider_token,'send_message',jsonb_build_object('thread_id',shift_chat_id,'body','О смене','request_id',gen_random_uuid()));
  update podmena.shift_applications a set withdrawn_at=now() where a.id=app_id;
  begin
    perform public.podmena_social_action(outsider_token,'send_message',jsonb_build_object('thread_id',shift_chat_id,'body','после отзыва','request_id',gen_random_uuid()));
    raise exception 'withdrawn relationship accepted';
  exception when sqlstate 'PT403' then null; end;
  res := public.podmena_social_action(worker_token,'messages',jsonb_build_object('thread_id',shift_chat_id));
  if (res->>'can_send')::boolean or jsonb_array_length(res->'items')<>1 then raise exception 'existing chat lost after withdrawal'; end if;
end;
$$;

rollback;
