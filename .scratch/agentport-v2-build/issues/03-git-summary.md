# 03: Git 摘要

**What to build:** Task 完成後 caller 在 `get_task` 看到這一輪改了哪些檔案（`diff_stat`）與新增的 commit 清單；workspace 不是 git repo 時 Task 仍 completed，兩欄為 null 並附 `hints.git`。

**Blocked by:** 02

**Status:** done

- [x] Turn 開始時記下 HEAD，結束後產生 `diff_stat`（含 untracked）與 `commits[]`（起點到 HEAD）
- [x] 假 Driver 在測試中實際寫檔與 commit，斷言摘要內容
- [x] 非 git 目錄、git 指令失敗 → completed + null + `hints.git` 說明原因
- [x] 摘要失敗不影響 Task 狀態
