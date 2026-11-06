# ictc-2027-registration
2027 國際華語相調特會報名管理系統，協助會所服事者進行與會者報名登記、資料維護、報名狀態追蹤及相關行政管理作業，提升報名流程的效率與便利性。

## 本機啟動

需要 Node.js 版本請見 `package.json` 的 `engines`。

1. 安裝套件：`npm ci`
2. 複製 `site/config.example.js` 為 `site/config.js`，填入開發用 Supabase 的 `supabaseUrl` 與 `publishableKey`。這個檔案不進版控，每台電腦都要建立一次。
3. 啟動：`npm start`，開啟 http://localhost:8765 。VSCode 也可以從側邊欄「NPM Scripts」點選 `start`。

E2E 測試：`npm run test:e2e`。測試會自己占用 8765，執行前先停掉 `npm start`。

## 測試環境使用
