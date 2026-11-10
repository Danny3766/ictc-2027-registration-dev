-- Test database only; fixtures are rolled back. Run after 202611100004.
begin;
do $$
declare v_district integer; v_actor uuid; v_hosting_activity bigint; v_pickup_activity bigint;
  v_choices jsonb; v_id uuid; v_serial bigint; v_row public.registrations;
  v_no_hosting jsonb := public.registration_hosting_value('{"status": "not_hosting"}');
  v_no_pickup jsonb := public.registration_pickup_value('{"status": "no", "count": 0}');
  v_yes_hosting jsonb := '{"status": "hosting", "guest_type": "any", "guest_count": 1}';
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  select id into v_district from public.districts order by sort_order limit 1;
  select auth_user_id into v_actor from public.staff_profiles
    where role = 'admin' and is_active and not must_change_password limit 1;
  if v_actor is null then raise exception 'TEST_ADMIN_REQUIRED'; end if;
  update public.site_settings set is_registration_open = true, registration_deadline_at = null, is_lookup_open = true,
    is_hosting_open = true, is_pickup_open = true where id;
  update public.registration_create_limits set window_started_at = now(), created_count = 0 where id;
  insert into public.registration_identities (code, name, is_active, public_selectable, sort_order)
    values ('verify_custom', 'Custom verification', true, true, 999);
  insert into public.activities (category, title, audience, is_published, sort_order)
    values ('other', 'Hosting audience verification', 'hosting', true, 998) returning id into v_hosting_activity;
  insert into public.activities (category, title, audience, is_published, sort_order)
    values ('other', 'Pickup audience verification', 'pickup', true, 999) returning id into v_pickup_activity;
  select jsonb_agg(jsonb_build_object('activity_id', id,
      'attending', id in (v_hosting_activity, v_pickup_activity)))
    into v_choices from public.activities where is_published;

  -- 一般 still answers both surveys.
  begin
    perform public.create_registration_with_pickup(gen_random_uuid(), 'General verification', v_district,
      v_choices, null, 'general');
    raise exception 'GENERAL_WITHOUT_HOSTING_ACCEPTED';
  exception when raise_exception then
    if sqlerrm <> 'HOSTING_REQUIRED' then raise; end if;
  end;

  -- A student answers neither, is stored as 否, and may join both restricted activities.
  select registration_id, serial_no into v_id, v_serial from public.create_registration_with_pickup(
    gen_random_uuid(), 'Student hosting verification', v_district, v_choices, v_yes_hosting, 'student',
    '{"status": "yes", "count": 2}');
  if public.registration_hosting_get(v_id) is distinct from v_no_hosting
    or public.registration_pickup_get(v_id) is distinct from v_no_pickup then
    raise exception 'STUDENT_ANSWERS_NOT_OFF';
  end if;
  if (select is_child from public.registrations where id = v_id) then raise exception 'STUDENT_BECAME_CHILD'; end if;

  -- Switching to 一般 asks again: the stored 否 stands until answered, and the hosting audience applies.
  begin
    perform public.update_registration_with_pickup('Student hosting verification', v_district, v_choices,
      null, 'general');
    raise exception 'GENERAL_AUDIENCE_SKIPPED';
  exception when raise_exception then
    if sqlerrm <> 'AUDIENCE_RESTRICTED' then raise; end if;
  end;
  perform public.update_registration_with_pickup('Student hosting verification', v_district, v_choices,
    v_yes_hosting, 'general', '{"status": "yes", "count": 1}');
  if public.registration_hosting_get(v_id)->>'status' <> 'hosting' then raise exception 'GENERAL_ANSWER_NOT_SAVED'; end if;

  -- Back to a custom identity, sent or kept from the stored one: both answers return to 否, audited.
  perform public.update_registration_with_pickup('Student hosting verification', v_district, v_choices,
    v_yes_hosting, 'verify_custom', '{"status": "yes", "count": 1}');
  if public.registration_hosting_get(v_id) is distinct from v_no_hosting
    or public.registration_pickup_get(v_id) is distinct from v_no_pickup then
    raise exception 'CUSTOM_ANSWERS_NOT_OFF';
  end if;
  if not exists (select 1 from public.audit_events where target_id = v_id and action = 'registration.child_updated'
      and after_data->'hosting' = v_no_hosting) then
    raise exception 'ANSWERS_OFF_AUDIT_MISSING';
  end if;
  perform public.update_registration_with_pickup('Student hosting verification', v_district, v_choices, v_yes_hosting);
  if public.registration_hosting_get(v_id) is distinct from v_no_hosting then raise exception 'STORED_IDENTITY_IGNORED'; end if;

  -- The back office follows the same rule.
  select registration_id into v_id from public.staff_create_registration_with_pickup(v_actor, gen_random_uuid(),
    'Staff custom verification', v_district, v_choices, v_yes_hosting, 'verify_custom', '{"status": "yes", "count": 1}');
  if public.registration_hosting_get(v_id) is distinct from v_no_hosting
    or public.registration_pickup_get(v_id) is distinct from v_no_pickup then
    raise exception 'STAFF_CUSTOM_ANSWERS_NOT_OFF';
  end if;
  perform public.staff_update_registration_with_pickup(v_actor, v_id, 'Staff custom verification', v_district,
    v_choices, v_yes_hosting, 'general', '{"status": "yes", "count": 1}');
  if public.registration_hosting_get(v_id)->>'status' <> 'hosting' then raise exception 'STAFF_GENERAL_ANSWER_NOT_SAVED'; end if;
  perform public.staff_update_registration_with_pickup(v_actor, v_id, 'Staff custom verification', v_district,
    v_choices, v_yes_hosting, 'student');
  if public.registration_hosting_get(v_id) is distinct from v_no_hosting then raise exception 'STAFF_STUDENT_ANSWERS_NOT_OFF'; end if;

  -- The setting does not leak into the next save in the same transaction.
  if public.registration_skipping_hosting() then raise exception 'SKIP_SETTING_LEFT_ON'; end if;
end;
$$;
rollback;
