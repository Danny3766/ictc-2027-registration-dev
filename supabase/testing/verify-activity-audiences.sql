-- 活動報名對象：接機與前置活動（202611060002）的資料庫驗證。
-- 也驗證後台新增／修改同樣受限，以及活動改為限定後既有報名的處理。
-- 在測試專案 SQL Editor 執行；需要一位已改過初始密碼的有效管理員。整個驗證交易最後回滾。只使用本腳本新增的虛構活動，
-- 不改動既有活動的報名對象。姓名與活動名稱都是虛構的。
begin;

do $$
declare
  v_admin uuid;
  v_district integer;
  v_id uuid;
  v_name text := '對象驗證-' || substr(gen_random_uuid()::text, 1, 8);
  v_others jsonb;      -- 既有公開活動，一律不參加
  v_pickup bigint;     -- 限接機接待
  v_first bigint;      -- 前置活動
  v_second bigint;     -- 須參加前置活動
  v_hidden bigint;     -- 未公開的前置活動
  v_choices jsonb;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select id into v_district from public.districts order by sort_order limit 1;
  if v_district is null then raise exception 'TEST_DATA_NOT_READY'; end if;
  select auth_user_id into v_admin from public.staff_profiles
    where role = 'admin' and is_active and not must_change_password limit 1;
  if v_admin is null then raise exception 'TEST_ADMIN_REQUIRED'; end if;

  update public.site_settings set is_registration_open = true, is_lookup_open = true,
    registration_deadline_at = null, is_pickup_open = true, is_hosting_open = false where id;
  update public.registration_create_limits set window_started_at = now(), created_count = 0 where id;
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', id, 'attending', false)), '[]')
  into v_others from public.activities where is_published;
  insert into public.activities (category, title, audience, is_published, sort_order)
  values ('other', '驗收接機限定', 'pickup', true, 9101) returning id into v_pickup;
  insert into public.activities (category, title, is_published, sort_order)
  values ('other', '驗收第一天', true, 9102) returning id into v_first;
  insert into public.activities (category, title, audience, is_published, sort_order)
  values ('other', '驗收第二天', 'activity:' || v_first, true, 9103) returning id into v_second;
  insert into public.activities (category, title, is_published, sort_order)
  values ('other', '驗收未公開', false, 9104) returning id into v_hidden;

  -- Pickup audience: only a stored 是 qualifies.
  v_choices := v_others || jsonb_build_array(
    jsonb_build_object('activity_id', v_pickup, 'attending', true),
    jsonb_build_object('activity_id', v_first, 'attending', false),
    jsonb_build_object('activity_id', v_second, 'attending', false));
  if public.registration_audience_valid(v_choices, null, '{"status":"no","count":0}') then
    raise exception 'PICKUP_NO_ACCEPTED';
  end if;
  if not public.registration_audience_valid(v_choices, null, '{"status":"yes","count":1}') then
    raise exception 'PICKUP_YES_REJECTED';
  end if;
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), v_name || '-no',
      v_district, v_choices, null, 'general', '{"status":"no","count":0}');
    raise exception 'PICKUP_NO_SAVED';
  exception when raise_exception then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;
  select registration_id into v_id from public.create_registration_with_pickup(
    gen_random_uuid(), v_name, v_district, v_choices, null, 'general', '{"status":"yes","count":1}');
  if v_id is null then raise exception 'PICKUP_YES_NOT_SAVED'; end if;
  begin
    perform public.update_registration_with_pickup(v_name, v_district, v_choices,
      null, null, '{"status":"no","count":0}');
    raise exception 'PICKUP_NO_UPDATE_SAVED';
  exception when raise_exception then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;
  -- A closed survey still counts the stored 是.
  update public.site_settings set is_pickup_open = false where id;
  if not public.update_registration_with_pickup(v_name, v_district, v_choices, null, 'general', null) then
    raise exception 'STORED_PICKUP_REJECTED';
  end if;
  update public.site_settings set is_pickup_open = true where id;

  -- Staff creation enforces the audience too.
  begin
    perform public.staff_create_registration_with_pickup(v_admin, gen_random_uuid(), v_name || '-staff',
      v_district, v_choices, null, 'general', '{"status":"no","count":0}');
    raise exception 'STAFF_CREATE_NOT_ENFORCED';
  exception when raise_exception then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;
  -- Open first, restricted later: the earlier sign-up stays until the next save, which must drop it.
  update public.activities set audience = 'all' where id = v_pickup;
  select registration_id into v_id from public.create_registration_with_pickup(
    gen_random_uuid(), v_name || '-early', v_district, v_choices, null, 'general', '{"status":"no","count":0}');
  update public.activities set audience = 'pickup' where id = v_pickup;
  if not exists (select 1 from public.registration_choices
      where registration_id = v_id and activity_id = v_pickup and attending) then
    raise exception 'EARLIER_SIGN_UP_CHANGED';
  end if;
  begin
    perform public.update_registration_with_pickup(v_name || '-early', v_district, v_choices, null, 'general', null);
    raise exception 'PUBLIC_UPDATE_NOT_ENFORCED';
  exception when raise_exception then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;
  begin
    perform public.staff_update_registration_with_pickup(v_admin, v_id, v_name || '-early', v_district,
      v_choices, null, 'general', null);
    raise exception 'STAFF_UPDATE_NOT_ENFORCED';
  exception when raise_exception then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;

  -- Activity audience: the published prerequisite must be attended.
  if public.registration_audience_valid(v_others || jsonb_build_array(
      jsonb_build_object('activity_id', v_first, 'attending', false),
      jsonb_build_object('activity_id', v_second, 'attending', true)), null, null) then
    raise exception 'MISSING_PREREQUISITE_ACCEPTED';
  end if;
  if not public.registration_audience_valid(v_others || jsonb_build_array(
      jsonb_build_object('activity_id', v_first, 'attending', true),
      jsonb_build_object('activity_id', v_second, 'attending', true)), null, null) then
    raise exception 'PREREQUISITE_REJECTED';
  end if;
  begin
    update public.activities set audience = 'activity:' || v_second where id = v_first;
    raise exception 'CYCLE_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'ACTIVITY_AUDIENCE_CYCLE' then raise; end if;
  end;
  begin
    update public.activities set audience = 'activity:' || v_first where id = v_first;
    raise exception 'SELF_REFERENCE_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'ACTIVITY_AUDIENCE_CYCLE' then raise; end if;
  end;
  begin
    update public.activities set audience = 'activity:' || (select max(id) + 1000 from public.activities) where id = v_first;
    raise exception 'MISSING_TARGET_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'ACTIVITY_AUDIENCE_NOT_FOUND' then raise; end if;
  end;
  update public.activities set audience = 'activity:' || v_hidden where id = v_second;
  if public.registration_audience_valid(jsonb_build_array(
      jsonb_build_object('activity_id', v_second, 'attending', true),
      jsonb_build_object('activity_id', v_hidden, 'attending', true)), null, null) then
    raise exception 'UNPUBLISHED_PREREQUISITE_ACCEPTED';
  end if;
  raise notice 'ACTIVITY_AUDIENCES_OK';
end;
$$;

rollback;
