begin;

create table podmena.worker_catalog (
  id uuid not null default gen_random_uuid() unique,
  user_id uuid primary key references podmena.worker_profiles(user_id) on delete cascade,
  visible boolean not null default false,
  description text not null default '' check (char_length(description) <= 500)
);
create index worker_catalog_visible_idx on podmena.worker_catalog(id) where visible;

create table podmena.chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_low uuid not null references podmena.telegram_users(id),
  user_high uuid not null references podmena.telegram_users(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_low, user_high),
  check (user_low < user_high)
);
create index chat_threads_low_updated_idx on podmena.chat_threads(user_low, updated_at desc, id);
create index chat_threads_high_updated_idx on podmena.chat_threads(user_high, updated_at desc, id);

create table podmena.contact_requests (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references podmena.manager_profiles(user_id),
  worker_id uuid not null references podmena.worker_profiles(user_id),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  thread_id uuid references podmena.chat_threads(id),
  created_at timestamptz not null default clock_timestamp(),
  check (manager_id <> worker_id),
  check ((thread_id is not null) = (status = 'accepted'))
);
create unique index contact_requests_pair_idx
  on podmena.contact_requests(least(manager_id,worker_id),greatest(manager_id,worker_id));
create index contact_requests_manager_idx on podmena.contact_requests(manager_id,created_at desc,id);
create index contact_requests_worker_idx on podmena.contact_requests(worker_id,created_at desc,id);
create index contact_requests_thread_idx on podmena.contact_requests(thread_id) where thread_id is not null;

create table podmena.chat_shift_links (
  shift_id uuid not null,
  application_id uuid primary key,
  thread_id uuid not null references podmena.chat_threads(id),
  foreign key (shift_id, application_id) references podmena.shift_applications(shift_id,id)
);
create index chat_shift_links_thread_idx on podmena.chat_shift_links(thread_id);

create table podmena.chat_blocks (
  blocker_id uuid not null references podmena.telegram_users(id),
  blocked_id uuid not null references podmena.telegram_users(id),
  created_at timestamptz not null default clock_timestamp(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index chat_blocks_blocked_idx on podmena.chat_blocks(blocked_id,blocker_id);

create table podmena.chat_messages (
  id uuid primary key default gen_random_uuid(),
  -- Private sequence to provide stable ordering and read cursors.
  ordinal bigint generated always as identity unique,
  thread_id uuid not null references podmena.chat_threads(id),
  sender_id uuid not null references podmena.telegram_users(id),
  request_id uuid not null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp(),
  unique (thread_id, sender_id, request_id)
);
create index chat_messages_thread_ordinal_idx on podmena.chat_messages(thread_id, ordinal desc);
create index chat_messages_sender_created_idx on podmena.chat_messages(sender_id,created_at desc);

create table podmena.chat_read_states (
  thread_id uuid not null references podmena.chat_threads(id),
  user_id uuid not null references podmena.telegram_users(id),
  read_ordinal bigint not null check (read_ordinal > 0),
  primary key (thread_id, user_id)
);
create index chat_read_states_user_idx on podmena.chat_read_states(user_id);

create table podmena.chat_reports (
  reporter_id uuid not null references podmena.telegram_users(id),
  reported_id uuid not null references podmena.telegram_users(id),
  thread_id uuid references podmena.chat_threads(id),
  contact_request_id uuid references podmena.contact_requests(id),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  primary key (reporter_id, reported_id),
  check (reporter_id <> reported_id),
  check (num_nonnulls(thread_id,contact_request_id) <= 1)
);
create index chat_reports_reported_idx on podmena.chat_reports(reported_id);

alter table podmena.worker_catalog enable row level security;
alter table podmena.chat_threads enable row level security;
alter table podmena.contact_requests enable row level security;
alter table podmena.chat_shift_links enable row level security;
alter table podmena.chat_blocks enable row level security;
alter table podmena.chat_messages enable row level security;
alter table podmena.chat_read_states enable row level security;
alter table podmena.chat_reports enable row level security;

revoke all on podmena.worker_catalog,podmena.chat_threads,podmena.contact_requests,podmena.chat_shift_links,
  podmena.chat_blocks,podmena.chat_messages,podmena.chat_read_states,podmena.chat_reports
  from public,anon,authenticated,service_role;
revoke all on sequence podmena.chat_messages_ordinal_seq from public,anon,authenticated,service_role;

create function podmena.chat_is_blocked(p_first uuid,p_second uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists (
    select from podmena.chat_blocks b
    where (b.blocker_id = p_first and b.blocked_id = p_second)
       or (b.blocker_id = p_second and b.blocked_id = p_first)
  );
$$;

create function podmena.chat_shift_access(p_shift podmena.shifts,p_app podmena.shift_applications)
returns boolean language sql stable set search_path = ''
as $$
  select p_app.withdrawn_at is null and p_app.declined_at is null
    and (p_shift.status in ('open','needs_replacement')
      or (p_shift.status in ('confirmed','completed') and p_shift.confirmed_application_id = p_app.id));
$$;

create function podmena.chat_thread_access(p_thread uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists (select from podmena.contact_requests r where r.thread_id = p_thread and r.status = 'accepted')
    or exists (
      select from podmena.chat_shift_links l
      join podmena.shifts s on s.id = l.shift_id
      join podmena.shift_applications a on a.shift_id = l.shift_id and a.id = l.application_id
      where l.thread_id = p_thread and podmena.chat_shift_access(s,a)
    );
$$;

-- Mask common contact-like strings in every field projected by the public-to-managers catalog.
-- Contacts stored in private_contacts are never consulted by this API.
create function podmena.catalog_display(p_text text)
returns text language sql immutable set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      regexp_replace(p_text, '(https?://|www\.|t\.me/|telegram\.me/)\S+', '[скрыто]', 'gi'),
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|@[A-Za-z0-9_]{4,}', '[скрыто]', 'gi'
    ),
    '\+?[[:digit:]]([[:space:]().-]*[[:digit:]]){6,}', '[скрыто]', 'g'
  );
$$;

create function podmena.chat_display_name(p_user uuid)
returns text language sql stable set search_path = ''
as $$
  select coalesce(podmena.catalog_display(
    coalesce((select w.name from podmena.worker_profiles w where w.user_id = p_user),
             (select m.name from podmena.manager_profiles m where m.user_id = p_user))
  ),'Участник');
$$;

create function podmena.social_settings(p_actor uuid)
returns jsonb language sql stable set search_path = ''
as $$
  select jsonb_build_object(
    'visible',coalesce((select c.visible from podmena.worker_catalog c where c.user_id=p_actor),false),
    'description',coalesce((select c.description from podmena.worker_catalog c where c.user_id=p_actor),''),
    'notifications_enabled',coalesce((select n.enabled from podmena.notification_settings n where n.user_id=p_actor),false)
  );
$$;

revoke all on function podmena.chat_is_blocked(uuid,uuid),podmena.chat_shift_access(podmena.shifts,podmena.shift_applications),
  podmena.chat_thread_access(uuid),podmena.catalog_display(text),podmena.chat_display_name(uuid),podmena.social_settings(uuid)
  from public,anon,authenticated,service_role;

create function public.podmena_social_action(p_token_hash text,p_action text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid;
  other_id uuid;
  lower_id uuid;
  higher_id uuid;
  target_id uuid;
  chat_id uuid;
  app_id uuid;
  selected_shift podmena.shifts%rowtype;
  selected_app podmena.shift_applications%rowtype;
  request_row podmena.contact_requests%rowtype;
  old_message podmena.chat_messages%rowtype;
  blocked boolean;
  blocked_by_me boolean;
  body text;
  decision text;
  pos bigint;
  page integer;
  result jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise sqlstate 'PT401' using message='session_expired';
  end if;
  select u.user_id into actor from public.podmena_get_session_user(p_token_hash) u;
  if actor is null then raise sqlstate 'PT401' using message='session_expired'; end if;
  if jsonb_typeof(p_input) is distinct from 'object' then raise sqlstate 'PT400' using message='invalid_request'; end if;
  page := coalesce((p_input->>'page')::integer,0);
  if page < 0 or page > 1000 then raise sqlstate 'PT400' using message='invalid_request'; end if;

  if p_action = 'settings' then return podmena.social_settings(actor); end if;
  if p_action = 'save_settings' then
    if p_input ? 'visible' or p_input ? 'description' then
      if not exists(select from podmena.worker_profiles w where w.user_id=actor) then
        raise sqlstate 'PT403' using message='actor_missing_worker_profile';
      end if;
      insert into podmena.worker_catalog(user_id,visible,description)
        values(actor,coalesce((p_input->>'visible')::boolean,false),coalesce(p_input->>'description',''))
      on conflict(user_id) do update set
        visible=coalesce((p_input->>'visible')::boolean,worker_catalog.visible),
        description=coalesce(p_input->>'description',worker_catalog.description);
    end if;
    if p_input ? 'notifications_enabled' then
      insert into podmena.notification_settings(user_id,enabled)
        values(actor,(p_input->>'notifications_enabled')::boolean)
      on conflict(user_id) do update set enabled=excluded.enabled;
    end if;
    return podmena.social_settings(actor);
  end if;

  if p_action = 'catalog' then
    if not exists(select from podmena.manager_profiles m where m.user_id=actor) then
      raise sqlstate 'PT403' using message='actor_missing_manager_profile';
    end if;
    with candidates as (
      select c.id,c.description,w.*
      from podmena.worker_catalog c join podmena.worker_profiles w on w.user_id=c.user_id
      where c.visible and w.user_id<>actor and not podmena.chat_is_blocked(actor,w.user_id)
        and (p_input->>'city' is null or strpos(lower(w.city),lower(p_input->>'city'))>0)
        and (p_input->>'district' is null or strpos(lower(w.district),lower(p_input->>'district'))>0)
        and (p_input->>'platform' is null or (p_input->>'platform')::podmena.platform=any(w.platforms))
        and (p_input->>'experience' is null or w.experience=p_input->>'experience')
        and (p_input->>'work_type' is null
             or (p_input->>'work_type'='single' and w.accepts_single_shifts)
             or (p_input->>'work_type'='permanent' and w.accepts_permanent_work))
      order by c.id offset page*20 limit 21
    ), cards as (
      select c.id,jsonb_build_object(
        'catalog_id',c.id,'name',podmena.catalog_display(c.name),
        'city',podmena.catalog_display(c.city),'district',podmena.catalog_display(c.district),
        'platforms',c.platforms,'experience',podmena.catalog_display(c.experience),
        'work_types',array_remove(array[
          case when c.accepts_single_shifts then 'single' end,
          case when c.accepts_permanent_work then 'permanent' end],null),
        'description',podmena.catalog_display(c.description),'completed_count',completed.total,
        'average',reviews.average,'review_count',reviews.total) as card
      from (select * from candidates order by id limit 20) c
      cross join lateral (select round(avg(r.stars),1) average,count(*) total
        from podmena.shift_reviews r where r.subject_id=c.user_id and r.subject_role='worker') reviews
      cross join lateral (select count(*) total from podmena.shift_applications a
        join podmena.shifts s on s.id=a.shift_id and s.confirmed_application_id=a.id and s.status='completed'
        join podmena.shift_completions f on f.shift_id=s.id and f.decision='confirmed'
        where a.worker_id=c.user_id) completed
    )
    select jsonb_build_object(
      'items',coalesce((select jsonb_agg(card order by id) from cards),'[]'::jsonb),
      'has_more',(select count(*) from candidates)>20) into result;
    return result;
  end if;

  if p_action in ('connections','threads') then
    if p_action='connections' then
      with rows as (
        select r.id,r.created_at,jsonb_build_object(
          'request_id',r.id,'name',podmena.chat_display_name(case when r.manager_id=actor then r.worker_id else r.manager_id end),
          'direction',case when r.manager_id=actor then 'outgoing' else 'incoming' end,
          'status',r.status,'created_at',r.created_at,'thread_id',r.thread_id,
          'blocked_by_me',exists(select from podmena.chat_blocks b where b.blocker_id=actor
            and b.blocked_id=case when r.manager_id=actor then r.worker_id else r.manager_id end)) card
        from podmena.contact_requests r where actor in (r.manager_id,r.worker_id)
        order by r.created_at desc,r.id desc offset page*20 limit 21
      )
      select jsonb_build_object('items',coalesce((select jsonb_agg(x.card order by x.created_at desc,x.id desc)
        from (select * from rows order by created_at desc,id desc limit 20) x),'[]'::jsonb),
        'has_more',(select count(*) from rows)>20) into result;
    else
      with rows as (
        select t.id,t.updated_at,case when t.user_low=actor then t.user_high else t.user_low end partner
        from podmena.chat_threads t where actor in (t.user_low,t.user_high)
        order by t.updated_at desc,t.id desc offset page*20 limit 21
      ), cards as (
        select t.id,t.updated_at,jsonb_build_object(
          'thread_id',t.id,'name',podmena.chat_display_name(t.partner),'updated_at',t.updated_at,
          'blocked',podmena.chat_is_blocked(actor,t.partner),
          'blocked_by_me',exists(select from podmena.chat_blocks b where b.blocker_id=actor and b.blocked_id=t.partner),
          'can_send',podmena.chat_thread_access(t.id) and not podmena.chat_is_blocked(actor,t.partner),
          'unread_count',(select count(*) from podmena.chat_messages m
            where m.thread_id=t.id and m.sender_id<>actor and m.ordinal>coalesce(
              (select rs.read_ordinal from podmena.chat_read_states rs where rs.thread_id=t.id and rs.user_id=actor),0))) card
        from (select * from rows order by updated_at desc,id desc limit 20) t
      )
      select jsonb_build_object('items',coalesce((select jsonb_agg(card order by updated_at desc,id desc) from cards),'[]'::jsonb),
        'has_more',(select count(*) from rows)>20) into result;
    end if;
    return result;
  end if;

  -- Resolve the other participant only through an object belonging to this session actor.
  -- Author IDs and arbitrary user IDs from the browser are not used.
  if p_action in ('request_contact','report') and p_input ? 'catalog_id' then
    if not exists(select from podmena.manager_profiles m where m.user_id=actor) then
      raise sqlstate 'PT403' using message='actor_missing_manager_profile';
    end if;
    select c.user_id into other_id from podmena.worker_catalog c
      where c.id=(p_input->>'catalog_id')::uuid and c.visible and c.user_id<>actor;
  elsif p_action in ('decide_contact','block','unblock','report') and p_input ? 'request_id' and not p_input ? 'thread_id' then
    select r.* into request_row from podmena.contact_requests r
      where r.id=(p_input->>'request_id')::uuid and actor in (r.manager_id,r.worker_id);
    if p_action<>'decide_contact' or request_row.worker_id=actor then
      other_id := case when request_row.manager_id=actor then request_row.worker_id else request_row.manager_id end;
    end if;
  elsif p_action='shift_thread' then
    target_id := (p_input->>'shift_id')::uuid;
    app_id := (p_input->>'application_id')::uuid;
    select s.* into selected_shift from podmena.shifts s
      where s.id=target_id and (s.manager_id=actor or exists(select from podmena.shift_applications a
        where a.id=app_id and a.shift_id=s.id and a.worker_id=actor));
    select a.* into selected_app from podmena.shift_applications a where a.shift_id=selected_shift.id and a.id=app_id;
    if selected_app.id is not null and podmena.chat_shift_access(selected_shift,selected_app) then
      other_id := case when selected_shift.manager_id=actor then selected_app.worker_id else selected_shift.manager_id end;
    end if;
  elsif p_action in ('messages','send_message','mark_read','block','unblock','report') then
    chat_id := (p_input->>'thread_id')::uuid;
    select case when t.user_low=actor then t.user_high else t.user_low end into other_id
      from podmena.chat_threads t where t.id=chat_id and actor in (t.user_low,t.user_high);
  else
    raise sqlstate 'PT400' using message='invalid_request';
  end if;
  if other_id is null or other_id=actor then raise sqlstate 'PT404' using message='not_found'; end if;

  -- Account-level rate limits and relationship updates have a fixed lock order.
  -- Separate hash namespaces keep an account lock independent of a pair lock.
  if p_action in ('send_message','request_contact','report') then
    perform pg_advisory_xact_lock(204231,hashtext(actor::text));
  end if;
  lower_id := least(actor,other_id);
  higher_id := greatest(actor,other_id);
  if p_action not in ('messages','mark_read') then
    perform pg_advisory_xact_lock(hashtextextended(lower_id::text||':'||higher_id::text,0));
  end if;
  blocked := podmena.chat_is_blocked(actor,other_id);
  blocked_by_me := exists(select from podmena.chat_blocks b where b.blocker_id=actor and b.blocked_id=other_id);

  if p_action='request_contact' then
    -- Recheck visibility under the pair lock. An opt-out in progress must finish first.
    perform from podmena.worker_catalog c where c.user_id=other_id
      and c.id=(p_input->>'catalog_id')::uuid and c.visible for share;
    if not found then raise sqlstate 'PT404' using message='not_found'; end if;
    if blocked then raise sqlstate 'PT409' using message='blocked'; end if;
    select r.* into request_row from podmena.contact_requests r
      where least(r.manager_id,r.worker_id)=lower_id and greatest(r.manager_id,r.worker_id)=higher_id;
    if request_row.id is not null then
      if request_row.status='rejected' then raise sqlstate 'PT409' using message='contact_already_rejected'; end if;
      return jsonb_build_object('saved',true);
    end if;
    if (select count(*) from podmena.contact_requests r
        where r.manager_id=actor and r.created_at>clock_timestamp()-interval '1 hour')>=8 then
      raise sqlstate 'PT429' using message='rate_limited';
    end if;
    insert into podmena.contact_requests(manager_id,worker_id) values(actor,other_id) returning id into target_id;
    perform podmena.enqueue_notification(other_id,'connection_request','connection:'||target_id::text);
  elsif p_action='decide_contact' then
    decision := p_input->>'decision';
    if decision is null or decision not in ('accept','reject','block') then
      raise sqlstate 'PT400' using message='invalid_request';
    end if;
    select r.* into request_row from podmena.contact_requests r where r.id=request_row.id;
    if decision='accept' and request_row.status='accepted' and not blocked then
      return jsonb_build_object('saved',true,'thread_id',request_row.thread_id);
    end if;
    if decision='reject' and request_row.status='rejected' then return jsonb_build_object('saved',true); end if;
    if decision<>'block' and request_row.status<>'pending' then
      raise sqlstate 'PT409' using message='contact_already_decided';
    end if;
    if decision='block' then
      insert into podmena.chat_blocks(blocker_id,blocked_id) values(actor,other_id) on conflict do nothing;
      update podmena.contact_requests r set status='rejected' where r.id=request_row.id and r.status='pending';
    elsif decision='reject' then
      update podmena.contact_requests r set status='rejected' where r.id=request_row.id;
    else
      if blocked then raise sqlstate 'PT409' using message='blocked'; end if;
      insert into podmena.chat_threads(user_low,user_high) values(lower_id,higher_id)
        on conflict(user_low,user_high) do nothing;
      select t.id into chat_id from podmena.chat_threads t where t.user_low=lower_id and t.user_high=higher_id;
      update podmena.contact_requests r set status='accepted',thread_id=chat_id where r.id=request_row.id;
      return jsonb_build_object('saved',true,'thread_id',chat_id);
    end if;
  elsif p_action='shift_thread' then
    if blocked then raise sqlstate 'PT409' using message='blocked'; end if;
    -- Relationship writers lock the pair before any relevant shift. The 3Д
    -- transition RPC locks the shift before altering a related application.
    select s.* into selected_shift from podmena.shifts s where s.id=target_id for share;
    select a.* into selected_app from podmena.shift_applications a where a.shift_id=selected_shift.id and a.id=app_id;
    if selected_app.id is null or not podmena.chat_shift_access(selected_shift,selected_app) then
      raise sqlstate 'PT404' using message='not_found';
    end if;
    insert into podmena.chat_threads(user_low,user_high) values(lower_id,higher_id)
      on conflict(user_low,user_high) do nothing;
    select t.id into chat_id from podmena.chat_threads t where t.user_low=lower_id and t.user_high=higher_id;
    insert into podmena.chat_shift_links(shift_id,application_id,thread_id) values(target_id,app_id,chat_id)
      on conflict(application_id) do nothing;
    return jsonb_build_object('thread_id',chat_id);
  elsif p_action='messages' then
    if p_input ? 'before' then
      select m.ordinal into pos from podmena.chat_messages m where m.thread_id=chat_id and m.id=(p_input->>'before')::uuid;
      if pos is null then raise sqlstate 'PT404' using message='not_found'; end if;
    end if;
    with rows as (
      select m.ordinal,jsonb_build_object('message_id',m.id,'mine',m.sender_id=actor,
        'body',m.body,'created_at',m.created_at) card from podmena.chat_messages m
      where m.thread_id=chat_id and (pos is null or m.ordinal<pos) order by m.ordinal desc limit 41
    )
    select jsonb_build_object('items',coalesce((select jsonb_agg(x.card order by x.ordinal)
      from (select * from rows order by ordinal desc limit 40) x),'[]'::jsonb),
      'has_more',(select count(*) from rows)>40,'blocked',blocked,'blocked_by_me',blocked_by_me,
      'can_send',not blocked and podmena.chat_thread_access(chat_id)) into result;
    return result;
  elsif p_action='mark_read' then
    select m.ordinal into pos from podmena.chat_messages m where m.thread_id=chat_id and m.id=(p_input->>'message_id')::uuid;
    if pos is null then raise sqlstate 'PT404' using message='not_found'; end if;
    insert into podmena.chat_read_states(thread_id,user_id,read_ordinal) values(chat_id,actor,pos)
      on conflict(thread_id,user_id) do update set read_ordinal=greatest(chat_read_states.read_ordinal,excluded.read_ordinal);
  elsif p_action='send_message' then
    body := btrim(p_input->>'body');
    if body is null or char_length(body) not between 1 and 2000 or p_input->>'request_id' is null then
      raise sqlstate 'PT400' using message='invalid_request';
    end if;
    select m.* into old_message from podmena.chat_messages m
      where m.thread_id=chat_id and m.sender_id=actor and m.request_id=(p_input->>'request_id')::uuid;
    if old_message.id is not null then
      if old_message.body<>body then raise sqlstate 'PT409' using message='idempotency_conflict'; end if;
      return jsonb_build_object('saved',true,'message_id',old_message.id,'replayed',true);
    end if;
    if blocked then raise sqlstate 'PT409' using message='blocked'; end if;
    if not exists(select from podmena.contact_requests r where r.thread_id=chat_id and r.status='accepted') then
      -- Shift-driven threads need an active relationship even when a withdrawal
      -- or cancellation races a send. Recheck after the shared lock is granted.
      perform from podmena.chat_shift_links l
        join podmena.shifts s on s.id=l.shift_id
        join podmena.shift_applications a on a.shift_id=l.shift_id and a.id=l.application_id
        where l.thread_id=chat_id and podmena.chat_shift_access(s,a)
        order by s.id limit 1 for share of s;
      if not found or not podmena.chat_thread_access(chat_id) then
        raise sqlstate 'PT403' using message='forbidden';
      end if;
    end if;
    if (select count(*) from podmena.chat_messages m
        where m.sender_id=actor and m.created_at>clock_timestamp()-interval '10 seconds')>=6 then
      raise sqlstate 'PT429' using message='rate_limited';
    end if;
    insert into podmena.chat_messages(thread_id,sender_id,request_id,body)
      values(chat_id,actor,(p_input->>'request_id')::uuid,body) returning id into target_id;
    update podmena.chat_threads set updated_at=clock_timestamp() where id=chat_id;
    perform podmena.enqueue_notification(other_id,'chat_message','message:'||target_id::text);
    return jsonb_build_object('saved',true,'message_id',target_id);
  elsif p_action='block' then
    insert into podmena.chat_blocks(blocker_id,blocked_id) values(actor,other_id) on conflict do nothing;
    update podmena.contact_requests r set status='rejected'
      where least(r.manager_id,r.worker_id)=lower_id and greatest(r.manager_id,r.worker_id)=higher_id and r.status='pending';
  elsif p_action='unblock' then
    delete from podmena.chat_blocks b where b.blocker_id=actor and b.blocked_id=other_id;
  elsif p_action='report' then
    body := btrim(p_input->>'reason');
    if body is null or char_length(body) not between 1 and 500 then raise sqlstate 'PT400' using message='invalid_request'; end if;
    if exists(select from podmena.chat_reports r where r.reporter_id=actor and r.reported_id=other_id) then
      return jsonb_build_object('saved',true);
    end if;
    if (select count(*) from podmena.chat_reports r
        where r.reporter_id=actor and r.created_at>clock_timestamp()-interval '1 day')>=8 then
      raise sqlstate 'PT429' using message='rate_limited';
    end if;
    insert into podmena.chat_reports(reporter_id,reported_id,thread_id,contact_request_id,reason)
      values(actor,other_id,chat_id,request_row.id,body) on conflict do nothing;
  end if;
  return jsonb_build_object('saved',true);
end;
$$;

revoke all on function public.podmena_social_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.podmena_social_action(text,text,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
