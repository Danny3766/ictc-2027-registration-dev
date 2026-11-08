-- 兒童報名（202611090001）的資料庫驗證。
-- 在測試專案 SQL Editor 執行；整個驗證交易最後回滾。只使用本腳本新增的虛構活動與登記，
-- 不改動既有活動的報名對象。姓名與活動名稱都是虛構的。
begin;

do $$
declare
  v_admin uuid;
  v_district integer;
  v_other_district integer;
  v_tag text := substr(gen_random_uuid()::text, 1, 6);
  v_parent text := '兒童驗證家長' || v_tag;
  v_others jsonb;      -- 既有公開活動，一律不參加
  v_hosting bigint;    -- 限開家接待
  v_pickup bigint;     -- 限接機接待
  v_first bigint;      -- 前置活動
  v_second bigint;     -- 須參加前置活動
  v_choices jsonb;
  v_id uuid;
  v_row public.registrations;
  v_serials bigint[];
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into v_admin from public.staff_profiles
  where role = 'admin' and is_active and not must_change_password limit 1;
  select id into v_district from public.districts order by sort_order limit 1;
  select id into v_other_district from public.districts order by sort_order offset 1 limit 1;
  if v_admin is null or v_other_district is null then raise exception 'TEST_DATA_NOT_READY'; end if;

  update public.site_settings set is_registration_open = true, registration_deadline_at = null,
    is_lookup_open = true, is_hosting_open = true, is_pickup_open = true where id;
  update public.registration_create_limits set window_started_at = now(), created_count = 0 where id;
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', id, 'attending', false)), '[]')
  into v_others from public.activities where is_published and student_fee_amount is null;
  update public.activities set is_published = false where is_published and student_fee_amount is not null;
  insert into public.activities (category, title, audience, is_published, sort_order)
  values ('other', '兒童驗證開家限定', 'hosting', true, 9201) returning id into v_hosting;
  insert into public.activities (category, title, audience, is_published, sort_order)
  values ('other', '兒童驗證接機限定', 'pickup', true, 9202) returning id into v_pickup;
  insert into public.activities (category, title, is_published, sort_order)
  values ('other', '兒童驗證第一天', true, 9203) returning id into v_first;
  insert into public.activities (category, title, audience, is_published, sort_order)
  values ('other', '兒童驗證第二天', 'activity:' || v_first, true, 9204) returning id into v_second;
  v_choices := v_others || jsonb_build_array(
    jsonb_build_object('activity_id', v_hosting, 'attending', true),
    jsonb_build_object('activity_id', v_pickup, 'attending', true),
    jsonb_build_object('activity_id', v_first, 'attending', false),
    jsonb_build_object('activity_id', v_second, 'attending', false));

  -- 1. Both surveys open: a child attends both restricted activities and stores 否 for both.
  perform public.create_registration_with_pickup(gen_random_uuid(), '兒童驗證甲' || v_tag, v_district,
    v_choices, null, null, null, true, '  ' || v_parent || '  ');
  select * into v_row from public.registrations where full_name = '兒童驗證甲' || v_tag;
  if not v_row.is_child or v_row.parent_name <> v_parent then raise exception 'CHILD_NOT_SAVED'; end if;
  if public.registration_hosting_get(v_row.id)->>'status' <> 'not_hosting'
    or public.registration_pickup_get(v_row.id) <> '{"status":"no","count":0}' then
    raise exception 'CHILD_ANSWERS_NOT_NO';
  end if;
  if current_setting('registration.saving_child', true) <> '' then raise exception 'CHILD_FLAG_LEFT_ON'; end if;

  -- 2. The same restricted choices still fail for an adult answering 否, also after a child's save.
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), '兒童驗證成人' || v_tag, v_district,
      v_choices, '{"status":"not_hosting"}', null, '{"status":"no","count":0}');
    raise exception 'ADULT_RESTRICTION_SKIPPED';
  exception when raise_exception then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;

  -- 3. An activity prerequisite still applies to a child.
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), '兒童驗證前置' || v_tag, v_district,
      v_others || jsonb_build_array(jsonb_build_object('activity_id', v_hosting, 'attending', false),
        jsonb_build_object('activity_id', v_pickup, 'attending', false),
        jsonb_build_object('activity_id', v_first, 'attending', false),
        jsonb_build_object('activity_id', v_second, 'attending', true)), null, null, null, true, v_parent);
    raise exception 'CHILD_PREREQUISITE_SKIPPED';
  exception when raise_exception then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;

  -- 4. The parent name is required, 20 characters at most after trimming.
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), '兒童驗證乙' || v_tag, v_district,
      v_choices, null, null, null, true, '   ');
    raise exception 'EMPTY_PARENT_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_PARENT_NAME' then raise; end if;
  end;
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), '兒童驗證乙' || v_tag, v_district,
      v_choices, null, null, null, true, repeat('名', 21));
    raise exception 'LONG_PARENT_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_PARENT_NAME' then raise; end if;
  end;

  -- 5. Both surveys closed: a child still stores 否 for both; a second child names the same parent
  --    with other case and spacing.
  update public.site_settings set is_hosting_open = false, is_pickup_open = false where id;
  perform public.create_registration_with_pickup(gen_random_uuid(), '兒童驗證乙' || v_tag, v_district,
    v_choices, null, null, null, true, ' ' || replace(v_parent, '家長', '家 長'));
  select * into v_row from public.registrations where full_name = '兒童驗證乙' || v_tag;
  if public.registration_hosting_get(v_row.id)->>'status' <> 'not_hosting'
    or public.registration_pickup_get(v_row.id)->>'status' <> 'no' then
    raise exception 'CLOSED_CHILD_ANSWERS_NOT_NO';
  end if;

  -- 6. The parent registers; the 親子 lookup finds both children in the same district only.
  update public.site_settings set is_hosting_open = true, is_pickup_open = true where id;
  perform public.create_registration_with_pickup(gen_random_uuid(), v_parent, v_district,
    v_others || jsonb_build_array(jsonb_build_object('activity_id', v_hosting, 'attending', true),
      jsonb_build_object('activity_id', v_pickup, 'attending', true),
      jsonb_build_object('activity_id', v_first, 'attending', false),
      jsonb_build_object('activity_id', v_second, 'attending', false)),
    '{"status":"hosting","guest_type":"any","guest_count":2}', null, '{"status":"yes","count":3}');
  perform public.create_registration_with_pickup(gen_random_uuid(), '兒童驗證別區' || v_tag, v_other_district,
    v_choices, null, null, null, true, v_parent);
  select array_agg(c.serial_no order by c.serial_no) into v_serials
  from public.registration_children(jsonb_build_array(jsonb_build_object('district_id', v_district,
    'name_key', public.registration_name_key(v_parent)))) c;
  if v_serials <> (select array_agg(serial_no order by serial_no) from public.registrations
      where full_name in ('兒童驗證甲' || v_tag, '兒童驗證乙' || v_tag)) then
    raise exception 'CHILDREN_LOOKUP_WRONG %', v_serials;
  end if;

  -- 7. A voided child drops out of the lookup.
  update public.registrations set record_status = 'void' where full_name = '兒童驗證乙' || v_tag;
  if (select count(*) from public.registration_children(jsonb_build_array(jsonb_build_object(
      'district_id', v_district, 'name_key', public.registration_name_key(v_parent))))) <> 1 then
    raise exception 'VOID_CHILD_LISTED';
  end if;

  -- 8. The adult becomes a child on the public page: 否 replaces 是 and the import needs redoing.
  update public.registrations set import_status = 'imported' where full_name = v_parent;
  perform public.update_registration_with_pickup(v_parent, v_district, v_choices, null, null, null, true, '另一位家長');
  select * into v_row from public.registrations where full_name = v_parent;
  if not v_row.is_child or v_row.parent_name <> '另一位家長' or v_row.import_status <> 'reimport_needed'
    or public.registration_hosting_get(v_row.id)->>'status' <> 'not_hosting'
    or public.registration_pickup_get(v_row.id)->>'status' <> 'no' then
    raise exception 'BECOME_CHILD_WRONG';
  end if;
  if not exists (select 1 from public.audit_events where target_id = v_row.id and action = 'registration.child_updated'
      and before_data->>'is_child' = 'false' and after_data->>'parent_name' = '另一位家長') then
    raise exception 'CHILD_AUDIT_MISSING';
  end if;

  -- 9. An older page sends no child fields and a hosting answer: the child stays, answers stay 否.
  perform public.update_registration_with_pickup(v_parent, v_district, v_choices,
    '{"status":"hosting","guest_type":"any","guest_count":2}', null, '{"status":"yes","count":3}');
  select * into v_row from public.registrations where full_name = v_parent;
  if not v_row.is_child or v_row.parent_name <> '另一位家長'
    or public.registration_hosting_get(v_row.id)->>'status' <> 'not_hosting'
    or public.registration_pickup_get(v_row.id)->>'status' <> 'no' then
    raise exception 'OLDER_PAGE_CHANGED_CHILD';
  end if;
  if public.get_registration_child(v_parent, v_district) <> '{"is_child":true,"parent_name":"另一位家長"}' then
    raise exception 'LOOKUP_CHILD_WRONG';
  end if;

  -- 10. Back to an adult: the child fields clear and the surveys are answered again.
  perform public.update_registration_with_pickup(v_parent, v_district,
    v_others || jsonb_build_array(jsonb_build_object('activity_id', v_hosting, 'attending', false),
      jsonb_build_object('activity_id', v_pickup, 'attending', false),
      jsonb_build_object('activity_id', v_first, 'attending', false),
      jsonb_build_object('activity_id', v_second, 'attending', false)),
    '{"status":"not_hosting"}', null, '{"status":"no","count":0}', false, '不該存下');
  select * into v_row from public.registrations where full_name = v_parent;
  if v_row.is_child or v_row.parent_name is not null then raise exception 'BECOME_ADULT_WRONG'; end if;

  -- 11. Staff: a child created while both surveys are closed, then saved by an older page.
  update public.site_settings set is_hosting_open = false, is_pickup_open = false where id;
  select registration_id into v_id from public.staff_create_registration_with_pickup(v_admin, gen_random_uuid(),
    '兒童驗證協助' || v_tag, v_district, v_choices, null, null, null, true, v_parent);
  perform public.staff_update_registration_with_pickup(v_admin, v_id, '兒童驗證協助' || v_tag, v_other_district,
    v_choices, '{"status":"hosting","guest_type":"any","guest_count":2}', null, '{"status":"yes","count":3}');
  select * into v_row from public.registrations where id = v_id;
  if not v_row.is_child or v_row.parent_name <> v_parent or v_row.district_id <> v_other_district
    or public.registration_hosting_get(v_id)->>'status' <> 'not_hosting'
    or public.registration_pickup_get(v_id)->>'status' <> 'no' then
    raise exception 'STAFF_CHILD_WRONG';
  end if;
  begin
    perform public.staff_update_registration_with_pickup(v_admin, v_id, '兒童驗證協助' || v_tag, v_other_district,
      v_choices, null, null, null, true, '');
    raise exception 'STAFF_EMPTY_PARENT_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_PARENT_NAME' then raise; end if;
  end;

  -- 12. The table refuses a parent name without a child, or a child without one.
  begin
    update public.registrations set parent_name = '不該存下' where id = (select id from public.registrations
      where full_name = v_parent);
    raise exception 'ADULT_PARENT_NAME_ACCEPTED';
  exception when check_violation then null;
  end;
  begin
    update public.registrations set parent_name = null where id = v_id;
    raise exception 'CHILD_WITHOUT_PARENT_ACCEPTED';
  exception when check_violation then null;
  end;
  raise notice 'CHILD_REGISTRATION_OK';
end;
$$;

rollback;
