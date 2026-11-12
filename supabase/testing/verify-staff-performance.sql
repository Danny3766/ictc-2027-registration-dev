-- Local/test database only. All fixtures are rolled back.
begin;
do $$
declare actor uuid; district integer; meal bigint; prerequisite bigint; ids uuid[] := '{}';
  result jsonb; before_count bigint; before_no_identity bigint; n integer; fixture_id uuid; v_identity text; v_type text;
  parent text := 'Perf parent '||substr(gen_random_uuid()::text,1,6);
begin
  if not coalesce((select is_test_environment from public.site_settings where id), false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
  -- The fixtures expect only 一般 to answer the surveys; rolled back with everything else.
  update public.site_settings set hosting_identity_codes=array['general'], pickup_identity_codes=array['general'] where id;
  select auth_user_id into strict actor from public.staff_profiles
    where is_active and not must_change_password order by auth_user_id limit 1;
  select id into strict district from public.districts order by sort_order limit 1;
  result := public.staff_registration_statistics(actor);
  select coalesce(sum((x->>'count')::bigint),0) into before_count from jsonb_array_elements(result->'people') x;
  select coalesce(sum((x->>'no_identity')::bigint),0) into before_no_identity from jsonb_array_elements(result->'people') x;
  insert into public.activities(category,title,is_published,sort_order,audience,fee_amount)
    values ('meal','Performance prerequisite',true,9998,'all',null) returning id into prerequisite;
  insert into public.activities(category,title,is_published,sort_order,audience,fee_amount)
    values ('meal','Performance meal',true,9999,'hosting',100) returning id into meal;
  for n in 1..6 loop
    v_identity := (array['general','student','preschool','child',null,'general'])[n];
    v_type := case n when 3 then 'preschool' when 4 then 'elementary' end;
    insert into public.registrations(create_request_id,full_name,district_id,meal_identity,is_child,child_type,parent_name,record_status)
      values (gen_random_uuid(),case when n=1 then parent else 'Performance fixture '||gen_random_uuid() end,district,v_identity,v_type is not null,v_type,
        case when v_type is not null then parent end,case when n=6 then 'cancelled' else 'active' end)
      returning id into fixture_id;
    ids := array_append(ids, fixture_id);
    if n <> 5 then
      insert into public.registration_choices(registration_id,activity_id,attending) values (fixture_id,meal,n<>2);
    end if;
    if n=5 then
      insert into public.registration_choices(registration_id,activity_id,attending) values (fixture_id,prerequisite,true);
    end if;
    insert into public.registration_hosting(registration_id,status,guest_type,guest_count)
      values (fixture_id,case when n=1 then 'hosting' else 'not_hosting' end,
        case when n=1 then 'any' end,case when n=1 then 4 end);
    insert into public.registration_pickup(registration_id,status,count)
      values (fixture_id,case when n=1 then 'yes' else 'no' end,case when n=1 then 3 else 0 end);
  end loop;
  result := public.staff_registration_statistics(actor);
  if (select sum((x->>'count')::bigint) from jsonb_array_elements(result->'people') x) <> before_count+5 then
    raise exception 'ACTIVE_TOTAL_MISMATCH';
  end if;
  if (select sum((x->>'no_identity')::bigint) from jsonb_array_elements(result->'people') x) <> before_no_identity+1 then
    raise exception 'UNANSWERED_IDENTITY_MISMATCH';
  end if;
  if (select sum((x->>'count')::bigint) from jsonb_array_elements(result->'choices') x
      where (x->>'activity_id')::bigint=meal and (x->>'attending')::boolean) <> 3 then
    raise exception 'ATTENDANCE_MISMATCH';
  end if;
  if (select sum((x->>'count')::bigint) from jsonb_array_elements(result->'choices') x
      where (x->>'activity_id')::bigint=meal and x->>'child_type' in ('preschool','elementary')) <> 2 then
    raise exception 'CHILD_TYPES_MISMATCH';
  end if;
  if exists(select 1 from jsonb_array_elements(result->'choices') x
      where (x->>'activity_id')::bigint=meal and not (x->>'eligible')::boolean) then
    raise exception 'HOSTING_ELIGIBILITY_MISMATCH';
  end if;
  update public.registration_hosting set status='not_hosting',guest_type=null,guest_count=null where registration_id=ids[1];
  result := public.staff_registration_statistics(actor);
  if (select sum((x->>'count')::bigint) from jsonb_array_elements(result->'choices') x
      where (x->>'activity_id')::bigint=meal and not (x->>'eligible')::boolean) <> 1 then
    raise exception 'HOSTING_RESTRICTION_MISMATCH';
  end if;
  update public.activities set audience='pickup' where id=meal;
  result := public.staff_registration_statistics(actor);
  if exists(select 1 from jsonb_array_elements(result->'choices') x
      where (x->>'activity_id')::bigint=meal and not (x->>'eligible')::boolean) then
    raise exception 'PICKUP_ELIGIBILITY_MISMATCH';
  end if;
  update public.activities set audience='activity:'||prerequisite where id=meal;
  result := public.staff_registration_statistics(actor);
  if exists(select 1 from jsonb_array_elements(result->'choices') x
      where (x->>'activity_id')::bigint=meal and (x->>'eligible')::boolean) then
    raise exception 'PREREQUISITE_MISMATCH';
  end if;
  result := public.staff_registration_detail(actor,ids[1]);
  if result->>'id' <> ids[1]::text or result ? 'create_request_id' or result ? 'name_key'
    or result->'registration_choices' is null then raise exception 'DETAIL_MISMATCH'; end if;
  if jsonb_array_length(result->'children') <> 2 or result->'children'->0->>'full_name' is null then
    raise exception 'FAMILY_DETAIL_MISMATCH';
  end if;
  result := public.staff_update_registration_result(actor,ids[1],result->>'full_name',district,
    jsonb_build_array(jsonb_build_object('activity_id',meal,'attending',false)),
    null,'student');
  if result->>'meal_identity' <> 'student' or result->'registration_hosting'->>'status' <> 'not_hosting' then
    raise exception 'SAVED_DETAIL_MISMATCH';
  end if;
  update public.staff_profiles set is_active=false where auth_user_id=actor;
  begin
    perform public.staff_registration_statistics(actor);
    raise exception 'INACTIVE_ACTOR_ACCEPTED';
  exception when insufficient_privilege then null;
  end;
  if has_function_privilege('anon','public.staff_registration_statistics(uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.staff_registration_statistics(uuid)','EXECUTE') then
    raise exception 'STATISTICS_PUBLICLY_EXECUTABLE';
  end if;
  raise notice 'staff performance assertions passed';
end;
$$;
rollback;
