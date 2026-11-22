begin;

create table podmena.notification_settings (
  user_id uuid primary key references podmena.telegram_users(id),
  enabled boolean not null default false
);

create table podmena.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references podmena.telegram_users(id),
  event_kind text not null check (event_kind in (
    'new_application','assignment','worker_declined','shift_cancelled','replacement_opened',
    'completion_requested','completion_confirmed','dispute_opened','dispute_replied',
    'dispute_resolved','dispute_withdrawn','chat_message','connection_request'
  )),
  event_key text not null check (char_length(event_key) between 1 and 200),
  priority smallint generated always as (case
    when event_kind in ('shift_cancelled','worker_declined','assignment','dispute_opened') then 0
    when event_kind = 'chat_message' then 2 else 1 end) stored,
  status text not null default 'pending' check (status in
    ('pending','processing','delivered','unavailable','failed','uncertain','suppressed')),
  attempt integer not null default 0 check (attempt between 0 and 5),
  available_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  unique (recipient_id,event_kind,event_key),
  check ((status='processing') = (lease_token is not null and lease_until is not null))
);

create index notification_outbox_queue on podmena.notification_outbox(priority,available_at,id) where status='pending';
create index notification_outbox_recipient_queue on podmena.notification_outbox(recipient_id,priority,available_at,id)
  where status='pending';
create index notification_outbox_recipient_lease on podmena.notification_outbox(recipient_id,lease_until)
  where status='processing';
create index notification_outbox_expired_lease on podmena.notification_outbox(lease_until) where status='processing';
create index notification_outbox_settled on podmena.notification_outbox(recipient_id,settled_at desc)
  where status in ('delivered','unavailable');

alter table podmena.notification_settings enable row level security;
alter table podmena.notification_outbox enable row level security;
revoke all on podmena.notification_settings,podmena.notification_outbox from public,anon,authenticated,service_role;

-- Events are stored in the same transaction as the originating row. No text from users goes into the queue.
create function podmena.enqueue_notification(p_recipient uuid,p_kind text,p_key text)
returns void language sql set search_path='' as $$
  insert into podmena.notification_outbox(recipient_id,event_kind,event_key)
  select n.user_id,p_kind,p_key from podmena.notification_settings n
  where n.user_id=p_recipient and n.enabled
  on conflict (recipient_id,event_kind,event_key) do nothing;
$$;

create function podmena.notify_shift_application()
returns trigger language plpgsql set search_path='' as $$
declare
  recipient uuid;
begin
  select s.manager_id into recipient from podmena.shifts s where s.id=new.shift_id;
  if recipient is distinct from new.worker_id then
    perform podmena.enqueue_notification(recipient,'new_application','application:'||new.id);
  end if;
  return new;
end;
$$;

create function podmena.notify_shift_event()
returns trigger language plpgsql set search_path='' as $$
declare
  manager uuid;
  worker uuid;
begin
  select s.manager_id into manager from podmena.shifts s where s.id=new.shift_id;
  select a.worker_id into worker from podmena.shift_applications a where a.id=new.application_id and a.shift_id=new.shift_id;
  if new.action='assigned' then
    perform podmena.enqueue_notification(worker,'assignment','shift_event:'||new.id);
  elsif new.action='declined' then
    perform podmena.enqueue_notification(manager,'worker_declined','shift_event:'||new.id);
  elsif new.action in ('cancelled','reopened') then
    perform podmena.enqueue_notification(a.worker_id,
      case when new.action='cancelled' then 'shift_cancelled' else 'replacement_opened' end,
      'shift_event:'||new.id)
    from podmena.shift_applications a
    where a.shift_id=new.shift_id and a.withdrawn_at is null and a.declined_at is null
      and a.worker_id<>new.actor_id;
  end if;
  return new;
end;
$$;

create function podmena.notify_shift_completion()
returns trigger language plpgsql set search_path='' as $$
declare
  manager uuid;
  worker uuid;
begin
  select s.manager_id,a.worker_id into manager,worker
  from podmena.shifts s join podmena.shift_applications a on a.id=new.application_id and a.shift_id=s.id
  where s.id=new.shift_id;
  if new.decision='pending' and (tg_op='INSERT' or new.requested_at is distinct from old.requested_at) then
    perform podmena.enqueue_notification(worker,'completion_requested','completion:'||new.shift_id||':'||new.requested_at);
  elsif new.decision='confirmed' and (tg_op='INSERT' or new.decision is distinct from old.decision) then
    perform podmena.enqueue_notification(manager,'completion_confirmed','completion:'||new.shift_id);
  end if;
  return new;
end;
$$;

create function podmena.notify_dispute_event()
returns trigger language plpgsql set search_path='' as $$
declare
  recipient uuid;
  kind text;
begin
  select case when new.actor_role='worker' then s.manager_id else a.worker_id end into recipient
  from podmena.shifts s join podmena.shift_completions c on c.shift_id=s.id
  join podmena.shift_applications a on a.id=c.application_id and a.shift_id=s.id
  where s.id=new.shift_id;
  kind := case new.action when 'opened' then 'dispute_opened'
    when 'withdrawn' then 'dispute_withdrawn' when 'accepted' then 'dispute_resolved'
    else 'dispute_replied' end;
  if recipient is distinct from new.actor_id then
    perform podmena.enqueue_notification(recipient,kind,'dispute_event:'||new.id);
  end if;
  return new;
end;
$$;

revoke all on function podmena.enqueue_notification(uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function podmena.notify_shift_application(),podmena.notify_shift_event(),
  podmena.notify_shift_completion(),podmena.notify_dispute_event() from public,anon,authenticated,service_role;

create trigger pilot_application_notify after insert on podmena.shift_applications
for each row execute function podmena.notify_shift_application();
create trigger pilot_shift_event_notify after insert on podmena.shift_events
for each row execute function podmena.notify_shift_event();
create trigger pilot_shift_completion_notify after insert or update on podmena.shift_completions
for each row execute function podmena.notify_shift_completion();
create trigger pilot_dispute_notify after insert on podmena.shift_dispute_events
for each row execute function podmena.notify_dispute_event();

create function public.podmena_claim_notifications(p_limit integer)
returns table(id uuid,lease_token uuid,telegram_id text,event_kind text,attempt integer)
language plpgsql security definer set search_path='' as $$
declare
  at_time timestamptz := clock_timestamp();
begin
  -- A lost worker has an unknown delivery result. Reclaiming would risk sending duplicates.
  update podmena.notification_outbox o set status='uncertain',settled_at=at_time,
    lease_token=null,lease_until=null where o.status='processing' and o.lease_until<=at_time;
  update podmena.notification_outbox o set status='suppressed',settled_at=at_time
  where o.status='pending' and not exists (
    select from podmena.notification_settings n where n.user_id=o.recipient_id and n.enabled
  );

  return query
  with tickets as (
    select q.id from podmena.notification_outbox q
    join podmena.notification_settings n on n.user_id=q.recipient_id and n.enabled
    where q.status='pending' and q.available_at<=at_time
      and not exists (select from podmena.notification_outbox lease
        where lease.recipient_id=q.recipient_id and lease.status='processing')
      and not exists (select from podmena.notification_outbox recent
        where recent.recipient_id=q.recipient_id and recent.status in ('delivered','unavailable')
          and recent.settled_at>at_time-interval '1 minute')
      and not exists (select from podmena.notification_outbox earlier
        where earlier.recipient_id=q.recipient_id and earlier.status='pending' and earlier.available_at<=at_time
          and (earlier.priority,earlier.available_at,earlier.id)<(q.priority,q.available_at,q.id))
    order by q.priority,q.available_at,q.id limit least(greatest(coalesce(p_limit,1),1),5)
    for update of q skip locked
  ), leased as (
    update podmena.notification_outbox o set status='processing',attempt=o.attempt+1,
      lease_token=gen_random_uuid(),lease_until=at_time+interval '3 minutes'
    from tickets where tickets.id=o.id returning o.*
  )
  select l.id,l.lease_token,u.telegram_id::text,l.event_kind,l.attempt
  from leased l join podmena.telegram_users u on u.id=l.recipient_id
  order by l.priority,l.available_at,l.id;
end;
$$;

create function public.podmena_finish_notification(
  p_id uuid,p_lease_token uuid,p_result text,p_retry_after integer default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare
  at_time timestamptz := clock_timestamp();
begin
  if p_result is null or p_result not in ('delivered','retry','unavailable','failed','uncertain') then
    raise sqlstate 'PT400' using message='invalid_result';
  end if;
  update podmena.notification_outbox o set
    status=case when p_result='retry' then case when o.attempt>=5 then 'failed' else 'pending' end else p_result end,
    available_at=case when p_result='retry' and o.attempt<5 then at_time+make_interval(secs=>
      greatest(30*(1<<o.attempt),least(86400,greatest(0,coalesce(p_retry_after,0))))) else o.available_at end,
    settled_at=case when p_result='retry' and o.attempt<5 then null else at_time end,
    lease_token=null,lease_until=null
  where o.id=p_id and o.status='processing' and o.lease_token=p_lease_token and o.lease_until>at_time;
  return found;
end;
$$;

create function public.podmena_notification_counts()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(x.status,x.total),'{}'::jsonb)
  from (select o.status,count(*) as total from podmena.notification_outbox o group by o.status) x;
$$;

revoke all on function public.podmena_claim_notifications(integer),
  public.podmena_finish_notification(uuid,uuid,text,integer),
  public.podmena_notification_counts() from public,anon,authenticated,service_role;
grant execute on function public.podmena_claim_notifications(integer),
  public.podmena_finish_notification(uuid,uuid,text,integer),
  public.podmena_notification_counts() to service_role;

notify pgrst,'reload schema';
commit;
