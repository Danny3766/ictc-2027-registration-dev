-- Test database only, after 202611110004. All changes roll back.
begin;
do $$
declare
  v_actor uuid;
  v_codes text[];
  v_actual text[];
  v_count bigint;
  v_code text;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into v_actor from public.staff_profiles
    where role = 'admin' and is_active and not must_change_password limit 1;
  if v_actor is null then raise exception 'TEST_ADMIN_REQUIRED'; end if;
  v_code := public.staff_save_reference(v_actor, 'identity',
    '{"name":"Reorder inactive fixture","is_active":false,"public_selectable":false}')->>'code';
  select array_agg(code order by sort_order desc, code desc) into v_codes from public.registration_identities;
  select count(*) into v_count from public.audit_events where action = 'reference.reordered' and target_type = 'identity';
  perform public.staff_reorder_identities(v_actor, v_codes);
  select array_agg(code order by sort_order, code) into v_actual from public.registration_identities;
  if v_actual is distinct from v_codes then raise exception 'ORDER_NOT_SAVED'; end if;
  if exists (select 1 from public.registration_identities i
    join unnest(v_codes) with ordinality o(code, position) using (code)
    where i.sort_order <> o.position) then raise exception 'POSITIONS_INVALID'; end if;
  if (select count(*) from public.audit_events where action = 'reference.reordered' and target_type = 'identity') <> v_count + 1 then
    raise exception 'AUDIT_MISSING';
  end if;
  perform public.staff_reorder_identities(v_actor, v_codes);
  if (select count(*) from public.audit_events where action = 'reference.reordered' and target_type = 'identity') <> v_count + 1 then
    raise exception 'NOOP_AUDITED';
  end if;
  begin
    perform public.staff_reorder_identities(v_actor, v_codes[2:]);
    raise exception 'MISSING_CODE_ACCEPTED';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.staff_reorder_identities(v_actor, array_fill(v_codes[1], array[cardinality(v_codes)]));
    raise exception 'DUPLICATES_ACCEPTED';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.staff_reorder_identities(v_actor, array['unknown'] || v_codes[2:]);
    raise exception 'UNKNOWN_CODE_ACCEPTED';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.staff_reorder_identities(v_actor, array[null::text] || v_codes[2:]);
    raise exception 'NULL_CODE_ACCEPTED';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.staff_reorder_identities(v_actor, null);
    raise exception 'NULL_LIST_ACCEPTED';
  exception when invalid_parameter_value then null; end;
  if has_function_privilege('anon', 'public.staff_reorder_identities(uuid,text[])', 'execute')
    or has_function_privilege('authenticated', 'public.staff_reorder_identities(uuid,text[])', 'execute')
    or not has_function_privilege('service_role', 'public.staff_reorder_identities(uuid,text[])', 'execute') then
    raise exception 'RPC_GRANTS_INVALID';
  end if;
  update public.staff_profiles set role = 'staff' where auth_user_id = v_actor;
  begin
    perform public.staff_reorder_identities(v_actor, v_codes);
    raise exception 'STAFF_REORDER_ACCEPTED';
  exception when insufficient_privilege then null; end;
  update public.staff_profiles set role = 'admin', is_active = false where auth_user_id = v_actor;
  begin
    perform public.staff_reorder_identities(v_actor, v_codes);
    raise exception 'INACTIVE_ADMIN_ACCEPTED';
  exception when insufficient_privilege then null; end;
end;
$$;
rollback;
