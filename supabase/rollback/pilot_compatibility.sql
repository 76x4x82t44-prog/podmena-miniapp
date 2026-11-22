-- Optional owner-authorized compatibility rollback for the old 3Ж page.
-- Keeps all tables, events, request IDs, queue and security grants.
begin;

create or replace function public.podmena_shift_action(p_token_hash text,p_action text,p_input jsonb)
returns jsonb language sql security definer set search_path='' as $$
  select podmena.shift_action_3zh(p_token_hash,p_action,p_input);
$$;
revoke all on function public.podmena_shift_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.podmena_shift_action(text,text,jsonb) to service_role;
notify pgrst,'reload schema';

commit;
