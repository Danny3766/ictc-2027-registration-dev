-- A separate, optional statistics source per environment. No old identity is selected automatically.
begin;

alter table public.site_settings add column student_statistics_identity_code text
  references public.registration_identities(code);

alter function public.staff_save_reference(uuid,text,jsonb) rename to staff_save_reference_before_student_statistics;
create function public.staff_save_reference(p_actor uuid,p_kind text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_before text; v_code text; v_after jsonb;
begin
  perform public.staff_assert_actor(p_actor,true);
  if p_kind='delete_identity' then
    perform 1 from public.site_settings where id for update;
    if exists(select 1 from public.site_settings where id and student_statistics_identity_code=p_data->>'code') then
      raise exception using errcode='22023',message='IDENTITY_IN_STUDENT_STATISTICS';
    end if;
  end if;
  if p_kind<>'student_statistics_identity' then
    return public.staff_save_reference_before_student_statistics(p_actor,p_kind,p_data);
  end if;
  if not (p_data ? 'code') or jsonb_typeof(p_data->'code') not in ('string','null') then
    raise exception using errcode='22023',message='INVALID_STUDENT_STATISTICS_IDENTITY';
  end if;
  v_code := p_data->>'code';
  select student_statistics_identity_code into v_before from public.site_settings where id for update;
  if v_code is not null and not exists (
    select 1 from public.registration_identities
    where code=v_code and (is_active or code=v_before)
      and code not in ('general','child','preschool') for share
  ) then
    raise exception using errcode='22023',message='INVALID_STUDENT_STATISTICS_IDENTITY';
  end if;
  update public.site_settings set student_statistics_identity_code=v_code,
    updated_at=case when student_statistics_identity_code is distinct from v_code then now() else updated_at end
  where id returning to_jsonb(site_settings.*) into v_after;
  if v_before is distinct from v_code then
    insert into public.audit_events(actor_type,actor_user_id,action,target_type,before_data,after_data)
    values('admin',p_actor,'reference.saved','student_statistics_identity',
      jsonb_build_object('code',v_before),jsonb_build_object('code',v_code));
  end if;
  return v_after;
end;
$$;
revoke all on function public.staff_save_reference(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.staff_save_reference(uuid,text,jsonb) to service_role;

commit;
