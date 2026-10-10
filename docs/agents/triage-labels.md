# Triage Labels

各 skill 以五個標準 triage 角色溝通。本檔把角色對應到本 repo tracker 實際使用的字串；local-markdown tracker 把它寫在票頭的 `Status:` 行。

| mattpocock/skills 的 label | 本 repo 的字串      | 意義                               |
| -------------------------- | ------------------- | ---------------------------------- |
| `needs-triage`             | `needs-triage`      | 維護者需要評估這張票               |
| `needs-info`               | `needs-info`        | 等待回報者補資訊                   |
| `ready-for-agent`          | `ready-for-agent`   | 規格完整，可交給 AFK agent         |
| `ready-for-human`          | `ready-for-human`   | 需要人來實作                       |
| `wontfix`                  | `wontfix`           | 不處理                             |

skill 提到某個角色時（例如「套上 AFK-ready 的 triage label」），使用右欄對應的字串。

建置工單完成後的 `done`、決策票的 `open | claimed | resolved` 屬於 `issue-tracker.md` 定義的生命週期，不是 triage label。
