alter table podmena.shifts
  add column time_zone text not null default 'Europe/Moscow',
  add column request_id uuid,
  add constraint shifts_manager_request_unique unique (manager_id, request_id),
  add constraint shifts_time_zone_check check (time_zone in (
    'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg',
    'Asia/Omsk', 'Asia/Novosibirsk', 'Asia/Irkutsk', 'Asia/Yakutsk',
    'Asia/Vladivostok', 'Asia/Magadan', 'Asia/Kamchatka'
  ));

create index shifts_open_starts_at_idx on podmena.shifts (starts_at, id) where status = 'open';

-- Explicit projection shared by the three lists. Account IDs and request IDs stay private.
create function podmena.shift_card(s podmena.shifts)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'platform', s.platform, 'city', s.city, 'district', s.district,
    'pickup_point', s.pickup_point, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
    'time_zone', s.time_zone, 'pay_rubles', s.pay_rubles, 'notes', s.notes, 'status', s.status
  )
$$;

revoke all on function podmena.shift_card(podmena.shifts) from public, anon, authenticated, service_role;

create function public.podmena_shift_action(p_token_hash text, p_action text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  target_id uuid;
  application_id uuid;
  picked_shift podmena.shifts%rowtype;
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
        'applied', a.id is not null
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
        'application_count', (select count(*) from podmena.shift_applications as a where a.shift_id = s.id)
      ) as card
      from podmena.shifts as s where s.manager_id = actor
      order by s.created_at desc, s.id desc limit 31 offset page_offset
    ) as r;
    return jsonb_build_object('items', items);
  end if;

  if p_action = 'outgoing' then
    select coalesce(jsonb_agg(r.card order by r.created_at desc, r.id desc), '[]'::jsonb) into items
    from (
      select a.id, a.created_at, podmena.shift_card(s) || jsonb_build_object(
        'application_status', case
          when s.status = 'cancelled' then 'cancelled'
          when s.confirmed_application_id = a.id then 'selected'
          when s.confirmed_application_id is not null then 'not_selected'
          when s.starts_at <= now() then 'closed'
          else 'pending'
        end
      ) as card
      from podmena.shift_applications as a join podmena.shifts as s on s.id = a.shift_id
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
      ) as card
      from podmena.shifts as s
      join podmena.shift_applications as a on a.shift_id = s.id
      join podmena.worker_profiles as w on w.user_id = a.worker_id
      where s.id = target_id and s.manager_id = actor
      order by a.created_at, a.id limit 31 offset page_offset
    ) as r;
    if not exists (select from podmena.shifts as s where s.id = target_id and s.manager_id = actor) then
      raise sqlstate 'PT404' using message = 'shift_not_found';
    end if;
    return jsonb_build_object('items', items);
  end if;

  if p_action not in ('apply', 'confirm', 'cancel', 'complete') or p_action is null then
    raise sqlstate 'PT400' using message = 'invalid_request';
  end if;

  -- Applying and all status changes lock the same shift, serializing competing requests.
  select s.* into picked_shift from podmena.shifts as s
    where s.id = target_id and (p_action = 'apply' or s.manager_id = actor)
    for update;
  if not found then
    raise sqlstate 'PT404' using message = 'shift_not_found';
  end if;

  if p_action = 'apply' then
    if picked_shift.manager_id = actor then
      raise sqlstate 'PT403' using message = 'cannot_apply_to_own_shift';
    end if;
    if not exists (select from podmena.worker_profiles as w where w.user_id = actor) then
      raise sqlstate 'PT403' using message = 'worker_profile_required';
    end if;
    if exists (select from podmena.shift_applications as a where a.shift_id = target_id and a.worker_id = actor) then
      return jsonb_build_object('saved', true);
    end if;
    if picked_shift.status <> 'open' or picked_shift.starts_at <= clock_timestamp() then
      raise sqlstate 'PT409' using message = 'shift_not_open';
    end if;
    insert into podmena.shift_applications (shift_id, worker_id) values (target_id, actor)
      on conflict (shift_id, worker_id) do nothing;
  elsif p_action = 'confirm' then
    application_id := (p_input->>'application_id')::uuid;
    if picked_shift.status = 'confirmed' and picked_shift.confirmed_application_id = application_id then
      return jsonb_build_object('saved', true);
    end if;
    if picked_shift.status <> 'open' or picked_shift.starts_at <= clock_timestamp() then
      raise sqlstate 'PT409' using message = 'shift_not_open';
    end if;
    if not exists (select from podmena.shift_applications as a where a.shift_id = target_id and a.id = application_id) then
      raise sqlstate 'PT404' using message = 'application_not_found';
    end if;
    update podmena.shifts set status = 'confirmed', confirmed_application_id = application_id,
      confirmed_at = clock_timestamp() where id = target_id;
  elsif p_action = 'cancel' then
    if picked_shift.status = 'cancelled' then return jsonb_build_object('saved', true); end if;
    if picked_shift.status <> 'open' then raise sqlstate 'PT409' using message = 'shift_not_open'; end if;
    update podmena.shifts set status = 'cancelled' where id = target_id;
  else
    if picked_shift.status = 'completed' then return jsonb_build_object('saved', true); end if;
    if picked_shift.status <> 'confirmed' or picked_shift.ends_at > clock_timestamp() then
      raise sqlstate 'PT409' using message = 'shift_not_ready_to_complete';
    end if;
    update podmena.shifts set status = 'completed', completed_at = clock_timestamp() where id = target_id;
  end if;

  return jsonb_build_object('saved', true);
end;
$$;

revoke all on function public.podmena_shift_action(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.podmena_shift_action(text, text, jsonb) to service_role;
