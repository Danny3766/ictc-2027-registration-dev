-- 2026-11-09: 各身分價格獨立. Rules are in docs/用餐身分管理.md, section "空白價格與合計".
-- Apply right after 202611090002; no Edge Function change. Every identity is priced on its own: a blank
-- price is unset, never the general price, so a student price no longer needs a general one.
begin;
alter table public.activities drop constraint if exists activities_student_fee_needs_fee;
commit;
