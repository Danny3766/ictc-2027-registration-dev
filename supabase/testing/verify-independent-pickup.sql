-- 接機接待獨立調查（202611060001）的資料庫驗證。
-- 在測試專案 SQL Editor 執行；需要一位已改過初始密碼的有效管理員。整個驗證交易最後回滾，
-- 暫時開放的設定與建立的登記都不會留下。姓名都是虛構的。
begin;
-- Some checks are asserts: a database with asserts switched off would skip them and pass silently.
set local plpgsql.check_asserts = on;

do $$
declare
  v_admin uuid;
  v_district integer;
  v_choices jsonb;
  v_name text := '接機驗證-' || substr(gen_random_uuid()::text, 1, 8);
  v_id uuid;
  v_staff_id uuid;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into v_admin from public.staff_profiles
  where role = 'admin' and is_active and not must_change_password limit 1;
  select id into v_district from public.districts order by sort_order limit 1;
  if v_admin is null or v_district is null then raise exception 'TEST_DATA_NOT_READY'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', id, 'attending', false)), '[]')
  into v_choices from public.activities where is_published;

  update public.site_settings set is_registration_open = true, is_lookup_open = true,
    registration_deadline_at = null, is_hosting_open = false, is_pickup_open = true where id;
  update public.registration_create_limits set window_started_at = now(), created_count = 0 where id;

  -- Pickup is saved without hosting, and audited.
  select registration_id into v_id from public.create_registration_with_pickup(
    gen_random_uuid(), v_name, v_district, v_choices, null, 'general', '{"status":"yes","count":2}');
  if public.registration_hosting_get(v_id) is not null
    or public.registration_pickup_get(v_id) is distinct from '{"status":"yes","count":2}'::jsonb
    or public.get_registration_pickup(v_name, v_district) is distinct from '{"status":"yes","count":2}'::jsonb
    or not exists (select 1 from public.audit_events where target_id = v_id and action = 'registration.pickup_updated') then
    raise exception 'pickup must be saved without hosting';
  end if;

  update public.registrations set import_status = 'imported' where id = v_id;
  perform public.update_registration_with_pickup(v_name, v_district, v_choices, null, 'general', '{"status":"yes","count":3}');
  assert public.registration_pickup_get(v_id) = '{"status":"yes","count":3}'::jsonb, 'PICKUP_COUNT_NOT_SAVED';
  assert (select import_status='reimport_needed' from public.registrations where id=v_id), 'PICKUP_COUNT_NOT_DIRTY';
  update public.registrations set import_status='imported' where id=v_id;
  -- Call and check in separate statements: one expression reads a single snapshot.
  if not public.update_registration_with_pickup(v_name, v_district, v_choices, null, 'general', '{"status":"no","count":0}') then
    raise exception 'pickup update returned false';
  end if;
  if public.registration_pickup_get(v_id) is distinct from '{"status":"no","count":0}'::jsonb
    or (select import_status from public.registrations where id = v_id) is distinct from 'reimport_needed' then
    raise exception 'pickup update failed';
  end if;
  -- No answer sent keeps the stored one.
  perform public.update_registration_with_pickup(v_name, v_district, v_choices, null, 'general', null);
  if public.registration_pickup_get(v_id) is distinct from '{"status":"no","count":0}'::jsonb then
    raise exception 'missing pickup must keep the stored answer';
  end if;

  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), v_name || '-missing', v_district,
      v_choices, null, 'general', null);
    raise exception 'missing pickup was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm is distinct from 'PICKUP_REQUIRED' then raise; end if;
  end;
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), v_name || '-bad', v_district,
      v_choices, null, 'general', '{"status":"yes","count":0}');
    raise exception 'invalid pickup was accepted';
  exception when sqlstate '22023' then
    if sqlerrm is distinct from 'INVALID_PICKUP' then raise; end if;
  end;

  -- The registration's own closed state wins over the pickup answer.
  update public.site_settings set is_registration_open = false where id;
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), v_name || '-late', v_district,
      v_choices, null, 'general', null);
    raise exception 'closed registration was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm is distinct from 'REGISTRATION_CLOSED' then raise; end if;
  end;
  update public.site_settings set is_registration_open = true where id;

  update public.site_settings set is_hosting_open = true, is_pickup_open = false where id;
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), v_name || '-closed', v_district,
      v_choices, '{"status":"not_hosting"}', 'general', '{"status":"yes","count":1}');
    raise exception 'closed pickup was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm is distinct from 'PICKUP_CLOSED' then raise; end if;
  end;

  -- Staff cannot answer pickup while it is closed; saving stores 否.
  select registration_id into v_staff_id from public.staff_create_registration_with_pickup(v_admin,
    gen_random_uuid(), v_name || '-staff', v_district, v_choices, '{"status":"not_hosting"}', 'general',
    '{"status":"yes","count":3}');
  if not public.staff_update_registration_with_pickup(v_admin, v_staff_id, v_name || '-staff', v_district,
      v_choices, null, 'general', null)
    or public.registration_pickup_get(v_staff_id) is distinct from '{"status":"no","count":0}'::jsonb then
    raise exception 'staff pickup failed';
  end if;
  if public.staff_update_registration_with_pickup(v_admin, gen_random_uuid(), v_name, v_district,
      v_choices, null, 'general', '{"status":"no"}') then
    raise exception 'unknown registration was updated';
  end if;
end;
$$;
rollback;
