begin;

alter table podmena.shift_applications
  add column withdrawn_at timestamptz,
  add column declined_at timestamptz,
  add constraint shift_application_single_end check (num_nonnulls(withdrawn_at, declined_at) <= 1);

alter table podmena.shifts
  add column replacement_application_id uuid,
  add constraint replacement_application_matches_shift foreign key (id, replacement_application_id)
    references podmena.shift_applications (shift_id, id),
  drop constraint shifts_check1,
  add constraint shifts_assignment_state check (
    (status in ('open', 'cancelled', 'needs_replacement') and confirmed_application_id is null
      and confirmed_at is null and completed_at is null)
    or
    (status = 'confirmed' and confirmed_application_id is not null and confirmed_at is not null and completed_at is null)
    or
    (status = 'completed' and confirmed_application_id is not null and confirmed_at is not null
      and completed_at is not null and completed_at >= greatest(confirmed_at, ends_at))
  ),
  add constraint shifts_replacement_state check (
    (status = 'needs_replacement') = (replacement_application_id is not null)
  );

create table podmena.shift_events (
  id bigint generated always as identity primary key,
  shift_id uuid not null references podmena.shifts (id),
  application_id uuid,
  actor_id uuid not null references podmena.telegram_users (id),
  action text not null check (action in ('assigned', 'withdrawn', 'declined', 'reopened', 'cancelled')),
  happened_at timestamptz not null default clock_timestamp(),
  reason text check (char_length(reason) <= 500),
  foreign key (shift_id, application_id) references podmena.shift_applications (shift_id, id),
  unique nulls not distinct (shift_id, action, application_id),
  check (action = 'cancelled' or application_id is not null)
);

alter table podmena.shift_events enable row level security;
revoke all on podmena.shift_events from public, anon, authenticated, service_role;

-- Existing confirmations have a known owner and timestamp. Old cancellations
-- have no recorded timestamp or reason and are left as they are.
insert into podmena.shift_events (shift_id, application_id, actor_id, action, happened_at)
select s.id, s.confirmed_application_id, s.manager_id, 'assigned', s.confirmed_at
from podmena.shifts as s where s.confirmed_application_id is not null;

create or replace function public.podmena_shift_action(p_token_hash text, p_action text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  target_id uuid;
  requested_application_id uuid;
  picked_shift podmena.shifts%rowtype;
  own_application podmena.shift_applications%rowtype;
  event_time timestamptz;
  event_reason text;
  items jsonb;
  requested_zone text;
  work_date date;
  start_time time;
  end_time time;
  starts timestamptz;
  ends timestamptz;
  page_offset integer;
begin
  select s.user_id into actor from public.podmena_get_session_user(p_token_hash) as s;
  if actor is null then
    raise sqlstate 'PT401' using message = 'session_expired';
  end if;

  page_offset := coalesce((p_input->>'page')::integer, 0) * 30;

  if p_action = 'browse' then
    select coalesce(jsonb_agg(r.card order by r.starts_at, r.id), '[]'::jsonb) into items
    from (
      select s.id, s.starts_at, podmena.shift_card(s) || jsonb_build_object(
        'can_apply', s.manager_id <> actor and a.id is null
          and exists (select from podmena.worker_profiles as w where w.user_id = actor),
        'own_shift', s.manager_id = actor,
        'applied', a.id is not null and a.withdrawn_at is null and a.declined_at is null,
        'inactive_application', case when a.withdrawn_at is not null then 'withdrawn'
          when a.declined_at is not null then 'declined' end
      ) as card
      from podmena.shifts as s
      left join podmena.shift_applications as a on a.shift_id = s.id and a.worker_id = actor
      where s.status = 'open' and s.starts_at > now()
        and (p_input->>'platform' is null or s.platform = (p_input->>'platform')::podmena.platform)
        and position(lower(coalesce(p_input->>'city', '')) in lower(s.city)) > 0
        and position(lower(coalesce(p_input->>'district', '')) in lower(s.district)) > 0
      order by s.starts_at, s.id limit 31 offset page_offset
    ) as r;
    return jsonb_build_object('items', items);
  end if;

  if p_action = 'owned' then
    select coalesce(jsonb_agg(r.card order by r.created_at desc, r.id desc), '[]'::jsonb) into items
    from (
      select s.id, s.created_at, podmena.shift_card(s) || jsonb_build_object(
        'application_count', (select count(*) from podmena.shift_applications as a where a.shift_id = s.id),
        'confirmed_application_id', s.confirmed_application_id,
        'replacement_application_id', s.replacement_application_id,
        'can_reopen', s.status = 'needs_replacement' and s.starts_at > now(),
        'cancelled_at', e.happened_at, 'cancellation_reason', e.reason
      ) as card
      from podmena.shifts as s
      left join podmena.shift_events as e on e.shift_id = s.id and e.action = 'cancelled'
      where s.manager_id = actor
      order by s.created_at desc, s.id desc limit 31 offset page_offset
    ) as r;
    return jsonb_build_object('items', items);
  end if;

  if p_action = 'outgoing' then
    select coalesce(jsonb_agg(r.card order by r.created_at desc, r.id desc), '[]'::jsonb) into items
    from (
      select a.id, a.created_at, podmena.shift_card(s) || jsonb_build_object(
        'application_id', a.id,
        'can_withdraw', s.status not in ('completed', 'cancelled') and a.withdrawn_at is null
          and a.declined_at is null and s.confirmed_application_id is distinct from a.id,
        'can_decline', s.status = 'confirmed' and s.confirmed_application_id is not distinct from a.id,
        'withdrawn_at', a.withdrawn_at, 'declined_at', a.declined_at,
        'decline_reason', d.reason, 'cancelled_at', c.happened_at, 'cancellation_reason', c.reason,
        'application_status', case
          when a.withdrawn_at is not null then 'withdrawn'
          when a.declined_at is not null then 'declined'
          when s.status = 'cancelled' then 'cancelled'
          when s.confirmed_application_id = a.id then 'selected'
          when s.confirmed_application_id is not null then 'not_selected'
          when s.starts_at <= now() then 'closed'
          else 'pending'
        end
      ) as card
      from podmena.shift_applications as a join podmena.shifts as s on s.id = a.shift_id
      left join podmena.shift_events as d on d.shift_id = s.id and d.application_id = a.id and d.action = 'declined'
      left join podmena.shift_events as c on c.shift_id = s.id and c.action = 'cancelled'
      where a.worker_id = actor
      order by a.created_at desc, a.id desc limit 31 offset page_offset
    ) as r;
    return jsonb_build_object('items', items);
  end if;

  if p_action = 'create' then
    if not exists (select from podmena.manager_profiles as m where m.user_id = actor) then
      raise sqlstate 'PT403' using message = 'manager_profile_required';
    end if;

    select s.id into target_id from podmena.shifts as s
    where s.manager_id = actor and s.request_id = (p_input->>'request_id')::uuid;
    if target_id is not null then
      return jsonb_build_object('id', target_id);
    end if;

    work_date := (p_input->>'date')::date;
    start_time := (p_input->>'start_time')::time;
    end_time := (p_input->>'end_time')::time;
    requested_zone := p_input->>'time_zone';
    starts := (work_date + start_time) at time zone requested_zone;
    ends := ((work_date + case when end_time < start_time then 1 else 0 end) + end_time)
      at time zone requested_zone;

    if starts <= clock_timestamp() or ends <= starts then
      raise sqlstate 'PT400' using message = 'invalid_shift_time';
    end if;

    insert into podmena.shifts (manager_id, platform, city, district, pickup_point,
      starts_at, ends_at, time_zone, pay_rubles, notes, request_id)
    values (actor, (p_input->>'platform')::podmena.platform, p_input->>'city', p_input->>'district',
      p_input->>'pickup_point', starts, ends, requested_zone,
      (p_input->>'pay_rubles')::integer, p_input->>'notes', (p_input->>'request_id')::uuid)
    on conflict (manager_id, request_id) do nothing returning id into target_id;

    if target_id is null then
      select s.id into target_id from podmena.shifts as s
      where s.manager_id = actor and s.request_id = (p_input->>'request_id')::uuid;
    end if;
    return jsonb_build_object('id', target_id);
  end if;

  target_id := (p_input->>'shift_id')::uuid;
  if p_action = 'respondents' then
    -- The join checks ownership in the same query that reads applicants.
    select coalesce(jsonb_agg(r.card order by r.created_at, r.id), '[]'::jsonb) into items
    from (
      select a.id, a.created_at, jsonb_build_object(
        'id', a.id, 'name', w.name, 'city', w.city, 'district', w.district,
        'experience', w.experience, 'selected', s.confirmed_application_id is not distinct from a.id,
        'can_confirm', s.status = 'open' and s.starts_at > now()
          and a.withdrawn_at is null and a.declined_at is null,
        'withdrawn_at', a.withdrawn_at, 'declined_at', a.declined_at,
        'assigned_at', h.happened_at, 'decline_reason', d.reason
      ) as card
      from podmena.shifts as s
      join podmena.shift_applications as a on a.shift_id = s.id
      join podmena.worker_profiles as w on w.user_id = a.worker_id
      left join podmena.shift_events as h on h.shift_id = s.id and h.application_id = a.id and h.action = 'assigned'
      left join podmena.shift_events as d on d.shift_id = s.id and d.application_id = a.id and d.action = 'declined'
      where s.id = target_id and s.manager_id = actor
      order by a.created_at, a.id limit 31 offset page_offset
    ) as r;
    if not exists (select from podmena.shifts as s where s.id = target_id and s.manager_id = actor) then
      raise sqlstate 'PT404' using message = 'shift_not_found';
    end if;
    return jsonb_build_object('items', items);
  end if;

  if p_action not in ('apply', 'confirm', 'cancel', 'complete', 'withdraw', 'decline', 'reopen') or p_action is null then
    raise sqlstate 'PT400' using message = 'invalid_request';
  end if;

  -- All writers acquire the shift lock first. Requests re-check the resulting state under that lock.
  select s.* into picked_shift from podmena.shifts as s
    where s.id = target_id and (p_action in ('apply', 'withdraw', 'decline') or s.manager_id = actor)
    for update;
  if not found then
    raise sqlstate 'PT404' using message = 'shift_not_found';
  end if;

  event_time := clock_timestamp();
  requested_application_id := (p_input->>'application_id')::uuid;
  event_reason := nullif(btrim(p_input->>'reason'), '');

  if p_action = 'apply' then
    if picked_shift.manager_id = actor then
      raise sqlstate 'PT403' using message = 'cannot_apply_to_own_shift';
    end if;
    if not exists (select from podmena.worker_profiles as w where w.user_id = actor) then
      raise sqlstate 'PT403' using message = 'worker_profile_required';
    end if;
    select a.* into own_application from podmena.shift_applications as a
      where a.shift_id = target_id and a.worker_id = actor;
    if found then
      if own_application.withdrawn_at is not null or own_application.declined_at is not null then
        raise sqlstate 'PT409' using message = 'application_inactive';
      end if;
      return jsonb_build_object('saved', true);
    end if;
    if picked_shift.status <> 'open' or picked_shift.starts_at <= event_time then
      raise sqlstate 'PT409' using message = 'shift_not_open';
    end if;
    insert into podmena.shift_applications (shift_id, worker_id) values (target_id, actor)
      on conflict (shift_id, worker_id) do nothing;

  elsif p_action = 'confirm' then
    if picked_shift.status = 'confirmed' and picked_shift.confirmed_application_id = requested_application_id then
      return jsonb_build_object('saved', true);
    end if;
    if picked_shift.status <> 'open' or picked_shift.starts_at <= event_time then
      raise sqlstate 'PT409' using message = 'shift_not_open';
    end if;
    select a.* into own_application from podmena.shift_applications as a
      where a.shift_id = target_id and a.id = requested_application_id;
    if not found then raise sqlstate 'PT404' using message = 'application_not_found'; end if;
    if own_application.withdrawn_at is not null or own_application.declined_at is not null then
      raise sqlstate 'PT409' using message = 'application_inactive';
    end if;
    update podmena.shifts set status = 'confirmed', confirmed_application_id = requested_application_id,
      confirmed_at = event_time where id = target_id;
    insert into podmena.shift_events (shift_id, application_id, actor_id, action, happened_at)
      values (target_id, requested_application_id, actor, 'assigned', event_time);

  elsif p_action in ('withdraw', 'decline') then
    select a.* into own_application from podmena.shift_applications as a
      where a.shift_id = target_id and a.id = requested_application_id and a.worker_id = actor;
    if not found then raise sqlstate 'PT404' using message = 'application_not_found'; end if;
    if (p_action = 'withdraw' and own_application.withdrawn_at is not null)
      or (p_action = 'decline' and own_application.declined_at is not null) then
      return jsonb_build_object('saved', true, 'replayed', true);
    end if;
    if own_application.withdrawn_at is not null or own_application.declined_at is not null then
      raise sqlstate 'PT409' using message = 'application_inactive';
    end if;
    if picked_shift.status in ('completed', 'cancelled') then
      raise sqlstate 'PT409' using message = 'shift_terminal';
    end if;
    if p_action = 'withdraw' then
      if picked_shift.confirmed_application_id = requested_application_id then
        raise sqlstate 'PT409' using message = 'application_already_selected';
      end if;
      update podmena.shift_applications set withdrawn_at = event_time where id = requested_application_id;
      insert into podmena.shift_events (shift_id, application_id, actor_id, action, happened_at)
        values (target_id, requested_application_id, actor, 'withdrawn', event_time);
    else
      if picked_shift.status <> 'confirmed' or picked_shift.confirmed_application_id is distinct from requested_application_id then
        raise sqlstate 'PT409' using message = 'application_not_selected';
      end if;
      update podmena.shift_applications set declined_at = event_time where id = requested_application_id;
      update podmena.shifts set status = 'needs_replacement', replacement_application_id = requested_application_id,
        confirmed_application_id = null, confirmed_at = null where id = target_id;
      insert into podmena.shift_events (shift_id, application_id, actor_id, action, happened_at, reason)
        values (target_id, requested_application_id, actor, 'declined', event_time, event_reason);
    end if;

  elsif p_action = 'reopen' then
    if exists (select from podmena.shift_events as e
      where e.shift_id = target_id and e.application_id = requested_application_id and e.action = 'reopened') then
      return jsonb_build_object('saved', true, 'replayed', true);
    end if;
    if picked_shift.status <> 'needs_replacement' or picked_shift.replacement_application_id is distinct from requested_application_id then
      raise sqlstate 'PT409' using message = 'shift_state_changed';
    end if;
    if picked_shift.starts_at <= event_time then
      raise sqlstate 'PT409' using message = 'shift_already_started';
    end if;
    update podmena.shifts set status = 'open', replacement_application_id = null where id = target_id;
    insert into podmena.shift_events (shift_id, application_id, actor_id, action, happened_at)
      values (target_id, requested_application_id, actor, 'reopened', event_time);

  elsif p_action = 'cancel' then
    if picked_shift.status = 'cancelled' then return jsonb_build_object('saved', true, 'replayed', true); end if;
    if picked_shift.status = 'completed' then raise sqlstate 'PT409' using message = 'shift_terminal'; end if;
    requested_application_id := coalesce(picked_shift.confirmed_application_id, picked_shift.replacement_application_id);
    -- Do not cancel a freshly assigned shift after the client saw an empty seat.
    if requested_application_id is distinct from (p_input->>'expected_application_id')::uuid then
      raise sqlstate 'PT409' using message = 'shift_state_changed';
    end if;
    update podmena.shifts set status = 'cancelled', confirmed_application_id = null, confirmed_at = null,
      replacement_application_id = null where id = target_id;
    insert into podmena.shift_events (shift_id, application_id, actor_id, action, happened_at, reason)
      values (target_id, requested_application_id, actor, 'cancelled', event_time, event_reason);

  else
    if picked_shift.status = 'completed' then return jsonb_build_object('saved', true); end if;
    if picked_shift.status <> 'confirmed' or picked_shift.ends_at > event_time then
      raise sqlstate 'PT409' using message = 'shift_not_ready_to_complete';
    end if;
    update podmena.shifts set status = 'completed', completed_at = event_time where id = target_id;
  end if;

  return jsonb_build_object('saved', true);
end;
$$;

revoke all on function public.podmena_shift_action(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.podmena_shift_action(text, text, jsonb) to service_role;

commit;
