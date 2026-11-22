-- Проверка выполняется только на локальной временной базе.
begin;
do $test$
<<stage>>
declare
  manager_id uuid;
  worker_id uuid;
  stranger_id uuid;
  shift_id uuid;
  application_id uuid;
  round_id text;
  first_offer text;
  next_offer text;
  first_request uuid := gen_random_uuid();
  next_request uuid := gen_random_uuid();
  resolve_request uuid := gen_random_uuid();
  shared jsonb;
  card jsonb;
  result jsonb;
begin
  insert into podmena.telegram_users(telegram_id) values(4499999800001) returning id into manager_id;
  insert into podmena.telegram_users(telegram_id) values(4499999800002) returning id into worker_id;
  insert into podmena.telegram_users(telegram_id) values(4499999800003) returning id into stranger_id;
  insert into podmena.manager_profiles(user_id,name,city,district,pickup_point,platform)
    values(manager_id,'Проверяющий','Тест','Центр','Тестовый ПВЗ','ozon');
  insert into podmena.worker_profiles(user_id,name,city,district,platforms,experience,accepts_single_shifts)
    values(worker_id,'Сотрудник','Тест','Центр',array['ozon']::podmena.platform[],'Тест',true);
  insert into podmena.telegram_sessions(token_hash,telegram_hash,user_id,expires_at) values
    (decode(repeat('2',64),'hex'),decode(repeat('7',64),'hex'),manager_id,now()+interval '30 minutes'),
    (decode(repeat('3',64),'hex'),decode(repeat('8',64),'hex'),worker_id,now()+interval '30 minutes'),
    (decode(repeat('4',64),'hex'),decode(repeat('9',64),'hex'),stranger_id,now()+interval '30 minutes'),
    (decode(repeat('5',64),'hex'),decode(repeat('a',64),'hex'),stranger_id,now()-interval '1 minute');

  insert into podmena.shifts(manager_id,platform,city,district,pickup_point,starts_at,ends_at,pay_rubles,time_zone)
    values(manager_id,'ozon','Тест','Центр','Сменный тест',now()-interval '3 hours',now()-interval '2 hours',100,'Europe/Moscow') returning id into shift_id;
  insert into podmena.shift_applications(shift_id,worker_id) values(shift_id,worker_id) returning id into application_id;
  update podmena.shifts set confirmed_application_id=application_id,confirmed_at=now()-interval '3 hours',status='confirmed'
    where id=shift_id;
  insert into podmena.shift_completions(shift_id,application_id,requested_at,decision,decided_at,dispute_reason)
    values(shift_id,application_id,now()-interval '60 minutes','disputed',now()-interval '30 minutes','Тестовый спор');
  insert into podmena.shift_dispute_events(shift_id,actor_id,actor_role,action,message)
    values(shift_id,worker_id,'worker','opened','Тестовый спор') returning id::text into round_id;

  shared := jsonb_build_object('shift_id',shift_id,'round_id',round_id);
  card := public.podmena_shift_action(repeat('2',64),'owned','{"page":0}'::jsonb)->'items'->0;
  if card->>'dispute_round_id' is distinct from round_id or card ? 'dispute_offer_id' then
    raise exception 'dispute round access does not match the manager role';
  end if;

  if jsonb_array_length(public.podmena_shift_action(repeat('4',64),'owned',jsonb_build_object('actor_id',manager_id))->'items') <> 0
     or jsonb_array_length(public.podmena_shift_action(repeat('4',64),'outgoing',jsonb_build_object('actor_id',worker_id))->'items') <> 0 then
    raise exception 'stranger received private listings';
  end if;
  begin
    perform public.podmena_shift_action(repeat('4',64),'reply_dispute',shared ||
      jsonb_build_object('request_id',first_request,'message','Тест','actor_id',manager_id));
    raise exception 'stranger replied to a dispute';
  exception when sqlstate 'PT404' then null;
  end;
  begin
    perform public.podmena_shift_action(repeat('5',64),'owned','{}'::jsonb);
    raise exception 'expired session received private listings';
  exception when sqlstate 'PT401' then null;
  end;
  begin
    perform public.podmena_shift_action(repeat('6',64),'owned','{}'::jsonb);
    raise exception 'unknown session received private listings';
  exception when sqlstate 'PT401' then null;
  end;

  perform public.podmena_shift_action(repeat('2',64),'reply_dispute',shared ||
    jsonb_build_object('request_id',first_request,'message','Первое предложение'));
  result := public.podmena_shift_action(repeat('2',64),'reply_dispute',shared ||
    jsonb_build_object('request_id',first_request,'message','Первое предложение'));
  if result->>'replayed' is distinct from 'true' then
    raise exception 'retry did not use the saved result';
  end if;
  begin
    perform public.podmena_shift_action(repeat('2',64),'reply_dispute',shared ||
      jsonb_build_object('request_id',first_request,'message','Другое предложение'));
    raise exception 'a key was reused for another action';
  exception when sqlstate 'PT409' then null;
  end;
  card := public.podmena_shift_action(repeat('3',64),'outgoing','{"page":0}'::jsonb)->'items'->0;
  first_offer := card->>'dispute_offer_id';
  if first_offer is null then raise exception 'worker did not receive the offer version'; end if;

  perform public.podmena_shift_action(repeat('2',64),'reply_dispute',shared ||
    jsonb_build_object('request_id',next_request,'message','Второе предложение'));
  card := public.podmena_shift_action(repeat('3',64),'outgoing','{"page":0}'::jsonb)->'items'->0;
  next_offer := card->>'dispute_offer_id';
  if next_offer is null or next_offer = first_offer then raise exception 'offer was not versioned'; end if;
  begin
    perform public.podmena_shift_action(repeat('3',64),'accept_dispute',shared ||
      jsonb_build_object('request_id',resolve_request,'offer_id',first_offer));
    raise exception 'worker accepted an offer that changed after viewing';
  exception when sqlstate 'PT409' then null;
  end;
  begin
    perform public.podmena_shift_action(repeat('2',64),'accept_dispute',shared ||
      jsonb_build_object('request_id',resolve_request,'offer_id',next_offer));
    raise exception 'manager closed dispute on behalf of the worker';
  exception when sqlstate 'PT404' then null;
  end;
  perform public.podmena_shift_action(repeat('3',64),'accept_dispute',shared ||
    jsonb_build_object('request_id',resolve_request,'offer_id',next_offer));
  result := public.podmena_shift_action(repeat('3',64),'accept_dispute',shared ||
    jsonb_build_object('request_id',resolve_request,'offer_id',next_offer));
  if result->>'replayed' is distinct from 'true' then raise exception 'retry did not preserve acceptance'; end if;
  if (select count(*) from podmena.shift_dispute_events e where e.shift_id=stage.shift_id) <> 4 then
    raise exception 'dispute events were duplicated or lost';
  end if;
  if (select decision from podmena.shift_completions c where c.shift_id=stage.shift_id) <> 'pending'
     or (select status::text from podmena.shifts s where s.id=stage.shift_id) <> 'confirmed' then
    raise exception 'settlement completed or paid the shift instead of awaiting confirmation';
  end if;
end;
$test$;
rollback;
