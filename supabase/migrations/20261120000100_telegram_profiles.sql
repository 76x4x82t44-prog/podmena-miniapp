-- Only the Edge Function may call the RPCs. In each transaction, the owner
-- comes from the active session, never from a profile payload.
create function public.podmena_read_profiles(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
begin
  select s.user_id into owner_id
  from public.podmena_get_session_user(p_token_hash) as s;
  if owner_id is null then
    raise sqlstate 'PT401' using message = 'Invalid or expired session';
  end if;

  return jsonb_build_object(
    'worker', (select jsonb_build_object(
      'name', w.name, 'city', w.city, 'district', w.district,
      'platforms', w.platforms, 'experience', w.experience,
      'accepts_single_shifts', w.accepts_single_shifts,
      'accepts_permanent_work', w.accepts_permanent_work, 'about', w.about
    ) from podmena.worker_profiles as w where w.user_id = owner_id),
    'manager', (select jsonb_build_object(
      'name', m.name, 'city', m.city, 'district', m.district,
      'pickup_point', m.pickup_point, 'platform', m.platform, 'conditions', m.conditions
    ) from podmena.manager_profiles as m where m.user_id = owner_id),
    'contacts', (select jsonb_build_object(
      'worker', c.worker_phone, 'manager', c.manager_contact
    ) from podmena.private_contacts as c where c.user_id = owner_id)
  );
end;
$$;

create function public.podmena_save_profile(
  p_token_hash text,
  p_role text,
  p_profile jsonb,
  p_contact text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
begin
  select s.user_id into owner_id
  from public.podmena_get_session_user(p_token_hash) as s;
  if owner_id is null then
    raise sqlstate 'PT401' using message = 'Invalid or expired session';
  end if;

  -- An empty contact clears the field. NULL leaves its previous value intact.
  if p_role = 'worker' then
    insert into podmena.worker_profiles (
      user_id, name, city, district, platforms, experience,
      accepts_single_shifts, accepts_permanent_work, about
    ) values (
      owner_id, p_profile->>'name', p_profile->>'city', p_profile->>'district',
      array(select v::podmena.platform from jsonb_array_elements_text(p_profile->'platforms') as v),
      p_profile->>'experience', (p_profile->>'accepts_single_shifts')::boolean,
      (p_profile->>'accepts_permanent_work')::boolean, p_profile->>'about'
    )
    on conflict (user_id) do update set
      name = excluded.name, city = excluded.city, district = excluded.district,
      platforms = excluded.platforms, experience = excluded.experience,
      accepts_single_shifts = excluded.accepts_single_shifts,
      accepts_permanent_work = excluded.accepts_permanent_work, about = excluded.about;

    if p_contact is not null then
      insert into podmena.private_contacts (user_id, worker_phone)
      values (owner_id, nullif(p_contact, ''))
      on conflict (user_id) do update set worker_phone = excluded.worker_phone;
    end if;
  elsif p_role = 'manager' then
    insert into podmena.manager_profiles (
      user_id, name, city, district, pickup_point, platform, conditions
    ) values (
      owner_id, p_profile->>'name', p_profile->>'city', p_profile->>'district',
      p_profile->>'pickup_point', (p_profile->>'platform')::podmena.platform,
      p_profile->>'conditions'
    )
    on conflict (user_id) do update set
      name = excluded.name, city = excluded.city, district = excluded.district,
      pickup_point = excluded.pickup_point, platform = excluded.platform,
      conditions = excluded.conditions;

    if p_contact is not null then
      insert into podmena.private_contacts (user_id, manager_contact)
      values (owner_id, nullif(p_contact, ''))
      on conflict (user_id) do update set manager_contact = excluded.manager_contact;
    end if;
  else
    raise sqlstate 'PT400' using message = 'Invalid profile role';
  end if;

  return true;
end;
$$;

revoke all on function public.podmena_read_profiles(text) from public, anon, authenticated, service_role;
revoke all on function public.podmena_save_profile(text, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.podmena_read_profiles(text) to service_role;
grant execute on function public.podmena_save_profile(text, text, jsonb, text) to service_role;
