-- 2026-11-15: changing a registration to an identity a survey is not open to stores 否 for a valid
-- answer of that survey, even when the old identity could not answer it either. Before, a 學生 changed
-- to 兒童（國小） kept its pickup answer, since 學生 could not answer pickup either; staff saving the
-- same change stored 否. A survey with no valid answer, from an identity never asked, stays unanswered.
-- Decisions are in docs/需求討論與決策紀錄.md, section
-- "換成不能填的身分時接待答案一律存「否」" Q22. Only later saves change; stored answers are untouched.
-- Deploy the site with it: the public page shows the 否 before saving.
begin;
create or replace function public.save_registration_surveys(p_actor uuid,p_id uuid,p_request uuid,p_full_name text,
  p_district integer,p_choices jsonb,p_hosting jsonb,p_identity text,p_pickup jsonb,p_child_type text,p_parent text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare r public.registrations; s public.site_settings; new_id uuid; new_serial bigint;
  identity_code text; v_child_type text; v_parent_name text; kind text; before_answer jsonb; after_answer jsonb;
  payload jsonb; allowed boolean; opened boolean; leaving boolean; changed boolean; was_valid boolean; valid boolean;
  actor_type text := case when p_actor is null then 'public' else 'staff' end;
begin
  select * into strict s from public.site_settings where id for share;
  if p_actor is not null then perform public.staff_assert_actor(p_actor,false); end if;
  -- Closed public operations must fail alike before looking up a name.
  if p_actor is null and p_request is null then
    if not s.is_registration_open or (s.registration_deadline_at is not null and s.registration_deadline_at<=now()) then
      raise exception using errcode='P0001',message='REGISTRATION_CLOSED';
    end if;
    if not s.is_lookup_open then raise exception using errcode='P0001',message='LOOKUP_CLOSED'; end if;
  end if;
  if p_request is null then
    if p_actor is null then
      select * into r from public.registrations where full_name is not null and district_id=p_district
        and name_key=public.registration_name_key(p_full_name) and record_status='active' for update;
    else
      select * into r from public.registrations where id=p_id and record_status='active' for update;
    end if;
    if r.id is null then return null; end if;
  elsif p_identity is null then
    raise exception using errcode='P0001',message='MEAL_IDENTITY_REQUIRED';
  end if;
  identity_code := coalesce(p_identity,r.meal_identity,'general');
  v_child_type := case identity_code when 'child' then 'elementary' when 'preschool' then 'preschool' end;
  if v_child_type is not null then
    v_parent_name := public.registration_parent_name(true,case when p_parent is null and r.child_type is not null then r.parent_name else p_parent end);
  end if;
  perform set_config('registration.saving_child',coalesce(v_child_type,''),true);
  perform set_config('registration.staff_identity',case when p_actor is null then '' else 'on' end,true);
  perform set_config('registration.surveys_managed','on',true);
  if p_request is not null then
    if p_actor is null then
      select registration_id,serial_no into new_id,new_serial from public.create_registration(p_request,p_full_name,p_district,p_choices,null,identity_code);
    else
      select registration_id,serial_no into new_id,new_serial from public.staff_create_registration(p_actor,p_request,p_full_name,p_district,p_choices,null,identity_code);
    end if;
  else
    new_id:=r.id;
    if not (case when p_actor is null then public.update_registration(p_full_name,p_district,p_choices,null,identity_code)
      else public.staff_update_registration(p_actor,new_id,p_full_name,p_district,p_choices,null,identity_code) end) then
      -- The flags must not leak into a later save in the same transaction.
      perform set_config('registration.surveys_managed','',true);
      perform set_config('registration.saving_child','',true);
      perform set_config('registration.staff_identity','',true);
      return null;
    end if;
  end if;
  if (r.child_type,r.parent_name) is distinct from (v_child_type,v_parent_name) then
    update public.registrations set is_child=v_child_type is not null,child_type=v_child_type,
      parent_name=v_parent_name,updated_at=now() where id=new_id;
    insert into public.audit_events(actor_type,actor_user_id,action,target_type,target_id,before_data,after_data)
      values(actor_type,p_actor,'registration.child_updated','registration',new_id,
        jsonb_build_object('is_child',coalesce(r.is_child,false),'child_type',r.child_type,'parent_name',r.parent_name),
        jsonb_build_object('is_child',v_child_type is not null,'child_type',v_child_type,'parent_name',v_parent_name));
  end if;
  foreach kind in array array['hosting','pickup'] loop
    before_answer:=case kind when 'hosting' then public.registration_hosting_get(new_id) else public.registration_pickup_get(new_id) end;
    was_valid:=before_answer is not null and coalesce((before_answer->>'answer_valid')::boolean,true);
    valid:=was_valid;
    payload:=case kind when 'hosting' then p_hosting else p_pickup end;
    allowed:=public.survey_identity_allowed(kind,identity_code);
    opened:=case kind when 'hosting' then s.is_hosting_open else s.is_pickup_open end;
    -- Saving a change to an identity this survey is not open to stores 否 (decided 2026-11-11). When
    -- the old identity could not answer it either, only a valid answer becomes 否: an invalidated one
    -- counts as unanswered, so no 否 appears for someone never asked (2026-11-15). Staff saving a
    -- survey closed or not open to the identity also stores 否 (decided 2026-11-12). Whatever the page
    -- sent for this survey is then ignored. A missing identity counts as general, so choosing general
    -- is no change.
    leaving:=p_request is null and coalesce(r.meal_identity,'general') is distinct from identity_code and not allowed
      and (public.survey_identity_allowed(kind,r.meal_identity) or was_valid);
    if leaving or (p_actor is not null and (not allowed or not opened)) then
      payload:=case kind when 'hosting' then '{"status":"not_hosting"}'::jsonb else '{"status":"no","count":0}'::jsonb end;
    end if;
    if payload='{"reset":true}'::jsonb and p_request is null then
      -- A public page may only reset a survey its identity can answer.
      if p_actor is not null or allowed then valid:=false; end if;
      after_answer:=null;
      if p_actor is null and allowed and opened then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
    else
      if kind='hosting' and jsonb_typeof(payload)='object' and payload->>'pickup_count' is null then
        payload:=payload||jsonb_build_object('pickup_count',coalesce(before_answer->'pickup_count','0'::jsonb));
      end if;
      after_answer:=case when kind='hosting' then public.registration_hosting_value(payload) else public.registration_pickup_value(payload) end;
    end if;
    if p_actor is null and (not allowed or not opened) and not leaving then
      if after_answer is not null and after_answer is distinct from
        (case kind when 'hosting' then public.registration_hosting_value(before_answer) else public.registration_pickup_value(before_answer) end) then
        raise exception using errcode='P0001',message=upper(kind)||case when not allowed then '_NOT_ALLOWED' else '_CLOSED' end;
      end if;
      -- Changing configuration alone neither changes nor invalidates answers.
      after_answer:=before_answer;
    else
      if p_actor is null and allowed and opened and not was_valid and after_answer is null then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
      if p_request is not null and allowed and opened and after_answer is null then
        raise exception using errcode='P0001',message=upper(kind)||'_REQUIRED';
      end if;
      if after_answer is not null then
        valid:=true;
        if kind='hosting' then perform public.registration_hosting_put(new_id,after_answer);
        else perform public.registration_pickup_put(new_id,after_answer); end if;
      else
        after_answer:=before_answer;
      end if;
    end if;
    if kind='hosting' then update public.registration_hosting set answer_valid=valid where registration_id=new_id;
    else update public.registration_pickup set answer_valid=valid where registration_id=new_id; end if;
    changed := (before_answer-'answer_valid') is distinct from (after_answer-'answer_valid') or was_valid is distinct from valid;
    if changed then
      update public.registrations set updated_at=now(),import_status=case when import_status='imported' then 'reimport_needed' else import_status end where id=new_id;
      insert into public.audit_events(actor_type,actor_user_id,action,target_type,target_id,before_data,after_data)
        values(actor_type,p_actor,'registration.'||kind||'_updated','registration',new_id,
          jsonb_build_object(kind,before_answer,'answer_valid',was_valid),jsonb_build_object(kind,after_answer,'answer_valid',valid));
    end if;
  end loop;
  if not public.survey_audience_valid(identity_code,p_choices,public.registration_hosting_get(new_id),public.registration_pickup_get(new_id)) then
    raise exception using errcode='P0001',message='AUDIENCE_RESTRICTED';
  end if;
  perform set_config('registration.surveys_managed','',true);
  perform set_config('registration.saving_child','',true);
  perform set_config('registration.staff_identity','',true);
  return new_id;
end;
$$;
revoke all on function public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.save_registration_surveys(uuid,uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text) to service_role;
commit;
