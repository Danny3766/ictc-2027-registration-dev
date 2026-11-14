-- 2026-11-14: 學生 (code student) becomes reserved like 一般 and both 兒童 identities: it cannot be
-- deleted, deactivated or made staff-only; only its name and badge change. It stays selectable as the
-- 學生統計身分 (202611130001 already excludes only general/child/preschool). Decisions are in
-- docs/需求討論與決策紀錄.md, section "正式站發布時保留既有登記資料" Q11, Q12.
-- Adding the constraint fails, and nothing is applied, if 學生 is inactive or staff-only. Check first;
-- the row must show is_active and public_selectable both true (no row: 學生 was deleted, nothing to check):
--   select code, name, is_active, public_selectable from public.registration_identities where code = 'student';
begin;
alter table public.registration_identities drop constraint registration_identities_reserved;
alter table public.registration_identities add constraint registration_identities_reserved check
  (code not in ('general','student','child','preschool') or (is_active and public_selectable));
create or replace function public.registration_identity_delete_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.code in ('general','student','child','preschool') then
    raise exception using errcode = '22023', message = 'IDENTITY_IN_USE';
  end if;
  return old;
end;
$$;
commit;
