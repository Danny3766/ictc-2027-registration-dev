-- Local/test only; all fixtures roll back.
begin;
-- The checks are asserts: a database with asserts switched off would skip them and pass silently.
set local plpgsql.check_asserts = on;
do $$
declare actor uuid; district integer; registration uuid; tracked bigint; local_activity bigint;
  choices jsonb; data jsonb; state text;
begin
  if not (select is_test_environment from public.site_settings where id) then
    raise exception 'TEST_PROJECT_REQUIRED';
  end if;
  select auth_user_id into strict actor from public.staff_profiles
    where is_active and not must_change_password and role = 'admin' limit 1;
  select id into district from public.districts limit 1;
  insert into public.activities(category,title,is_published,sort_order,affects_conference_import)
    values ('meeting','Import tracked fixture',true,9998,true) returning id into tracked;
  insert into public.activities(category,title,is_published,sort_order)
    values ('meal','Import local fixture',true,9999) returning id into local_activity;
  insert into public.registrations(create_request_id,full_name,district_id,meal_identity,import_status)
    values(gen_random_uuid(),'Import fixture '||gen_random_uuid(),district,'general','imported') returning id into registration;
  select coalesce(jsonb_agg(jsonb_build_object('activity_id',id,'attending',false)),'[]') into choices
    from public.activities where is_published;
  insert into public.registration_choices(registration_id,activity_id,attending)
    select registration,(c->>'activity_id')::bigint,false from jsonb_array_elements(choices) c;
  -- A local answer must persist without dirtying the import status.
  select jsonb_agg(case when (c->>'activity_id')::bigint=local_activity then c||'{"attending":true}'::jsonb else c end)
    into choices from jsonb_array_elements(choices) c;
  perform public.staff_update_registration(actor,registration,
    (select full_name from public.registrations where id=registration),district,choices,null,'general');
  assert (select import_status='imported' from public.registrations where id=registration), 'LOCAL_ANSWER_DIRTIED_IMPORT';
  assert (select attending from public.registration_choices where registration_id=registration and activity_id=local_activity), 'LOCAL_ANSWER_NOT_SAVED';
  -- A tracked answer dirties imported, and reverting does not restore it.
  select jsonb_agg(case when (c->>'activity_id')::bigint=tracked then c||'{"attending":true}'::jsonb else c end)
    into choices from jsonb_array_elements(choices) c;
  perform public.staff_update_registration(actor,registration,
    (select full_name from public.registrations where id=registration),district,choices,null,'general');
  assert (select import_status='reimport_needed' from public.registrations where id=registration), 'TRACKED_ANSWER_NOT_DIRTY';
  select jsonb_agg(case when (c->>'activity_id')::bigint=tracked then c||'{"attending":false}'::jsonb else c end)
    into choices from jsonb_array_elements(choices) c;
  perform public.staff_update_registration(actor,registration,
    (select full_name from public.registrations where id=registration),district,choices,null,'general');
  assert (select import_status='reimport_needed' from public.registrations where id=registration), 'REVERT_RESTORED_IMPORT';
  delete from public.registration_choices where registration_id=registration and activity_id=tracked;
  update public.registrations set import_status='imported' where id=registration;
  perform public.staff_update_registration(actor,registration,
    (select full_name from public.registrations where id=registration),district,choices,null,'general');
  assert (select import_status='reimport_needed' from public.registrations where id=registration), 'UNANSWERED_NO_NOT_DIRTY';
  update public.registrations set import_status='pending' where id=registration;
  perform public.staff_update_registration(actor,registration,
    (select full_name from public.registrations where id=registration),district,choices,null,'student');
  assert (select import_status='pending' from public.registrations where id=registration), 'PENDING_CHANGED';
  update public.registrations set meal_identity='general' where id=registration;
  update public.registrations set import_status='imported' where id=registration;
  perform public.staff_update_registration(actor,registration,
    (select full_name from public.registrations where id=registration),district,choices,null,'student');
  assert (select import_status='reimport_needed' from public.registrations where id=registration), 'IDENTITY_NOT_DIRTY';
  -- Activity edits outside the import scope do not dirty an attending registration.
  update public.registrations set import_status='imported' where id=registration;
  select to_jsonb(a)||jsonb_build_object('title','Local renamed') into data from public.activities a where id=local_activity;
  perform public.staff_save_reference(actor,'activity',data);
  assert (select import_status='imported' from public.registrations where id=registration), 'LOCAL_TITLE_DIRTY';
  perform public.staff_save_reference(actor,'activity',data||'{"affects_conference_import":true}'::jsonb);
  assert (select import_status='reimport_needed' from public.registrations where id=registration), 'ENABLE_NOT_DIRTY';
  update public.registrations set import_status='imported' where id=registration;
  perform public.staff_save_reference(actor,'activity',data||'{"affects_conference_import":false}'::jsonb);
  assert (select import_status='reimport_needed' from public.registrations where id=registration), 'DISABLE_NOT_DIRTY';
  update public.registration_choices set attending=true where registration_id=registration and activity_id=tracked;
  update public.registrations set import_status='imported' where id=registration;
  select to_jsonb(a)||jsonb_build_object('title','Tracked renamed') into data from public.activities a where id=tracked;
  perform public.staff_save_reference(actor,'activity',data);
  assert (select import_status='reimport_needed' from public.registrations where id=registration), 'TRACKED_TITLE_NOT_DIRTY';
  update public.registrations set import_status='imported' where id=registration;
  perform public.staff_save_reference(actor,'activity',data||'{"cost_amount":100}'::jsonb);
  assert (select import_status='imported' from public.registrations where id=registration), 'COST_DIRTIED_IMPORT';
  -- New activities save the setting, default to unchecked and leave import statuses alone.
  data := public.staff_save_reference(actor,'activity',
    '{"category":"meal","title":"Import new fixture","is_published":false,"sort_order":10000}'::jsonb);
  assert not (data->>'affects_conference_import')::boolean, 'NEW_ACTIVITY_NOT_UNCHECKED';
  data := public.staff_save_reference(actor,'activity',
    '{"category":"meeting","title":"Import new tracked fixture","is_published":true,"sort_order":10001,"affects_conference_import":true}'::jsonb);
  assert (data->>'affects_conference_import')::boolean, 'NEW_ACTIVITY_SETTING_NOT_SAVED';
  assert (select import_status='imported' from public.registrations where id=registration), 'NEW_ACTIVITY_DIRTIED_IMPORT';
end;
$$;
-- Isolate each survey field: identity and every activity answer stay unchanged.
do $$
declare actor uuid; district integer; registration uuid; choices jsonb; staff_path boolean;
  fixture_name text; scenario integer; hosting jsonb; pickup jsonb; saved boolean;
  original_hosting jsonb := '{"status":"hosting","guest_type":"any","guest_count":2}';
  original_pickup jsonb := '{"status":"yes","count":2}';
begin
  select auth_user_id into strict actor from public.staff_profiles
    where role='admin' and is_active and not must_change_password limit 1;
  select id into strict district from public.districts limit 1;
  update public.site_settings set is_registration_open=true,is_lookup_open=true,
    registration_deadline_at=null,is_hosting_open=true,is_pickup_open=true where id;
  update public.registration_create_limits set created_count=0,window_started_at=now() where id;
  select jsonb_agg(jsonb_build_object('activity_id',id,'attending',false)) into choices
    from public.activities where is_published;
  foreach staff_path in array array[false,true] loop
    fixture_name := 'Survey import '||gen_random_uuid();
    select registration_id into strict registration from public.create_registration_with_pickup(
      gen_random_uuid(),fixture_name,district,choices,original_hosting,'general',original_pickup);
    for scenario in 1..5 loop
      -- Reset answers directly so each RPC changes exactly one survey field.
      perform public.registration_hosting_put(registration,public.registration_hosting_value(original_hosting));
      perform public.registration_pickup_put(registration,original_pickup);
      update public.registrations set import_status='imported',imported_at=now(),imported_by=actor where id=registration;
      hosting := case scenario
        when 1 then '{"status":"not_hosting"}'::jsonb
        when 2 then original_hosting||'{"guest_type":"brother"}'::jsonb
        when 3 then original_hosting||'{"guest_count":3}'::jsonb
        else original_hosting end;
      pickup := case scenario
        when 4 then '{"status":"no","count":0}'::jsonb
        when 5 then original_pickup||'{"count":3}'::jsonb
        else original_pickup end;
      saved := case when staff_path
        then public.staff_update_registration_with_pickup(actor,registration,fixture_name,district,choices,hosting,'general',pickup)
        else public.update_registration_with_pickup(fixture_name,district,choices,hosting,'general',pickup) end;
      assert saved, 'SURVEY_UPDATE_NOT_SAVED: '||scenario||' staff='||staff_path;
      assert (select import_status='reimport_needed' and meal_identity='general'
        and imported_at=now() and imported_by=actor from public.registrations where id=registration),
        'SURVEY_FIELD_NOT_DIRTY: '||scenario||' staff='||staff_path;
      assert public.registration_hosting_get(registration)=public.registration_hosting_value(hosting), 'HOSTING_NOT_SAVED';
      assert public.registration_pickup_get(registration)=public.registration_pickup_value(pickup), 'PICKUP_NOT_SAVED';
    end loop;
  end loop;
  -- The public page uses the same scope: a local answer keeps imported, a tracked one dirties it.
  update public.registrations set import_status='imported' where id=registration;
  select jsonb_agg(c||jsonb_build_object('attending',a.title='Local renamed')) into choices
    from jsonb_array_elements(choices) c join public.activities a on a.id=(c->>'activity_id')::bigint;
  saved := public.update_registration_with_pickup(fixture_name,district,choices,null,'general',null);
  assert saved and (select import_status='imported' from public.registrations where id=registration), 'PUBLIC_LOCAL_DIRTIED_IMPORT';
  select jsonb_agg(c||jsonb_build_object('attending',a.title in ('Local renamed','Tracked renamed'))) into choices
    from jsonb_array_elements(choices) c join public.activities a on a.id=(c->>'activity_id')::bigint;
  saved := public.update_registration_with_pickup(fixture_name,district,choices,null,'general',null);
  assert saved and (select import_status='reimport_needed' from public.registrations where id=registration), 'PUBLIC_TRACKED_NOT_DIRTY';
end;
$$;
rollback;
