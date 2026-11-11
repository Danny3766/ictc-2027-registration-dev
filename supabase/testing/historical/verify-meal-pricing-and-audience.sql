-- 用餐學生價、用餐身分與報名對象（202611050006）的資料庫驗證。
-- 在測試專案 SQL Editor 執行；需要一位已改過初始密碼的有效管理員。整個驗證交易最後回滾，
-- 暫時開放的設定、建立的活動與登記都不會留下。活動名稱與金額都是虛構的，不代表實際價格或成本。
-- 只適用於套用 202611090002_registration_identities.sql 之前：之後沒參加用餐時保留身分、每個用餐都要身分，
-- 本腳本會在 IDENTITY_KEPT_WITHOUT_MEAL 失敗。之後改用 verify-registration-identities.sql。
begin;

do $$
declare
  v_admin uuid;
  v_district integer;
  v_open_meal bigint;   -- 所有人可報名，有學生價
  v_hosting_meal bigint; -- 限有開家接待者，有學生價
  v_others jsonb;       -- 其他公開活動，一律不參加
  v_no constant jsonb := '{"status":"not_hosting"}';
  v_family constant jsonb := '{"status":"family_registered"}';
  v_id uuid;
  v_identity text;
  v_activity jsonb;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into v_admin from public.staff_profiles
  where role = 'admin' and is_active and not must_change_password limit 1;
  select id into v_district from public.districts order by sort_order limit 1;
  if v_admin is null or v_district is null then raise exception 'TEST_DATA_NOT_READY'; end if;

  update public.site_settings set is_registration_open = true, registration_deadline_at = null,
    is_lookup_open = true, is_hosting_open = true where id;
  update public.registration_create_limits set window_started_at = now(), created_count = 0 where id;
  select coalesce(jsonb_agg(jsonb_build_object('activity_id', id, 'attending', false)), '[]')
  into v_others from public.activities where is_published;
  insert into public.activities (category, title, fee_amount, student_fee_amount, cost_amount, is_published, sort_order)
  values ('meal', '驗收晚餐', 100, 60, 130, true, 9001) returning id into v_open_meal;
  insert into public.activities (category, title, fee_amount, student_fee_amount, audience, is_published, sort_order)
  values ('meal', '驗收限定午餐', 120, 70, 'hosting', true, 9002) returning id into v_hosting_meal;

  -- Choices for every published activity: the two test meals as given, every other one 不參加.
  create temporary table meal_choices (open_meal boolean, hosting_meal boolean, value jsonb) on commit drop;
  insert into meal_choices
  select open_meal, hosting_meal, v_others || jsonb_build_array(
    jsonb_build_object('activity_id', v_open_meal, 'attending', open_meal),
    jsonb_build_object('activity_id', v_hosting_meal, 'attending', hosting_meal))
  from (values (false, false), (true, false), (false, true), (true, true)) answers (open_meal, hosting_meal);

  -- 有學生價的用餐須回答身分；不合法的身分被拒。
  begin
    perform public.create_registration(gen_random_uuid(), '餐費驗收甲', v_district,
      (select value from meal_choices where open_meal and not hosting_meal), v_no);
    raise exception 'IDENTITY_NOT_REQUIRED';
  exception when others then
    if sqlerrm <> 'MEAL_IDENTITY_REQUIRED' then raise; end if;
  end;
  begin
    perform public.create_registration(gen_random_uuid(), '餐費驗收甲', v_district,
      (select value from meal_choices where open_meal and not hosting_meal), v_no, 'teacher');
    raise exception 'BAD_IDENTITY_ACCEPTED';
  exception when others then
    if sqlerrm <> 'INVALID_MEAL_IDENTITY' then raise; end if;
  end;

  -- 沒有參加有學生價的用餐時，送來的身分不保存。
  select registration_id into v_id from public.create_registration(gen_random_uuid(), '餐費驗收乙', v_district,
    (select value from meal_choices where not open_meal and not hosting_meal), v_no, 'student');
  if (select meal_identity from public.registrations where id = v_id) is not null then
    raise exception 'IDENTITY_KEPT_WITHOUT_MEAL';
  end if;

  -- 開家接待回答「否」不能參加限定活動，「家人已登記開家接待」可以。
  begin
    perform public.create_registration(gen_random_uuid(), '餐費驗收丙', v_district,
      (select value from meal_choices where not open_meal and hosting_meal), v_no, 'general');
    raise exception 'AUDIENCE_NOT_ENFORCED';
  exception when others then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;
  select registration_id into v_id from public.create_registration(gen_random_uuid(), '餐費驗收丙', v_district,
    (select value from meal_choices where open_meal and hosting_meal), v_family, 'student');
  if (select meal_identity from public.registrations where id = v_id) <> 'student' then
    raise exception 'IDENTITY_NOT_STORED';
  end if;
  if (select meal_identity from public.get_registration('餐費驗收丙', v_district)) <> 'student' then
    raise exception 'LOOKUP_WITHOUT_IDENTITY';
  end if;

  -- 只改身分不需重新匯入；未帶身分沿用已存的；取消有學生價的用餐後清空。
  update public.registrations set import_status = 'imported' where id = v_id;
  perform public.update_registration('餐費驗收丙', v_district,
    (select value from meal_choices where open_meal and hosting_meal), v_family, 'general');
  if (select (meal_identity, import_status) from public.registrations where id = v_id)
      is distinct from ('general'::text, 'imported'::text) then
    raise exception 'IDENTITY_ONLY_CHANGE_WRONG';
  end if;
  perform public.update_registration('餐費驗收丙', v_district,
    (select value from meal_choices where open_meal and not hosting_meal), v_family);
  if (select meal_identity from public.registrations where id = v_id) <> 'general' then
    raise exception 'IDENTITY_NOT_KEPT';
  end if;
  perform public.update_registration('餐費驗收丙', v_district,
    (select value from meal_choices where not open_meal and not hosting_meal), v_family);
  if (select meal_identity from public.registrations where id = v_id) is not null then
    raise exception 'IDENTITY_NOT_CLEARED';
  end if;

  -- 先開放後改為限定：既有報名保留，下次儲存時不能再維持「參加」。
  update public.activities set audience = 'all' where id = v_hosting_meal;
  select registration_id into v_id from public.create_registration(gen_random_uuid(), '餐費驗收丁', v_district,
    (select value from meal_choices where not open_meal and hosting_meal), v_no, 'general');
  update public.activities set audience = 'hosting' where id = v_hosting_meal;
  if not exists (select 1 from public.registration_choices
      where registration_id = v_id and activity_id = v_hosting_meal and attending) then
    raise exception 'EARLIER_SIGN_UP_CHANGED';
  end if;
  begin
    perform public.update_registration('餐費驗收丁', v_district,
      (select value from meal_choices where not open_meal and hosting_meal), v_no, 'general');
    raise exception 'PUBLIC_UPDATE_NOT_ENFORCED';
  exception when others then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;
  begin
    perform public.staff_update_registration(v_admin, v_id, '餐費驗收丁', v_district,
      (select value from meal_choices where not open_meal and hosting_meal), v_no, 'general');
    raise exception 'STAFF_UPDATE_NOT_ENFORCED';
  exception when others then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;
  begin
    perform public.staff_create_registration(v_admin, gen_random_uuid(), '餐費驗收戊', v_district,
      (select value from meal_choices where not open_meal and hosting_meal), v_no, 'general');
    raise exception 'STAFF_CREATE_NOT_ENFORCED';
  exception when others then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;

  -- 後台補登與修改的身分規則與公開頁相同。
  begin
    perform public.staff_create_registration(v_admin, gen_random_uuid(), '餐費驗收戊', v_district,
      (select value from meal_choices where open_meal and not hosting_meal), v_no);
    raise exception 'STAFF_IDENTITY_NOT_REQUIRED';
  exception when others then
    if sqlerrm <> 'MEAL_IDENTITY_REQUIRED' then raise; end if;
  end;
  select registration_id into v_id from public.staff_create_registration(v_admin, gen_random_uuid(), '餐費驗收戊',
    v_district, (select value from meal_choices where open_meal and not hosting_meal), v_no, 'student');
  perform public.staff_update_registration(v_admin, v_id, '餐費驗收戊', v_district,
    (select value from meal_choices where open_meal and not hosting_meal), v_no);
  if (select meal_identity from public.registrations where id = v_id) <> 'student' then
    raise exception 'STAFF_IDENTITY_NOT_KEPT';
  end if;

  -- 管理員移除學生價後，下次儲存清掉留下的身分。
  update public.activities set student_fee_amount = null where id = v_open_meal;
  perform public.staff_update_registration(v_admin, v_id, '餐費驗收戊', v_district,
    (select value from meal_choices where open_meal and not hosting_meal), v_no, 'student');
  if (select meal_identity from public.registrations where id = v_id) is not null then
    raise exception 'STALE_IDENTITY_KEPT';
  end if;

  -- 活動設定：學生價不能沒有一般價；舊版頁面未帶新欄位時保留原值，帶空白時清除。
  begin
    perform public.staff_save_reference(v_admin, 'activity', jsonb_build_object('category', 'meal',
      'title', '只有學生價', 'fee_amount', '', 'student_fee_amount', '60', 'is_published', false, 'sort_order', 9003));
    raise exception 'STUDENT_PRICE_WITHOUT_FEE';
  exception when check_violation then null;
  end;
  update public.activities set student_fee_amount = 60, audience_note = '提示' where id = v_open_meal;
  v_activity := public.staff_save_reference(v_admin, 'activity', jsonb_build_object('id', v_open_meal,
    'category', 'meal', 'title', '驗收晚餐', 'fee_amount', '100', 'is_published', true, 'sort_order', 9001));
  if (v_activity->>'student_fee_amount', v_activity->>'cost_amount', v_activity->>'audience', v_activity->>'audience_note')
      is distinct from ('60', '130', 'all', '提示') then
    raise exception 'OLD_PAGE_DROPPED_FIELDS';
  end if;
  v_activity := public.staff_save_reference(v_admin, 'activity', jsonb_build_object('id', v_open_meal,
    'category', 'meal', 'title', '驗收晚餐', 'fee_amount', '100', 'student_fee_amount', '', 'cost_amount', '',
    'audience', 'hosting', 'audience_note', '  ', 'is_published', true, 'sort_order', 9001));
  if (v_activity->>'student_fee_amount', v_activity->>'cost_amount', v_activity->>'audience', v_activity->>'audience_note')
      is distinct from (null::text, null::text, 'hosting'::text, null::text) then
    raise exception 'BLANK_FIELDS_NOT_CLEARED';
  end if;

  -- 公開角色讀得到學生價與報名對象，讀不到實際成本，也不能呼叫輔助函式。
  set local role anon;
  perform id, fee_amount, student_fee_amount, audience, audience_note from public.activities limit 1;
  begin
    perform cost_amount from public.activities limit 1;
    raise exception 'ANON_READ_COST';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.registration_meal_identity('[]', null);
    raise exception 'ANON_CALLED_HELPER';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'MEAL_PRICING_AND_AUDIENCE_OK';
end;
$$;

rollback;
