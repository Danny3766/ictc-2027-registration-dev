-- 活動改為限定對象前的不符對象人數（202611240001）資料庫驗證。
-- 在測試專案 SQL Editor 執行；需要一位已改過初始密碼的有效管理員。虛構資料與設定變更最後全部回滾。
begin;
do $$
declare actor uuid; district integer; target bigint; prerequisite bigint; person uuid;
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into strict actor from public.staff_profiles
    where role = 'admin' and is_active and not must_change_password limit 1;
  select id into strict district from public.districts order by sort_order limit 1;
  update public.site_settings set hosting_identity_codes = array['general'], pickup_identity_codes = array['general'] where id;
  insert into public.activities(category,title,is_published,sort_order,audience)
    values ('other','Preview prerequisite',true,9998,'all') returning id into prerequisite;
  insert into public.activities(category,title,is_published,sort_order,audience)
    values ('other','Preview target',true,9999,'all') returning id into target;

  -- 1 開家是；2 接機是；3 學生不必填接待；4 已取消；5 沒有身分，接待答案都失效。只有 1、5 參加前置活動。
  for i in 1..5 loop
    insert into public.registrations(create_request_id,full_name,district_id,meal_identity,record_status)
      values (gen_random_uuid(),'Preview ' || gen_random_uuid(),district,
        case i when 3 then 'student' when 5 then null else 'general' end,
        case when i = 4 then 'cancelled' else 'active' end)
      returning id into person;
    insert into public.registration_choices(registration_id,activity_id,attending)
      values (person,target,true), (person,prerequisite,i in (1,5));
    insert into public.registration_hosting(registration_id,status,guest_type,guest_count,answer_valid)
      values (person,case when i in (1,5) then 'hosting' else 'not_hosting' end,
        case when i in (1,5) then 'any' end,case when i in (1,5) then 1 end,i <> 5);
    insert into public.registration_pickup(registration_id,status,count,answer_valid)
      values (person,case when i in (2,5) then 'yes' else 'no' end,case when i in (2,5) then 1 else 0 end,i <> 5);
  end loop;

  if public.staff_activity_audience_outside_count(actor,target,'hosting') <> 2 then
    raise exception 'HOSTING_COUNT_MISMATCH';
  end if;
  if public.staff_activity_audience_outside_count(actor,target,'pickup') <> 2 then
    raise exception 'PICKUP_COUNT_MISMATCH';
  end if;
  if public.staff_activity_audience_outside_count(actor,target,'activity:' || prerequisite) <> 2 then
    raise exception 'PREREQUISITE_COUNT_MISMATCH';
  end if;
  if public.staff_activity_audience_outside_count(actor,target,'all') <> 0 then
    raise exception 'ALL_COUNT_MISMATCH';
  end if;
  -- An unpublished prerequisite cannot be met, so everyone attending falls outside.
  update public.activities set is_published = false where id = prerequisite;
  if public.staff_activity_audience_outside_count(actor,target,'activity:' || prerequisite) <> 4 then
    raise exception 'HIDDEN_PREREQUISITE_COUNT_MISMATCH';
  end if;
  begin
    perform public.staff_activity_audience_outside_count(gen_random_uuid(),target,'hosting');
    raise exception 'UNAUTHORIZED_ACTOR_ACCEPTED';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;
