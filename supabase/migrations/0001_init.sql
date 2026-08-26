-- Instagram Monitor — Supabase schema.
--
-- Everything the monitor persists lives here. `app_state` holds the same JSON
-- documents the filesystem backend kept as files (config.json, usage.json,
-- history.json, hf-manifest.json, password.json), so the sync Store interface
-- and all of src/cost/* keep working unchanged.
--
-- SECURITY: RLS is enabled on every table and NO policy is created, so the
-- `anon` and `authenticated` roles can read nothing even if the anon key leaks
-- into the browser. All access is via the service-role key, server-side only —
-- which is the whole reason for this architecture.

create table if not exists app_state (
  key        text primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);

-- Per-task work queue. One row per (account, task), so the user's different
-- cadences — avatar 2h, stories 3h, posts 12h — are scheduled independently
-- instead of one poll doing everything on the shortest interval.
create table if not exists jobs (
  id         bigserial primary key,
  username   text        not null,
  kind       text        not null check (kind in ('profile', 'avatar', 'stories', 'posts')),
  due_at     timestamptz not null default now(),
  started_at timestamptz,
  attempts   int         not null default 0,
  last_error text,
  unique (username, kind)
);

create index if not exists jobs_due_idx on jobs (due_at) where started_at is null;

-- The "log the check, don't duplicate the bytes" decision. An unchanged avatar
-- writes a row here instead of a second copy of the same image, so the 1 GB
-- Storage allowance is not consumed by identical files every 2 hours.
create table if not exists avatar_checks (
  id         bigserial   primary key,
  username   text        not null,
  checked_at timestamptz not null default now(),
  hash       text        not null,
  changed    boolean     not null default false
);

create index if not exists avatar_checks_user_idx on avatar_checks (username, checked_at desc);

-- Single-row advisory lock replacing the O_EXCL lock file. Deleting the row is
-- the release, matching the filesystem semantics exactly.
create table if not exists poll_lock (
  id         boolean     primary key default true check (id),
  owner      text,
  started_at timestamptz not null default now()
);

alter table app_state    enable row level security;
alter table jobs         enable row level security;
alter table avatar_checks enable row level security;
alter table poll_lock    enable row level security;

-- ---------------------------------------------------------------------------
-- Poll lock
--
-- `select ... for update` serialises concurrent cron hits on the single lock
-- row: the loser blocks until the winner commits and then sees a fresh row, so
-- two overlapping GitHub Actions runs can never both start a poll and spend
-- provider quota twice.
-- ---------------------------------------------------------------------------
create or replace function try_acquire_poll_lock(p_owner text, p_stale_seconds int default 1200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
  v_owner   text;
  v_started timestamptz;
  v_age_ms  bigint;
begin
  select owner, started_at into v_owner, v_started
    from poll_lock where id = true for update;

  if not found then
    begin
      insert into poll_lock (id, owner, started_at) values (true, p_owner, v_now);
      return jsonb_build_object('ok', true, 'owner', p_owner, 'startedAt', v_now);
    exception when unique_violation then
      -- Another transaction inserted between our select and insert.
      return jsonb_build_object('ok', false, 'reason', 'locked', 'heldBy', null, 'ageMs', null);
    end;
  end if;

  v_age_ms := (extract(epoch from (v_now - v_started)) * 1000)::bigint;

  -- An undated or overlong lock means the host was killed mid-poll, which is
  -- routine on free tiers. Break it rather than deadlocking forever.
  if v_started is null or v_age_ms >= p_stale_seconds * 1000 then
    update poll_lock set owner = p_owner, started_at = v_now where id = true;
    return jsonb_build_object(
      'ok', true, 'owner', p_owner, 'startedAt', v_now, 'brokeStale', true,
      'previous', jsonb_build_object('owner', v_owner, 'startedAt', v_started),
      'ageMs', v_age_ms
    );
  end if;

  return jsonb_build_object(
    'ok', false, 'reason', 'locked',
    'heldBy', jsonb_build_object('owner', v_owner, 'startedAt', v_started),
    'ageMs', v_age_ms
  );
end;
$$;

create or replace function release_poll_lock(p_owner text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Owner-scoped so a process whose lock was already stale-broken by someone
  -- else cannot release the new holder's lock on its way out.
  delete from poll_lock where id = true and owner = p_owner;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Job claiming
--
-- `for update skip locked` lets overlapping invocations claim disjoint work
-- without blocking each other. `started_at` doubles as the in-flight marker;
-- a job whose worker died is re-claimable once it goes stale.
-- ---------------------------------------------------------------------------
create or replace function claim_due_jobs(p_limit int default 5, p_stale_seconds int default 900)
returns setof jobs
language sql
security definer
set search_path = public
as $$
  update jobs
     set started_at = now(),
         attempts   = attempts + 1
   where id in (
     select id from jobs
      where due_at <= now()
        and (started_at is null or started_at < now() - make_interval(secs => p_stale_seconds))
      order by due_at
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- The service-role key bypasses RLS but NOT function grants, so lock these down
-- to it explicitly: a leaked anon key must not be able to steal the poll lock.
revoke all on function try_acquire_poll_lock(text, int) from public, anon, authenticated;
revoke all on function release_poll_lock(text)          from public, anon, authenticated;
revoke all on function claim_due_jobs(int, int)         from public, anon, authenticated;
grant execute on function try_acquire_poll_lock(text, int) to service_role;
grant execute on function release_poll_lock(text)          to service_role;
grant execute on function claim_due_jobs(int, int)         to service_role;
