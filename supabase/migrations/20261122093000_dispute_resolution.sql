begin;
alter table podmena.shift_completions
  drop constraint shift_completions_check,
  drop constraint shift_completions_check1,
  drop constraint shift_completions_check2,
  drop constraint shift_completions_decision_check;
alter table podmena.shift_completions
  add constraint shift_completions_decision_check check (decision in ('pending','confirmed','disputed','awaiting_request')),
  add constraint shift_completions_request_check check (requested_at is not null or decision in ('disputed','awaiting_request')),
  add constraint shift_completions_date_check check ((decision in ('pending','awaiting_request')) = (decided_at is null)),
  add constraint shift_completions_dispute_check check (decision <> 'disputed' or dispute_reason is not null),
  add constraint shift_completions_awaiting_request_check check (decision <> 'awaiting_request' or requested_at is null);

create table podmena.shift_dispute_events (
  id bigint generated always as identity primary key,
  shift_id uuid not null references podmena.shift_completions(shift_id),
  actor_id uuid not null references podmena.telegram_users(id),
  actor_role text not null check (actor_role in ('worker','manager')),
  action text not null check (action in ('opened','manager_reply','worker_comment','withdrawn','accepted')),
  message text not null default '' check (char_length(message) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  check ((action in ('opened','manager_reply','worker_comment')) = (char_length(message) > 0)),
  check ((action in ('opened','worker_comment','withdrawn','accepted')) = (actor_role = 'worker'))
);
create index shift_dispute_events_shift_idx on podmena.shift_dispute_events(shift_id,id desc);
alter table podmena.shift_dispute_events enable row level security;
revoke all on podmena.shift_dispute_events from public,anon,authenticated,service_role;
revoke all on sequence podmena.shift_dispute_events_id_seq from public,anon,authenticated,service_role;

insert into podmena.shift_dispute_events(shift_id,actor_id,actor_role,action,message,created_at)
select c.shift_id,a.worker_id,'worker','opened',c.dispute_reason,c.decided_at
from podmena.shift_completions c
join podmena.shift_applications a on a.id=c.application_id and a.shift_id=c.shift_id
where c.decision='disputed' and c.dispute_reason is not null;

alter function public.podmena_shift_action(text,text,jsonb) set schema podmena;
alter function podmena.podmena_shift_action(text,text,jsonb) rename to shift_action_3e;
revoke all on function podmena.shift_action_3e(text,text,jsonb) from public,anon,authenticated,service_role;

create function public.podmena_shift_action(p_token_hash text,p_action text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  listing podmena.shifts%rowtype;
  completion podmena.shift_completions%rowtype;
  worker uuid;
  target uuid;
  body jsonb;
  note text;
  prev_action text;
  at_time timestamptz;
begin
  if p_action not in ('owned','outgoing','dispute_completion','request_completion',
                      'withdraw_dispute','reply_dispute','comment_dispute','accept_dispute') then
    return podmena.shift_action_3e(p_token_hash,p_action,p_input);
  end if;

  select u.user_id into actor from public.podmena_get_session_user(p_token_hash) u;
  if actor is null then raise sqlstate 'PT401' using message='session_expired'; end if;

  if p_action in ('owned','outgoing') then
    body := podmena.shift_action_3e(p_token_hash,p_action,p_input);
    select jsonb_build_object('items',coalesce(jsonb_agg(
      j.card || case when s.manager_id=actor or a.worker_id=actor then jsonb_build_object(
        'completion_state',case when c.decision='awaiting_request' then 'awaiting_request'
          else j.card->>'completion_state' end,
        'can_request_completion',s.manager_id=actor and s.status='confirmed'
          and s.ends_at <= now() and (c.shift_id is null or c.decision='awaiting_request'),
        'can_confirm_completion',a.worker_id=actor and s.status='confirmed' and c.decision='pending',
        'can_dispute_completion',a.worker_id=actor and s.status='confirmed'
          and s.ends_at <= now() and (c.shift_id is null or c.decision in ('pending','awaiting_request')),
        'can_withdraw_dispute',a.worker_id=actor and c.decision='disputed',
        'can_reply_dispute',s.manager_id=actor and c.decision='disputed',
        'can_comment_dispute',a.worker_id=actor and c.decision='disputed',
        'can_accept_dispute',a.worker_id=actor and c.decision='disputed'
          and (select e.action='manager_reply' from podmena.shift_dispute_events e
               where e.shift_id=s.id order by e.id desc limit 1) is true,
        'dispute_events',(select coalesce(jsonb_agg(jsonb_build_object(
            'action',e.action,'actor_role',e.actor_role,'message',e.message,'created_at',e.created_at
          ) order by e.id),'[]'::jsonb) from (
            select e.* from podmena.shift_dispute_events e where e.shift_id=s.id order by e.id desc limit 30
          ) e)
      ) else '{}'::jsonb end order by j.ord
    ),'[]'::jsonb)) into body
    from jsonb_array_elements(body->'items') with ordinality j(card,ord)
    join podmena.shifts s on s.id=(j.card->>'id')::uuid
    left join podmena.shift_applications a on a.id=s.confirmed_application_id and a.shift_id=s.id
    left join podmena.shift_completions c on c.shift_id=s.id;
    return body;
  end if;

  target := (p_input->>'shift_id')::uuid;
  select s.* into listing from podmena.shifts s
  left join podmena.shift_applications a on a.id=s.confirmed_application_id and a.shift_id=s.id
  where s.id=target and (
    ((p_action in ('reply_dispute','request_completion')) and s.manager_id=actor)
    or ((p_action in ('withdraw_dispute','comment_dispute','accept_dispute','dispute_completion')) and a.worker_id=actor)
  ) for update of s;
  if listing.id is null then raise sqlstate 'PT404' using message='shift_not_found'; end if;

  select a.worker_id into worker from podmena.shift_applications a
  where a.id=listing.confirmed_application_id and a.shift_id=target;
  if worker is null or worker=listing.manager_id then
    raise sqlstate 'PT409' using message='shift_not_ready_to_complete';
  end if;
  select c.* into completion from podmena.shift_completions c where c.shift_id=target;
  at_time := clock_timestamp();

  if p_action='request_completion' and completion.decision='awaiting_request' then
    if listing.status<>'confirmed' or listing.ends_at>at_time then
      raise sqlstate 'PT409' using message='shift_not_ready_to_complete';
    end if;
    update podmena.shift_completions c set requested_at=at_time,decision='pending',decided_at=null
      where c.shift_id=target;
    return jsonb_build_object('saved',true);
  end if;

  if p_action in ('request_completion','dispute_completion') then
    body := podmena.shift_action_3e(p_token_hash,p_action,p_input);
    if p_action='dispute_completion' and body->>'saved'='true'
       and coalesce((body->>'replayed')::boolean,false)=false then
      insert into podmena.shift_dispute_events(shift_id,actor_id,actor_role,action,message)
      values(target,actor,'worker','opened',btrim(p_input->>'reason'));
    end if;
    return body;
  end if;

  if completion.decision is distinct from 'disputed' or listing.status<>'confirmed' then
    raise sqlstate 'PT409' using message='dispute_not_open';
  end if;
  if p_action in ('reply_dispute','comment_dispute') then
    note := nullif(btrim(p_input->>'message'),'');
    if note is null or char_length(note)>500 then
      raise sqlstate 'PT400' using message='dispute_message_required';
    end if;
    insert into podmena.shift_dispute_events(shift_id,actor_id,actor_role,action,message)
    values(target,actor,case when p_action='reply_dispute' then 'manager' else 'worker' end,
      case when p_action='reply_dispute' then 'manager_reply' else 'worker_comment' end,note);
    return jsonb_build_object('saved',true);
  end if;

  if p_action='accept_dispute' then
    select e.action into prev_action from podmena.shift_dispute_events e
      where e.shift_id=target order by e.id desc limit 1;
    if prev_action is distinct from 'manager_reply' then
      raise sqlstate 'PT409' using message='dispute_offer_required';
    end if;
  end if;

  if p_action in ('withdraw_dispute','accept_dispute') then
    insert into podmena.shift_dispute_events(shift_id,actor_id,actor_role,action)
      values(target,actor,'worker',case when p_action='withdraw_dispute' then 'withdrawn' else 'accepted' end);
    update podmena.shift_completions c set
      decision=case when c.requested_at is null then 'awaiting_request' else 'pending' end,
      decided_at=null where c.shift_id=target;
    return jsonb_build_object('saved',true);
  end if;
  raise sqlstate 'PT400' using message='invalid_request';
end;
$$;
revoke all on function public.podmena_shift_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.podmena_shift_action(text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
