-- Stage 3Zh smoke test. Synthetic users, sessions, shifts; entire transaction rolled back.
begin;
do $test$
declare
  mid uuid;
  wid uuid;
  sid uuid;
  aid uuid;
  item jsonb;
begin
  insert into podmena.telegram_users(telegram_id) values(4499999900001) returning id into mid;
  insert into podmena.telegram_users(telegram_id) values(4499999900002) returning id into wid;
  insert into podmena.manager_profiles(user_id,name,city,district,pickup_point,platform)
    values(mid,'Проверяющий','Тест','Центр','Тестовый ПВЗ','ozon');
  insert into podmena.worker_profiles(user_id,name,city,district,platforms,experience,accepts_single_shifts)
    values(wid,'Тестовый сотрудник','Тест','Центр',array['ozon']::podmena.platform[],'Тест',true);
  insert into podmena.telegram_sessions(token_hash,telegram_hash,user_id,expires_at) values
    (decode(repeat('a',64),'hex'),decode(repeat('c',64),'hex'),mid,now()+interval '30 minutes'),
    (decode(repeat('b',64),'hex'),decode(repeat('d',64),'hex'),wid,now()+interval '30 minutes');

  insert into podmena.shifts(manager_id,platform,city,district,pickup_point,starts_at,ends_at,pay_rubles,time_zone)
    values(mid,'ozon','Тест','Центр','Сменный тест',now()-interval '3 hours',now()-interval '2 hours',100,'Europe/Moscow') returning id into sid;
  insert into podmena.shift_applications(shift_id,worker_id) values(sid,wid) returning id into aid;
  update podmena.shifts set confirmed_application_id=aid,confirmed_at=now()-interval '3 hours',status='confirmed' where id=sid;
  insert into podmena.shift_completions(shift_id,application_id,requested_at,decision,decided_at,dispute_reason)
    values(sid,aid,now()-interval '60 minutes','disputed',now()-interval '30 minutes','Тестовый спор');
  insert into podmena.shift_dispute_events(shift_id,actor_id,actor_role,action,message)
    values(sid,wid,'worker','opened','Тестовый спор');

  select card into item from jsonb_array_elements(public.podmena_shift_action(repeat('a',64),'owned','{"page":0}'::jsonb)->'items') card
    where (card->>'id')::uuid=sid;
  if item is null or item->>'can_reply_dispute'<>'true' or jsonb_array_length(item->'dispute_events')<>1 then
    raise exception 'manager cannot view/discuss dispute: %',item;
  end if;
  select card into item from jsonb_array_elements(public.podmena_shift_action(repeat('b',64),'outgoing','{"page":0}'::jsonb)->'items') card
    where (card->>'id')::uuid=sid;
  if item is null or item->>'can_withdraw_dispute'<>'true' or item->>'can_accept_dispute'<>'false' then
    raise exception 'worker cannot see correct dispute controls: %',item;
  end if;

  begin
    perform public.podmena_shift_action(repeat('a',64),'withdraw_dispute',jsonb_build_object('shift_id',sid));
    raise exception 'manager was able to withdraw worker dispute';
  exception when sqlstate 'PT404' then null;
  end;
  begin
    perform public.podmena_shift_action(repeat('b',64),'accept_dispute',jsonb_build_object('shift_id',sid));
    raise exception 'worker was able to accept nonexistent proposal';
  exception when sqlstate 'PT409' then null;
  end;

  perform public.podmena_shift_action(repeat('a',64),'reply_dispute',jsonb_build_object('shift_id',sid,'message','Урегулируем вопрос'));
  perform public.podmena_shift_action(repeat('b',64),'comment_dispute',jsonb_build_object('shift_id',sid,'message','Пока не согласен'));
  begin
    perform public.podmena_shift_action(repeat('b',64),'accept_dispute',jsonb_build_object('shift_id',sid));
    raise exception 'worker could accept superseded proposal';
  exception when sqlstate 'PT409' then null;
  end;

  perform public.podmena_shift_action(repeat('a',64),'reply_dispute',jsonb_build_object('shift_id',sid,'message','Новое предложение'));
  perform public.podmena_shift_action(repeat('b',64),'accept_dispute',jsonb_build_object('shift_id',sid));
  if (select decision from podmena.shift_completions where shift_id=sid)<>'pending' then
    raise exception 'settlement did not restore pending confirmation';
  end if;
  perform public.podmena_shift_action(repeat('b',64),'confirm_completion',jsonb_build_object('shift_id',sid));
  if (select status::text from podmena.shifts where id=sid)<>'completed' then
    raise exception 'completion after settlement failed';
  end if;
  if (select count(*) from podmena.shift_dispute_events where shift_id=sid)<>5 then
    raise exception 'audit trail lost entries';
  end if;

  if has_function_privilege('anon','public.podmena_shift_action(text,text,jsonb)','execute')
     or has_function_privilege('authenticated','public.podmena_shift_action(text,text,jsonb)','execute') then
    raise exception 'public permissions too broad';
  end if;
end;
$test$;
select 'role_access_reply_comment_accept_and_completion_passed' as smoke_test;
rollback;
