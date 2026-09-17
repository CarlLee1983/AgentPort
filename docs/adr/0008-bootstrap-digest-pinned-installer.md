---
status: accepted
---

# 一鍵安裝的信任鏈：版本固定腳本內嵌產物 digest

發行包放在公開 repository 的 GitHub Releases。每個 release 另產出一份內嵌該版本 archive SHA-256 的 `install.sh` 資產；使用者執行的一行安裝命令固定指向某個版本的腳本 URL，信任起點是該 URL 的 TLS，腳本在解壓前比對 digest，不符即中止。GitHub artifact attestation 同時產出，供稽核者以 `gh attestation verify` 另行確認產物來自哪個 workflow 與 source commit。

曾選擇以 attestation 作為安裝時的驗證，但驗證需 `gh` 或 cosign，Ubuntu 預設皆無，違反「空白主機不需額外工具」；下載固定 digest 的 cosign 再驗證會增加一段信任鏈與維護成本；自管 minisign／GPG 公鑰則需要私鑰保管與輪替流程。本決策的誠實邊界是：內嵌 digest 只證明下載內容與該版本腳本一致，不獨立證明來源；文件不得把 checksum 描述為來源證明，來源證明由 attestation 承擔。

**Falsified if:** 安裝命令改為指向不固定版本的腳本（例如 latest）而仍宣稱內容一致性；或發行 workflow 產出的 `install.sh` 不再內嵌 archive digest；或受支援平台預設即提供可驗證 attestation 的工具，使安裝時驗證來源不再需要額外依賴。
