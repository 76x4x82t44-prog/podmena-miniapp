create table podmena.telegram_sessions (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  telegram_hash bytea not null unique check (octet_length(telegram_hash) = 32),
  user_id uuid not null references podmena.telegram_users (id) on delete cascade,
  expires_at timestamptz not null
);

create index telegram_sessions_user_id_idx on podmena.telegram_sessions (user_id);
create index telegram_sessions_expires_at_idx on podmena.telegram_sessions (expires_at);

alter table podmena.telegram_sessions enable row level security;
revoke all on podmena.telegram_sessions from public, anon, authenticated, service_role;

-- Only the server role can call this after verifying Telegram's signature and age.
create function public.podmena_start_telegram_session(
  p_telegram_id bigint,
  p_telegram_hash text,
  p_token_hash text
)
returns table (user_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
begin
  insert into podmena.telegram_users (telegram_id)
  values (p_telegram_id)
  on conflict (telegram_id) do nothing;

  select u.id into strict account_id
    from podmena.telegram_users as u
    where u.telegram_id = p_telegram_id;

  return query
    insert into podmena.telegram_sessions as s (token_hash, telegram_hash, user_id, expires_at)
    values (decode(p_token_hash, 'hex'), decode(p_telegram_hash, 'hex'), account_id, now() + interval '1 hour')
    on conflict (telegram_hash) do nothing
    returning s.user_id, s.expires_at;

  if not found then
    raise sqlstate 'PT409' using message = 'Telegram login already used';
  end if;
end;
$$;

create function public.podmena_get_session_user(p_token_hash text)
returns table (user_id uuid, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.user_id, s.expires_at
    from podmena.telegram_sessions as s
    where s.token_hash = decode(p_token_hash, 'hex') and s.expires_at > now()
$$;

revoke execute on function public.podmena_start_telegram_session(bigint, text, text) from public, anon, authenticated, service_role;
revoke execute on function public.podmena_get_session_user(text) from public, anon, authenticated, service_role;
grant execute on function public.podmena_start_telegram_session(bigint, text, text) to service_role;
grant execute on function public.podmena_get_session_user(text) to service_role;
