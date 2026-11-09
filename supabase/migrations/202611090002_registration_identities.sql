-- 2026-11-09: 用餐身分管理. Rules are in docs/用餐身分管理.md.
-- Apply after 202611090001, during the maintenance window of docs/正式環境setup.md 9-3 (registration
-- closed): an older page asks for the identity only on student-priced meals, and this requires one on
-- every attended published meal. Then deploy the registration and staff Edge Functions, then the site.
--   * registration_identities: stable codes with an editable name. general and child are reserved;
--     child is stored for every child and never chosen by an adult. An identity not public_selectable
--     is set only by staff (the staff wrappers turn on registration.staff_identity).
--   * activity_identity_prices: a price per activity and identity; a missing one is unset (the general
--     price is activities.fee_amount; 202611090003 lets each be set alone). The student prices move here; the staff page still sends student_fee_amount with the
--     student price, so the column stays in step for older readers.
--   * Every registration stores an identity from now on: children become child, an unanswered one general.
begin;

create table public.registration_identities (
  code text primary key check (code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text not null unique check (name = btrim(name) and length(name) between 1 and 30),
  is_active boolean not null default true,
  public_selectable boolean not null default true,
  sort_order integer not null default 0,
  constraint registration_identities_reserved check (code not in ('general', 'child') or (is_active and public_selectable))
);
insert into public.registration_identities (code, name, sort_order)
values ('general', '一般', 0), ('student', '學生', 1), ('child', '兒童', 2);

create table public.activity_identity_prices (
  activity_id bigint references public.activities (id) on delete cascade,
  identity_code text references public.registration_identities (code) on delete cascade
    check (identity_code <> 'general'),
  fee_amount integer not null check (fee_amount >= 0),
  primary key (activity_id, identity_code)
);
insert into public.activity_identity_prices (activity_id, identity_code, fee_amount)
select id, 'student', student_fee_amount from public.activities where student_fee_amount is not null;

alter table public.registration_identities enable row level security;
alter table public.activity_identity_prices enable row level security;
revoke all on public.registration_identities, public.activity_identity_prices from anon, authenticated;
grant all on public.registration_identities, public.activity_identity_prices to service_role;

alter table public.registrations drop constraint registrations_meal_identity;
update public.registrations
set meal_identity = case when is_child then 'child' else coalesce(meal_identity, 'general') end;
alter table public.registrations add constraint registrations_meal_identity_fk
  foreign key (meal_identity) references public.registration_identities (code);

-- The identity to store: child while saving a child; otherwise the one sent, else p_stored, else
-- general. Attending a published meal with neither sent nor stored is MEAL_IDENTITY_REQUIRED. A new
-- choice must be active, and public_selectable unless staff save it; the stored one is always kept.
create or replace function public.registration_meal_identity(p_choices jsonb, p_identity text, p_stored text default null)
returns text language plpgsql security invoker set search_path = '' as $$
declare v_child boolean := public.registration_saving_child(); v_code text; v_identity public.registration_identities;
begin
  if v_child then
    v_code := 'child';
  else
    if p_identity is null and p_stored is null and exists (
      select 1 from jsonb_array_elements(p_choices) choice
      join public.activities activity on activity.id = (choice->>'activity_id')::bigint
      where activity.is_published and activity.category = 'meal' and (choice->>'attending')::boolean
    ) then
      raise exception using errcode = 'P0001', message = 'MEAL_IDENTITY_REQUIRED';
    end if;
    -- A former child's stored identity falls back to general.
    v_code := coalesce(p_identity, nullif(p_stored, 'child'), 'general');
    if v_code = 'child' then
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

-- The activity part stays in the renamed function; this adds the identity kinds and the activity's
-- identity_prices (an activity saved without the key, from an older page, keeps its prices).
alter function public.staff_save_reference(uuid, text, jsonb) rename to staff_save_reference_before_identities;
create function public.staff_save_reference(p_actor uuid, p_kind text, p_data jsonb)
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
      if v_code is null or v_code in ('general', 'child')
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
revoke all on function public.staff_save_reference(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.staff_save_reference(uuid, text, jsonb) to service_role;

-- Same as 202611090001, plus registration.staff_identity, so staff may set an identity that is not
-- public_selectable.
create or replace function public.staff_create_registration_with_pickup(
  p_actor uuid, p_request_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default false, p_parent_name text default null
) returns table (registration_id uuid, serial_no bigint)
language plpgsql security invoker set search_path = '' as $$
declare v_pickup jsonb; v_id uuid; v_serial bigint; v_child boolean := coalesce(p_is_child, false);
  v_before public.registrations;
begin
  perform public.staff_assert_actor(p_actor, false);
  perform set_config('registration.staff_identity', 'on', true);
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
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return query select v_id, v_serial;
end;
$$;

-- Same as 202611090001, plus registration.staff_identity.
create or replace function public.staff_update_registration_with_pickup(
  p_actor uuid, p_registration_id uuid, p_full_name text, p_district_id integer, p_choices jsonb,
  p_hosting jsonb default null, p_meal_identity text default null, p_pickup jsonb default null,
  p_is_child boolean default null, p_parent_name text default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_before jsonb; v_after jsonb; v_registration public.registrations; v_child boolean;
begin
  perform public.staff_assert_actor(p_actor, false);
  perform set_config('registration.staff_identity', 'on', true);
  select * into v_registration from public.registrations
  where id = p_registration_id and record_status = 'active' for update;
  v_child := coalesce(p_is_child, v_registration.is_child, false);
  if v_child then
    perform set_config('registration.saving_child', 'on', true);
    p_hosting := '{"status": "not_hosting"}';
  end if;
  if not public.staff_update_registration(p_actor, p_registration_id, p_full_name,
    p_district_id, p_choices, p_hosting, p_meal_identity) then
    perform set_config('registration.staff_identity', '', true);
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
  perform set_config('registration.staff_identity', '', true);
  perform set_config('registration.saving_child', '', true);
  return true;
end;
$$;

commit;
