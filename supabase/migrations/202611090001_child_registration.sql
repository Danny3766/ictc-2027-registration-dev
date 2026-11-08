-- 2026-11-09: 兒童報名. Decisions are in docs/需求討論與決策紀錄.md, section "2026-11-09 兒童報名".
-- Apply first, then deploy the registration and staff Edge Functions, then the site. Registration
-- can stay open throughout: an older Edge Function or page sends no child fields, so a new
-- registration is not a child and a saved one keeps what it has.
--   * registrations.is_child and parent_name (1～20 characters, required for a child only).
--     parent_name_key follows registration_name_key, so the back office finds the parent the way the
--     public lookup finds a person: same district, active registration, case and spaces ignored.
--   * A child answers neither 開家接待 nor 接機接待; both are stored as 否 whatever the switches say,
--     and a child is outside the hosting and pickup audiences (an activity: prerequisite still holds).
--   * The *_with_pickup wrappers take p_is_child and p_parent_name. On update, a request without
--     p_is_child keeps the stored child fields. Like meal_identity, a change to the child fields alone
--     needs no re-import; the 否 answers it brings do, like any hosting or pickup change.
begin;

alter table public.registrations
  add column is_child boolean not null default false,
  add column parent_name text,
  add column parent_name_key text generated always as
    (case when parent_name is null then null else public.registration_name_key(parent_name) end) stored,
  add constraint registrations_child_parent_name check (case when is_child
    then parent_name = btrim(parent_name) and length(parent_name) between 1 and 20
      and public.registration_name_key(parent_name) <> ''
    else parent_name is null end);

-- The back office looks up a page's parents by district and name; only active children count.
create index registrations_active_child_parent on public.registrations (district_id, parent_name_key)
  where record_status = 'active' and is_child;

-- The parent name to store: null when not a child, otherwise the trimmed name or INVALID_PARENT_NAME.
create function public.registration_parent_name(p_is_child boolean, p_parent_name text)
returns text language plpgsql immutable security invoker set search_path = '' as $$
begin
  if not coalesce(p_is_child, false) then return null; end if;
  if coalesce(length(btrim(p_parent_name)), 0) not between 1 and 20
    or public.registration_name_key(p_parent_name) = '' then
    raise exception using errcode = '22023', message = 'INVALID_PARENT_NAME';
  end if;
  return btrim(p_parent_name);
end;
$$;

-- The inner RPCs check audiences without knowing the registration is a child, so the wrappers mark a
-- child's save with this transaction-local setting and clear it when they finish.
create function public.registration_saving_child()
returns boolean language sql stable security invoker set search_path = '' as $$
  select coalesce(current_setting('registration.saving_child', true), '') = 'on';
$$;

-- Same as 202611050006, except a child is outside the hosting audience.
create or replace function public.registration_audience_valid(p_choices jsonb, p_hosting jsonb)
returns boolean language sql stable security invoker set search_path = '' as $$
  select public.registration_saving_child() or not exists (
    select 1 from jsonb_array_elements(p_choices) choice
    join public.activities activity on activity.id = (choice->>'activity_id')::bigint
    where activity.audience = 'hosting' and (choice->>'attending')::boolean
      and coalesce(p_hosting->>'status', '') not in ('hosting', 'family_registered')
  );
$$;

-- Same as 202611060002, except a child is outside the hosting and pickup audiences.
create or replace function public.registration_audience_valid(p_choices jsonb, p_hosting jsonb, p_pickup jsonb)
returns boolean language sql stable security invoker set search_path = '' as $$
  select not exists (
    select 1 from jsonb_array_elements(p_choices) choice
    join public.activities activity on activity.id = (choice->>'activity_id')::bigint
    where (choice->>'attending')::boolean and (
      (activity.audience = 'hosting' and not public.registration_saving_child()
        and coalesce(p_hosting->>'status', '') not in ('hosting', 'family_registered'))
      or (activity.audience = 'pickup' and not public.registration_saving_child()
        and coalesce(p_pickup->>'status', '') <> 'yes')
      or (activity.audience like 'activity:%' and not exists (
        select 1 from public.activities prerequisite
        join jsonb_array_elements(p_choices) required_choice
          on (required_choice->>'activity_id')::bigint = prerequisite.id
        where prerequisite.id = nullif(substring(activity.audience from 10), '')::bigint
          and prerequisite.is_published and (required_choice->>'attending')::boolean
      ))
    )
  );
$$;

-- Stores 否 for both surveys on a child's registration; true when either answer changed.
create function public.registration_child_answers_put(p_registration_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  v_hosting jsonb := public.registration_hosting_value('{"status": "not_hosting"}');
  v_pickup jsonb := public.registration_pickup_value('{"status": "no", "count": 0}');
  v_changed boolean := false;
begin
  if public.registration_hosting_get(p_registration_id) is distinct from v_hosting then
    perform public.registration_hosting_put(p_registration_id, v_hosting);
    v_changed := true;
  end if;
  if public.registration_pickup_get(p_registration_id) is distinct from v_pickup then
    perform public.registration_pickup_put(p_registration_id, v_pickup);
    v_changed := true;
  end if;
  return v_changed;
end;
$$;

-- Saves the child fields, and for a child the 否 answers, after an inner RPC saved the rest.
-- p_before is the registration as it was before that RPC. The audit's hosting and pickup are as this
-- function found and left them; a hosting answer the inner RPC changed is in its own audit.
create function public.registration_child_save(
  p_actor_type text, p_actor uuid, p_registration_id uuid, p_before public.registrations,
  p_is_child boolean, p_parent_name text
) returns void language plpgsql security invoker set search_path = '' as $$
declare v_hosting jsonb; v_pickup jsonb; v_fields_changed boolean; v_answers_changed boolean := false;
begin
  v_hosting := public.registration_hosting_get(p_registration_id);
  v_pickup := public.registration_pickup_get(p_registration_id);
  v_fields_changed := (p_before.is_child, p_before.parent_name) is distinct from (p_is_child, p_parent_name);
  if p_is_child then v_answers_changed := public.registration_child_answers_put(p_registration_id); end if;
  if not v_fields_changed and not v_answers_changed then return; end if;
  update public.registrations set is_child = p_is_child, parent_name = p_parent_name, updated_at = now(),
    import_status = case when v_answers_changed and import_status = 'imported' then 'reimport_needed'
      else import_status end
  where id = p_registration_id;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
  values (p_actor_type, p_actor, 'registration.child_updated', 'registration', p_registration_id,
    jsonb_build_object('is_child', p_before.is_child, 'parent_name', p_before.parent_name,
      'hosting', v_hosting, 'pickup', v_pickup),
    jsonb_build_object('is_child', p_is_child, 'parent_name', p_parent_name,
      'hosting', public.registration_hosting_get(p_registration_id),
      'pickup', public.registration_pickup_get(p_registration_id)));
end;
$$;

-- New parameters change the signatures, so these are dropped and recreated (create or replace would
-- add overloads) and granted again below.
drop function public.create_registration_with_pickup(uuid, text, integer, jsonb, jsonb, text, jsonb);
drop function public.update_registration_with_pickup(text, integer, jsonb, jsonb, text, jsonb);
drop function public.staff_create_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb);
drop function public.staff_update_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb);

-- Same as 202611060002, plus the child fields. The inner RPC refuses a hosting answer while the
-- survey is closed and requires one while it is open, so a child sends 否 only while it is open.
create function public.create_registration_with_pickup(
  p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default false, p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_open boolean; v_child boolean := coalesce(p_is_child, false);
  v_before public.registrations;
begin
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.create_registration(p_request_id, p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('public', null, v_id, v_before, true,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    select is_pickup_open into v_open from public.site_settings where id;
    if not v_open and v_pickup is not null then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and v_pickup is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, action, target_type, target_id, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611060002, plus the child fields. p_is_child null (an older page or Edge Function)
-- keeps the stored child fields. The row is locked first so they cannot change under this save.
create function public.update_registration_with_pickup(
  p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_open boolean; v_registration public.registrations;
  v_child boolean;
begin
  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  v_child := coalesce(p_is_child, v_registration.is_child, false);
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  if not public.update_registration(p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  v_id := v_registration.id;
  if v_child then
    perform public.registration_child_save('public', null, v_id, v_registration, true,
      case when p_is_child is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('public', null, v_id, v_registration, false, null);
    select is_pickup_open into v_open from public.site_settings where id;
    v_before := public.registration_pickup_get(v_id);
    v_after := public.registration_pickup_value(p_pickup);
    if not v_open and v_after is not null and v_after is distinct from v_before then
      raise exception using errcode = 'P0001', message = 'PICKUP_CLOSED';
    end if;
    if v_open and coalesce(v_after, v_before) is null then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_open and v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(v_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = v_id;
      insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
      values ('public', 'registration.pickup_updated', 'registration', v_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;

-- Same as 202611060002, plus the child fields. Staff answer hosting whether or not it is open.
create function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default false, p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_child boolean := coalesce(p_is_child, false);
  v_before public.registrations;
begin
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.staff_create_registration(p_actor, p_request_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('staff', p_actor, v_id, v_before, true,
      public.registration_parent_name(true, p_parent_name));
  else
    v_pickup := public.registration_pickup_value(p_pickup);
    if v_pickup is null and coalesce((select is_pickup_open from public.site_settings where id), false) then
      raise exception using errcode = 'P0001', message = 'PICKUP_REQUIRED';
    end if;
    if v_pickup is not null then
      perform public.registration_pickup_put(v_id, v_pickup);
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', v_id, jsonb_build_object('pickup', v_pickup));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(v_id),
    public.registration_pickup_get(v_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611060002, plus the child fields; p_is_child null keeps the stored ones.
create function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean;
begin
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  v_child := coalesce(p_is_child, v_registration.is_child, false);
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  if v_child then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, true,
      case when p_is_child is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  else
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, false, null);
    v_before := public.registration_pickup_get(p_registration_id);
    v_after := public.registration_pickup_value(p_pickup);
    if v_after is not null and v_after is distinct from v_before then
      perform public.registration_pickup_put(p_registration_id, v_after);
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = p_registration_id;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
      values ('staff', p_actor, 'registration.pickup_updated', 'registration', p_registration_id,
        jsonb_build_object('pickup', v_before), jsonb_build_object('pickup', v_after));
    end if;
  end if;
  if not public.registration_audience_valid(p_choices, public.registration_hosting_get(p_registration_id),
    public.registration_pickup_get(p_registration_id)) then
    raise exception using errcode = 'P0001', message = 'AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;

-- The public lookup's child fields, beside get_registration and get_registration_pickup.
create function public.get_registration_child(p_full_name text, p_district_id integer)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_child jsonb;
begin
  if not exists (select 1 from public.site_settings where id and is_lookup_open) then
    raise exception using errcode = 'P0001', message = 'LOOKUP_CLOSED';
  end if;
  select jsonb_build_object('is_child', r.is_child, 'parent_name', r.parent_name) into v_child
  from public.registrations r
  where r.district_id = p_district_id and r.name_key = public.registration_name_key(p_full_name)
    and r.record_status = 'active';
  return v_child;
end;
$$;

-- The active children whose parent name matches one of p_parents ([{district_id, name_key}]),
-- for the back office's 親子 column. Uses registrations_active_child_parent.
create function public.registration_children(p_parents jsonb)
returns table (district_id integer, parent_name_key text, serial_no bigint)
language sql stable security invoker set search_path = '' as $$
  select child.district_id, child.parent_name_key, child.serial_no
  from jsonb_to_recordset(p_parents) parent(district_id integer, name_key text)
  join public.registrations child on child.district_id = parent.district_id
    and child.parent_name_key = parent.name_key
  where child.record_status = 'active' and child.is_child
  order by child.serial_no;
$$;

revoke execute on function public.registration_parent_name(boolean, text), public.registration_saving_child(),
  public.registration_child_answers_put(uuid),
  public.registration_child_save(text, uuid, uuid, public.registrations, boolean, text),
  public.create_registration_with_pickup(uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.update_registration_with_pickup(text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.staff_create_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.staff_update_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.get_registration_child(text, integer), public.registration_children(jsonb)
  from public, anon, authenticated;
grant execute on function public.registration_parent_name(boolean, text), public.registration_saving_child(),
  public.registration_child_answers_put(uuid),
  public.registration_child_save(text, uuid, uuid, public.registrations, boolean, text),
  public.create_registration_with_pickup(uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.update_registration_with_pickup(text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.staff_create_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.staff_update_registration_with_pickup(uuid, uuid, text, integer, jsonb, jsonb, text, jsonb, boolean, text),
  public.get_registration_child(text, integer), public.registration_children(jsonb)
  to service_role;

commit;
