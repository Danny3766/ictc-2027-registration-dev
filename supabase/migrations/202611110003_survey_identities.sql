-- Close registration while applying; then deploy both Edge Functions and the site.
-- Existing answers remain stored. Only validity changes; import statuses are untouched.
begin;
alter table public.site_settings
  add column hosting_identity_codes text[] not null default array['general'],
  add column pickup_identity_codes text[] not null default array['general'],
  add constraint hosting_identities_not_empty check (not is_hosting_open or cardinality(hosting_identity_codes)>0),
  add constraint pickup_identities_not_empty check (not is_pickup_open or cardinality(pickup_identity_codes)>0);
alter table public.registration_hosting add column answer_valid boolean not null default true;
alter table public.registration_pickup add column answer_valid boolean not null default true;

-- Previous wrappers always generated 否 for non-general identities. Audit child_updated also
-- identifies generated answers retained after returning to general without explicit confirmation.
update public.registration_hosting h set answer_valid=false
from public.registrations r where r.id=h.registration_id and (
  coalesce(r.meal_identity,'general')<>'general' or h.status='not_hosting' and coalesce((
    -- A non-general save had its hosting forced to 否 inside registration.updated/staff_updated too.
    select e.action in ('registration.child_updated','registration.hosting_general_only')
      or coalesce(e.after_data->>'meal_identity','general')<>'general'
    from public.audit_events e where e.target_id=r.id and (
      e.action in ('registration.created','registration.staff_created') and e.after_data->'hosting' is not null
      or e.action='registration.child_updated' and e.after_data->'hosting' is not null
      or e.action in ('registration.updated','registration.staff_updated','registration.hosting_general_only')
        and e.before_data->'hosting' is distinct from e.after_data->'hosting')
    order by e.created_at desc,e.id desc limit 1),false));
update public.registration_pickup p set answer_valid=false
from public.registrations r where r.id=p.registration_id and (
  coalesce(r.meal_identity,'general')<>'general' or p.status='no' and coalesce((
    select e.action in ('registration.child_updated','registration.hosting_general_only')
    from public.audit_events e where e.target_id=r.id and (
      e.action='registration.pickup_updated'
      or e.action='registration.child_updated' and e.after_data->'pickup' is not null
      or e.action='registration.hosting_general_only'
        and e.before_data->'pickup' is distinct from e.after_data->'pickup')
    order by e.created_at desc,e.id desc limit 1),false));

create function public.survey_identity_allowed(p_kind text,p_identity text) returns boolean
language sql stable security invoker set search_path='' as $$
  select coalesce(coalesce(p_identity,'general')=any(case p_kind when 'hosting' then hosting_identity_codes
    when 'pickup' then pickup_identity_codes end),false) from public.site_settings where id;
$$;
revoke all on function public.survey_identity_allowed(text,text) from public,anon,authenticated;
grant execute on function public.survey_identity_allowed(text,text) to service_role;

create or replace function public.registration_hosting_get(p_registration_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('status',status,'guest_type',guest_type,'guest_count',guest_count,'pickup_count',pickup_count)
    || case when answer_valid then '{}'::jsonb else '{"answer_valid":false}'::jsonb end
  from public.registration_hosting where registration_id=p_registration_id;
$$;
create or replace function public.registration_pickup_get(p_registration_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('status',status,'count',count)
    || case when answer_valid then '{}'::jsonb else '{"answer_valid":false}'::jsonb end
  from public.registration_pickup where registration_id=p_registration_id;
$$;

create function public.survey_audience_valid(p_identity text,p_choices jsonb,p_hosting jsonb,p_pickup jsonb)
returns boolean language sql stable security invoker set search_path='' as $$
  select not exists (
    select 1 from jsonb_array_elements(p_choices) c join public.activities a on a.id=(c->>'activity_id')::bigint
    where (c->>'attending')::boolean and (
      a.audience='hosting' and public.survey_identity_allowed('hosting',p_identity)
        and not coalesce(p_hosting->>'status' in ('hosting','family_registered') and coalesce((p_hosting->>'answer_valid')::boolean,true),false)
      or a.audience='pickup' and public.survey_identity_allowed('pickup',p_identity)
        and not coalesce(p_pickup->>'status'='yes' and coalesce((p_pickup->>'answer_valid')::boolean,true),false)
      or a.audience like 'activity:%' and not exists (
        select 1 from public.activities required join jsonb_array_elements(p_choices) rc on required.id=(rc->>'activity_id')::bigint
        where required.id=substring(a.audience from 10)::bigint and required.is_published and (rc->>'attending')::boolean)));
$$;
revoke all on function public.survey_audience_valid(text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.survey_audience_valid(text,jsonb,jsonb,jsonb) to service_role;


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
  if coalesce(current_setting('registration.surveys_managed',true),'') <> 'on' then
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
  else v_hosting := null; end if;
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

create or replace function public.staff_create_registration(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null
)
returns table (registration_id uuid, serial_no bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_serial bigint;
  v_hosting jsonb;
  v_identity text;
begin
  perform public.staff_assert_actor(p_actor);
  if coalesce(length(btrim(p_full_name)), 0) not between 1 and 100
    or public.registration_name_key(p_full_name) = ''
    or not exists (select 1 from public.districts where id = p_district_id) then
    raise exception using errcode = '22023', message = 'INVALID_REGISTRATION';
  end if;
  if public.registration_choices_valid(p_choices) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  if coalesce(current_setting('registration.surveys_managed',true),'') <> 'on' then
  v_hosting := public.registration_hosting_value(p_hosting);
  if v_hosting is null and coalesce((select is_hosting_open from public.site_settings where id), false) then
    raise exception using errcode = 'P0001', message = 'HOSTING_REQUIRED';
  end if;
  if public.registration_audience_valid(p_choices, v_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  else v_hosting := null; end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity);

  insert into public.registrations
    (create_request_id, full_name, district_id, meal_identity)
  values (p_request_id, btrim(p_full_name), p_district_id, v_identity)
  returning id, registrations.serial_no into v_id, v_serial;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select v_id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice;
  if v_hosting is not null then perform public.registration_hosting_put(v_id, v_hosting); end if;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, after_data)
  values ('staff', p_actor, 'registration.staff_created', 'registration', v_id,
    jsonb_build_object('full_name', btrim(p_full_name), 'district_id', p_district_id, 'hosting', v_hosting,
      'meal_identity', v_identity));
  return query select v_id, v_serial;
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

create or replace function public.update_registration(
  p_full_name text,
  p_district_id integer,
  p_choices jsonb,
  p_hosting jsonb default null,
  p_meal_identity text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_registration public.registrations%rowtype;
  v_before_choices jsonb;
  v_after_choices jsonb;
  v_before_hosting jsonb;
  v_after_hosting jsonb;
  v_identity text;
  v_import_change boolean;
  v_settings public.site_settings%rowtype;
begin
  select * into v_settings from public.site_settings where id;
  if not coalesce(v_settings.is_registration_open
      and (v_settings.registration_deadline_at is null or v_settings.registration_deadline_at > now()), false) then
    raise exception using errcode = 'P0001', message = 'REGISTRATION_CLOSED';
  end if;
  if not coalesce(v_settings.is_lookup_open, false) then
    raise exception using errcode = 'P0001', message = 'LOOKUP_CLOSED';
  end if;

  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  if not found then return false; end if;
  if public.registration_choices_valid(p_choices) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  if coalesce(current_setting('registration.surveys_managed',true),'') <> 'on' then
  v_before_hosting := public.registration_hosting_get(v_registration.id);
  -- An older page sends no pickup_count; keep the stored one instead of resetting it to 0.
  -- ->> is null also covers an explicit JSON null, which registration_hosting_value would turn into 0.
  if jsonb_typeof(p_hosting) = 'object' and p_hosting->>'pickup_count' is null then
    p_hosting := p_hosting || jsonb_build_object('pickup_count', coalesce(v_before_hosting->'pickup_count', '0'));
  end if;
  v_after_hosting := public.registration_hosting_value(p_hosting);
  if not v_settings.is_hosting_open
    and v_after_hosting is not null and v_after_hosting is distinct from v_before_hosting then
    raise exception using errcode = 'P0001', message = 'HOSTING_CLOSED';
  end if;
  -- No answer sent keeps the stored one: a page loaded before the switch opened, or an older page
  -- or Edge Function, sends none. Only a registration that never answered must answer now.
  v_after_hosting := case when v_settings.is_hosting_open then coalesce(v_after_hosting, v_before_hosting)
    else v_before_hosting end;
  if v_after_hosting is null and v_settings.is_hosting_open then
    raise exception using errcode = 'P0001', message = 'HOSTING_REQUIRED';
  end if;
  if public.registration_audience_valid(p_choices, v_after_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  else v_before_hosting := null; v_after_hosting := null; end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity, v_registration.meal_identity);

  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_before_choices
  from public.registration_choices where registration_id = v_registration.id
    and activity_id in (select id from public.activities where is_published);
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_after_choices
  from (
    select (choice->>'activity_id')::bigint as activity_id, (choice->>'attending')::boolean as attending
    from jsonb_array_elements(p_choices) choice
  ) answers;
  -- Hosting answers are imported into the assembly system too, so any change needs a re-import.
  v_import_change := public.conference_choices(v_before_choices) <> public.conference_choices(v_after_choices) or v_before_hosting is distinct from v_after_hosting
    or v_registration.meal_identity is distinct from v_identity;
  if not v_import_change and v_before_choices = v_after_choices then
    return true;
  end if;

  update public.registrations set
    meal_identity = v_identity,
    import_status = case when v_import_change and import_status = 'imported' then 'reimport_needed'
      else import_status end,
    updated_at = now()
  where id = v_registration.id;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select v_registration.id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice
  on conflict (registration_id, activity_id) do update
    set attending = excluded.attending, updated_at = now();
  if v_after_hosting is distinct from v_before_hosting then
    perform public.registration_hosting_put(v_registration.id, v_after_hosting);
  end if;
  insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
  values ('public', 'registration.updated', 'registration', v_registration.id,
    jsonb_build_object('choices', v_before_choices, 'hosting', v_before_hosting,
      'meal_identity', v_registration.meal_identity, 'import_status', v_registration.import_status),
    jsonb_build_object('choices', v_after_choices, 'hosting', v_after_hosting, 'meal_identity', v_identity,
      'import_status', case when v_import_change and v_registration.import_status = 'imported'
        then 'reimport_needed' else v_registration.import_status end));
  return true;
exception
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

create or replace function public.staff_update_registration(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_registration public.registrations%rowtype;
  v_before_choices jsonb;
  v_after_choices jsonb;
  v_before_hosting jsonb;
  v_after_hosting jsonb;
  v_identity text;
  v_import_change boolean;
begin
  perform public.staff_assert_actor(p_actor);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  if not found then return false; end if;

  if coalesce(length(btrim(p_full_name)), 0) not between 1 and 100
    or public.registration_name_key(p_full_name) = ''
    or not exists (select 1 from public.districts where id = p_district_id) then
    raise exception using errcode = '22023', message = 'INVALID_REGISTRATION';
  end if;
  if public.registration_choices_valid(p_choices, p_registration_id) is not true then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
  end if;
  if coalesce(current_setting('registration.surveys_managed',true),'') <> 'on' then
  v_before_hosting := public.registration_hosting_get(p_registration_id);
  -- An older page sends no pickup_count; keep the stored one instead of resetting it to 0.
  -- ->> is null also covers an explicit JSON null, which registration_hosting_value would turn into 0.
  if jsonb_typeof(p_hosting) = 'object' and p_hosting->>'pickup_count' is null then
    p_hosting := p_hosting || jsonb_build_object('pickup_count', coalesce(v_before_hosting->'pickup_count', '0'));
  end if;
  -- No answer sent keeps the stored one (for example a cached older back-office page).
  v_after_hosting := coalesce(public.registration_hosting_value(p_hosting), v_before_hosting);
  if public.registration_audience_valid(p_choices, v_after_hosting) is not true then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  else v_before_hosting := null; v_after_hosting := null; end if;
  v_identity := public.registration_meal_identity(p_choices, p_meal_identity, v_registration.meal_identity);

  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_before_choices
  from public.registration_choices where registration_id = p_registration_id
    and activity_id in (select id from public.activities where is_published);
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', activity_id, 'attending', attending)
    order by activity_id), '[]'::jsonb) into v_after_choices
  from (
    select (choice->>'activity_id')::bigint as activity_id,
      (choice->>'attending')::boolean as attending
    from jsonb_array_elements(p_choices) choice
  ) answers;

  v_import_change := v_registration.full_name <> btrim(p_full_name) or v_registration.district_id <> p_district_id
    or public.conference_choices(v_before_choices) <> public.conference_choices(v_after_choices) or v_before_hosting is distinct from v_after_hosting
    or v_registration.meal_identity is distinct from v_identity;
  if not v_import_change and v_before_choices = v_after_choices then return true; end if;

  update public.registrations set full_name = btrim(p_full_name), district_id = p_district_id,
    meal_identity = v_identity,
    import_status = case when v_import_change and import_status = 'imported' then 'reimport_needed'
      else import_status end,
    updated_at = now()
  where id = p_registration_id;
  insert into public.registration_choices (registration_id, activity_id, attending)
  select p_registration_id, (choice->>'activity_id')::bigint, (choice->>'attending')::boolean
  from jsonb_array_elements(p_choices) choice
  on conflict (registration_id, activity_id) do update
    set attending = excluded.attending, updated_at = now();
  if v_after_hosting is distinct from v_before_hosting then
    perform public.registration_hosting_put(p_registration_id, v_after_hosting);
  end if;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
  values ('staff', p_actor, 'registration.staff_updated', 'registration', p_registration_id,
    jsonb_build_object('full_name', v_registration.full_name, 'district_id', v_registration.district_id,
      'choices', v_before_choices, 'hosting', v_before_hosting, 'meal_identity', v_registration.meal_identity,
      'import_status', v_registration.import_status),
    jsonb_build_object('full_name', btrim(p_full_name), 'district_id', p_district_id, 'choices', v_after_choices,
      'hosting', v_after_hosting, 'meal_identity', v_identity,
      'import_status', case when v_import_change and v_registration.import_status = 'imported'
        then 'reimport_needed' else v_registration.import_status end));
  return true;
exception
  when unique_violation then
    if exists (select 1 from public.registrations where district_id = p_district_id
        and record_status = 'active' and id <> p_registration_id
        and name_key = public.registration_name_key(p_full_name)) then
      raise exception using errcode = '23505', message = 'NAME_TAKEN';
    end if;
    raise;
  when invalid_text_representation then
    raise exception using errcode = '22023', message = 'INVALID_CHOICES';
end;
$$;

-- Central lifecycle for both surveys; the existing base RPCs retain name/choice/rate-limit rules.
create or replace function public.save_registration_surveys(p_actor uuid,p_id uuid,p_request uuid,p_full_name text,
  p_district integer,p_choices jsonb,p_hosting jsonb,p_identity text,p_pickup jsonb,p_child_type text,p_parent text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.registrations; s public.site_settings; new_id uuid; new_serial bigint;
  identity_code text; v_child_type text; v_parent_name text; kind text; before_answer jsonb; after_answer jsonb;
  payload jsonb; allowed boolean; opened boolean; leaving boolean; changed boolean; was_valid boolean; valid boolean;
  actor_type text := case when p_actor is null then 'public' else 'staff' end;
begin
  select * into strict s from public.site_settings where id for share;
  if p_actor is not null then perform public.staff_assert_actor(p_actor,false); end if;
  -- Closed public operations must fail alike before looking up a name.
  if p_actor is null and p_request is null then
    if not s.is_registration_open or (s.registration_deadline_at is not null and s.registration_deadline_at<=now()) then
      raise exception using errcode='P0001',message='REGISTRATION_CLOSED';
    end if;
    if not s.is_lookup_open then raise exception using errcode='P0001',message='LOOKUP_CLOSED'; end if;
  end if;
  if p_request is null then
    if p_actor is null then
      select * into r from public.registrations where full_name is not null and district_id=p_district
        and name_key=public.registration_name_key(p_full_name) and record_status='active' for update;
    else
      select * into r from public.registrations where id=p_id and record_status='active' for update;
    end if;
    if r.id is null then return null; end if;
  elsif p_identity is null then
    raise exception using errcode='P0001',message='MEAL_IDENTITY_REQUIRED';
  end if;
  identity_code := coalesce(p_identity,r.meal_identity,'general');
  v_child_type := case identity_code when 'child' then 'elementary' when 'preschool' then 'preschool' end;
  if v_child_type is not null then
    v_parent_name := public.registration_parent_name(true,case when p_parent is null and r.child_type is not null then r.parent_name else p_parent end);
  end if;
  perform set_config('registration.saving_child',coalesce(v_child_type,''),true);
  perform set_config('registration.staff_identity',case when p_actor is null then '' else 'on' end,true);
  perform set_config('registration.surveys_managed','on',true);
  if p_request is not null then
    if p_actor is null then
      select registration_id,serial_no into new_id,new_serial from public.create_registration(p_request,p_full_name,p_district,p_choices,null,identity_code);
    else
      select registration_id,serial_no into new_id,new_serial from public.staff_create_registration(p_actor,p_request,p_full_name,p_district,p_choices,null,identity_code);
    end if;
  else
    new_id:=r.id;
    if not (case when p_actor is null then public.update_registration(p_full_name,p_district,p_choices,null,identity_code)
      else public.staff_update_registration(p_actor,new_id,p_full_name,p_district,p_choices,null,identity_code) end) then
      -- The flags must not leak into a later save in the same transaction.
      perform set_config('registration.surveys_managed','',true);
      perform set_config('registration.saving_child','',true);
      perform set_config('registration.staff_identity','',true);
      return null;
    end if;
  end if;
  if (r.child_type,r.parent_name) is distinct from (v_child_type,v_parent_name) then
    update public.registrations set is_child=v_child_type is not null,child_type=v_child_type,
      parent_name=v_parent_name,updated_at=now() where id=new_id;
    insert into public.audit_events(actor_type,actor_user_id,action,target_type,target_id,before_data,after_data)
      values(actor_type,p_actor,'registration.child_updated','registration',new_id,
        jsonb_build_object('is_child',coalesce(r.is_child,false),'child_type',r.child_type,'parent_name',r.parent_name),
        jsonb_build_object('is_child',v_child_type is not null,'child_type',v_child_type,'parent_name',v_parent_name));
  end if;
  foreach kind in array array['hosting','pickup'] loop
    before_answer:=case kind when 'hosting' then public.registration_hosting_get(new_id) else public.registration_pickup_get(new_id) end;
    was_valid:=before_answer is not null and coalesce((before_answer->>'answer_valid')::boolean,true);
    valid:=was_valid;
    payload:=case kind when 'hosting' then p_hosting else p_pickup end;
    allowed:=public.survey_identity_allowed(kind,identity_code);
    opened:=case kind when 'hosting' then s.is_hosting_open else s.is_pickup_open end;
    -- Saving a move out of this survey's identities stores 否 (decided 2026-11-11); staff saving a
    -- survey closed or not open to the identity also stores 否 (decided 2026-11-12). Whatever the
    -- page sent for this survey is then ignored.
    leaving:=p_request is null and r.meal_identity is distinct from identity_code
      and public.survey_identity_allowed(kind,r.meal_identity) and not allowed;
    if leaving or (p_actor is not null and (not allowed or not opened)) then
      payload:=case kind when 'hosting' then '{"status":"not_hosting"}'::jsonb else '{"status":"no","count":0}'::jsonb end;
    end if;
    if payload='{"reset":true}'::jsonb and p_request is null then
      -- A public page may only reset a survey its identity can answer.
      if p_actor is not null or allowed then valid:=false; end if;
      after_answer:=null;
      if p_actor is null and allowed and opened then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
    else
      if kind='hosting' and jsonb_typeof(payload)='object' and payload->>'pickup_count' is null then
        payload:=payload||jsonb_build_object('pickup_count',coalesce(before_answer->'pickup_count','0'::jsonb));
      end if;
      after_answer:=case when kind='hosting' then public.registration_hosting_value(payload) else public.registration_pickup_value(payload) end;
    end if;
    if p_actor is null and (not allowed or not opened) and not leaving then
      if after_answer is not null and after_answer is distinct from
        (case kind when 'hosting' then public.registration_hosting_value(before_answer) else public.registration_pickup_value(before_answer) end) then
        raise exception using errcode='P0001',message=upper(kind)||case when not allowed then '_NOT_ALLOWED' else '_CLOSED' end;
      end if;
      -- Changing configuration alone neither changes nor invalidates answers.
      after_answer:=before_answer;
    else
      if p_actor is null and allowed and opened and not was_valid and after_answer is null then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
      if p_request is not null and allowed and opened and after_answer is null then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
      if after_answer is not null then
        valid:=true;
        if kind='hosting' then perform public.registration_hosting_put(new_id,after_answer);
        else perform public.registration_pickup_put(new_id,after_answer); end if;
      else
        after_answer:=before_answer;
      end if;
    end if;
    if kind='hosting' then update public.registration_hosting set answer_valid=valid where registration_id=new_id;
    else update public.registration_pickup set answer_valid=valid where registration_id=new_id; end if;
    changed := (before_answer-'answer_valid') is distinct from (after_answer-'answer_valid') or was_valid is distinct from valid;
    if changed then
      update public.registrations set updated_at=now(),import_status=case when import_status='imported' then 'reimport_needed' else import_status end where id=new_id;
      insert into public.audit_events(actor_type,actor_user_id,action,target_type,target_id,before_data,after_data)
        values(actor_type,p_actor,'registration.'||kind||'_updated','registration',new_id,
          jsonb_build_object(kind,before_answer,'answer_valid',was_valid),jsonb_build_object(kind,after_answer,'answer_valid',valid));
    end if;
  end loop;
  if not public.survey_audience_valid(identity_code,p_choices,public.registration_hosting_get(new_id),public.registration_pickup_get(new_id)) then
    raise exception using errcode='P0001',message='AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.surveys_managed','',true);
  perform set_config('registration.saving_child','',true);
  perform set_config('registration.staff_identity','',true);
  return new_id;
end;
$$;
revoke all on function public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;

create or replace function public.create_registration_with_pickup(p_request_id uuid,p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default '',p_parent_name text default null)
returns table(registration_id uuid,serial_no bigint) language plpgsql security invoker set search_path='' as $$
declare saved uuid;
begin
  saved:=public.save_registration_surveys(null,null,p_request_id,p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name);
  return query select r.id,r.serial_no from public.registrations r where r.id=saved;
end;
$$;
create or replace function public.staff_create_registration_with_pickup(p_actor uuid,p_request_id uuid,p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default '',p_parent_name text default null)
returns table(registration_id uuid,serial_no bigint) language plpgsql security invoker set search_path='' as $$
declare saved uuid;
begin
  perform public.staff_assert_actor(p_actor,false);
  saved:=public.save_registration_surveys(p_actor,null,p_request_id,p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name);
  return query select r.id,r.serial_no from public.registrations r where r.id=saved;
end;
$$;
create or replace function public.update_registration_with_pickup(p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default null,p_parent_name text default null)
returns boolean language sql security invoker set search_path='' as $$
  select public.save_registration_surveys(null,null,null,p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name) is not null;
$$;
create or replace function public.staff_update_registration_with_pickup(p_actor uuid,p_registration_id uuid,p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default null,p_parent_name text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  perform public.staff_assert_actor(p_actor,false);
  return public.save_registration_surveys(p_actor,p_registration_id,null,p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name) is not null;
end;
$$;

-- The public page receives authoritative validity in the same save transaction, even if an
-- administrator changed targets while it was editing. Older clients may ignore the extra data.
create function public.update_registration_survey_result(p_full_name text,p_district_id integer,p_choices jsonb,
  p_hosting jsonb default null,p_meal_identity text default null,p_pickup jsonb default null,p_child_type text default null,p_parent_name text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if not public.update_registration_with_pickup(p_full_name,p_district_id,p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name) then return null; end if;
  select jsonb_build_object('success',true,'surveys',jsonb_build_object('hosting',public.registration_hosting_get(r.id),'pickup',public.registration_pickup_get(r.id)))
    into result from public.registrations r where r.district_id=p_district_id and r.name_key=public.registration_name_key(p_full_name) and r.record_status='active';
  return result;
end;
$$;
revoke all on function public.update_registration_survey_result(text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.update_registration_survey_result(text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;


create or replace function public.staff_registration_detail(p_actor uuid, p_registration_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  perform public.staff_assert_actor(p_actor, false);
  select to_jsonb(detail) into result from (
    select r.id,r.serial_no,r.full_name,r.district_id,r.record_status,r.import_status,r.created_at,r.updated_at,
      r.meal_identity,r.is_child,r.child_type,r.parent_name,
      coalesce((select jsonb_agg(jsonb_build_object('activity_id',c.activity_id,'attending',c.attending))
        from public.registration_choices c where c.registration_id=r.id),'[]') as registration_choices,
      public.registration_hosting_get(r.id) as registration_hosting,
      public.registration_pickup_get(r.id) as registration_pickup,
      coalesce((select jsonb_agg(jsonb_build_object('serial_no',c.serial_no,'full_name',c.full_name) order by c.serial_no)
        from public.staff_registration_children(jsonb_build_array(jsonb_build_object('district_id',r.district_id,'name_key',r.name_key))) c
        where r.record_status='active' and not r.is_child),'[]') as children
    from public.registrations r where r.id=p_registration_id
  ) detail;
  return result;
end;
$$;

create or replace function public.staff_registration_statistics(p_actor uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare v_result jsonb; v_hosting_codes text[]; v_pickup_codes text[];
begin
  perform public.staff_assert_actor(p_actor, false);
  select hosting_identity_codes,pickup_identity_codes into v_hosting_codes,v_pickup_codes from public.site_settings where id;
  with people as materialized (
    select r.id, r.district_id, r.meal_identity, r.child_type,
      case when h.registration_id is null and not (coalesce(r.meal_identity,'general')=any(v_hosting_codes)) then 'not_applicable' else h.status end as hosting_status, h.guest_type, h.guest_count,
      case when p.registration_id is null and not (coalesce(r.meal_identity,'general')=any(v_pickup_codes)) then 'not_applicable' else p.status end as pickup_status, p.count as pickup_count
    from public.registrations r
    left join public.registration_hosting h on h.registration_id = r.id and h.answer_valid
    left join public.registration_pickup p on p.registration_id = r.id and p.answer_valid
    where r.record_status = 'active'
  ), responses as materialized (
    select r.id, r.district_id, r.meal_identity, r.child_type, c.activity_id, c.attending,
      case coalesce(a.audience, 'all')
        when 'all' then true
        when 'hosting' then not (coalesce(r.meal_identity,'general')=any(v_hosting_codes))
          or coalesce(r.hosting_status in ('hosting','family_registered'), false)
        when 'pickup' then not (coalesce(r.meal_identity,'general')=any(v_pickup_codes))
          or coalesce(r.pickup_status = 'yes', false)
        else coalesce(required.attending, false) end as eligible
    from people r
    join public.registration_choices c on c.registration_id = r.id
    join public.activities a on a.id = c.activity_id and a.is_published
    left join public.activities prerequisite on 'activity:' || prerequisite.id::text = a.audience and prerequisite.is_published
    left join public.registration_choices required on required.registration_id = r.id and required.activity_id = prerequisite.id
  ), meal_attendees as (
    select distinct c.id from responses c join public.activities a on a.id = c.activity_id
    where c.attending and a.category = 'meal'
  ), person_counts as (
    select district_id, meal_identity, child_type, count(*) as count,
      count(*) filter (where meal_identity is null and m.id is not null) as no_identity
    from people left join meal_attendees m on m.id = people.id
    group by district_id, meal_identity, child_type
  ), choice_counts as (
    select district_id, meal_identity, child_type, activity_id, attending, eligible, count(*) as count
    from responses group by district_id, meal_identity, child_type, activity_id, attending, eligible
  ), hosting_counts as (
    select hosting_status as status, guest_type, count(*) as registrations,
      coalesce(sum(guest_count),0) as people
    from people group by hosting_status, guest_type
  ), pickup_counts as (
    select pickup_status as status, count(*) as registrations, coalesce(sum(pickup_count),0) as people
    from people group by pickup_status
  )
  select jsonb_build_object(
    'people', coalesce((select jsonb_agg(to_jsonb(x)) from person_counts x),'[]'),
    'choices', coalesce((select jsonb_agg(to_jsonb(x)) from choice_counts x),'[]'),
    'hosting', coalesce((select jsonb_agg(to_jsonb(x)) from hosting_counts x),'[]'),
    'pickup', coalesce((select jsonb_agg(to_jsonb(x)) from pickup_counts x),'[]')
  ) into v_result;
  return v_result;
end;
$$;

alter function public.staff_save_reference(uuid,text,jsonb) rename to staff_save_reference_before_surveys;
create function public.staff_save_reference(p_actor uuid,p_kind text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare before_settings jsonb; result jsonb; h text[]; p text[];
begin
  perform public.staff_assert_actor(p_actor,true);
  if p_kind='delete_identity' then perform 1 from public.site_settings where id for update; end if;
  if p_kind='delete_identity' and exists(select 1 from public.site_settings where id and
    (p_data->>'code'=any(hosting_identity_codes) or p_data->>'code'=any(pickup_identity_codes))) then
    raise exception using errcode='22023',message='IDENTITY_IN_SURVEY_TARGETS';
  end if;
  if p_kind<>'hosting' then return public.staff_save_reference_before_surveys(p_actor,p_kind,p_data); end if;
  if jsonb_typeof(p_data->'is_hosting_open') is distinct from 'boolean' or jsonb_typeof(p_data->'is_pickup_open') is distinct from 'boolean' then
    raise exception using errcode='22023',message='INVALID_REFERENCE_DATA';
  end if;
  select to_jsonb(s),s.hosting_identity_codes,s.pickup_identity_codes into before_settings,h,p from public.site_settings s where id for update;
  if p_data ? 'hosting_identity_codes' then
    if jsonb_typeof(p_data->'hosting_identity_codes')<>'array' then raise exception using errcode='22023',message='INVALID_SURVEY_IDENTITIES'; end if;
    select coalesce(array_agg(value),'{}') into h from jsonb_array_elements_text(p_data->'hosting_identity_codes');
  end if;
  if p_data ? 'pickup_identity_codes' then
    if jsonb_typeof(p_data->'pickup_identity_codes')<>'array' then raise exception using errcode='22023',message='INVALID_SURVEY_IDENTITIES'; end if;
    select coalesce(array_agg(value),'{}') into p from jsonb_array_elements_text(p_data->'pickup_identity_codes');
  end if;
  if exists(select 1 from unnest(h||p) selected(code) where selected.code is null or not exists(select 1 from public.registration_identities i where i.code=selected.code))
    or coalesce((p_data->>'is_hosting_open')::boolean,false) and cardinality(h)=0
    or coalesce((p_data->>'is_pickup_open')::boolean,false) and cardinality(p)=0 then
    raise exception using errcode='22023',message='INVALID_SURVEY_IDENTITIES';
  end if;
  update public.site_settings set is_hosting_open=(p_data->>'is_hosting_open')::boolean,
    is_pickup_open=(p_data->>'is_pickup_open')::boolean,
    hosting_description=nullif(btrim(p_data->>'hosting_description'),''),pickup_description=nullif(btrim(p_data->>'pickup_description'),''),
    hosting_identity_codes=h,pickup_identity_codes=p,updated_at=now() where id returning to_jsonb(site_settings.*) into result;
  if (before_settings-'updated_at') is distinct from (result-'updated_at') then
    insert into public.audit_events(actor_type,actor_user_id,action,target_type,before_data,after_data)
      values('admin',p_actor,'reference.saved','hosting',before_settings,result);
  end if;
  return result;
end;
$$;
revoke all on function public.staff_save_reference(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.staff_save_reference(uuid,text,jsonb) to service_role;

create or replace function public.staff_save_reception_settings(p_actor uuid,p_kind text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  if p_kind<>'hosting' then raise exception using errcode='22023',message='INVALID_REFERENCE_KIND'; end if;
  return public.staff_save_reference(p_actor,p_kind,p_data);
end;
$$;


commit;
