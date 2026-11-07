-- 2026-11-07: raise the 10-minute public limits for the 11/8 launch peak. The numbers and the
-- reasons (about 80 sign-ups in one window, about 40% of them sharing the venue Wi-Fi's IP) are in
-- docs/需求討論與決策紀錄.md, section "2026-11-07 上線尖峰限流".
--   new public registrations, site-wide  50 -> 150 (kept after the peak)
--   public requests per source           60 -> 200 (peak value; normal value is 60)
--   public requests, site-wide          600 -> 1000 (kept after the peak)
-- Staff-created registrations stay outside the create limit.
begin;

alter table public.registration_create_limits
  drop constraint registration_create_limits_created_count_check,
  add constraint registration_create_limits_created_count_check check (created_count between 0 and 150);

-- Same as 202611050006 except the create limit (50 -> 150). Copy this version, not the older ones,
-- when create_registration changes again. CREATE OR REPLACE keeps its grants.
create or replace function public.create_registration(
  p_request_id uuid,
  p_full_name text,
  p_district_id integer,
  p_choices jsonb,
  p_hosting jsonb default null,
  p_meal_identity text default null
)
returns table (registration_id uuid, serial_no bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_registration_id uuid;
  v_serial_no bigint;
  v_hosting jsonb;
  v_identity text;
  v_settings public.site_settings%rowtype;
begin
  select * into v_settings from public.site_settings where id;
  if not coalesce(v_settings.is_registration_open
      and (v_settings.registration_deadline_at is null or v_settings.registration_deadline_at > now()), false) then
    raise exception using errcode = 'P0001', message = 'REGISTRATION_CLOSED';
  end if;
  if coalesce(length(btrim(p_full_name)), 0) not between 1 and 100
    or public.registration_name_key(p_full_name) = '' then
    raise exception using errcode = '22023', message = 'INVALID_NAME';
  end if;
  if not exists (select 1 from public.districts where id = p_district_id) then
    raise exception using errcode = '22023', message = 'INVALID_DISTRICT';
  end if;
  if public.registration_choices_valid(p_choices) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  v_hosting := public.registration_hosting_value(p_hosting);
  if not v_settings.is_hosting_open and v_hosting is not null then
    raise exception using errcode = 'P0001', message = 'HOSTING_CLOSED';
  end if;
  if v_settings.is_hosting_open and v_hosting is null then
    raise exception using errcode = 'P0001', message = 'HOSTING_REQUIRED';
  end if;
  if public.registration_audience_valid(p_choices, v_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity);

  update public.registration_create_limits
  set window_started_at = case when window_started_at <= now() - interval '10 minutes' then now() else window_started_at end,
      created_count = case when window_started_at <= now() - interval '10 minutes' then 1 else created_count + 1 end
  where id = true
    and (window_started_at <= now() - interval '10 minutes' or created_count < 150);
  if not found then
    raise exception using errcode = 'P0001', message = 'CREATE_RATE_LIMITED';
  end if;

  insert into public.registrations (create_request_id, full_name, district_id, meal_identity)
  values (p_request_id, btrim(p_full_name), p_district_id, v_identity)
  returning id, registrations.serial_no into v_registration_id, v_serial_no;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select v_registration_id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice;
  if v_hosting is not null then perform public.registration_hosting_put(v_registration_id, v_hosting); end if;
  insert into public.audit_events (actor_type, action, target_type, target_id, after_data)
  values ('public', 'registration.created', 'registration', v_registration_id,
    jsonb_build_object('full_name', btrim(p_full_name), 'district_id', p_district_id, 'hosting', v_hosting,
      'meal_identity', v_identity));

  return query select v_registration_id, v_serial_no;
exception
  when unique_violation then
    if exists (select 1 from public.registrations where create_request_id = p_request_id) then
      raise exception using errcode = '23505', message = 'DUPLICATE_REQUEST';
    end if;
    if exists (select 1 from public.registrations where district_id = p_district_id
        and record_status = 'active' and name_key = public.registration_name_key(p_full_name)) then
      raise exception using errcode = '23505', message = 'NAME_TAKEN';
    end if;
    raise;
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

-- Same as 202611040001 except the per-source (60 -> 200) and site-wide (600 -> 1000) limits.
create or replace function public.consume_public_request(p_source_key text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_global integer;
  v_source integer;
begin
  if p_source_key !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_SOURCE_KEY';
  end if;
  delete from public.public_request_limits where window_started_at <= now() - interval '10 minutes';
  insert into public.public_request_limits as limits (source_key, request_count) values (p_source_key, 1)
  on conflict (source_key) do update set request_count = limits.request_count + 1
  returning request_count into v_source;
  -- A request refused for its own source does not count globally, so one source alone
  -- cannot use up the site-wide allowance for everyone else.
  if v_source > 200 then return false; end if;
  insert into public.public_request_limits as limits (source_key, request_count) values ('global', 1)
  on conflict (source_key) do update set request_count = limits.request_count + 1
  returning request_count into v_global;
  return v_global <= 1000;
end;
$$;

commit;
