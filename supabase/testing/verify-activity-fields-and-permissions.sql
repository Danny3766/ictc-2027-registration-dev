-- Current activity-field compatibility and anonymous permissions. Test database only.
begin;
do $$
declare v_admin uuid; v_open_meal bigint; v_activity jsonb;
begin
  if not coalesce((select is_test_environment from public.site_settings where id),false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select auth_user_id into strict v_admin from public.staff_profiles
    where role='admin' and is_active and not must_change_password limit 1;
  insert into public.activities(category,title,fee_amount,cost_amount,is_published,sort_order)
    values('meal','Field permission fixture',100,130,false,9900) returning id into v_open_meal;
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
  begin
    perform public.conference_choices('[]');
    raise exception 'ANON_CALLED_CONFERENCE_HELPER';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'ACTIVITY_FIELDS_AND_PERMISSIONS_OK';
end;
$$;
rollback;
