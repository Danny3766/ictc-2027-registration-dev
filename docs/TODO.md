# ICTC 2027 登記系統 TODO

> 更新日期：2026-11-27。已完成並發布的項目已刪除，過程與結果見 [驗收紀錄](驗收紀錄.md)、[需求討論與決策紀錄](需求討論與決策紀錄.md) 與 git 歷史。

## 目前狀態

| 環境 | 前端 | 資料庫 migration | Edge Function |
| --- | --- | --- | --- |
| 正式站 | `main`，PR #73（2026-11-27） | 套用至 `202611270001`（2026-11-27） | `registration`、`staff` 為 2026-11-26 版（`develop` 的 `333773a`） |
| 測試站 | `develop`，PR #78（2026-11-27） | 確定套用至 `202611100004`（2026-11-10）；`202611110001`～`202611110004` 未記錄；`202611240001` 已套用（日期未記錄）；`202611270001` 已套用（2026-11-27） | `staff` 已部署 PR #71 之後的版本（日期未記錄） |

PR #73 已把 PR #70～#72 發布到正式站，`main` 與 `develop` 的內容相同。結果見[驗收紀錄](驗收紀錄.md)「2026-11-27 正式站發布」。

## 待處理：後台名單分頁（2026-11-23 審查延後項目）

- [ ] 多位服事者同時處理篩選名單時，名單 offset 可能超過最新總筆數。依 PostgREST 的規則，要求精確筆數且 offset 大於總筆數時回 416，`staff` function 會轉成 503，前端的空頁退回因此不會執行。修正方向：後端遇到這個錯誤時改回空陣列與最新筆數。這是既有後端問題，改完要在測試站確認行為並重新部署 `staff` function。目前 E2E 用假資料模擬「超出範圍回 200 空陣列」，和正式環境的 503 不同，後端修好前不能當成這個情況的驗證。

## 進行中：活動改時間不觸發重新匯入（`fix/activity-time-no-reimport`）

只需套用 migration，前端與 Edge Function 不需重新部署。決策與驗證見[大會匯入狀態驗證](大會匯入狀態驗證.md)。

- [x] 測試站：套用 `202611270001`，執行 `verify-conference-import-status.sql`（2026-11-27）。
- [x] 正式站：套用 `202611270001`（2026-11-27）。

## 進行中：活動限定對象的人數檢查

- [x] 正式站：套用 `202611240001`，部署 `staff`、`registration`，隨 PR #73 發布前端（2026-11-27）。
- [x] 正式站後台驗收：調整活動報名對象時顯示不符人數的提示；匯出報名 CSV 期間頁面可操作、格式不變。
- [x] 測試站：套用 `202611240001`。
- [x] 測試站：執行對應 verify 腳本並部署 `staff` Edge Function。

## 進行中：正式站發布時保留既有登記資料（`fix/preserve-prod-registrations`）

決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-14 正式站發布時保留既有登記資料」。

- [x] 從 `develop` 建立分支，先記錄決策與文件。
- [x] `202611090002`：回填只處理兒童，沒有身分的登記保留空白（Q7）。
- [x] `202611100004`：刪除改寫既有登記接待答案的區塊（Q8）。
- [x] `202611110003`：回填拿掉「非一般身分一律標為無效」的條件，只依審計紀錄判斷系統自動產生的「否」（Q8）。審計紀錄的判斷也拿掉「儲存時身分不是一般」：`main` 的舊版儲存同樣在審計紀錄寫入身分，學生本人選的「否」會被誤判；現在只認 `registration.child_updated`、`registration.hosting_general_only` 兩種系統動作，這兩種在正式站都不存在。
- [x] 新增 `202611140001_student_identity_reserved.sql`：學生加入保留規則與刪除保護（Q11、Q12）。本機從 `main` 結構重播到此支：停用、改僅後台、刪除學生都被擋下，可改名，仍可指定為學生統計身分。`verify-unified-identity.sql` 原本停用學生來測「停用身分仍算已使用」，改用測試用的自訂身分；身分相關 7 支 verify 腳本在本機通過。
- [x] 後台：學生不顯示刪除、不能改啟用與開放選擇；「學生統計身分」仍可選學生；更新提示文字。`tests/staff.spec.mjs`「admins manage meal identities…」補學生的檢查，身分相關 6 個測試在桌機／手機 Chromium 與 WebKit 共 24 項通過。
- [x] 前端：沒有身分的登記在公開查詢結果與後台詳情不再預選「一般」，修改時必須選身分才能儲存（Q19、Q20）。只查看時接待答案照舊視為一般身分顯示；公開頁修改中還沒選身分時，接待答案以唯讀文字顯示。`read-only.spec.mjs`、`staff.spec.mjs` 各補一項，換回舊版程式兩項都會失敗；兩項都先開一筆有身分的登記，確認下一筆沒有身分時不沿用前一筆的選項（`Meals.renderIdentity()` 收到 `null` 會清空，省略才保留目前選項）；原本沒有身分、靠預選一般的測試假資料改成帶一般。完整測試四個瀏覽器 602 項通過、22 項略過、沒有失敗（Chromium 與 WebKit 分兩批執行）；先前整批執行時「the 身分別 checklist filters…」偶有版面量測失敗（既有現象），這次沒有出現。
- [x] 本機隔離資料庫從 `main` 的結構重播全部 13 支新 migration（到 `202611140001`），用虛構舊登記比對：登記、活動回覆、開家、接機的欄位與審計筆數都沒變，接待答案全部有效。再照部署後設定（開家可填一般與學生、接機只有一般、學生統計身分指定學生）取統計：沒有身分的登記照常列入人數，開家答案算一般身分的答案；學生的接機答案仍有效，計入接機統計與 CSV，與[接待身分設定](接待身分設定.md)「取消身分資格保留原答案」一致。`main` 沒有兒童欄位，正式站沒有兒童登記，`202611090002` 的兒童回填在正式站不會改到資料。沒有身分的登記在公開修改與後台的行為見上一項，CSV 由既有 Playwright 案例涵蓋。
- [x] 準備正式站唯讀查詢：發布前後比對 `supabase/testing/compare-preserved-registrations.sql`（Q4），只輸出筆數與 md5，並在檔頭附發布後確認沒有無效接待答案的查詢；學生接待答案預覽沿用 `preview-hosting-general-only.sql`（Q2）；測試站套用前的檢查寫在 `202611140001` 檔頭。本機重播驗證：比對查詢在 `main` 結構與新結構都能執行，新版前後結果相同；換成舊版 migration 時，身分、匯入狀態、開家、接機與審計筆數的差異都會出現。
- [x] 送 PR 至 `develop`（2026-11-15 PR #61 完成），隨 PR #64 發布到正式站。
- [ ] 測試站先執行 `202611140001` 檔頭的檢查查詢，學生為啟用且開放選擇才套用，再部署 `staff` Edge Function（學生統計身分的錯誤訊息改成「不是一般或兒童」，因為學生成為保留身分後仍可指定）。前端已發布。

## 進行中：換成不能填的身分時接待答案一律存「否」（`fix/child-switch-pickup-no`）

決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-15 換成不能填的身分時接待答案一律存『否』」。

- [x] 從 `develop` 建立分支，先記錄決策與文件。
- [x] 新增 `202611150001_identity_change_survey_no.sql`：儲存函式判斷「離開」時不再要求原身分能填（Q22）；原身分也不能填時，只有有效答案才改成否，沒有答案或失效答案維持未回答。
- [x] 公開頁 `editLeaves()` 同步修改，存檔前顯示接機也會變成「否」。`survey-identities.spec.mjs`、`verify-survey-identities.sql` 各補學生改兒童的案例，換回舊版都會失敗。
- [x] 審查修正：失效答案（例如舊系統自動否）視同未回答，換身分不會變成有效的否；沒有身分的舊登記選一般不算換身分。`verify-survey-identities.sql` 補這兩個案例、`survey-identities.spec.mjs` 補失效答案案例，換回修正前都會失敗。完整測試四個瀏覽器 610 項通過、22 項略過。
- [x] 本機從 `main` 結構重播到 `202611150001`：`compare-preserved-registrations.sql` 前後結果相同（審查修正只改函式內容，不動資料）；16 支 verify 腳本全部通過。
- [x] 送 PR 至 `develop`（2026-11-15 PR #62 完成），隨 PR #64 發布到正式站。
- [ ] 測試站套用 `202611150001`，用已重現的那筆登記驗收。前端已發布。

## 測試站：補齊部署並驗收

前端已更新到 PR #65（2026-11-16）；以下確認後端跟上。

- [ ] 名單身分篩選與學生統計（PR #57）：依序套用 `202611130001_student_statistics_identity.sql` → `verify-student-statistics-identity.sql` → staff Edge Function。驗收名單身分篩選（含 PostgREST 篩選）與學生統計，再由管理員指定學生統計身分；首次部署不自動指定。staff Edge Function 更新前，舊版會忽略名單身分篩選並回傳整份名單，不要據此驗收。本機驗證結果見[用餐身分管理](用餐身分管理.md)「指定學生身分統計」「名單身分篩選」。
- [ ] 確認測試專案已依序套用 `202611110001_staff_performance.sql`、`202611110002_conference_import_status.sql`、`202611110003_survey_identities.sql`、`202611110004_identity_reorder.sql`，並部署 `develop` 上的 `registration`、`staff` Edge Function；未套用的依序補上。`202611110003` 前先關閉登記，完成後恢復原開放狀態；若這支還沒套用，非一般身分在 `202611100004` 之後儲存時被改成的開家「否」，部分會維持有效（只影響測試資料）。每支套用後執行對應的 `verify-staff-performance.sql`、`verify-conference-import-status.sql`、`verify-survey-identities.sql`、`verify-identity-reorder.sql`。結果記在[驗收紀錄](驗收紀錄.md)。
- [ ] 在測試專案執行尚未留紀錄的驗證腳本：`verify-child-registration.sql`、`verify-child-type.sql`、`verify-registration-identities.sql`、`verify-independent-identity-prices.sql`、`verify-unified-identity.sql`。
- [ ] 請專案負責人與弟兄們驗收 PR #43～#60 的功能，各項細節見對應文件：
  - 兒童報名、兒童類型與親子對應、名單兒童條件：[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-09 兒童報名」「兒童類型」。
  - 身分別管理、各身分價格、統一身分別、身分標籤、拖拉排序：[用餐身分管理](用餐身分管理.md)。
  - 接待題依身分開放、藍色提醒區塊、查詢結果外框：[接待身分設定](接待身分設定.md)。
  - 活動影響大會匯入狀態：[大會匯入狀態驗證](大會匯入狀態驗證.md)。
  - 後台效能與身分別區塊、公開表單缺漏欄位提示。
  - 名單身分篩選、指定學生身分統計（PR #57，後端部署後驗收）：[用餐身分管理](用餐身分管理.md)。
  - 公開查詢頁修改時鎖定查詢欄位、漏選活動紅框（PR #58）：[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-13 公開查詢頁修改時鎖定查詢欄位」「2026-11-13 公開頁漏選活動的紅框提示」。
  - 免費身分的費用文字（PR #59）、後台登記詳情的唯讀樣式（PR #60）：[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-14 免費身分的費用文字」「2026-11-14 後台登記詳情的唯讀樣式」。
- [ ] 確認兒童類型標籤色碼（學齡前粉色底、國小粉藍底）。

## 正式站：2026-11-15 發布（PR #64）

含 migration，依[正式環境設定流程](正式環境setup.md) 9-3 關閉登記後更新。結果見[驗收紀錄](驗收紀錄.md)「2026-11-15 正式站發布」。

- [x] 依 9-3 關閉登記，通知服事者。
- [x] 留底：後台下載報名登記 CSV 與統計 CSV，執行 `supabase/testing/compare-preserved-registrations.sql` 並記下結果（只有筆數與 md5，不含姓名）。結果留在本機，[驗收紀錄](驗收紀錄.md)只寫兩次是否相同，不寫筆數。
- [x] 正式專案在 SQL Editor 執行一次合併檔 `supabase/production/release_202611150001.sql`，內容是 `202611090001`～`202611150001` 共 14 支 migration 包成單一交易，在[正式環境設定流程](正式環境setup.md)第 3 節記一列。失敗時整份回滾，停下來並保持關閉登記。合併檔已在本機從 `main` 結構驗證：套用後的結構與資料和逐支套用完全相同，既有登記不變。
- [ ] 執行 `supabase/testing/preview-hosting-general-only.sql`（唯讀；`main` 的結構沒有它用到的 `is_child` 與 `registration_identities`，所以排在套用 migration 之後），請專案負責人確認學生身分登記的接待答案，並認出其實是國小或學齡前的學生，這些登記改成兒童後開家、接機會變成「否」（2026-11-15 Q24）。結果含個資，不貼到 repo、PR 或對話。
- [x] 部署 `registration` 與 `staff` Edge Function，Verify JWT 依第 5 節設定。
- [x] 以 **Create a merge commit** 合併 `develop` → `main`，依 7-4 核對，結果記在[驗收紀錄](驗收紀錄.md)。
- [ ] 執行第 8 節的 8-1、8-2 查詢（8-1 在重新開放登記前，`is_registration_open` 應為 `false`）。
- [x] 再執行一次 `compare-preserved-registrations.sql`，兩次結果相同才繼續；再執行檔頭的無效接待答案查詢，兩個數字都要是 0。
- [x] 管理員在正式站後台：把 `general` 改名「聖徒」、開家接待可填身分加入學生（接機維持只有聖徒）；另新增公開可選的「親友」身分並設定價格。
- [ ] 學生統計身分指定學生，確認「其中學生」人數。
- [ ] 重新開放登記，通知服事者維護結束。
- [ ] 在 LINE 群組公告（2026-11-15 已定稿）：用餐身分改為表單上方的身分別、一般改名聖徒；之前用孩子名字登記的家庭改成兒童類型並填家長姓名（家長本人登記時的姓名，或特會期間聯絡得上的家長姓名），孩子與家長同區，區不同請聯絡服事者；身分別空白時修改前先選；福音朋友或親友改為「親友」。

## 上線前移除的多餘程式碼與欄位

各項都用新 migration 處理，先在測試專案驗證，再隨正式站發布。

- [ ] 刪除 `registration_hosting.family_count`、`note`、約束 `registration_hosting_removed_fields`，以及 `registration_hosting.pickup_count`。執行前確認兩站的 Edge Function 都已是不讀這些欄位的版本。
- [ ] 移除已無呼叫者的舊接待流程：`registration_audience_valid`（兩個多載）、`registration_skipping_hosting`、`registration_child_save`、`registration_child_answers_put`，以及 `create_registration`、`update_registration`、`staff_create_registration`、`staff_update_registration` 中 `registration.surveys_managed` 未開啟時的接待分支（該分支比對的 `registration_hosting_get` 已多帶 `answer_valid`）；`staff_save_reception_settings` 可改由 staff Edge Function 直接呼叫 `staff_save_reference`。
- [ ] 由專案負責人判斷尖峰已過後，把同一來源限流調回 60，同步更新 `verify-all-no-and-rate-limit.sql` 與 9-3 的唯讀查詢。

## 待決定

- [ ] 公開頁未儲存時切出再切回接待題，要維持清空重答，還是改成不動答案並移除 `reset` 標記；見[接待身分設定](接待身分設定.md)「待決定」第 1 項。
- [ ] 身分加進某題可填清單時，是否比照活動報名對象先提醒受影響人數；見[接待身分設定](接待身分設定.md)「待決定」第 2 項。
- [ ] 確認大會系統欄位後，評估用餐身分變更是否要改為「需重新匯入」。

## 正式環境維運

- [ ] 訂出備份的頻率與存放位置，並演練一次還原。
- [ ] 依方案限制定期開啟正式站或後台，避免專案因閒置暫停；發現暫停就到 Dashboard 恢復。
- [ ] 用 iPhone、iPad 或 Mac 的實際 Safari 完成正式站 smoke test。
- [ ] 在能直連 Supabase 的網路重跑 `rls.spec.mjs`，確認 RLS 允許與拒絕案例。
- [ ] 補記上線前必驗、但[驗收紀錄](驗收紀錄.md)沒有結果的帳號、限速與權限項目；清單在維護者本機的稽核紀錄，不寫進 repo。
- [ ] 測試資料清理：清除前確認環境、資料表與筆數，先備份並取得人工確認，保留活動、區與系統設定。

## 後台改善

- [ ] 取消公開活動前提示受影響的登記人數（[系統架構規劃](系統架構規劃.md)第 4 節）。
- [ ] 為 `staff` Edge Function 的改名同步登入識別、設定密碼流程補上注入假 Supabase client 的單元測試。
- [ ] 評估改用不會變的內部識別作為 Auth 登入 email，改名時只更新 `staff_profiles`。

## 可延後項目

- 後台離開前提醒：有未儲存的修改時，重新整理或關閉分頁前先確認；需判斷 8 個功能區塊的表單是否改過，另開功能分支。
- 後台左側選單：原 `feat/admin-sidebar-layout` 分支已不存在，要做時重新開分支。
- Cloudflare Turnstile：以公開設定提供 site key、伺服端 secret 驗證 token，用新 migration 調整防護；測試與正式環境分開設定。未完成前不讓公開流程依賴 Turnstile。
- GitHub Actions 完整 CI。
- 進階 rate limiting 服務。
- 後台統計的匯入狀態人數（待匯入、已匯入、需重新匯入）：大會匯入流程確定後再做。

## 分支與部署流程

`feat/*` 從 `develop` 建立 → PR 進 `develop` → 測試站驗收 → PR 進 `main`（**Create a merge commit**）。只有 `main` 部署正式站；測試站是獨立網址。細節見[正式環境設定流程](正式環境setup.md)第 9 節。

## 已定案摘要

- 靜態 HTML、CSS、原生 JavaScript，runtime 無 build step；npm 只負責開發工具、測試與本機伺服器。
- 開發／測試與正式環境使用不同 Supabase 專案；資料庫遷移以版本控制管理，依核准的部署程序套用。
- 公開操作經 Edge Function；狀態轉換使用受控 RPC／服務端流程。
- 手機優先，測近期 Chrome、Edge 與 Safari；不設 WCAG 驗收項目。
