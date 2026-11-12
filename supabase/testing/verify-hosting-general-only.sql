-- Default survey targets remain general; configurable targets supersede forced 否.
-- Test database only; all fixtures roll back.
begin;
do $$
declare district integer; actor uuid; hosting_activity bigint; pickup_activity bigint; choices jsonb; rid uuid;
begin
  if not coalesce((select is_test_environment from public.site_settings where id),false) then raise exception 'TEST_PROJECT_REQUIRED'; end if;
  select id into strict district from public.districts limit 1;
  select auth_user_id into strict actor from public.staff_profiles where role='admin' and is_active and not must_change_password limit 1;
  update public.site_settings set is_registration_open=true,is_lookup_open=true,registration_deadline_at=null,
    is_hosting_open=true,is_pickup_open=true,hosting_identity_codes=array['general'],pickup_identity_codes=array['general'] where id;
  update public.registration_create_limits set created_count=0,window_started_at=now() where id;
  insert into public.activities(category,title,audience,is_published,sort_order)
    values('other','Default hosting fixture','hosting',true,9998) returning id into hosting_activity;
  insert into public.activities(category,title,audience,is_published,sort_order)
    values('other','Default pickup fixture','pickup',true,9999) returning id into pickup_activity;
  select jsonb_agg(jsonb_build_object('activity_id',id,'attending',id in(hosting_activity,pickup_activity))) into choices
    from public.activities where is_published;
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(),'General default fixture',district,choices,null,'general');
    raise exception 'GENERAL_WITHOUT_HOSTING_ACCEPTED';
  exception when raise_exception then if sqlerrm<>'HOSTING_REQUIRED' then raise; end if; end;
  select registration_id into strict rid from public.create_registration_with_pickup(gen_random_uuid(),'Student default fixture',district,choices,null,'student');
  assert public.registration_hosting_get(rid) is null and public.registration_pickup_get(rid) is null,'NON_TARGET_GENERATED_NO';
  assert public.survey_audience_valid('student',choices,null,null),'NON_TARGET_NOT_EXEMPT';
  assert not public.survey_audience_valid('general',choices,null,null),'GENERAL_AUDIENCE_SKIPPED';
  perform public.update_registration_with_pickup('Student default fixture',district,choices,
    '{"status":"hosting","guest_type":"any","guest_count":1}','general','{"status":"yes","count":1}');
  perform public.update_registration_with_pickup('Student default fixture',district,choices,null,'student');
  assert public.registration_hosting_get(rid)=public.registration_hosting_value('{"status":"not_hosting"}'),'LEAVING_HOSTING_NOT_NO';
  assert public.registration_pickup_get(rid)='{"status":"no","count":0}','LEAVING_PICKUP_NOT_NO';
  perform public.staff_update_registration_with_pickup(actor,rid,'Student default fixture',district,choices,
    '{"status":"hosting","guest_type":"any","guest_count":3}','student','{"status":"yes","count":2}');
  -- Staff cannot answer a survey the identity is not asked; it stays a valid 否.
  assert public.registration_hosting_get(rid)->>'status'='not_hosting','STAFF_NON_TARGET_ANSWERED';
  assert not(public.registration_hosting_get(rid)?'answer_valid'),'STAFF_NO_NOT_VALID';
end;
$$;
rollback;
