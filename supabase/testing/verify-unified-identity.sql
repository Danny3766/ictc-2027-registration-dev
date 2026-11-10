-- Test database only; fixtures are rolled back.
begin;
do $$
declare v_district integer; v_choices jsonb; v_id uuid; v_serial bigint; v_row public.registrations; v_actor uuid;
begin
  if not coalesce((select is_test_environment from public.site_settings where id),false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select id into v_district from public.districts order by sort_order limit 1;
  select auth_user_id into v_actor from public.staff_profiles where role='admin' and is_active and not must_change_password limit 1;
  update public.site_settings set is_registration_open=true,registration_deadline_at=null,is_lookup_open=true,
    is_hosting_open=false,is_pickup_open=false where id;
  update public.registration_create_limits set window_started_at=now(),created_count=0 where id;
  select coalesce(jsonb_agg(jsonb_build_object('activity_id',id,'attending',false)),'[]') into v_choices
    from public.activities where is_published;
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(),'Missing identity verification',v_district,v_choices);
    raise exception 'MISSING_IDENTITY_ACCEPTED';
  exception when raise_exception then
    if sqlerrm <> 'MEAL_IDENTITY_REQUIRED' then raise; end if;
  end;
  select registration_id,serial_no into v_id,v_serial from public.create_registration_with_pickup(
    gen_random_uuid(),'Unified identity verification',v_district,v_choices,null,'student');
  select * into v_row from public.registrations where id=v_id;
  if v_row.meal_identity <> 'student' or v_row.is_child then raise exception 'STUDENT_NOT_SAVED'; end if;
  perform public.update_registration_with_pickup(v_row.full_name,v_district,v_choices,null,'preschool',null,null,'Parent');
  select * into v_row from public.registrations where id=v_id;
  if v_row.meal_identity <> 'preschool' or v_row.child_type <> 'preschool' then raise exception 'PRESCHOOL_NOT_DERIVED'; end if;
  perform public.update_registration_with_pickup(v_row.full_name,v_district,v_choices,null,'student');
  select * into v_row from public.registrations where id=v_id;
  if v_row.meal_identity <> 'student' or v_row.child_type is not null or v_row.parent_name is not null then
    raise exception 'ADULT_NOT_RESTORED';
  end if;
  update public.registration_identities set is_active=false where code='student';
  perform public.update_registration_with_pickup(v_row.full_name,v_district,v_choices,null,'student');
  if not exists(select 1 from public.registration_used_identity_codes() code where code='student') then
    raise exception 'USED_INACTIVE_IDENTITY_MISSING';
  end if;
  select registration_id,serial_no into v_id,v_serial from public.staff_create_registration_with_pickup(
    v_actor,gen_random_uuid(),'Staff unified verification',v_district,v_choices,null,'child',null,null,'Parent');
  perform public.staff_update_registration_with_pickup(v_actor,v_id,'Staff unified verification',v_district,
    v_choices,null,'preschool',null,null,'Parent');
  select * into v_row from public.registrations where id=v_id;
  if v_row.child_type <> 'preschool' or v_row.meal_identity <> 'preschool' then raise exception 'STAFF_TYPE_NOT_DERIVED'; end if;
end;
$$;
rollback;
