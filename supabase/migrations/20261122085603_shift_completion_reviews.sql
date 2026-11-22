begin;

create table podmena.shift_completions (
  shift_id uuid primary key references podmena.shifts (id),
  application_id uuid not null,
  requested_at timestamptz,
  decision text not null default 'pending' check (decision in ('pending', 'confirmed', 'disputed')),
  decided_at timestamptz,
  dispute_reason text check (char_length(dispute_reason) between 1 and 500),
  foreign key (shift_id, application_id) references podmena.shift_applications (shift_id, id),
  check (requested_at is not null or decision = 'disputed'),
  check ((decision = 'pending') = (decided_at is null)),
  check ((decision = 'disputed') = (dispute_reason is not null)),
  check (decided_at is null or requested_at is null or decided_at >= requested_at)
);

create table podmena.shift_reviews (
  shift_id uuid not null references podmena.shift_completions (shift_id),
  author_id uuid not null references podmena.telegram_users (id),
  subject_id uuid not null references podmena.telegram_users (id),
  subject_role text not null check (subject_role in ('worker', 'manager')),
  stars smallint not null check (stars between 1 and 5),
  comment text not null default '' check (char_length(comment) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  primary key (shift_id, author_id),
  check (author_id <> subject_id)
);

create index shift_reviews_recipient_idx
  on podmena.shift_reviews (subject_id, subject_role, created_at desc, shift_id);

alter table podmena.shift_completions enable row level security;
alter table podmena.shift_reviews enable row level security;
revoke all on podmena.shift_completions, podmena.shift_reviews from public, anon, authenticated, service_role;

-- Keep the tested 3D lifecycle intact as an internal function. The public RPC
-- retains its signature so the page and the existing Edge Function keep their endpoint.
alter function public.podmena_shift_action(text, text, jsonb) set schema podmena;
alter function podmena.podmena_shift_action(text, text, jsonb) rename to shift_action_lifecycle;
revoke all on function podmena.shift_action_lifecycle(text, text, jsonb) from public, anon, authenticated, service_role;

create function podmena.completed_shifts_for(p_actor uuid)
returns table (shift_id uuid, viewer_role text)
language sql stable set search_path = ''
as $$
  select s.id, 'manager'::text
  from podmena.shifts as s where s.manager_id = p_actor and s.status = 'completed'
  union all
  select s.id, 'worker'::text
  from podmena.shift_applications as a
  join podmena.shifts as s on s.id = a.shift_id and s.confirmed_application_id = a.id
  where a.worker_id = p_actor and s.status = 'completed' and s.manager_id <> p_actor;
$$;

revoke all on function podmena.completed_shifts_for(uuid) from public, anon, authenticated, service_role;

create function public.podmena_shift_action(p_token_hash text, p_action text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  shift_id_input uuid;
  listing podmena.shifts%rowtype;
  completion podmena.shift_completions%rowtype;
  existing_review podmena.shift_reviews%rowtype;
  worker_id uuid;
  event_time timestamptz;
  body jsonb;
  reason text;
  review_stars smallint;
  review_comment text;
  review_subject uuid;
  review_role text;
begin
  if p_action not in ('complete', 'request_completion', 'confirm_completion', 'dispute_completion', 'review',
                     'work_history', 'reputation', 'owned', 'outgoing', 'cancel', 'decline') then
    return podmena.shift_action_lifecycle(p_token_hash, p_action, p_input);
  end if;

  select u.user_id into actor from public.podmena_get_session_user(p_token_hash) as u;
  if actor is null then raise sqlstate 'PT401' using message = 'session_expired'; end if;
  -- A previous client treats a successful "complete" as final. Fail closed during rollout.
  if p_action = 'complete' then raise sqlstate 'PT409' using message = 'completion_client_update'; end if;

  if p_action = 'work_history' then
    select jsonb_build_object('items', coalesce(jsonb_agg(x.card order by x.completed_at desc, x.id desc), '[]'::jsonb))
    into body from (
      select s.id, s.completed_at, podmena.shift_card(s) || jsonb_build_object(
        'viewer_role', h.viewer_role, 'completed_at', s.completed_at,
        'minutes', floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer,
        'completion_state', case when c.decision = 'confirmed' then 'confirmed' else 'legacy' end,
        'can_review', c.decision is not distinct from 'confirmed' and r.author_id is null,
        'review', case when r.author_id is not null then jsonb_build_object('stars', r.stars, 'comment', r.comment) end
      ) as card
      from podmena.completed_shifts_for(actor) as h
      join podmena.shifts as s on s.id = h.shift_id
      left join podmena.shift_completions as c on c.shift_id = s.id
      left join podmena.shift_reviews as r on r.shift_id = s.id and r.author_id = actor
      order by s.completed_at desc, s.id desc
      limit 31 offset coalesce((p_input->>'page')::integer, 0) * 30
    ) as x;
    return body;
  end if;

  if p_action = 'reputation' then
    select jsonb_object_agg(role_names.role, jsonb_build_object(
      'average', (select round(avg(r.stars), 1) from podmena.shift_reviews as r
                  where r.subject_id = actor and r.subject_role = role_names.role),
      'review_count', (select count(*) from podmena.shift_reviews as r
                       where r.subject_id = actor and r.subject_role = role_names.role),
      'completed_count', (select count(*) from podmena.completed_shifts_for(actor) as h
                          join podmena.shift_completions as c on c.shift_id = h.shift_id
                          where h.viewer_role = role_names.role and c.decision = 'confirmed'),
      'reviews', (select coalesce(jsonb_agg(x.card order by x.created_at desc, x.shift_id), '[]'::jsonb)
                  from (
                    select r.created_at, r.shift_id, jsonb_build_object(
                      'stars', r.stars, 'comment', r.comment, 'created_at', r.created_at
                    ) as card
                    from podmena.shift_reviews as r
                    where r.subject_id = actor and r.subject_role = role_names.role
                    order by r.created_at desc, r.shift_id limit 10
                  ) as x)
    )) into body from (values ('worker'), ('manager')) as role_names(role);
    return body;
  end if;

  if p_action in ('owned', 'outgoing') then
    body := podmena.shift_action_lifecycle(p_token_hash, p_action, p_input);
    select jsonb_build_object('items', coalesce(jsonb_agg(
      j.card || case when s.manager_id = actor or a.worker_id = actor then jsonb_build_object(
        'completion_state', case when s.status = 'completed' and c.shift_id is null then 'legacy' else c.decision end,
        'dispute_reason', c.dispute_reason,
        'can_request_completion', s.manager_id = actor and s.status = 'confirmed' and c.shift_id is null and s.ends_at <= now(),
        'can_confirm_completion', a.worker_id = actor and s.status = 'confirmed' and c.decision = 'pending',
        'can_dispute_completion', a.worker_id = actor and s.status = 'confirmed' and s.ends_at <= now()
          and (c.shift_id is null or c.decision = 'pending')
      ) else '{}'::jsonb end order by j.ord
    ), '[]'::jsonb)) into body
    from jsonb_array_elements(body->'items') with ordinality as j(card, ord)
    join podmena.shifts as s on s.id = (j.card->>'id')::uuid
    left join podmena.shift_applications as a on a.shift_id = s.id and a.id = s.confirmed_application_id
    left join podmena.shift_completions as c on c.shift_id = s.id;
    return body;
  end if;

  shift_id_input := (p_input->>'shift_id')::uuid;

  -- Scope the lock to a participant. The 3D writer uses the same shift row lock.
  select s.* into listing
  from podmena.shifts as s
  left join podmena.shift_applications as a on a.shift_id = s.id and a.id = s.confirmed_application_id
  where s.id = shift_id_input and (
    (p_action in ('request_completion', 'cancel') and s.manager_id = actor)
    or (p_action in ('confirm_completion', 'dispute_completion') and a.worker_id = actor)
    or (p_action = 'review' and (s.manager_id = actor or a.worker_id = actor))
    or (p_action = 'decline' and a.worker_id = actor and a.id = (p_input->>'application_id')::uuid)
  ) for update of s;

  if p_action in ('cancel', 'decline') then
    if listing.id is not null and exists (
      select from podmena.shift_completions as c where c.shift_id = shift_id_input
        and c.decision in ('pending', 'disputed')
    ) then
      raise sqlstate 'PT409' using message = 'completion_under_review';
    end if;
    return podmena.shift_action_lifecycle(p_token_hash, p_action, p_input);
  end if;

  if listing.id is null then raise sqlstate 'PT404' using message = 'shift_not_found'; end if;
  select a.worker_id into worker_id from podmena.shift_applications as a
    where a.shift_id = shift_id_input and a.id = listing.confirmed_application_id;
  select c.* into completion from podmena.shift_completions as c where c.shift_id = shift_id_input;
  event_time := clock_timestamp();

  if p_action = 'review' then
    if worker_id = listing.manager_id then raise sqlstate 'PT403' using message = 'review_self_forbidden'; end if;
    if listing.status <> 'completed' or completion.decision is distinct from 'confirmed' then
      raise sqlstate 'PT409' using message = 'review_completion_required';
    end if;
    review_stars := (p_input->>'stars')::smallint;
    review_comment := coalesce(btrim(p_input->>'comment'), '');
    if review_stars is null or review_stars not between 1 and 5 or char_length(review_comment) > 500 then
      raise sqlstate 'PT400' using message = 'invalid_request';
    end if;
    review_subject := case when actor = listing.manager_id then worker_id else listing.manager_id end;
    review_role := case when actor = listing.manager_id then 'worker' else 'manager' end;
    select r.* into existing_review from podmena.shift_reviews as r
      where r.shift_id = shift_id_input and r.author_id = actor;
    if found then
      if existing_review.stars = review_stars and existing_review.comment = review_comment then
        return jsonb_build_object('saved', true, 'replayed', true);
      end if;
      raise sqlstate 'PT409' using message = 'review_already_exists';
    end if;
    insert into podmena.shift_reviews (shift_id, author_id, subject_id, subject_role, stars, comment, created_at)
      values (shift_id_input, actor, review_subject, review_role, review_stars, review_comment, event_time);
    return jsonb_build_object('saved', true);
  end if;

  if worker_id is null or worker_id = listing.manager_id then
    raise sqlstate 'PT409' using message = 'shift_not_ready_to_complete';
  end if;
  if (p_action = 'request_completion' and completion.decision in ('pending', 'confirmed'))
    or (p_action = 'confirm_completion' and completion.decision = 'confirmed')
    or (p_action = 'dispute_completion' and completion.decision = 'disputed') then
    return jsonb_build_object('saved', true, 'replayed', true);
  end if;
  if completion.decision = 'disputed' then raise sqlstate 'PT409' using message = 'completion_disputed'; end if;
  if listing.status <> 'confirmed' or listing.ends_at > event_time then
    raise sqlstate 'PT409' using message = 'shift_not_ready_to_complete';
  end if;

  if p_action = 'request_completion' then
    insert into podmena.shift_completions (shift_id, application_id, requested_at)
      values (shift_id_input, listing.confirmed_application_id, event_time);
  elsif p_action = 'confirm_completion' then
    if completion.decision is distinct from 'pending' then
      raise sqlstate 'PT409' using message = 'completion_request_required';
    end if;
    update podmena.shift_completions as c set decision = 'confirmed', decided_at = event_time
      where c.shift_id = shift_id_input;
    update podmena.shifts as s set status = 'completed', completed_at = event_time where s.id = shift_id_input;
  else
    reason := nullif(btrim(p_input->>'reason'), '');
    if reason is null or char_length(reason) > 500 then
      raise sqlstate 'PT400' using message = 'dispute_reason_required';
    end if;
    insert into podmena.shift_completions (shift_id, application_id, decision, decided_at, dispute_reason)
      values (shift_id_input, listing.confirmed_application_id, 'disputed', event_time, reason)
    on conflict (shift_id) do update set decision = excluded.decision, decided_at = excluded.decided_at,
      dispute_reason = excluded.dispute_reason;
  end if;

  return jsonb_build_object('saved', true);
end;
$$;

revoke all on function public.podmena_shift_action(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.podmena_shift_action(text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
