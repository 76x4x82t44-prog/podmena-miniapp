create schema podmena;
revoke all on schema podmena from public, anon, authenticated, service_role;

create type podmena.platform as enum ('ozon', 'wildberries', 'yandex_market');
create type podmena.shift_status as enum ('open', 'confirmed', 'completed', 'cancelled');

create table podmena.telegram_users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique check (telegram_id between 1 and 4503599627370495),
  created_at timestamptz not null default now()
);

-- An account can have both profiles. The profile's primary key is the account ID.
create table podmena.worker_profiles (
  user_id uuid primary key references podmena.telegram_users (id) on delete cascade,
  name text not null check (char_length(name) <= 80 and name ~ '[^[:space:]]'),
  city text not null check (char_length(city) <= 80 and city ~ '[^[:space:]]'),
  district text not null check (char_length(district) <= 100 and district ~ '[^[:space:]]'),
  platforms podmena.platform[] not null check (
    cardinality(platforms) between 1 and 3
    and array_ndims(platforms) = 1
    and array_position(platforms, null) is null
  ),
  experience text not null check (char_length(experience) <= 100 and experience ~ '[^[:space:]]'),
  accepts_single_shifts boolean not null default false,
  accepts_permanent_work boolean not null default false,
  about text not null default '' check (char_length(about) <= 500),
  check (accepts_single_shifts or accepts_permanent_work)
);

create table podmena.manager_profiles (
  user_id uuid primary key references podmena.telegram_users (id) on delete cascade,
  name text not null check (char_length(name) <= 80 and name ~ '[^[:space:]]'),
  city text not null check (char_length(city) <= 80 and city ~ '[^[:space:]]'),
  pickup_point text not null check (char_length(pickup_point) <= 160 and pickup_point ~ '[^[:space:]]'),
  platform podmena.platform not null,
  district text not null check (char_length(district) <= 100 and district ~ '[^[:space:]]'),
  conditions text not null default '' check (char_length(conditions) <= 500)
);

-- Dedicated storage so future catalog queries can omit contacts entirely.
create table podmena.private_contacts (
  user_id uuid primary key references podmena.telegram_users (id) on delete cascade,
  worker_phone text check (char_length(worker_phone) <= 40),
  manager_contact text check (char_length(manager_contact) <= 160)
);

-- One row tracks the listing and the selected worker through completion.
create table podmena.shifts (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references podmena.manager_profiles (user_id),
  platform podmena.platform not null,
  city text not null check (char_length(city) <= 80 and city ~ '[^[:space:]]'),
  district text not null check (char_length(district) <= 100 and district ~ '[^[:space:]]'),
  pickup_point text not null check (char_length(pickup_point) <= 160 and pickup_point ~ '[^[:space:]]'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  pay_rubles integer not null check (pay_rubles >= 0),
  notes text not null default '' check (char_length(notes) <= 500),
  status podmena.shift_status not null default 'open',
  confirmed_application_id uuid,
  confirmed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (
    (status in ('open', 'cancelled') and confirmed_application_id is null and confirmed_at is null and completed_at is null)
    or
    (status = 'confirmed' and confirmed_application_id is not null and confirmed_at is not null and completed_at is null)
    or
    (status = 'completed' and confirmed_application_id is not null and confirmed_at is not null
      and completed_at is not null and completed_at >= greatest(confirmed_at, ends_at))
  )
);

create table podmena.shift_applications (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references podmena.shifts (id),
  worker_id uuid not null references podmena.worker_profiles (user_id),
  created_at timestamptz not null default now(),
  unique (shift_id, worker_id),
  unique (shift_id, id)
);

-- The selected application must belong to this very shift.
alter table podmena.shifts add constraint confirmed_application_matches_shift
  foreign key (id, confirmed_application_id)
  references podmena.shift_applications (shift_id, id);

create index shifts_manager_id_idx on podmena.shifts (manager_id);
create index shifts_open_city_starts_at_idx on podmena.shifts (city, starts_at) where status = 'open';
create index shift_applications_worker_id_idx on podmena.shift_applications (worker_id);

alter table podmena.telegram_users enable row level security;
alter table podmena.worker_profiles enable row level security;
alter table podmena.manager_profiles enable row level security;
alter table podmena.private_contacts enable row level security;
alter table podmena.shifts enable row level security;
alter table podmena.shift_applications enable row level security;

revoke all on all tables in schema podmena from public, anon, authenticated, service_role;
