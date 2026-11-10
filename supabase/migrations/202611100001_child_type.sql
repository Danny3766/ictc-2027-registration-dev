-- Child types: apply after 202611090003 with registration closed.
-- Then deploy registration/staff Edge Functions and the site together.
begin;
alter table public.registrations add column child_type text;
update public.registrations set child_type = 'elementary' where is_child;
alter table public.registrations add constraint registrations_child_type check
  (child_type in ('preschool', 'elementary') and is_child = (child_type is not null));
alter table public.registration_identities drop constraint registration_identities_reserved;
alter table public.registration_identities add constraint registration_identities_reserved check
  (code not in ('general','child','preschool') or (is_active and public_selectable));
update public.registration_identities set name = '兒童（國小）' where code = 'child';
insert into public.registration_identities(code,name,sort_order) values ('preschool','兒童（學齡前）',3);
create function public.registration_identity_delete_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.code in ('general','child','preschool') then
    raise exception using errcode = '22023', message = 'IDENTITY_IN_USE';
  end if;
  return old;
end;
$$;
create trigger registration_identity_delete_guard before delete on public.registration_identities
for each row execute function public.registration_identity_delete_guard();
create function public.registration_child_type(p_type text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_type is not null and p_type not in ('','preschool','elementary') then
    raise exception using errcode = '22023', message = 'INVALID_CHILD_TYPE';
  end if;
  return nullif(p_type,'');
end;
$$;
create or replace function public.registration_saving_child() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('registration.saving_child',true),'') <> '';
$$;
create or replace function public.registration_meal_identity(p_choices jsonb, p_identity text, p_stored text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_child boolean := public.registration_saving_child(); v_code text; v_identity public.registration_identities;
begin
  if v_child then
    v_code := case when current_setting('registration.saving_child',true) = 'preschool' then 'preschool' else 'child' end;
  else
    if p_identity is null and p_stored is null and exists (
      select 1 from jsonb_array_elements(p_choices) choice
      join public.activities activity on activity.id = (choice->>'activity_id')::bigint
      where activity.is_published and activity.category = 'meal' and (choice->>'attending')::boolean
    ) then
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
drop function public.registration_child_save(text,uuid,uuid,public.registrations,boolean,text);
create function public.registration_child_save(
  p_actor_type text, p_actor uuid, p_registration_id uuid, p_before public.registrations,
  p_child_type text, p_parent_name text
) returns void language plpgsql security invoker set search_path = '' as $$
declare v_is_child boolean := p_child_type is not null; v_hosting jsonb; v_pickup jsonb; v_fields_changed boolean; v_answers_changed boolean := false;
begin
  v_hosting := public.registration_hosting_get(p_registration_id);
  v_pickup := public.registration_pickup_get(p_registration_id);
  v_fields_changed := (p_before.child_type, p_before.parent_name) is distinct from (p_child_type, p_parent_name);
  if v_is_child then v_answers_changed := public.registration_child_answers_put(p_registration_id); end if;
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
drop function public.create_registration_with_pickup(uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,text);
create function public.create_registration_with_pickup(
  p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_open boolean; v_type text := public.registration_child_type(p_child_type); v_child boolean := v_type is not null;
  v_before public.registrations;
begin
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
revoke all on function public.create_registration_with_pickup(uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.create_registration_with_pickup(uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
drop function public.update_registration_with_pickup(text,integer,jsonb,jsonb,text,jsonb,boolean,text);
create function public.update_registration_with_pickup(
  p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_id uuid; v_before jsonb; v_after jsonb; v_open boolean; v_registration public.registrations;
  v_child boolean; v_type text;
begin
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
revoke all on function public.update_registration_with_pickup(text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.update_registration_with_pickup(text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
drop function public.staff_create_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,text);
create function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default '', p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_type text := public.registration_child_type(p_child_type); v_child boolean := v_type is not null;
  v_before public.registrations;
begin
  perform public.staff_assert_actor(p_actor, false);
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
revoke all on function public.staff_create_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.staff_create_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
drop function public.staff_update_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,boolean,text);
create function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_child_type text default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean; v_type text;
begin
  perform public.staff_assert_actor(p_actor, false);
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
revoke all on function public.staff_update_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.staff_update_registration_with_pickup(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
create or replace function public.get_registration_child(p_full_name text, p_district_id integer)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_child jsonb;
begin
  if not exists (select 1 from public.site_settings where id and is_lookup_open) then
    raise exception using errcode = 'P0001', message = 'LOOKUP_CLOSED';
  end if;
  select jsonb_build_object('child_type', r.child_type, 'is_child', r.is_child, 'parent_name', r.parent_name) into v_child
  from public.registrations r
  where r.district_id = p_district_id and r.name_key = public.registration_name_key(p_full_name)
    and r.record_status = 'active';
  return v_child;
end;
$$;
revoke all on function public.registration_child_type(text), public.registration_identity_delete_guard(), public.registration_child_save(text,uuid,uuid,public.registrations,text,text) from public,anon,authenticated;
grant execute on function public.registration_child_type(text), public.registration_child_save(text,uuid,uuid,public.registrations,text,text) to service_role;
create or replace function public.staff_save_reference(p_actor uuid, p_kind text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_prices jsonb; v_code text; v_activity bigint;
begin
  perform public.staff_assert_actor(p_actor, true);
  if p_kind in ('identity', 'delete_identity') then
    v_code := nullif(p_data->>'code', '');
    if v_code is not null then
      select to_jsonb(i) into v_before from public.registration_identities i where code = v_code for update;
      if v_before is null then
        raise exception using errcode = '22023', message = 'REFERENCE_NOT_FOUND';
      end if;
    end if;
    if p_kind = 'delete_identity' then
      if v_code is null
        or exists (select 1 from public.registrations where meal_identity = v_code) then
        raise exception using errcode = '22023', message = 'IDENTITY_IN_USE';
      end if;
      delete from public.registration_identities where code = v_code;
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data)
      values ('admin', p_actor, 'reference.deleted', 'identity', v_before);
      return v_before;
    end if;
    if v_code is null then
      insert into public.registration_identities (code, name, is_active, public_selectable, sort_order)
      values ('identity_' || replace(gen_random_uuid()::text, '-', ''), btrim(p_data->>'name'),
        (p_data->>'is_active')::boolean, (p_data->>'public_selectable')::boolean,
        (select coalesce(max(sort_order), 0) + 1 from public.registration_identities))
      returning to_jsonb(registration_identities.*) into v_after;
    else
      update public.registration_identities set name = btrim(p_data->>'name'),
        is_active = (p_data->>'is_active')::boolean, public_selectable = (p_data->>'public_selectable')::boolean
      where code = v_code returning to_jsonb(registration_identities.*) into v_after;
    end if;
    if v_before is distinct from v_after then
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
      values ('admin', p_actor, 'reference.saved', 'identity', v_before, v_after);
    end if;
    return v_after;
  end if;

  v_after := public.staff_save_reference_before_identities(p_actor, p_kind, p_data);
  if p_kind = 'activity' and p_data ? 'identity_prices' then
    if jsonb_typeof(p_data->'identity_prices') <> 'array' then
      raise exception using errcode = '22023', message = 'INVALID_REFERENCE_DATA';
    end if;
    v_activity := (v_after->>'id')::bigint;
    select coalesce(jsonb_agg(jsonb_build_object('identity_code', identity_code, 'fee_amount', fee_amount)
      order by identity_code), '[]'::jsonb) into v_before
    from public.activity_identity_prices where activity_id = v_activity;
    delete from public.activity_identity_prices where activity_id = v_activity;
    insert into public.activity_identity_prices (activity_id, identity_code, fee_amount)
    select v_activity, price->>'identity_code', (price->>'fee_amount')::integer
    from jsonb_array_elements(p_data->'identity_prices') price;
    select coalesce(jsonb_agg(jsonb_build_object('identity_code', identity_code, 'fee_amount', fee_amount)
      order by identity_code), '[]'::jsonb) into v_prices
    from public.activity_identity_prices where activity_id = v_activity;
    if v_before is distinct from v_prices then
      insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
      values ('admin', p_actor, 'reference.saved', 'activity_identity_prices',
        jsonb_build_object('activity_id', v_activity, 'identity_prices', v_before),
        jsonb_build_object('activity_id', v_activity, 'identity_prices', v_prices));
    end if;
  end if;
  return v_after;
end;
$$;
commit;
