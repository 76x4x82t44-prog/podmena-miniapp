begin;

-- Keep Supabase's DDL hook. For the verified platform configuration,
-- remove direct EXECUTE grants without changing the trigger or function body.
do $migration$
declare
  helper oid := to_regprocedure('public.rls_auto_enable()');
begin
  if helper is null then return; end if;
  if exists (
    select from pg_proc p
    join pg_event_trigger t on t.evtfoid = p.oid
    where p.oid = helper and p.prorettype = 'event_trigger'::regtype
      and p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
      and t.evtname = 'ensure_rls' and t.evtevent = 'ddl_command_end'
      and t.evtenabled = 'O' and pg_get_userbyid(t.evtowner) = 'postgres'
      and t.evttags @> array['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]
  ) and (select count(*) from pg_event_trigger where evtfoid = helper) = 1 then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated, service_role;
  else
    raise notice 'PODMENA: unexpected RLS hook signature. EXECUTE grants left unchanged.';
  end if;
end;
$migration$;

alter table podmena.shift_dispute_events
  add column if not exists request_id uuid,
  add column if not exists accepted_offer_id bigint references podmena.shift_dispute_events(id);
create unique index if not exists shift_dispute_event_request_idx
  on podmena.shift_dispute_events(shift_id, actor_id, request_id)
  where request_id is not null;
create index if not exists shift_dispute_opening_idx
  on podmena.shift_dispute_events(shift_id, id desc) where action = 'opened';

do $migration$
begin
  if to_regprocedure('podmena.shift_action_3zh(text,text,jsonb)') is null then
    alter function public.podmena_shift_action(text,text,jsonb) set schema podmena;
    alter function podmena.podmena_shift_action(text,text,jsonb) rename to shift_action_3zh;
  end if;
end;
$migration$;
revoke all on function podmena.shift_action_3zh(text,text,jsonb) from public,anon,authenticated,service_role;

create or replace function public.podmena_shift_action(p_token_hash text,p_action text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  target uuid;
  saved jsonb;
  request_key uuid;
  expected_round text;
  expected_offer text;
  current_round text;
  current_offer bigint;
  expected_action text;
  note text;
  previous podmena.shift_dispute_events%rowtype;
begin
  if p_action not in ('owned','outgoing','reply_dispute','comment_dispute','withdraw_dispute','accept_dispute') then
    return podmena.shift_action_3zh(p_token_hash,p_action,p_input);
  end if;

  if p_action in ('owned','outgoing') then
    saved := podmena.shift_action_3zh(p_token_hash,p_action,p_input);
    select jsonb_build_object('items', coalesce(jsonb_agg(
      x.item
      || case when opened.id is null then '{}'::jsonb
              else jsonb_build_object('dispute_round_id',opened.id::text) end
      || case when events.history is null then '{}'::jsonb
              else jsonb_build_object('dispute_events',events.history) end
      || case when events.latest_action='manager_reply' and x.item->>'can_comment_dispute'='true'
              then jsonb_build_object('dispute_offer_id',events.latest_id::text,'can_accept_dispute',true)
              else case when x.item ? 'can_accept_dispute'
                        then jsonb_build_object('can_accept_dispute',false) else '{}'::jsonb end end
      order by x.position),'[]'::jsonb)) into saved
    from jsonb_array_elements(saved->'items') with ordinality x(item,position)
    left join lateral (
      select e.id from podmena.shift_dispute_events e
      where e.shift_id=(x.item->>'id')::uuid and e.action='opened'
        and (x.item->>'can_reply_dispute'='true' or x.item->>'can_comment_dispute'='true')
      order by e.id desc limit 1
    ) opened on true
    -- The displayed proposal and its ID must come from the same snapshot.
    left join lateral (
      select jsonb_agg(jsonb_build_object('action',e.action,'actor_role',e.actor_role,
          'message',e.message,'created_at',e.created_at) order by e.id) history,
        (array_agg(e.id order by e.id desc))[1] latest_id,
        (array_agg(e.action order by e.id desc))[1] latest_action
      from (
        select d.id,d.action,d.actor_role,d.message,d.created_at
        from podmena.shift_dispute_events d
        where d.shift_id=(x.item->>'id')::uuid and x.item ? 'dispute_events'
        order by d.id desc limit 30
      ) e
    ) events on true;
    return saved;
  end if;

  select s.user_id into actor from public.podmena_get_session_user(p_token_hash) s;
  if actor is null then raise sqlstate 'PT401' using message='session_expired'; end if;

  target := (p_input->>'shift_id')::uuid;
  perform from podmena.shifts s
    left join podmena.shift_applications a on a.id=s.confirmed_application_id and a.shift_id=s.id
    where s.id=target and (
      (p_action='reply_dispute' and s.manager_id=actor and a.worker_id<>actor)
      or (p_action<>'reply_dispute' and a.worker_id=actor and s.manager_id<>actor)
    ) for update of s;
  if not found then raise sqlstate 'PT404' using message='shift_not_found'; end if;

  if coalesce(p_input->>'request_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p_input->>'round_id','') !~ '^[1-9][0-9]{0,18}$'
     or (p_action='accept_dispute' and coalesce(p_input->>'offer_id','') !~ '^[1-9][0-9]{0,18}$') then
    raise sqlstate 'PT400' using message='invalid_dispute_version';
  end if;
  request_key := (p_input->>'request_id')::uuid;
  expected_round := p_input->>'round_id';
  expected_offer := p_input->>'offer_id';
  note := coalesce(btrim(p_input->>'message'),'');
  expected_action := case p_action when 'reply_dispute' then 'manager_reply'
    when 'comment_dispute' then 'worker_comment' when 'withdraw_dispute' then 'withdrawn' else 'accepted' end;

  select e.* into previous from podmena.shift_dispute_events e
    where e.shift_id=target and e.actor_id=actor and e.request_id=request_key;
  if found then
    if previous.action=expected_action and previous.message=note
       and (p_action<>'accept_dispute' or previous.accepted_offer_id::text=expected_offer)
       and expected_round=(
         select e.id::text from podmena.shift_dispute_events e
         where e.shift_id=target and e.action='opened' and e.id<previous.id
         order by e.id desc limit 1
       ) then
      return jsonb_build_object('saved',true,'replayed',true);
    end if;
    raise sqlstate 'PT409' using message='dispute_request_conflict';
  end if;

  select e.id::text into current_round from podmena.shift_dispute_events e
    where e.shift_id=target and e.action='opened' order by e.id desc limit 1;
  if current_round is distinct from expected_round then
    raise sqlstate 'PT409' using message='stale_dispute_offer';
  end if;

  if p_action='accept_dispute' then
    select e.id into current_offer from podmena.shift_dispute_events e
      where e.shift_id=target order by e.id desc limit 1;
    if current_offer::text is distinct from expected_offer then
      raise sqlstate 'PT409' using message='stale_dispute_offer';
    end if;
  end if;

  saved := podmena.shift_action_3zh(p_token_hash,p_action,p_input);
  if saved->>'saved'='true' then
    update podmena.shift_dispute_events e
      set request_id=request_key, accepted_offer_id=current_offer
      where e.id=(select max(d.id) from podmena.shift_dispute_events d where d.shift_id=target)
        and e.shift_id=target and e.actor_id=actor and e.action=expected_action and e.request_id is null;
    if not found then raise exception 'dispute_event_missing'; end if;
  end if;
  return saved;
end;
$$;
revoke all on function public.podmena_shift_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.podmena_shift_action(text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
