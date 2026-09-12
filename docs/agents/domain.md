# Domain Docs

本專案採 single-context：根目錄 `CONTEXT.md` 與 `docs/adr/`。

## 讀取順序

探索程式、撰寫規格或處理票據前：

1. 讀根目錄 `CONTEXT.md`。
2. 讀 `docs/adr/` 中與工作相關的 ADR。
3. 若日後出現 `CONTEXT-MAP.md`，依其指向讀取相關 context 文件。

文件不存在時繼續工作，不為補齊結構而預先建立空文件。
術語與決策由 domain-modeling 在釐清後記錄。

## 術語

規格、票據、測試與設計使用 glossary 定義的名稱。
發現缺少術語時，先確認是否為既有概念，必要時交由 domain-modeling 釐清。

## 決策

遵守相關 ADR，並留意 proposed、accepted 或 superseded 狀態。
若方案與既有 ADR 衝突，明確指出衝突及重新討論的理由，不默默覆寫。
