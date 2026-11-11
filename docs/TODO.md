# ICTC 2027 登記系統 TODO

## 身分別拖拉排序（2026-11-11）

- [x] 從 `develop` 建立 `feat/identity-drag-sort`，在修改程式前記錄 Q1、Q2 與實作安排，見 [需求討論與決策紀錄](需求討論與決策紀錄.md)「身分別拖拉排序」及 [用餐身分管理](用餐身分管理.md)。
- [x] 比照活動提供排序模式、拖拉／觸控／鍵盤操作、完成儲存與取消還原；全部身分可移動。
- [x] 補管理員批次儲存排序的 API／資料庫操作，沿用排序欄位，檢查權限與清單完整性並寫審計。
- [x] 驗證前台身分選單同步、重載保留、取消、失敗與清單變更；確認身分保護及公開選擇規則不變。驗證結果見 [用餐身分管理](用餐身分管理.md)「身分別拖拉排序」。
- [x] 記錄驗證結果與部署順序。
- [ ] 測試站部署：`202611110004_identity_reorder.sql` → staff Edge Function → 前端；驗收後另行發布正式站。目前兩站均未部署。

## 接待調查依身分開放（2026-11-11）

- [x] 記錄 Q1～Q16，沿用目前分支，見 [接待身分設定](接待身分設定.md)。
- [x] 實作資料庫、API、後台設定、公開與代填流程、有效答案及統計匯出。
- [x] 驗證 SQL、單元測試與跨瀏覽器流程，結果與部署順序見 [接待身分設定](接待身分設定.md)。
- [ ] 遠端測試站：關閉登記 → `202611110003_survey_identities.sql` → registration 與 staff Edge Functions → 前端 → 驗收後恢復原開放狀態。
- [ ] 待決定：公開頁未儲存的切出再切回，要維持清空重答，還是改成不動答案並移除 `reset` 標記；見 [接待身分設定](接待身分設定.md)「待決定」第 1 項。
- [ ] 待決定：身分加進某題可填清單時，是否比照活動報名對象先提醒受影響人數；見 [接待身分設定](接待身分設定.md)「待決定」第 2 項。
- [ ] 上線前以新 migration 移除已無呼叫者的舊接待流程：`registration_audience_valid`（兩個多載）、`registration_skipping_hosting`、`registration_child_save`、`registration_child_answers_put`，以及 `create_registration`、`update_registration`、`staff_create_registration`、`staff_update_registration` 中 `registration.surveys_managed` 未開啟時的接待分支（該分支比對的 `registration_hosting_get` 已多帶 `answer_valid`）；`staff_save_reception_settings` 可改由 staff Edge Function 直接呼叫 `staff_save_reference`。

## 大會匯入狀態調整（2026-11-11）

- [x] 從 develop 建立 `feat/conference-import-status`，先記錄討論及 Q1～Q8 決策再實作。
- [x] 活動增加匯入影響設定；回答限定勾選活動，任何身分異動觸發。
- [x] 完成 SQL 與後台回歸測試，結果見 [大會匯入狀態驗證](大會匯入狀態驗證.md)。
- [ ] 測試站部署：`202611110002_conference_import_status.sql` → staff Edge Function → 前端；不需更新 registration Edge Function。
- [ ] 測試站確認後，另行發布正式環境。

## 本次新增必要範圍：後台身分別區塊調整

2026-11-11 Q1～Q4 已確認，只改前端。分支 `style/identity-section`。規格見 [需求討論與決策紀錄](需求討論與決策紀錄.md) 同名最新章節。

- [x] 區塊標題「用餐身分」改為「身分別」。
- [x] 標籤底色選色器縮小為色塊寬度；截圖確認桌機與手機版面。
- [x] 「取消／新增」改為「取消編輯」，只在編輯時出現；編輯時儲存按鈕顯示「儲存身分（編輯：身分名稱）」。登出時一併清空身分表單，下一位登入者不會接到編輯中的狀態。
- [x] 補 Playwright：平常看不到「取消編輯」、編輯時按鈕顯示名稱、取消與存檔後回到新增模式、取消後焦點回到身分名稱、登出再登入不留編輯狀態。
- [ ] 測試站：更新前端後請專案負責人確認；正式站隨下次發布一併更新。

## 本次新增必要範圍：接待題限一般身分、提醒區塊與查詢結果版面

2026-11-10 Q1～Q13 已確認，本機實作與驗證已完成，尚未部署。規格見 [需求討論與決策紀錄](需求討論與決策紀錄.md) 同名最新章節。

- [x] 資料庫：非一般身分（學生、兒童、自訂）不回答開家／接機並存「否」，公開與後台共用；身分空值不套用。報名對象「開家接待者」「接機者」對非一般身分不設限。新增 `202611100004_hosting_general_only.sql`，含既有學生與自訂身分答案回填為「否」及每筆審計紀錄。
- [x] 新增部署前查詢 `supabase/testing/preview-hosting-general-only.sql`（只讀，列出受影響筆數與名單）及驗證 `supabase/testing/verify-hosting-general-only.sql`（測試資料回滾）。
- [x] 公開登記：身分別選「一般」才顯示接待區塊，「請選擇」與其他身分隱藏；修改時改身分比照兒童，不另外確認。
- [x] 後台協助登記與修改登記：非一般身分隱藏接待區塊；報名對象判斷同步。
- [x] 提醒區塊：兒童提醒與活動選擇說明改藍色資訊區塊（公開頁）；後台兒童提醒同步改藍色。
- [x] 查詢或修改登記：兒童提醒藍色；活動選擇說明藍色且只在修改時顯示；兩行說明改灰色區塊；查詢結果包進「登記內容」外框。
- [x] 補 Playwright（桌機、手機）：身分切換顯示接待、報名對象、提醒區塊樣式、查詢結果外框；後台截圖確認國小標籤與藍色提醒不混淆。
- [ ] 測試站：先執行 `preview-hosting-general-only.sql` 並請專案負責人確認受影響名單（結果含個資，不貼到 repo、PR 或對話），關閉登記後套用 `202611100004_hosting_general_only.sql`，執行 `verify-hosting-general-only.sql`，再部署前端（Edge Function 本次無變更）；正式站依正式環境 9-3 關閉登記後同樣先查名單再更新。
- [x] 更新過時的 7 支資料庫驗證 SQL，依 [資料庫驗證腳本維護](資料庫驗證腳本維護.md)：6 支修正保留，meal-pricing 搬移有效案例後退役至 historical；補公開／後台共 10 個接待欄位獨立觸發案例，13 支現行相關腳本完整通過並回滾。

本機驗證：隔離 PostgreSQL 套用全部 migration，`verify-hosting-general-only.sql`、`verify-unified-identity.sql`、`verify-identity-badges.sql`、`verify-independent-identity-prices.sql` 通過；回填只改既有學生與自訂身分、一般與身分空值不變並寫審計紀錄，部署前查詢在套用後為 0 筆。24 項單元測試、四種瀏覽器 Playwright 482 項通過；4 項在並行負載下偶發失敗，重跑 32 次通過；`rls.spec` 因公司網路連不到 Supabase 未驗證。測試站與正式站尚未部署。

## 本次新增必要範圍：統一身分別與統計排版

2026-11-10 Q1～Q10 已確認，本機實作與驗證已完成，尚未部署。規格見 [需求討論與決策紀錄](需求討論與決策紀錄.md) 同名最新章節及 [用餐身分管理](用餐身分管理.md)。原兒童下拉、名單篩選及統計呈現由本輪規格取代，既有兒童類型資料與家長規則繼續沿用。

- [x] 四處表單改「姓名／區／身分別」，標題與欄位上下對齊、手機可換行；新登記不論是否用餐都必填，修改保留原值。移除活動區用餐身分單選題與說明；同步檢查資料庫、Edge Function 及表單契約，確保兒童類型／家長／接待連動一致。
- [x] 動態身分選項沿用啟用及公開選擇規則，保留既有停用與非公開值；既有登記不重新分類。
- [x] 名單搜尋列改「姓名／區／身分別」，支援全部身分、一般、學生、全部兒童、國小、學齡前、自訂及有既有登記的停用身分；保留姓名／流水號、區與分頁連動。
- [x] 名單姓名旁與詳情標題加學生淡紫標籤，一般不加標籤，兒童沿用粉紅／粉藍底。
- [x] 各活動與各區的兒童總數在上，非零類型標籤在下；費用與補貼金額在上，未計入說明在下並加淺灰底。統計 CSV 保留文字分隔，個人明細兒童類型／家長姓名欄保留。
- [x] 補資料庫／Edge Function 必要驗證及桌機、手機 Playwright，涵蓋既有身分保留、無用餐仍必填、兒童切換、身分篩選、標籤、零人類型隱藏及 CSV。
- [ ] 測試站：確認已套用 `202611100001_child_type.sql`，再套用 `202611100002_unified_identity.sql`、`202611100003_identity_badges.sql`，執行 `supabase/testing/verify-unified-identity.sql`、`supabase/testing/verify-identity-badges.sql`，部署 `registration`、`staff` Edge Function 及前端，驗收後再依正式環境 9-3 關閉登記並更新正式站。

本機驗證：18 項單元測試、118 項桌機 Chromium Playwright，以及桌機 WebKit／手機 Chrome／手機 Safari 共 18 項針對性 Playwright 通過。隔離 PostgreSQL 套用新 migration，統一身分別 SQL 驗證通過並回滾測試資料。測試站與正式站尚未部署。

## 安全強化（2026-11-10 稽核）

細節依 [GitHub 公開內容機敏資料審查準則](GitHub公開內容機敏資料審查準則.md) 不公開，未完成項目與完整內容記在維護者本機的稽核紀錄（`docs/*.local.md`，不提交），需要時請向維護者索取。

- [x] 本機完成：公開與後台 API 在讀取請求時即限制大小；待測試與正式環境部署。（2026-11-10）
- [x] 本機完成：公開頁與後台加入內容安全政策（CSP）與 referrer policy；待部署。（2026-11-10）

> 更新日期：2026-11-08
> 目標：完成測試與正式環境驗收後才公開；核心流程或資料安全未通過則延後。

> 2026-11-04 範圍修訂：測試站須包含完整服事者／管理員登入與後台，並驗收公開與後台流程。取消／恢復從公開 API、後台操作及驗收移除；既有資料欄位暫留。Turnstile 改為主要功能上線後擴充，不作為本次公開關卡。未通過必要驗收則延後。驗收結果記在 [驗收紀錄](驗收紀錄.md)。

> 2026-11-04 查詢方式改版：填寫者改用「姓名＋區」查詢，不再使用查詢碼；有效登記的姓名＋區不可重複，後台以「作廢」取代疑似重複流程，公開操作改為依來源限速。最新時程：11/4 完成改版並部署測試站；11/5 上午完成測試站必驗項目，下午部署正式站並保持登記關閉；11/6～11/7 封閉驗收；11/8 開放。必驗項目未通過時順延正式站部署，開放日不變。決策見 [需求討論與決策紀錄](需求討論與決策紀錄.md)。

> 2026-11-05 試用回饋修訂：開家接待改為下拉選單、網站備註、區新增「其他」，見 `202611050004`；決策見 [需求討論與決策紀錄](需求討論與決策紀錄.md)。

> 2026-11-05 開家接待：依測試回饋納入開家接待意願調查，須在測試站試用後與其他活動同在 11/6 12:00 開放；未通過 go/no-go 時只維持接待關閉。決策見 [需求討論與決策紀錄](需求討論與決策紀錄.md)。

## 開發與驗收進度

- 公開登記、姓名與區查詢、修改活動選擇與截止規則已有自動化驗證；跨瀏覽器、實際 Safari、部署重建及資料復原仍列為公開前驗收項目。
- 已建立資料庫遷移、Row Level Security、Edge Function 與靜態網站部署流程。
- 依來源限速與同名同區擋下仍須在測試站完成端對端驗收。
- 服事者／管理員登入與後台已有本機實作及自動測試；仍須部署至測試 Supabase，使用獨立測試帳號完成真人驗收。
- 開發工具版本與相依套件安全狀態應在每個開發環境依 `package.json` 和 lockfile 檢查。

## 下一個開發工作階段：依序執行

### 1. 確認部署環境與目前版本

- [ ] 確認工作目錄乾淨、分支與遠端同步狀態正確；依專案分支流程建立功能分支。
- [ ] 確認 Node.js 與 npm 符合 `package.json` 的 engines，再執行 `npm ci`。
- [ ] 確認 `npm audit` 無漏洞，執行 `npm run test:e2e`；Windows 下確認測試 process 正常結束。
- [ ] 確認部署環境可用瀏覽器登入 Supabase、GitHub；部署環境不使用 Supabase CLI，依受控的 Dashboard 流程逐版套用已版控 SQL 與 Edge Function 原始碼，記錄環境、版本及結果。

### 2. 確認測試環境部署

- [ ] 將已完成功能依既定分支流程合併到共用測試分支，確認 Pages workflow 成功；變更登記流程前先通知正在試填的人。
- [ ] 檢查部署 artifact 只包含 `site/` 成品，沒有 SQL、測試、`node_modules`、文件或 secrets。
- [ ] 確認測試站連到開發資料環境並顯示測試站提示；正式環境設定不可混用。
- [ ] 在 Dashboard 確認 Edge Function 的 Verify JWT：`staff` 開啟、`registration` 關閉。Dashboard 部署不讀取 `supabase/config.toml`，兩邊設定須一致。
- [ ] 套用 `202611040001_staff_backoffice_and_name_lookup.sql` 前，清空測試站的登記資料（`registrations`、`registration_choices`），並通知試填者以新流程重填；試填回饋先另行保存。
- [ ] 測試站已套用 `202611030001` 至 `202611030004`；接著依序套用 `202611040001_staff_backoffice_and_name_lookup.sql`、`202611040002_activity_reorder.sql`、`202611040003_activity_time_precision.sql`、`202611050001_hosting.sql`（測試站已套用）、`202611050002_hosting_review_fixes.sql`，再立即部署 `registration` 與 `staff` Edge Function。
- [ ] 在 Edge Function secrets 新增至少 32 字元的 `RATE_LIMIT_KEY`；移除已不使用的 `QUERY_CODE_PEPPER`。
- [ ] 在本機與測試站檢查活動、時間表、登記、姓名與區查詢、修改登記內容及完成頁摘要。

### 3. 測試站完整驗收

- [ ] **11/5 上午必驗，未通過則順延正式站部署：**
  - [ ] `postgres` 角色可刪除 `auth.sessions`：重設密碼、改密碼、停用帳號後，舊登入立即失效。
  - [ ] Supabase Auth 接受後台帳號的內部識別格式（`@accounts.invalid`），可建立首位管理員並登入。
  - [ ] Edge Function 收到 `x-forwarded-for`，不同來源分別計算限速；缺少時全部共用同一額度。
  - [ ] 請求自行帶入 `x-forwarded-for` 時，限速仍依閘道判定的來源計算；不符時先調整取用的來源 header 並重新驗證，再部署正式站。
  - [ ] Dashboard 的 Verify JWT 設定下，後台請求與瀏覽器 preflight 都能通過。
  - [ ] Auth 錯誤碼 `email_exists`、`invalid_credentials` 與程式判斷一致。
  - [ ] 資料庫 locale 對非英文字母的大小寫轉換與後台一致：`select registration_name_key('JOSÉ')` 須回傳 `josé`。
- [x] Playwright 在 Desktop Chromium、Desktop WebKit、Mobile Chrome、Mobile Safari 模擬驗證建立、姓名與區查詢、確認／修改狀態、儲存、取消與未儲存變更提醒、查無資料、同名同區擋下及截止行為。
- [ ] 確認匿名角色無法直接讀取敏感資料，並驗證依來源限速與全站上限有效、到期自動恢復。
- [ ] 使用獨立 `admin` 與 `staff` 測試帳號，驗收登入、角色權限、名單、協助登記與更正姓名或區的同名擋下、作廢後可重新登記、統計、CSV 及設定；將結果記在 `docs/驗收紀錄.md`。
- [ ] 邀請弟兄姊妹在測試站實際操作手機流程，記錄並修正阻擋使用的問題。
- [ ] 測試資料須能與正式資料區分；測試完成後依核准的資料生命週期程序處理。

### 4. 建立及驗收正式環境

- [x] 建立獨立正式資料環境，透過安全方式確認環境身分，避免誤連開發環境。（2026-11-06，Free 方案）
- [x] 依相同版本順序套用 migrations、seed 與 Edge Function；逐項記錄正式環境已套用的 migration，禁止重複執行一次性 SQL。（2026-11-06 以 `baseline_202611060003.sql` 一次套用至 `202611060003`，紀錄在[正式環境設定流程](正式環境setup.md)第 3 節；之後的 migration 逐支記錄。）
- [x] 依核准的部署程序套用資料庫遷移與函式，並核對部署結果。
- [x] 設定正式網站公開連線資訊與服務端 secrets；確認前端只包含可公開的設定值。
- [ ] 正式網站先保持登記關閉，部署後檢查資料權限、Edge Function、既有防濫用控制、活動公開狀態與錯誤處理。
- [ ] 用正式環境執行建立、姓名與區查詢、修改與作廢 smoke test，並驗證後台兩種角色；使用明確標記的測試登記。
- [ ] 用 iPhone、iPad 或 Mac 的實際 Safari 完成 smoke test；Playwright WebKit 僅作自動化輔助。

### 5. 備份、清除與開放

- [ ] 演練正式資料備份及還原方式，確認備份檔位置與存取權限。正式專案為 Free 方案，沒有自動備份，要訂出手動匯出的頻率與存放位置。
- [ ] Free 方案的專案連續 7 天沒有請求會被暫停：開放登記後每週至少開一次正式站或後台；若發現暫停，到 Dashboard 恢復專案。
- [ ] 清除正式測試資料前，確認目標環境、資料範圍與筆數；先備份並核對範圍。
- [ ] 依核准範圍清除測試登記及相關資料；保留正式活動與系統設定。
- [ ] 依核准程序完成驗收資料處理，並確認正式環境狀態符合開放條件。
- [ ] 驗收通過後才開啟正式登記；核心流程、RLS、既有防濫用控制或資料復原任一未通過，先維持關閉並延後開放。

## 現在先做

- [x] Q42 原決策已於 2026-11-04 修訂：完整服事者／管理員後台改為本次必要範圍；其他功能仍凍結。
- [x] Q43：建立規劃檔中的全部活動，未確認項目保持未公開。
- [x] 測試環境依核准設定開放測試活動；正式環境維持關閉，直到驗收通過。
- [x] 確認開發環境使用仍受支援且已修補的 Node.js 26.13.0 LTS，並在最小 `package.json` 限定支援版本。
- [x] 依既定分支流程建立功能分支，不直接在共用測試分支開發。
- [x] 依 Supabase 建置 wizard，從頭建立開發專案並驗證連線。
- [x] 建立最小網站、migration、RLS、Edge Function 與 Playwright 骨架。

## 分支與部署流程

每次開發都使用以下流程：

```text
feat/*（功能開發）
    ↓ PR
develop（整合，原名 feat/ver-001；上線後不部署）
    ↓ PR
main（正式環境，唯一由 GitHub Pages 部署的分支）
```

- `feat/*` 從 `develop` 建立，完成並測試後開 PR 合併至 `develop`。
- `develop` 驗收後開 PR 合併至 `main`。不經過 `feat/ver-001-main` 這類中轉分支。
- 上線後 `pages.yml` 與 `github-pages` 部署環境都只允許 `main`；測試改用本機 `npm start`，需要遠端試用時另開獨立測試站。細節見 [正式環境設定流程](正式環境setup.md) 第 9 節。
- 部署 artifact 只包含網站成品，不包含 SQL、測試、`node_modules`、規劃文件或 secrets。

## Supabase 建置 wizard

使用者需要從零開始逐步操作；不得假設已熟悉 Supabase Dashboard。

### 開發專案

- [ ] 登入或建立 Supabase 帳號。
- [ ] 建立獨立的開發／測試專案。
- [ ] 確認 project name、region 與資料庫密碼保存位置。
- [ ] 完成專案連線設定，並確認公開設定值已妥善管理。
- [ ] 將公開設定寫入 Git 忽略的本機設定檔。
- [ ] secret 與資料庫密碼不得寫入 repo、前端設定或對話紀錄。
- [ ] 驗證資料庫及 Edge Function 的可重建部署方式。
- [ ] 套用 migration、RLS、seed 與 Edge Functions。
- [ ] 驗證靜態頁面能連接開發專案。

### 正式專案

- [x] 建立獨立的正式專案。
- [ ] 使用相同 migration 與 seed 重建，不在 Dashboard 人工重做 schema；驗證正式 RLS、RPC 與 Edge Functions。
- [ ] 設定 GitHub Pages 所需的公開設定與 Edge Function secrets。
- [ ] 分開管理各環境的公開連線設定；不將實際值或任何 secret 放入 repo。
- [ ] 將 Pages Source 設為 GitHub Actions，驗證測試版的公開網址與資料連線；上線切換後只允許 `main` 部署。
- [ ] 正式上線前確認 Pages 的最後部署來源與正式環境連線設定。
- [ ] 部署正式環境並完成驗收。

## Node.js 與 npm 安全原則

Node.js 與 npm 只用於開發工具；正式 GitHub Pages 不執行 Node.js server。

- [x] 使用仍受支援且已修補的 Node.js LTS。
- [ ] 只安裝必要開發工具；依核准的部署程序部署。
- [x] 套件使用精確版本，不使用 `^` 或 `~` 自動升級。
- [x] 提交 `package-lock.json`，後續使用 `npm ci`。
- [x] 執行 `npm audit` 並檢查直接與間接相依套件。
- [x] 本機靜態伺服器只綁定 `127.0.0.1`。
- [ ] 瀏覽器使用的 Supabase library 固定明確版本。

## 上線範圍

### 公開流程

- [ ] 全站採 RWD；桌機、筆電、平板、手機均可閱讀時間表並操作登記與查詢，不產生水平溢出。
- [ ] 公開登記頁：姓名、區與當下所有公開活動。
- [ ] 每個公開活動都須明確選擇參加或不參加，允許全部不參加。
- [ ] 完成頁顯示這次送出的姓名、區與各活動選擇，並提示日後以相同姓名與區查詢；流水號僅供內部核對。
- [x] 查詢後先以純文字確認參加／不參加／未回覆；按「修改登記內容」才顯示 radio、儲存與取消。沒有變更時不能儲存；有未儲存變更時，取消、切換頁籤、重新查詢或離開頁面須提醒。儲存成功後更新比較基準並回到確認狀態。姓名與區由服事者更正。
- [ ] 截止後仍可查看，不能自行儲存修改。
- [ ] 同區已有相同姓名的有效登記時擋下送出，提示改用查詢。

### 姓名與區查詢

- [ ] 姓名照填寫內容保存；比對時先做 NFKC 正規化，再轉小寫並移除所有空白與零寬字元，支援中文與英文姓名。
- [ ] 查無資料使用一致訊息，提示姓名寫法須與登記時相同。
- [ ] 建立成功後以 `sessionStorage` 將摘要傳至 `success.html`，關閉分頁後消失。

### 安全界線

- [ ] 所有公開登記操作經 Edge Function 驗證。
- [ ] 啟用 RLS；公開訪客不能直接讀取登記、選擇、staff profile、audit 或限速資料表。
- [ ] 建立登記使用 honeypot、最短合理填寫時間及 `create_request_id`。
- [ ] 公開新增、查詢與修改依來源限速，成功與失敗都計入，另有全站上限；額度到期自動恢復。
- [ ] 不保存原始 IP；限速只短期保存以 `RATE_LIMIT_KEY` 保護的 IP 雜湊，時間窗過後自動刪除。
- [ ] 設定異常監控及緊急關閉登記的維護流程；緊急時管理員可在後台網站設定取消「開放公開查詢與修改」，立即停止公開查詢與修改，驗收此開關。
- [ ] 加入 `robots` 禁止索引；不得把它視為存取控制。
- [ ] 本次先驗收 honeypot、合理填寫時間、`create_request_id`、建立限額與依來源限速；Turnstile 留待主要功能上線後新增。

### Audit

- [ ] 建立 append-only `audit_events`。
- [ ] 記錄公開建立、修改，以及後台異動。
- [ ] 保存操作者、動作、目標、時間與非機密欄位的修改前後值。
- [ ] 不保存密碼、原始 IP 或防機器人憑證。
- [ ] 稽核紀錄照常寫入，不在後台顯示。

## 資料與狀態規則

- [ ] 開放條件使用 `is_registration_open`；截止時間為空代表無期限，有設定時才檢查截止。
- [ ] 新增活動後，舊登記儲存修改時，必須回答當下所有公開活動。
- [ ] 建立、修改及匯入狀態更新使用資料庫交易。
- [ ] 活動、區與系統設定保存在資料庫，不寫死於 HTML。
- [ ] 未確認的活動不得顯示為已公告。

## 測試與驗收

### CI/CD 與測試站

- [ ] GitHub Actions 的 Pages 部署只打包 `site/`，不包含 migration、測試、`node_modules` 或本機設定；部署工作流程不得輸出 secret。
- [ ] 測試版連開發資料環境，正式版連獨立正式環境；分開管理部署設定並驗證連線。
- [ ] 每次準備發布時先執行本機測試與機敏資料審查；目前完整 CI 可延後，但 Pages 部署失敗不得當成發布成功。
- [ ] 測試人員驗證後，關閉測試入口並依清理程序處理測試資料；正式環境通過驗收前維持關閉。

### 公開前

- [ ] 以桌機、筆電、平板、手機寬度驗證 RWD 版面與主要操作；實際裝置驗收另列於正式環境關卡。
- [x] 全部 migration 可在乾淨的本機 PostgreSQL 依版本順序套用；已套用的版本不得重複執行，Dashboard 部署須記錄版本。
- [ ] RLS 允許與拒絕案例通過。
- [x] Playwright 覆蓋建立、姓名與區查詢、確認／修改狀態、儲存、取消與未儲存變更提醒、查無資料、同名同區擋下與截止規則。
- [ ] 自動測試 Desktop Chromium、Desktop WebKit、Mobile Chrome 與 Mobile Safari 模擬。
- [ ] 完成後台 `admin` 與 `staff` 權限、主要操作及拒絕案例驗收；紀錄於 `docs/驗收紀錄.md`。
- [ ] 測試資料須能與正式資料區分，完成後依核准程序處理。
- [ ] GitHub Actions 可延後；可重複執行的本機測試不能延後。

### 正式環境公開前

- [ ] 使用 iPhone、iPad 或 Mac 的實際 Safari 完成 smoke test。
- [ ] 驗證 GitHub Pages、正式 Supabase、RLS 與 Edge Functions。
- [ ] 驗證依來源限速與作廢後重新登記。
- [ ] 驗證備份及 rollback 程序。
- [ ] 外觀小問題可記錄後修；核心流程與資料安全問題必須修正。

### 公開前處理驗收資料

- [ ] 清除前確認目標環境、資料表與筆數。
- [ ] 先匯出可還原備份並取得人工確認。
- [ ] 依核准的資料生命週期程序清理驗收資料。
- [ ] 保留活動、區與系統設定。
- [ ] 確認正式環境符合開放條件。
- [ ] 確認正式環境狀態符合開放條件後，再依發布流程開放服務。

## 初始活動策略

建立規劃檔中的全部活動，以下未確認項目保持未公開：

- 青年大會的時間與地點。
- 週五晚間帶菜愛筵的時間與地點（原主日晚間愛筵已取消）。
- 尚未公告的用餐時間與地圖連結。

Q43 已確認。

## 本次新增必要範圍：服事者／管理員後台

- [ ] Supabase Auth 登入、首次改密碼、登出及停用帳號即時失效；由部署維護者安全建立首位測試管理員。
- [ ] `admin` 建立（設定密碼、不分區）、改名、設定密碼、停用服事者帳號；禁止停用最後一位有效管理員。
- [ ] 所有登入者可從導覽列「更改密碼」修改自己的密碼；套用 `202611050003_staff_account_management.sql` 並部署 `staff` Edge Function 後，在測試站驗證改名後以新名稱登入、設定密碼後舊登入失效。
- [ ] 為 `staff` Edge Function 的改名同步登入識別、設定密碼流程補上注入假 Supabase client 的單元測試；目前只有輔助函式單元測試、資料庫檢查與模擬 API 的瀏覽器測試。
- [ ] 評估改用不會變的內部識別作為 Auth 登入 email，改名時只更新 `staff_profiles`，免去兩處同步。
- [ ] `staff` 與 `admin` 查詢及維護名單、作廢登記（須填原因）、更新匯入狀態、查看統計與匯出 CSV。
- [ ] `admin` 管理活動、詳細時間表與截止時間；區固定，後台不提供區選項管理；活動可用「調整排序」拖曳 ☰ 或方向鍵排序，按「完成排序」一次儲存。
- [ ] 取消公開活動前提示受影響的登記人數（[系統架構規劃](系統架構規劃.md) 第 4 節）；目前尚未實作。
- [ ] 公開前驗證匿名、未授權、停用帳號、`staff`、`admin` 的允許及拒絕案例；帳號與驗收資料不跨測試及正式專案共用。

## 本次新增必要範圍：開家接待

- [x] 本機完成：`202611050001_hosting.sql`、`202611050002_hosting_review_fixes.sql`（code review 修正）、公開登記與查詢、後台登記資料與補登、開家接待設定、統計與 CSV；資料庫與 Playwright 測試通過。
- [ ] 測試站套用 migration 並部署兩個 Edge Function 後，管理員填寫說明文字（例如接待期間）並開啟開關，邀請弟兄試用回饋。
- [ ] 驗收開放與關閉兩種狀態：開放時必答；關閉時登記頁不顯示、查詢頁唯讀、公開修改不能變更接待；後台不受開關限制。
- [ ] 驗收已匯入的登記改接待後變成「需重新匯入」，統計與 CSV 數字正確，作廢登記不計入。
- [ ] 正式站列入 11/6 10:30 go/no-go；通過則 12:00 與 `is_registration_open` 一起開啟，未通過只維持接待關閉。

## 本次新增必要範圍：試用回饋修訂

- [x] 本機完成：`202611050004_hosting_dropdowns_site_note_other_district.sql`、公開頁與後台接待下拉選單、統計與 CSV、網站備註、區「其他」；資料庫與 Playwright 測試通過。
- [ ] 測試站依序套用 `202611050003`、`202611050004`，部署兩個 Edge Function 與前端；確認試用資料已轉換（家庭→不拘、人數最多 10）。
- [ ] 驗收公開頁：三個選項、兩個下拉選單必選、成功頁與查詢頁顯示；備註顯示在地址下方且連結可點；「其他」可登記與查詢。
- [ ] 驗收後台：網站設定右欄備註儲存、統計四種接待對象與合計、CSV 3 個接待欄位。
- [ ] 測試站與正式站的兩個 Edge Function 都重新部署後，新增 migration 刪除 `registration_hosting.family_count`、`note` 與約束 `registration_hosting_removed_fields`。

## 歷史範圍：接機附屬於開家接待（已由獨立接機調查取代）

- [x] `202611050005_hosting_pickup.sql` 曾實作 0～6 位、預設 0 的舊方案；部署與驗收改依下方「接機接待獨立調查」，不再以預設 0 當成明確回答。

## 本次新增必要範圍：用餐學生價與報名對象

- [x] 本機完成：`202611050006_meal_pricing_and_audience.sql`、兩個 Edge Function、公開頁身分題與限定活動、後台活動欄位、統計與 CSV；`supabase/testing/verify-meal-pricing-and-audience.sql`、Edge Function 單元測試與四種瀏覽器的 Playwright 測試通過。
- [ ] 舊版部署待辦：`202611050006` → Edge Functions → 前端。2026-11-11 更新：舊 meal-pricing 驗證已退役，現行驗收執行 `verify-registration-identities.sql`、`verify-independent-identity-prices.sql`、`verify-hosting-general-only.sql` 與 `verify-activity-fields-and-permissions.sql`，不執行 historical 目錄腳本。
- [ ] 部署後由管理員在後台設定三餐的一般價、學生價、實際成本，以及 2/20 午餐的報名對象；實際成本不寫入版控文件。
- [ ] 驗收公開頁：學生價顯示、勾選有學生價的用餐才出現身分題且必填、限定活動依開家接待回答開放或退回、完成頁與查詢頁顯示身分。
- [ ] 驗收後台：活動新欄位儲存、改為限定時的確認人數、統計的學生人數／成本／補貼、CSV 兩個新欄位；以 `anon` 直接讀取 `activities.cost_amount` 必須被拒。
- [ ] 日後確認大會系統欄位後，評估用餐身分是否要改為「變更即需重新匯入」。

## 本次新增必要範圍：後台登記名單調整

- [x] 本機完成：登記名單每頁 10 筆、表頭「匯入大會」；登記資料先以查看模式鎖住欄位，按「修改登記資料」才能修改；登記資料與補登改為左欄姓名｜區與開家接待、右欄每項一行的活動；匯入狀態與作廢並排。Playwright 通過。
- [ ] 測試站依序：先部署 `staff` Edge Function（每頁 10 筆），再部署前端；兩邊都上線前，換頁可能短暫跳過或重複幾筆，不影響資料。
- [ ] 驗收後台：超過 10 筆時可換頁、查看時欄位無法點選、修改與取消、作廢登記沒有「修改登記資料」、寬螢幕與手機版面。
- [x] 本機完成：「補登」改名為「協助登記」（後台文字與 `staff` Edge Function 錯誤訊息）；統計、服事者帳號、網站與登記設定、開家接待設定、活動、詳細時間表改為緊湊版面。Playwright 通過。
- [ ] 重新部署 `staff` Edge Function（只改錯誤訊息文字，前後端誰先上線都可以），並驗收各區塊在寬螢幕與手機的版面。
- [x] 本機完成：各區各活動改為每區一張小卡；各區、開家接待回覆加合計列；統計小卡不需左右捲動。Playwright 通過。
- [ ] 驗收統計：每區小卡的數字、各區合計與摘要一致、接機卡在寬螢幕不需左右捲動（只改前端）。
- [x] 本機完成：依 [2026-11-06 後台統計與匯出決策](需求討論與決策紀錄.md)確認各活動及各區各活動涵蓋全會所有效登記者、只列公開活動，參加／不參加／未回覆人數正確；開家接待回覆隱藏「家人已登記開家接待」的人數，合計仍含該回答並顯示註記。針對性 Playwright 測試通過。
- [x] 本機完成：新增「下載統計 CSV」，收錄畫面的各活動、各區、開家接待回覆、接待對象、接機及各區各活動統計，含費用／成本／補貼、適用合計與接待合計註記；保留原每人一列 CSV 的按鈕、欄位與格式。針對性 Playwright 測試通過。
- [ ] 驗收統計 CSV 與畫面數字一致，作廢登記及未公開活動不計入，未選活動算未回覆；原個人明細 CSV 仍可照原格式開啟。
- [x] 本機完成：公開頁登記與查詢的姓名欄，重新整理或回上一頁後不再填回前一位輸入的姓名。Playwright 通過。
- [ ] 測試站驗收：在 Chrome、Edge 與 Safari 輸入姓名後重新整理及回上一頁，姓名欄為空白（只改前端）。

## 本次新增範圍：後台一次顯示一個功能畫面

決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-08 後台一次顯示一個功能畫面」一節。只改前端，不關閉登記。11/8 登記尖峰過後才合併進 `develop` 並發布，尖峰前分支保持獨立。

- [x] 本機完成：上方導覽列一次只顯示一個功能畫面，預設登記名單並標示目前功能；重新整理停在原畫面，登出後清除；服事者不會停在管理員畫面。Playwright 補上切換、保留輸入、重新整理、登出後重新登入與服事者權限的測試。
- [ ] 測試站驗收：以管理員與服事者帳號各操作一次：預設登記名單、切換各功能、填到一半切走再切回、重新整理、登出後重新登入。
- [ ] 合併 `develop` → `main`（**Create a merge commit**），依[正式環境設定流程](正式環境setup.md)第 7-4 節核對，結果記在[驗收紀錄](驗收紀錄.md)。

## 可延後項目

- 後台離開前提醒：有未儲存的修改時，重新整理或關閉分頁前先確認；需判斷 8 個功能區塊的表單是否改過，另開功能分支。
- 後台左側選單：`feat/admin-sidebar-layout`（未合併）保留，之後決定是否改用。
- Cloudflare Turnstile：後續以公開設定提供 site key、伺服端 secret 驗證 token，使用新 migration 調整防護；測試與正式環境分開設定。未完成前不讓公開流程依賴 Turnstile。
- GitHub Actions 完整 CI。
- 進階 rate limiting 服務。
- 後台統計的匯入狀態人數（待匯入、已匯入、需重新匯入）：待大會匯入流程確定後再做。

## 已定案摘要

- 靜態 HTML、CSS、原生 JavaScript，runtime 無 build step。
- npm 只負責開發工具、測試與本機伺服器。
- 開發／測試與正式環境使用不同 Supabase 專案。
- 資料庫遷移以版本控制管理，並依核准的部署程序套用。
- 公開操作經 Edge Function；狀態轉換使用受控 RPC／服務端流程。
- 第一個垂直切片包含 schema、RLS、建立、完成、查詢、修改及測試；本次公開前還須完成後台。
- 手機優先，測近期 Chrome、Edge 與 Safari；不設 WCAG 驗收項目。

## 本次新增必要範圍：接機接待獨立調查

- [x] 本機完成：`202611060001_independent_pickup.sql`、公開頁與後台各自開關、是／否與人數選擇、摘要、統計及 CSV。接機可不依附開家；人數預設「請選擇」，舊 0 轉未回覆。
- [ ] 測試站依序：套用 `202611060001_independent_pickup.sql`，再部署 `registration` 與 `staff` Edge Function（會呼叫 `*_with_pickup` RPC、讀 `registration_pickup`，不能早於 migration），最後部署前端（舊版 Edge Function 會丟掉 `pickup`）；三步之間若開家接待開放，舊頁面送出的接機人數只寫入舊欄位，因此部署期間先關閉開家接待或連續完成三步。套用後在 SQL Editor 執行 `supabase/testing/verify-independent-pickup.sql`。
- [ ] 確認既有接機人數 1～6 轉為「是」、0 轉為未回覆；兩個 Edge Function 都更新後，新增 migration 刪除 `registration_hosting.pickup_count`。
- [ ] 驗收公開頁：開家與接機單獨開關、同一淺綠區塊各一個標題及淡分隔線；選是才選 1～6 位，否為 0，未回答不能當 0。驗收後台共用緊湊設定區塊、各自說明及導覽列「開家與接機接待」。

## 本次新增必要範圍：接機與活動報名資格

- [x] 本機完成：`202611060002_activity_audiences.sql`、活動報名對象選項（所有人／開家／接機／其他活動）、空白限定提示不顯示、公開頁與後台連動、API 儲存驗證、自我參照與循環檢查，以及原愛筵改名。針對性瀏覽器與資料庫驗證已執行；依需求未跑完整測試套件。
- [ ] 測試站依序套用 `202611060002_activity_audiences.sql`，再部署 `registration` 與 `staff` Edge Function，最後部署前端；於 SQL Editor 執行 `supabase/testing/verify-activity-audiences.sql`。若前一版 `202611060001` 尚未套用，須先完成其部署順序。
- [ ] 驗收後台單選清單含接機及實際活動（未公開者有標示、不含自己），無法形成循環；驗收接機回答是才符合資格、前置活動須已公開且勾選參加、取消後依賴活動退回不參加、同畫面重選後恢復；限定對象提示留空不顯示。
- [ ] 確認週五晚間帶菜愛筵沿用原活動 ID 與答案，週五活動已存在時不重複改名；時間與地點由管理員確認後設定，不自動填入。

## 本次新增必要範圍：正式站上線準備

- [x] 本機完成：`202611070001_raise_launch_rate_limits.sql` 為 11/8 上線尖峰放寬 10 分鐘限流：全站新登記 50→150、同一來源 60→200、全站公開請求 600→1000；`verify-all-no-and-rate-limit.sql` 改驗新數值。依據見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-07 上線尖峰限流」一節。
- [x] 測試專案套用 `202611070001_raise_launch_rate_limits.sql`：`supabase/testing/verify-all-no-and-rate-limit.sql` 顯示 `Success. No rows returned`、沒有 `ERROR`，[正式環境設定流程](正式環境setup.md)第 9-3 節唯讀查詢四欄皆為 `true`。結果記在[驗收紀錄](驗收紀錄.md)。（2026-11-07）
- [x] 正式專案套用 `202611070001_raise_launch_rate_limits.sql`，以[正式環境設定流程](正式環境setup.md)第 9-3 節的唯讀查詢確認四欄皆為 `true`，記錄在[正式環境設定流程](正式環境setup.md)第 3 節。依決策不需關閉登記；套用當下的登記開關狀態未記錄。（2026-11-07）
- [x] 2026-11-07 合併 `develop` → `main`（專案負責人決定當天合併）：先把本套用紀錄的文件 PR 合併進 `develop`，再開 `develop` → `main` 的 PR，以 **Create a merge commit** 合併。內容包含已套用到正式專案的 `202611070001`，以及 PR #30 的後台活動內容展開（前端，會部署到正式站）。部署後依[正式環境設定流程](正式環境setup.md)第 7-4 節核對，並在正式站後台確認點活動名稱可展開活動內容、編輯與排序正常，結果記在[驗收紀錄](驗收紀錄.md)。（2026-11-07 PR #33 完成，核對結果記在[驗收紀錄](驗收紀錄.md)。）
- [ ] 尖峰過後由專案負責人判斷，新增 migration 把同一來源上限調回 60，並更新驗證腳本。
- [x] 公開頁過了截止時間就停用送出並顯示「登記已截止。」：PR #35 進 `develop`，專案負責人在測試站確認；PR #36 進 `main`，`Deploy GitHub Pages` 成功。（2026-11-07）

## 本次新增必要範圍：LINE 連結預覽

決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-08 LINE 連結預覽與截止時間顯示」一節。

- [x] 本機完成：首頁、登記完成頁與後台的 HTML 不再寫測試站提示文字，改由 JavaScript 在測試環境填入；首頁與登記完成頁加 `description`、`og:title`、`og:description`。Playwright 新增案例檢查三頁原始碼沒有「測試站」、首頁與登記完成頁有預覽說明，且測試環境仍顯示提示；完整測試套件 373 通過、19 略過。（2026-11-08）
- [x] PR `fix/link-preview-text` → `develop`，更新測試站，確認三頁仍顯示測試站提示。（2026-11-08 PR #37 完成）
- [x] PR `develop` → `main`，以 **Create a merge commit** 合併；部署後依[正式環境設定流程](正式環境setup.md)第 7-4 節核對，並確認三頁原始碼沒有「測試站」。不需關閉登記。（2026-11-08 PR #38 完成）
- [x] 專案負責人用 LINE Page Poker 清除正式網址的預覽快取，到群組重貼連結，確認預覽顯示新說明。結果記在[驗收紀錄](驗收紀錄.md)。（2026-11-08）

## 本次新增必要範圍：個人明細 CSV 按鈕改名

決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-08 後台個人明細 CSV 按鈕改名」一節。

- [x] 本機完成：「統計與匯出」的「下載 CSV」改為「下載報名登記 CSV」，下載檔名與內容不變；Playwright 改用新名稱。（2026-11-08）
- [x] 與「登記名單依區篩選」同一個分支一起發布，步驟見下一節；測試站確認按鈕文字與下載內容，正式站確認按鈕文字。（2026-11-08 PR #40、#41 完成）

## 本次新增必要範圍：登記名單依區篩選

決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-08 後台登記名單依區篩選」一節。部署順序：每個環境都先部署 `staff` Edge Function，再部署前端。

- [x] 本機完成：登記名單加「區」下拉選單與「清除條件」按鈕；`staff` Edge Function 的 `list_registrations` 接受選填的 `district_id`（正整數），其他值回傳 `INVALID_REQUEST`；登出（包含登入過期）時清空名單條件。Edge Function 單元測試與 Playwright 已補。（2026-11-08）
- [x] 本機完成：「各區各活動」小卡寬螢幕每列 3 張（上 3 下 2）、手機每列 1 張；Playwright 新增排列案例。決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-08 各區各活動小卡排版」一節。（2026-11-08）
- [x] PR `feat/admin-list-and-stats` → `develop`。（2026-11-08 PR #40 完成）
- [x] 測試專案：Dashboard 部署 `develop` 上的 `supabase/functions/staff/index.ts` 到 `staff` Edge Function（Verify JWT 維持開啟）。（2026-11-08）
- [x] 更新測試站前端，專案負責人確認區篩選、清除條件、CSV 按鈕文字與各區各活動小卡排列。（2026-11-08）
- [x] 正式專案：Dashboard 部署同一份 `staff` Edge Function（Verify JWT 維持開啟）。（2026-11-08）
- [x] PR `develop` → `main`，以 **Create a merge commit** 合併；部署後確認正式站後台的區篩選與按鈕文字。不需關閉登記。（2026-11-08 PR #41 完成）

## 本次新增必要範圍：兒童報名

決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-09 兒童報名」一節。部署順序：每個環境都先套用 migration，再部署 `registration` 與 `staff` Edge Function，最後部署前端；不需關閉登記。

- [x] 本機完成：`202611090001_child_registration.sql` 新增兒童與家長姓名欄位、親子比對索引、兒童不受開家／接機報名對象限制與兩題存「否」；`registration`、`staff` Edge Function 接受 `is_child`、`parent_name`，查詢回傳兒童欄位，名單回傳親子對應；公開頁、查詢修改頁、協助登記與後台單筆修改加兒童勾選框與家長姓名；登記名單「親子」欄與說明、各區統計「其中兒童」、個人明細 CSV「兒童」「家長姓名」。資料庫驗證腳本 `supabase/testing/verify-child-registration.sql`、Edge Function 單元測試與 Playwright 已補。（2026-11-09）
- [ ] PR `feat/child-registration` → `develop`，合併後在 `develop` 跑完整 Playwright。
- [ ] 測試專案：SQL Editor 套用 `202611090001_child_registration.sql`，再執行 `supabase/testing/verify-child-registration.sql`，結果應顯示 `CHILD_REGISTRATION_OK` 並回滾。
- [ ] 測試專案：Dashboard 部署 `develop` 上的 `registration`（Verify JWT 關閉）與 `staff`（Verify JWT 開啟）Edge Function。
- [ ] 更新測試站前端，請弟兄們測試：兒童登記與家長姓名必填、兒童不顯示開家／接機、查詢修改切換兒童、協助登記與後台修改、親子欄、其中兒童與 CSV 欄位。
- [ ] 弟兄們確認後，正式專案依同樣順序套用 migration、部署兩個 Edge Function。
- [ ] PR `develop` → `main`，以 **Create a merge commit** 合併；部署後確認正式站的兒童勾選框與後台親子欄。不需關閉登記。
- [ ] 測試站回饋：登記名單查詢條件加「兒童」、「親子」說明改暖灰底色、家長那列改「兒童：小明、小華」、家長的登記列出兒童姓名並可點開。PR `feat/child-registration` → `develop` 後，測試專案先重新部署 `staff` Edge Function，再接著更新測試站前端；兩步之間舊版後台的「親子」欄會暫時顯示異常，更新後請弟兄們重新整理頁面。
- [ ] 上線後在 LINE 群組公告：已經幫兒童登記的家庭，用「查詢或修改登記」選擇兒童類型並填家長姓名。

## 本次新增必要範圍：用餐身分管理

規則見[用餐身分管理](用餐身分管理.md)。套用 migration 後每個用餐活動都要回答身分，舊版頁面不相容，所以正式站依[正式環境setup](正式環境setup.md) 9-3 先關閉登記再更新。本機已完成（commit `41a16b9`）。

- [ ] 測試專案：確認已套用 `202611090001_child_registration.sql`，再依序套用 `202611090002_registration_identities.sql`、`202611090003_independent_identity_prices.sql`，執行 `verify-registration-identities.sql` 與 `verify-independent-identity-prices.sql`（只在測試專案）。
- [ ] 測試專案：部署 `registration` 與 `staff` Edge Function，更新測試站前端，請弟兄們測試身分別管理、各身分價格與表單身分題。
- [ ] 正式站：依 9-3 關閉登記，套用同兩支 migration，部署兩個 Edge Function 與前端，確認後重新開放登記。

## 本次新增必要範圍：兒童類型

決策見[需求討論與決策紀錄](需求討論與決策紀錄.md)「2026-11-09 兒童類型：學齡前與國小」一節。已在 `feat/child-registration` 本機實作，和兒童報名、用餐身分管理一起上線。新增資料庫驗證 `supabase/testing/verify-child-type.sql`；測試站套用 migration 後須執行。

- [x] 本機實作：`202611100001_child_type.sql` 新增 `child_type`（既有兒童回填國小）、保留身分 `preschool`、`child` 改名「兒童（國小）」、刪除保護改 before delete trigger、`registration_child_save` 與四個 wrapper 改收 `p_child_type`；`registration`、`staff` Edge Function 的 `validChild` 改收 `child_type`；四處表單兒童下拉與學齡前提示；後台名單篩選下拉、類型標籤、統計「其中兒童 N（學齡前 a、國小 b）」、CSV 兒童欄填類型。補資料庫驗證、Edge Function 單元測試與 Playwright。
- [ ] 確認類型標籤色碼（學齡前粉色底、國小粉藍底）。
- [ ] 測試專案：套用 migration、部署兩個 Edge Function、更新前端，請弟兄們測試。
- [x] 移除前端多送的 `is_child`（2026-11-10，`refactor/remove-redundant-code`）：`registration`、`staff` Edge Function 已改讀 `child_type`，不再讀請求裡的 `is_child`。要改的地方：`site/app.js` 的 `create` 請求，以及 `currentEditChild()` 展開進 `update` 請求的 `is_child`；`site/admin/staff.js` 的 `save_registration`、`create_registration` 請求；`tests/read-only.spec.mjs`、`tests/staff.spec.mjs` 比對請求內容的 `is_child`。查詢回應與後台名單仍用 `is_child`，不在此範圍。
- [ ] 正式站：依 9-3 與用餐身分管理一起更新。

- [x] 本機完成：`202611060003_revoke_default_api_grants.sql` 撤銷 Supabase 預設給 `anon`、`authenticated` 的資料表、序列與函式權限，只保留原本刻意開放的公開讀取，並停止新物件自動授權。在模擬 Supabase 預設權限的本機資料庫驗證：私有資料表匿名不可讀、函式匿名不可執行；四支 `supabase/testing` 驗證以 `service_role` 執行通過。
- [x] 本機完成：`supabase/production/baseline_202611060003.sql` 依序串接 16 支 migration 成單一交易，與逐支執行比對結構、權限與初始資料完全一致。
- [x] `pages.yml` 只由 `main` 觸發；分支與發布規則寫入 [正式環境設定流程](正式環境setup.md) 第 7、9 節。
- [x] 測試專案套用 `202611060003_revoke_default_api_grants.sql`（不需重新部署 Edge Function），確認私有表匿名不可讀，並完成登記、查詢、修改與後台 smoke test。（2026-11-06）
- [x] `feat/ver-001` 改名為 `develop`，刪除 `feat/ver-001-main`。（2026-11-06）
- [x] 依[正式環境設定流程](正式環境setup.md) 第 1～8 節建立正式站：Auth、管理員、baseline、`staff_profiles`、Edge Function、GitHub Variables、部署環境只允許 `main`、第一次接合 `main` 並開上線 PR、部署後核對。
