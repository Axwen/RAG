# CI-01：Python 依赖漏洞扫描（`services/parser` 的 `uv.lock`）

CI 系列票据编号与 `T*` 产品票据分开：这类工作不改产品行为，只补门禁，不该占用阶段 1
的实施票据号，也不该混进[实施票据地图](../stage1-implementation-tickets.md#ticket-地图)。

## 目的

依赖漏洞门禁目前只覆盖 Node 侧。2026-09-04 换掉 `pnpm audit` 之后（新门禁
[`scripts/check-npm-advisories.sh`](../../../scripts/check-npm-advisories.sh)，直连 npm 的
bulk advisory 端点，见 [ci-cd.md §6.8](../ci-cd.md)），**`services/parser` 的 `uv.lock`
仍然没有任何东西在扫**。

这不是"顺手也扫一下"的锦上添花：Parser 是唯一处理不可信输入的服务（ADR-0032 把解析入口
列为三处注入检测点之一），它的依赖树里有 OCR、图像、XML/Office 解析这一类历史上漏洞密度
最高的库。Node 侧那条门禁绿着，容易让人读成"依赖漏洞已经管住了"，而实际覆盖率是一半。

Dependabot 已经在提 uv 生态的升级 PR（`.github/dependabot.yml` 里 uv 那组），但
**Dependabot version updates 不是漏洞门禁**：它按"有没有新版本"提 PR，不按"当前锁定版本
有没有已知漏洞"阻断。两件事的判据不同，不能互相顶替。

## 范围

- 一条新的门禁脚本（`scripts/` 下，与 `check-npm-advisories.sh` 同一形状），读
  `services/parser/uv.lock`，对已锁定的版本查漏洞库。
- 接进 `.github/workflows/security.yml`：与 npm 侧那条并列，各自独立成步，任一红都能一眼
  看出是哪套生态。
- `package.json` 加 `check:advisories:py`（真调网络，**不进 `verify`**，与 npm 侧同一口径），
  离线自检进 `verify`。
- 文档：`ci-cd.md` §2.3 安全检测表格加一行，`PROJECT_STATE.md`
  「尚未完成且不能假装完成」里那条相应删掉。

## 要先定的三件事

1. **数据源与工具**。三条候选，判据是"能不能离线自检 + 是否引入新的信任对象"：
   - `pip-audit`（PyPA 官方，查 PyPI Advisory DB / OSV）：与生态最贴近，但要在 CI 里装一个
     Python 工具链之外的包。
   - `osv-scanner`（Google，单个 Go 二进制，直接认 `uv.lock`）：像 gitleaks 那样钉版本 +
     sha256 就能用（`scripts/check-secrets.sh` 是现成的样板），不需要 Python 环境，但多一个
     二进制信任对象。
   - 直接查 OSV 的 HTTP API（`POST /v1/querybatch`）：与 npm 侧那条脚本形状完全一致，零新增
     依赖，代价是要自己解析 `uv.lock`（TOML，Python 3.11+ 有 `tomllib`，标准库够用）。
2. **阻断阈值**。npm 侧是 critical 阻断、其余只报告，理由是没有修复版本的传递依赖告警会把
   所有 PR 堵死。Python 侧要不要同一档需要先看真实数量：`uv.lock` 里 `xgboost` 被
   PROBE-002 的二进制模型钉在 `<3.1`（`.github/dependabot.yml` 显式忽略），钉死版本天然更容易
   常年挂着告警。**先量再定，不要抄一个数字**。
3. **CVSS/severity 口径**。OSV 与 PyPI Advisory 的 severity 字段不像 npm advisory 那样总是
   四档齐全，有的条目只有 CVSS 向量没有等级。要么本地换算，要么把"没有等级"当最高档处理
   （与 npm 侧"未见过的枚举值按 critical"同一个方向：宁可多挡一条）。

## 不变量（与 npm 侧保持同一套）

- **取不到数据 ≠ 没有漏洞。** 漏洞库不可达必须失败，不许有任何"忽略 registry 错误"的开关。
- **解析要么对要么响。** 锁文件格式变了要红，不能静默解析出 0 个包然后报"没有漏洞"。
  npm 侧的做法是断言 `lockfileVersion` 与"键数 == `resolution:` 行数"，Python 侧要有等价的
  结构断言（例如 `version` 字段与 `[[package]]` 条目数）。
- **自检离线可跑，且断言有牙。** 桩数据源 + 植入缺陷验证断言真的会红（npm 侧植了三个：
  未知严重度回退、去掉结构守卫、把取不到数据当成没有漏洞）。
- **真调网络的那条不进 `verify`**：`verify` 至今是一批完全离线的本地检查。

## 完成判据

- `security.yml` 上有一条独立的 Python 依赖漏洞步骤，在真 runner 上绿过一次，并且用一份
  含已知漏洞版本的桩锁文件红过一次（两个方向都要证）。
- 离线自检在 `verify` 里，且植入缺陷能让它红。
- `PROJECT_STATE.md` 里"Python 依赖没人扫"那条被删掉，而不是被改成"部分完成"。
