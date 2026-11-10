-- Run only against a test database. All fixture changes roll back.
begin;
do $$
declare v_district integer; v_choices jsonb; v_id uuid; v_serial bigint; v_row public.registrations; v_actor uuid;
begin
  if not coalesce((select is_test_environment from public.site_settings where id),false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select id into v_district from public.districts order by sort_order limit 1;
  update public.site_settings set is_registration_open=true, registration_deadline_at=null,
    is_lookup_open=true, is_hosting_open=true, is_pickup_open=true where id;
  update public.registration_create_limits set window_started_at=now(),created_count=0 where id;
  select coalesce(jsonb_agg(jsonb_build_object('activity_id',id,'attending',false)),'[]')
    into v_choices from public.activities where is_published;
  select registration_id,serial_no into v_id,v_serial from public.create_registration_with_pickup(
    gen_random_uuid(),'Child type verification',v_district,v_choices,null,null,null,'preschool','Parent');
  select * into v_row from public.registrations where id=v_id;
  if v_row.child_type <> 'preschool' or v_row.meal_identity <> 'preschool' or not v_row.is_child then
    raise exception 'PRESCHOOL_NOT_SAVED';
  end if;
  if public.get_registration_child(v_row.full_name,v_district)->>'child_type' <> 'preschool' then
    raise exception 'LOOKUP_TYPE_MISSING';
  end if;
  update public.registrations set import_status='imported' where id=v_id;
  perform public.update_registration_with_pickup(v_row.full_name,v_district,v_choices,null,null,null,'elementary','Parent');
  select * into v_row from public.registrations where id=v_id;
  if v_row.child_type <> 'elementary' or v_row.meal_identity <> 'child' or v_row.import_status <> 'reimport_needed' then
    raise exception 'TYPE_CHANGE_NOT_SAVED';
  end if;
  perform public.update_registration_with_pickup(v_row.full_name,v_district,v_choices,null,null,null,null,null);
  if (select child_type from public.registrations where id=v_id) <> 'elementary' then
    raise exception 'OMITTED_TYPE_NOT_PRESERVED';
  end if;
  perform public.update_registration_with_pickup(v_row.full_name,v_district,v_choices,null,null,null,'',null);
  select * into v_row from public.registrations where id=v_id;
  if v_row.is_child or v_row.child_type is not null or v_row.meal_identity <> 'general' then
    raise exception 'ADULT_NOT_RESTORED';
  end if;
  begin
    perform public.registration_meal_identity('[]','preschool');
    raise exception 'ADULT_CHILD_IDENTITY_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_MEAL_IDENTITY' then raise; end if;
  end;
  begin
    perform public.registration_child_type('invalid');
    raise exception 'INVALID_TYPE_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_CHILD_TYPE' then raise; end if;
  end;
  begin
    delete from public.registration_identities where code='preschool';
    raise exception 'RESERVED_IDENTITY_DELETED';
  exception when invalid_parameter_value then
    if sqlerrm <> 'IDENTITY_IN_USE' then raise; end if;
  end;
  select auth_user_id into v_actor from public.staff_profiles
    where role='admin' and is_active and not must_change_password limit 1;
  if v_actor is null then raise exception 'TEST_ADMIN_REQUIRED'; end if;
  select registration_id,serial_no into v_id,v_serial from public.staff_create_registration_with_pickup(
    v_actor,gen_random_uuid(),'Staff child type verification',v_district,v_choices,null,null,null,'preschool','Parent');
  perform public.staff_update_registration_with_pickup(v_actor,v_id,'Staff child type verification',
    v_district,v_choices,null,null,null,'elementary','Parent');
  select * into v_row from public.registrations where id=v_id;
  if v_row.child_type <> 'elementary' or v_row.meal_identity <> 'child' then
    raise exception 'STAFF_TYPE_CHANGE_NOT_SAVED';
  end if;
  raise notice 'CHILD_TYPE_OK';
end;
$$;
rollback;
