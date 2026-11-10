-- Unified identity selection; apply with registration closed, then deploy both Edge Functions and site.
begin;
create or replace function public.registration_meal_identity(p_choices jsonb, p_identity text, p_stored text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_child boolean := public.registration_saving_child(); v_code text; v_identity public.registration_identities;
begin
  if v_child then
    v_code := case when current_setting('registration.saving_child',true) = 'preschool' then 'preschool' else 'child' end;
  else
    if p_identity is null and p_stored is null then
      raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
    end if;
    -- A former child's stored identity falls back to general.
    v_code := coalesce(p_identity, case when p_stored not in ('child','preschool') then p_stored end, 'general');
    if v_code in ('child','preschool') then
      raise exception using errcode = '22023', message = 'INVALID_MEAL_IDENTITY';
    end if;
  end if;
  select * into v_identity from public.registration_identities where code = v_code for share;
  if not found or (v_code is distinct from p_stored and (not v_identity.is_active
      or (not v_identity.public_selectable
        and coalesce(current_setting('registration.staff_identity', true), '') <> 'on'))) then
    raise exception using errcode = '22023', message = 'INVALID_MEAL_IDENTITY';
  end if;
  return v_code;
end;
$$;
create or replace function public.create_registration_with_pickup(
  p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_open boolean; v_type text; v_child boolean;
  v_before public.registrations;
begin
  -- A new registration must choose an identity; it alone decides the child type.
  if p_meal_identity is null then
    raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
  end if;
  v_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' end;
  v_child := v_type is not null;
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.create_registration(p_request_id, p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('public', null, v_id, v_before, v_type,
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
create or replace function public.update_registration_with_pickup(
  p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_open boolean; v_registration public.registrations;
  v_child boolean; v_type text;
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
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := case when (select is_hosting_open from public.site_settings where id)
      then '{"status": "not_hosting"}'::jsonb end;
  end if;
  if not public.update_registration(p_full_name, p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  v_id := v_registration.id;
  if v_child then
    perform public.registration_child_save('public', null, v_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
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
  return true;
end;
$$;
create or replace function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_type text; v_child boolean;
  v_before public.registrations;
begin
  perform public.staff_assert_actor(p_actor, false);
  -- A new registration must choose an identity; it alone decides the child type.
  if p_meal_identity is null then
    raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
  end if;
  v_type := case p_meal_identity when 'preschool' then 'preschool' when 'child' then 'elementary' end;
  v_child := v_type is not null;
  perform set_config('registration.staff_identity', 'on', true);
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  select c.registration_id, c.serial_no into v_id, v_serial
  from public.staff_create_registration(p_actor, p_request_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) c;
  if v_child then
    select * into v_before from public.registrations where id = v_id;
    perform public.registration_child_save('staff', p_actor, v_id, v_before, v_type,
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
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;
create or replace function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean; v_type text;
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
  if v_child then
    perform set_config('registration.saving_child', v_type, true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.staff_identity', '', true);
    perform set_config('registration.saving_child', '', true);
    return false;
  end if;
  if v_child then
    perform public.registration_child_save('staff', p_actor, p_registration_id, v_registration, v_type,
      case when p_child_type is null then v_registration.parent_name
        else public.registration_parent_name(true, p_parent_name) end);
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
  return true;
end;
$$;
create function public.registration_used_identity_codes() returns setof text
language sql stable security invoker set search_path = '' as $$
  select distinct meal_identity from public.registrations;
$$;
revoke all on function public.registration_used_identity_codes() from public, anon, authenticated;
grant execute on function public.registration_used_identity_codes() to service_role;
commit;
