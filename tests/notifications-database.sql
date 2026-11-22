begin;
do $$
declare
  manager uuid;
  worker uuid;
  shift uuid;
  application uuid;
  job record;
  second_job record;
begin
  insert into podmena.telegram_users(telegram_id) values(4499999200001) returning id into manager;
  insert into podmena.telegram_users(telegram_id) values(4499999200002) returning id into worker;
  insert into podmena.manager_profiles(user_id,name,city,district,pickup_point,platform)
    values(manager,'Управляющий','Тест','Центр','ПВЗ','ozon');
  insert into podmena.worker_profiles(user_id,name,city,district,platforms,experience,accepts_single_shifts)
    values(worker,'Сотрудник','Тест','Центр',array['ozon']::podmena.platform[],'Без опыта',true);
  perform podmena.enqueue_notification(manager,'chat_message','custom:default-off');
  if exists (select from podmena.notification_outbox where recipient_id=manager) then
    raise exception 'notification for default-disabled user';
  end if;
  insert into podmena.notification_settings(user_id,enabled) values(manager,true),(worker,true);
  insert into podmena.shifts(manager_id,platform,city,district,pickup_point,starts_at,ends_at,pay_rubles)
    values(manager,'ozon','Тест','Центр','ПВЗ',now()+interval '3 hours',now()+interval '6 hours',100) returning id into shift;
  insert into podmena.shift_applications(shift_id,worker_id) values(shift,worker) returning id into application;
  perform podmena.enqueue_notification(manager,'new_application','application:'||application);
  if (select count(*) from podmena.notification_outbox where recipient_id=manager)<>1 then raise exception 'application event missing/doubled'; end if;
  insert into podmena.shift_events(shift_id,application_id,actor_id,action) values(shift,application,manager,'assigned');
  select * into job from public.podmena_claim_notifications(5) where telegram_id='4499999200001';
  if job.event_kind is distinct from 'new_application' or job.attempt<>1 then raise exception 'unexpected lease'; end if;
  if not public.podmena_finish_notification(job.id,job.lease_token,'retry',3) then raise exception 'retry rejected'; end if;
  if public.podmena_finish_notification(job.id,job.lease_token,'delivered',null) then raise exception 'old lease allowed'; end if;
  if exists (select from public.podmena_claim_notifications(5) where id=job.id) then raise exception 'no backoff'; end if;
  update podmena.notification_outbox set available_at=now()-interval '1 minute' where id=job.id;
  select * into second_job from public.podmena_claim_notifications(5) where id=job.id;
  if second_job.attempt is distinct from 2 or second_job.lease_token=job.lease_token then raise exception 'retry lease invalid'; end if;
  if not public.podmena_finish_notification(second_job.id,second_job.lease_token,'uncertain',null) then raise exception 'uncertain result ignored'; end if;
  if exists(select from public.podmena_claim_notifications(5) where id=job.id) then raise exception 'ambiguous attempt retried'; end if;
  update podmena.notification_settings set enabled=false where user_id=worker;
  perform podmena.enqueue_notification(worker,'chat_message','custom:disabled');
  if exists(select from public.podmena_claim_notifications(5) where telegram_id='4499999200002') then raise exception 'opt-out ignored'; end if;
  if has_function_privilege('anon','public.podmena_claim_notifications(integer)','execute') then raise exception 'claim publicly callable'; end if;
end;
$$;
rollback;
