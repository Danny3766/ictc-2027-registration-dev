-- 用餐身分管理（202611090002）的資料庫驗證。
-- 在測試專案 SQL Editor 整份執行；整個驗證交易最後回滾。只使用本腳本新增的虛構身分、活動與登記。
begin;

do $$
declare
  v_admin uuid;
  v_district integer;
  v_code text;
  v_unused text;
  v_meal bigint;
  v_choices jsonb;
  v_id uuid;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  -- The fixtures expect only 一般 to answer the surveys; rolled back with everything else.
  update public.site_settings set hosting_identity_codes=array['general'], pickup_identity_codes=array['general'] where id;
  select auth_user_id into v_admin from public.staff_profiles
  where role = 'admin' and is_active and not must_change_password limit 1;
  select id into v_district from public.districts order by sort_order limit 1;
  if v_admin is null or v_district is null then raise exception 'TEST_DATA_NOT_READY'; end if;
  update public.site_settings set is_hosting_open = false, is_pickup_open = false where id;

  -- A staff-only identity: the public may not choose it, staff may; it sorts after the others.
  v_code := public.staff_save_reference(v_admin, 'identity',
    '{"name": "身分驗證志工", "is_active": true, "public_selectable": false}')->>'code';
  if (select sort_order from public.registration_identities where code = v_code)
    <= (select max(sort_order) from public.registration_identities where code is distinct from v_code) then
    raise exception 'NEW_IDENTITY_NOT_LAST';
  end if;
  if not exists (select 1 from public.audit_events where action = 'reference.saved' and target_type = 'identity'
    and after_data->>'code' = v_code) then
    raise exception 'IDENTITY_NOT_AUDITED';
  end if;
  begin
    perform public.registration_meal_identity('[]', v_code);
    raise exception 'PUBLIC_ACCEPTED_PRIVATE_IDENTITY';
  exception when invalid_parameter_value then null;
  end;
  perform set_config('registration.staff_identity', 'on', true);
  if public.registration_meal_identity('[]', v_code) is distinct from v_code then raise exception 'STAFF_IDENTITY_FAILED'; end if;
  perform set_config('registration.staff_identity', '', true);

  -- child: automatic for a child, refused for an adult, and a former child's stored child becomes general.
  begin
    perform public.registration_meal_identity('[]', 'child');
    raise exception 'ADULT_CHOSE_CHILD';
  exception when invalid_parameter_value then null;
  end;
  if public.registration_meal_identity('[]', null, 'child') is distinct from 'general' then raise exception 'FORMER_CHILD_NOT_GENERAL'; end if;
  perform set_config('registration.saving_child', 'on', true);
  if public.registration_meal_identity('[]', 'general') is distinct from 'child' then raise exception 'CHILD_NOT_AUTOMATIC'; end if;
  perform set_config('registration.saving_child', '', true);

  -- Any attended published meal needs an identity, with or without other prices.
  v_meal := (public.staff_save_reference(v_admin, 'activity', jsonb_build_object(
    'title', '身分驗證晚餐', 'category', 'meal', 'is_published', true, 'sort_order', 9301, 'fee_amount', 120,
    'identity_prices', jsonb_build_array(jsonb_build_object('identity_code', 'child', 'fee_amount', 80),
      jsonb_build_object('identity_code', v_code, 'fee_amount', 0))))->>'id')::bigint;
  if (select count(*) from public.activity_identity_prices where activity_id = v_meal) is distinct from 2 then
    raise exception 'PRICES_NOT_SAVED';
  end if;
  if not exists (select 1 from public.audit_events where action = 'reference.saved'
    and target_type = 'activity_identity_prices' and (after_data->>'activity_id')::bigint = v_meal) then
    raise exception 'PRICES_NOT_AUDITED';
  end if;
  begin
    perform public.registration_meal_identity(jsonb_build_array(jsonb_build_object('activity_id', v_meal, 'attending', true)), null);
    raise exception 'MEAL_WITHOUT_IDENTITY_ACCEPTED';
  exception when raise_exception then
    if sqlerrm is distinct from 'MEAL_IDENTITY_REQUIRED' then raise; end if;
  end;
  begin
    perform public.registration_meal_identity('[]', null);
    raise exception 'IDENTITY_WITHOUT_MEAL_NOT_REQUIRED';
  exception when raise_exception then
    if sqlerrm is distinct from 'MEAL_IDENTITY_REQUIRED' then raise; end if;
  end;

  -- Staff save the staff-only identity; once stopped it stays on that registration but is no new choice.
  select jsonb_agg(jsonb_build_object('activity_id', id, 'attending', id = v_meal)) into v_choices
  from public.activities where is_published;
  select registration_id into v_id from public.staff_create_registration_with_pickup(
    v_admin, gen_random_uuid(), '身分驗證登記', v_district, v_choices, null, v_code);
  if (select meal_identity from public.registrations where id = v_id) is distinct from v_code then raise exception 'STAFF_CREATE_FAILED'; end if;
  perform public.staff_save_reference(v_admin, 'identity',
    jsonb_build_object('code', v_code, 'name', '身分驗證志工', 'is_active', false, 'public_selectable', false));
  if public.registration_meal_identity('[]', v_code, v_code) is distinct from v_code then raise exception 'STOPPED_IDENTITY_NOT_KEPT'; end if;
  begin
    perform public.registration_meal_identity('[]', v_code, 'general');
    raise exception 'STOPPED_IDENTITY_ACCEPTED';
  exception when invalid_parameter_value then null;
  end;

  -- Used and reserved identities cannot be deleted, an unknown code is not found, an unused one goes.
  begin
    perform public.staff_save_reference(v_admin, 'delete_identity', jsonb_build_object('code', v_code));
    raise exception 'USED_IDENTITY_DELETED';
  exception when invalid_parameter_value then
    if sqlerrm is distinct from 'IDENTITY_IN_USE' then raise; end if;
  end;
  begin
    perform public.staff_save_reference(v_admin, 'delete_identity', '{"code": "child"}');
    raise exception 'RESERVED_IDENTITY_DELETED';
  exception when invalid_parameter_value then
    if sqlerrm is distinct from 'IDENTITY_IN_USE' then raise; end if;
  end;
  begin
    perform public.staff_save_reference(v_admin, 'identity',
      '{"code": "identity_missing", "name": "不存在", "is_active": true, "public_selectable": true}');
    raise exception 'MISSING_IDENTITY_CREATED';
  exception when invalid_parameter_value then
    if sqlerrm is distinct from 'REFERENCE_NOT_FOUND' then raise; end if;
  end;
  v_unused := public.staff_save_reference(v_admin, 'identity',
    '{"name": "身分驗證未使用", "is_active": true, "public_selectable": true}')->>'code';
  perform public.staff_save_reference(v_admin, 'delete_identity', jsonb_build_object('code', v_unused));
  if exists (select 1 from public.registration_identities where code = v_unused) then raise exception 'DELETE_FAILED'; end if;
  raise notice 'REGISTRATION_IDENTITIES_OK';
end;
$$;

rollback;
