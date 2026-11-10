-- 2026-11-10: only 一般 (code general) answers 開家接待 and 接機接待. Decisions are in
-- docs/需求討論與決策紀錄.md, section "接待題限一般身分、提醒區塊與查詢結果版面".
-- Before applying, run supabase/testing/preview-hosting-general-only.sql and have the project lead
-- confirm the listed registrations. Apply with registration closed, then deploy the site.
--   * Students and custom identities answer neither survey, like children: both are stored as 否,
--     and they are outside the hosting and pickup audiences (an activity: prerequisite still holds).
--   * A registration without an identity (from before the unified identity) is left as it is.
--   * Existing active registrations with such an identity get 否 now, each with an audit row.
begin;

-- Set by the wrappers below while saving a non-general, non-child registration.
create function public.registration_skipping_hosting()
returns boolean language sql stable security invoker set search_path = '' as $$
  select public.registration_saving_child()
    or coalesce(current_setting('registration.skip_hosting', true), '') = 'on';
$$;

-- Same as 202611090001, except any identity that skips the surveys is outside the hosting audience.
create or replace function public.registration_audience_valid(p_choices jsonb, p_hosting jsonb)
returns boolean language sql stable security invoker set search_path = '' as $$
  select public.registration_skipping_hosting() or not exists (
    select 1 from jsonb_array_elements(p_choices) choice
    join public.activities activity on activity.id = (choice->>'activity_id')::bigint
    where activity.audience = 'hosting' and (choice->>'attending')::boolean
      and coalesce(p_hosting->>'status', '') not in ('hosting', 'family_registered')
  );
$$;

-- Same as 202611090001, except any identity that skips the surveys is outside both audiences.
create or replace function public.registration_audience_valid(p_choices jsonb, p_hosting jsonb, p_pickup jsonb)
returns boolean language sql stable security invoker set search_path = '' as $$
  select not exists (
    select 1 from jsonb_array_elements(p_choices) choice
    join public.activities activity on activity.id = (choice->>'activity_id')::bigint
    where (choice->>'attending')::boolean and (
      (activity.audience = 'hosting' and not public.registration_skipping_hosting()
        and coalesce(p_hosting->>'status', '') not in ('hosting', 'family_registered'))
      or (activity.audience = 'pickup' and not public.registration_skipping_hosting()
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

-- Same as 202611100001, plus p_answers_off: a non-child that skips the surveys also gets the 否 answers.
drop function public.registration_child_save(text,uuid,uuid,public.registrations,text,text);
create function public.registration_child_save(
  p_actor_type text, p_actor uuid, p_registration_id uuid, p_before public.registrations,
  p_child_type text, p_parent_name text, p_answers_off boolean default false
) returns void language plpgsql security invoker set search_path = '' as $$
declare v_is_child boolean := p_child_type is not null; v_hosting jsonb; v_pickup jsonb; v_fields_changed boolean; v_answers_changed boolean := false;
begin
  v_hosting := public.registration_hosting_get(p_registration_id);
  v_pickup := public.registration_pickup_get(p_registration_id);
  v_fields_changed := (p_before.child_type, p_before.parent_name) is distinct from (p_child_type, p_parent_name);
  if v_is_child or p_answers_off then v_answers_changed := public.registration_child_answers_put(p_registration_id); end if;
  if not v_fields_changed and not v_answers_changed then return; end if;
  update public.registrations set child_type = p_child_type, is_child = v_is_child, parent_name = p_parent_name, updated_at = now(),
    import_status = case when (v_answers_changed or p_before.child_type is distinct from p_child_type) and import_status = 'imported' then 'reimport_needed'
      else import_status end
  where id = p_registration_id;
  insert into public.audit_events (actor_type, actor_user_id, action, target_type, target_id, before_data, after_data)
  values (p_actor_type, p_actor, 'registration.child_updated', 'registration', p_registration_id,
    jsonb_build_object('child_type', p_before.child_type, 'is_child', p_before.is_child, 'parent_name', p_before.parent_name,
      'hosting', v_hosting, 'pickup', v_pickup),
    jsonb_build_object('child_type', p_child_type, 'is_child', v_is_child, 'parent_name', p_parent_name,
      'hosting', public.registration_hosting_get(p_registration_id),
      'pickup', public.registration_pickup_get(p_registration_id)));
end;
$$;

-- Same as 202611100002, except a non-general identity skips both surveys like a child.
create or replace function public.create_registration_with_pickup(
  p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_open boolean; v_type text; v_child boolean; v_skip boolean;
  v_before public.registrations;
begin
  -- A new registration must choose an identity; it alone decides the child type.
  if p_meal_identity is null then
    raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
  end if;
  v_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' end;
  v_child := v_type is not null;
  v_skip := not v_child and p_meal_identity <> 'general';
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
  elsif v_skip then
    perform set_config('registration.skip_hosting', 'on', true);
  end if;
  if v_child or v_skip then
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.create_registration(p_request_id, p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child or v_skip then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('public', null, v_id, v_before, v_type,
      case when v_child then public.registration_parent_name(true, p_parent_name) end, v_skip);
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
  perform set_config('registration.skip_hosting', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611100002, except a non-general identity skips both surveys like a child. A stored
-- identity counts when the page sends none; a registration without one is left as it is.
create or replace function public.update_registration_with_pickup(
  p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_open boolean; v_registration public.registrations;
  v_child boolean; v_type text; v_skip boolean;
begin
  -- An identity sent decides the child type; an older page sends none and keeps the stored one.
  if p_meal_identity is not null then
    p_child_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' else '' end;
  end if;
  select * into v_registration from public.registrations
  where district_id = p_district_id and name_key = public.registration_name_key(p_full_name)
    and record_status = 'active'
  for update;
  v_type := public.registration_child_type(coalesce(p_child_type, v_registration.child_type));
  v_child := v_type is not null;
  v_skip := not v_child and coalesce(p_meal_identity, v_registration.meal_identity, 'general') <> 'general';
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
  elsif v_skip then
    perform set_config('registration.skip_hosting', 'on', true);
  end if;
  if v_child or v_skip then
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  if not public.update_registration(p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    perform set_config('registration.skip_hosting', '', true);
    return false;
  end if;
  v_id := v_registration.id;
  if v_child then
    perform public.registration_child_save('public', null, v_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  elsif v_skip then
    perform public.registration_child_save('public', null, v_id, v_registration, null, null, true);
  else
    perform public.registration_child_save('public', null, v_id, v_registration, null, null);
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
  perform set_config('registration.skip_hosting', '', true);
  return true;
end;
$$;

-- Same as 202611100002, except a non-general identity skips both surveys like a child.
create or replace function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_type text; v_child boolean; v_skip boolean;
  v_before public.registrations;
begin
  perform public.staff_assert_actor(p_actor, false);
  -- A new registration must choose an identity; it alone decides the child type.
  if p_meal_identity is null then
    raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
  end if;
  v_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' end;
  v_child := v_type is not null;
  v_skip := not v_child and p_meal_identity <> 'general';
  perform set_config('registration.staff_identity', 'on', true);
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
  elsif v_skip then
    perform set_config('registration.skip_hosting', 'on', true);
  end if;
  if v_child or v_skip then p_hosting := '{"status": "not_hosting"}'; end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.staff_create_registration(p_actor, p_request_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child or v_skip then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('staff', p_actor, v_id, v_before, v_type,
      case when v_child then public.registration_parent_name(true, p_parent_name) end, v_skip);
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
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  perform set_config('registration.skip_hosting', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611100002, except a non-general identity skips both surveys like a child. A stored
-- identity counts when the page sends none; a registration without one is left as it is.
create or replace function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean; v_type text; v_skip boolean;
begin
  perform public.staff_assert_actor(p_actor, false);
  -- An identity sent decides the child type; an older page sends none and keeps the stored one.
  if p_meal_identity is not null then
    p_child_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' else '' end;
  end if;
  perform set_config('registration.staff_identity', 'on', true);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  v_type := public.registration_child_type(coalesce(p_child_type, v_registration.child_type));
  v_child := v_type is not null;
  v_skip := not v_child and coalesce(p_meal_identity, v_registration.meal_identity, 'general') <> 'general';
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
  elsif v_skip then
    perform set_config('registration.skip_hosting', 'on', true);
  end if;
  if v_child or v_skip then p_hosting := '{"status": "not_hosting"}'; end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.staff_identity', '', true);
    perform set_config('registration.saving_child', '', true);
    perform set_config('registration.skip_hosting', '', true);
    return false;
  end if;
  if v_child then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
  elsif v_skip then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, null, null, true);
  else
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, null, null);
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
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  perform set_config('registration.skip_hosting', '', true);
  return true;
end;
$$;

revoke all on function public.registration_skipping_hosting(),
  public.registration_child_save(text,uuid,uuid,public.registrations,text,text,boolean)
  from public, anon, authenticated;
grant execute on function public.registration_skipping_hosting(),
  public.registration_child_save(text,uuid,uuid,public.registrations,text,text,boolean)
  to service_role;

-- Existing active registrations with a non-general, non-child identity: 否 for both surveys, audited.
do $$
declare v_registration public.registrations; v_hosting jsonb; v_pickup jsonb;
begin
  for v_registration in
    select * from public.registrations
    where record_status = 'active' and not is_child and meal_identity is not null
      and meal_identity not in ('general', 'child', 'preschool')
    order by serial_no
    for update
  loop
    v_hosting := public.registration_hosting_get(v_registration.id);
    v_pickup := public.registration_pickup_get(v_registration.id);
    if public.registration_child_answers_put(v_registration.id) then
      update public.registrations set updated_at = now(),
        import_status = case when import_status = 'imported' then 'reimport_needed' else import_status end
      where id = v_registration.id;
      insert into public.audit_events (actor_type, action, target_type, target_id, before_data, after_data)
      values ('maintenance', 'registration.hosting_general_only', 'registration', v_registration.id,
        jsonb_build_object('meal_identity', v_registration.meal_identity, 'hosting', v_hosting, 'pickup', v_pickup),
        jsonb_build_object('meal_identity', v_registration.meal_identity,
          'hosting', public.registration_hosting_get(v_registration.id),
          'pickup', public.registration_pickup_get(v_registration.id)));
    end if;
  end loop;
end;
$$;

commit;
