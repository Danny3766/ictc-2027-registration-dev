-- Test database only. All fixture changes roll back.
begin;
set local plpgsql.check_asserts = on;
do $$
declare actor uuid; district integer; choices jsonb; rid uuid; settings jsonb; result jsonb; before_people bigint; h_activity bigint; p_activity bigint;
  name text:='Survey identity '||gen_random_uuid();
begin
  if not coalesce((select is_test_environment from public.site_settings where id),false) then raise exception 'TEST_PROJECT_REQUIRED'; end if;
  select auth_user_id into strict actor from public.staff_profiles where role='admin' and is_active and not must_change_password limit 1;
  select id into strict district from public.districts limit 1;
  update public.site_settings set is_registration_open=true,is_lookup_open=true,registration_deadline_at=null,
    is_hosting_open=true,is_pickup_open=true where id;
  update public.registration_create_limits set created_count=0,window_started_at=now() where id;
  insert into public.activities(category,title,audience,is_published,sort_order)
    values('other','Survey hosting audience','hosting',true,9998) returning id into h_activity;
  insert into public.activities(category,title,audience,is_published,sort_order)
    values('other','Survey pickup audience','pickup',true,9999) returning id into p_activity;
  select jsonb_agg(jsonb_build_object('activity_id',id,'attending',false)) into choices from public.activities where is_published;
  settings:=public.staff_save_reception_settings(actor,'hosting',
    '{"is_hosting_open":true,"is_pickup_open":true,"hosting_identity_codes":["general","child"],"pickup_identity_codes":["general","student","preschool"]}');
  assert public.survey_audience_valid('student',jsonb_build_array(jsonb_build_object('activity_id',h_activity,'attending',true)),null,null),'STUDENT_HOSTING_NOT_EXEMPT';
  assert not public.survey_audience_valid('student',jsonb_build_array(jsonb_build_object('activity_id',p_activity,'attending',true)),null,null),'STUDENT_PICKUP_WRONGLY_EXEMPT';
  assert not public.survey_audience_valid('child',jsonb_build_array(jsonb_build_object('activity_id',h_activity,'attending',true)),null,null),'CHILD_HOSTING_WRONGLY_EXEMPT';
  begin
    perform public.staff_save_reception_settings(actor,'hosting',settings||'{"hosting_identity_codes":[]}');
    raise exception 'EMPTY_IDENTITIES_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm<>'INVALID_SURVEY_IDENTITIES' then raise; end if;
  end;
  begin
    perform public.staff_save_reference(actor,'delete_identity','{"code":"student"}');
    raise exception 'TARGET_IDENTITY_DELETED';
  exception when invalid_parameter_value then
    if sqlerrm<>'IDENTITY_IN_SURVEY_TARGETS' then raise; end if;
  end;
  begin
    perform public.staff_save_reception_settings(actor,'hosting',settings-'is_pickup_open');
    raise exception 'MISSING_SWITCH_ACCEPTED';
  exception when invalid_parameter_value then
    if sqlerrm<>'INVALID_REFERENCE_DATA' then raise; end if;
  end;
  select registration_id into strict rid from public.create_registration_with_pickup(gen_random_uuid(),name,district,choices,
    null,'student','{"status":"yes","count":3}');
  assert public.registration_hosting_get(rid) is null, 'UNASKED_HOSTING_NOT_EMPTY';
  assert public.registration_pickup_get(rid)->>'count'='3','PICKUP_NOT_SAVED';
  update public.registrations set import_status='imported' where id=rid;
  -- Removing eligibility preserves answers and import status; it is only a configuration change.
  settings:=public.staff_save_reception_settings(actor,'hosting',settings||'{"pickup_identity_codes":["general","preschool"]}');
  assert public.registration_pickup_get(rid)->>'count'='3','CONFIG_ERASED_ANSWER';
  assert (select import_status='imported' from public.registrations where id=rid),'CONFIG_DIRTIED_IMPORT';
  begin
    perform public.update_registration_with_pickup(name,district,choices,null,'student','{"status":"yes","count":4}');
    raise exception 'NON_TARGET_CHANGED_ANSWER';
  exception when raise_exception then
    if sqlerrm<>'PICKUP_NOT_ALLOWED' then raise; end if;
  end;
  result:=public.update_registration_survey_result(name,district,choices,null,'student',null);
  assert (result->>'success')::boolean and result->'surveys'->'pickup'->>'count'='3','PUBLIC_CANONICAL_RESULT_MISSING';
  assert public.registration_pickup_get(rid)->>'count'='3' and not(public.registration_pickup_get(rid)?'answer_valid'),'CONFIG_RETRY_INVALIDATED_ANSWER';
  assert (select import_status='imported' from public.registrations where id=rid),'CONFIG_RETRY_DIRTIED_IMPORT';
  -- Staff can answer either survey for any identity while surveys are closed.
  settings:=public.staff_save_reception_settings(actor,'hosting',settings||'{"is_hosting_open":false,"is_pickup_open":false}');
  perform public.staff_update_registration_with_pickup(actor,rid,name,district,choices,
    '{"status":"hosting","guest_type":"any","guest_count":2}','student','{"status":"yes","count":4}');
  assert public.registration_hosting_get(rid)->>'guest_count'='2','STAFF_HOSTING_NOT_SAVED';
  assert public.registration_pickup_get(rid)->>'count'='4','STAFF_PICKUP_NOT_SAVED';
  assert (select import_status='reimport_needed' from public.registrations where id=rid),'STAFF_ANSWER_NOT_DIRTY';
  -- A child can answer the configured hosting question independently of pickup.
  settings:=public.staff_save_reception_settings(actor,'hosting',settings||'{"is_hosting_open":true,"is_pickup_open":true}');
  select registration_id into strict rid from public.create_registration_with_pickup(gen_random_uuid(),name||' child',district,choices,
    '{"status":"hosting","guest_type":"sister","guest_count":2}','child',null,null,'Parent');
  assert (select is_child and child_type='elementary' from public.registrations where id=rid),'CHILD_NOT_SAVED';
  assert public.registration_hosting_get(rid)->>'status'='hosting','CHILD_HOSTING_FORCED_NO';
  assert public.registration_pickup_get(rid) is null,'CHILD_PICKUP_NOT_EMPTY';
  result:=public.staff_registration_statistics(actor);
  select coalesce(sum((item->>'people')::bigint),0) into before_people from jsonb_array_elements(result->'hosting') item;
  -- Saving a move out of an eligible identity on the public page stores a valid 否, even if a page sends an answer.
  update public.registrations set import_status='imported' where id=rid;
  perform public.update_registration_with_pickup(name||' child',district,choices,
    '{"status":"hosting","guest_type":"any","guest_count":4}','student',null);
  assert public.registration_hosting_get(rid)->>'status'='not_hosting' and not(public.registration_hosting_get(rid)?'answer_valid'),'LEAVING_NOT_NO';
  assert public.registration_pickup_get(rid) is null,'LEAVING_TOUCHED_UNASKED_PICKUP';
  assert (select import_status='reimport_needed' from public.registrations where id=rid),'LEAVING_NOT_DIRTY';
  assert exists(select 1 from public.audit_events where target_id=rid and action='registration.hosting_updated'
    and before_data->'hosting'->>'status'='hosting' and after_data->'hosting'->>'status'='not_hosting'),'LEAVING_AUDIT_MISSING';
  result:=public.staff_registration_statistics(actor);
  assert (select coalesce(sum((item->>'people')::bigint),0) from jsonb_array_elements(result->'hosting') item)=before_people-2,'STALE_PEOPLE_COUNTED';
  -- Returning keeps that 否 as the answer; nothing has to be answered again.
  perform public.update_registration_with_pickup(name||' child',district,choices,null,'child',null,null,'Parent');
  assert public.registration_hosting_get(rid)->>'status'='not_hosting' and not(public.registration_hosting_get(rid)?'answer_valid'),'RETURN_LOST_NO';
  perform public.update_registration_with_pickup(name||' child',district,choices,
    '{"status":"hosting","guest_type":"any","guest_count":5}','child',null,null,'Parent');
  assert public.registration_hosting_get(rid)->>'guest_count'='5','RECONFIRM_NOT_SAVED';
  assert not (public.registration_hosting_get(rid) ? 'answer_valid'),'RECONFIRM_NOT_VALID';
  -- No browser-supplied validity flag can suppress a fresh, explicit answer.
  perform public.update_registration_with_pickup(name||' child',district,choices,
    '{"status":"not_hosting","answer_valid":false}','child',null,null,'Parent');
  assert (select answer_valid from public.registration_hosting where registration_id=rid),'CLIENT_CONTROLLED_VALIDITY';
  -- A same-screen identity round trip while closed can invalidate without erasing history.
  settings:=public.staff_save_reception_settings(actor,'hosting',settings||'{"is_hosting_open":false}');
  select coalesce(sum((item->>'registrations')::bigint) filter (where item->>'status'='not_hosting'),0) into before_people
    from jsonb_array_elements(public.staff_registration_statistics(actor)->'hosting') item;
  perform public.update_registration_with_pickup(name||' child',district,choices,'{"reset":true}','child',null,null,'Parent');
  assert public.registration_hosting_get(rid)->>'status'='not_hosting','RESET_ERASED_HISTORY';
  assert public.registration_hosting_get(rid)->>'answer_valid'='false','RESET_NOT_SAVED';
  -- Statistics count an invalidated answer as unanswered, not as 否.
  assert (select coalesce(sum((item->>'registrations')::bigint) filter (where item->>'status'='not_hosting'),0)
    from jsonb_array_elements(public.staff_registration_statistics(actor)->'hosting') item)=before_people-1,'INVALID_ANSWER_COUNTED';
  settings:=public.staff_save_reception_settings(actor,'hosting',settings||'{"is_hosting_open":true}');
  begin
    perform public.update_registration_with_pickup(name||' child',district,choices,null,'child',null,null,'Parent');
    raise exception 'RESET_ACCEPTED_WITHOUT_ANSWER';
  exception when raise_exception then if sqlerrm<>'HOSTING_REQUIRED' then raise; end if; end;
  -- Staff moving an eligible identity out of a survey's list stores 否 for that survey only.
  perform public.staff_update_registration_with_pickup(actor,rid,name||' child',district,choices,
    '{"status":"hosting","guest_type":"any","guest_count":5}','child',null);
  settings:=public.staff_save_reception_settings(actor,'hosting',settings||'{"hosting_identity_codes":["general","child"],"pickup_identity_codes":["general","child"]}');
  perform public.staff_update_registration_with_pickup(actor,rid,name||' child',district,choices,
    '{"status":"hosting","guest_type":"any","guest_count":5}','student','{"status":"yes","count":2}');
  assert public.registration_hosting_get(rid)->>'status'='not_hosting' and not(public.registration_hosting_get(rid)?'answer_valid'),'STAFF_LEAVING_HOSTING_NOT_NO';
  assert public.registration_pickup_get(rid)='{"status":"no","count":0}','STAFF_LEAVING_PICKUP_NOT_NO';
  -- Staff may still answer for the student once the identity stays the same.
  perform public.staff_update_registration_with_pickup(actor,rid,name||' child',district,choices,
    '{"status":"hosting","guest_type":"any","guest_count":5}','student','{"status":"yes","count":2}');
  assert public.registration_hosting_get(rid)->>'status'='hosting','STAFF_SAME_IDENTITY_FORCED_NO';
  -- The public page cannot reset a survey its identity cannot answer.
  perform public.update_registration_with_pickup(name||' child',district,choices,'{"reset":true}','student',null);
  assert public.registration_hosting_get(rid)->>'status'='hosting' and not(public.registration_hosting_get(rid)?'answer_valid'),'NON_TARGET_RESET_ACCEPTED';
  assert not has_function_privilege('anon','public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text)','EXECUTE'), 'ANON_SAVE_HELPER';
  assert not has_function_privilege('anon','public.update_registration_survey_result(text,integer,jsonb,jsonb,text,jsonb,text,text)','EXECUTE'), 'ANON_PUBLIC_SAVE_RPC';
  update public.site_settings set is_lookup_open=false where id;
  begin
    perform public.update_registration_with_pickup('Unknown fixture name',district,choices,null,'general');
    raise exception 'CLOSED_LOOKUP_REVEALED_MISSING_NAME';
  exception when raise_exception then if sqlerrm<>'LOOKUP_CLOSED' then raise; end if; end;
  update public.site_settings set is_registration_open=false where id;
  begin
    perform public.update_registration_with_pickup('Unknown fixture name',district,choices,null,'general');
    raise exception 'CLOSED_REGISTRATION_REVEALED_MISSING_NAME';
  exception when raise_exception then if sqlerrm<>'REGISTRATION_CLOSED' then raise; end if; end;
  raise notice 'SURVEY_IDENTITIES_OK';
end;
$$;
rollback;
