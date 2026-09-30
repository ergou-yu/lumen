# 本地证据包格式

使用脚本前读本文件。依赖图与材料清单由整理者根据原文核查；脚本计算可达性并校验字节，不能发现未登记的数学假设或证明依赖。

## 输入

命令中的脚本路径相对于技能目录。`--root` 是原始材料根目录；`--out` 是新的包目录，已有目录拒绝覆盖。文件路径须在 root 内；指向外部的符号链接也拒绝。先把相关外部文件的完整快照纳入案例，保留原始定位信息。

```sh
python3 /absolute/skill/scripts/package_evidence.py build \
  --root /absolute/case --spec /absolute/package-spec.json \
  --out /absolute/case/evidence-packages/review-01
```

后续包加 `--previous /absolute/previous-package`，从已归档字节计算差异。可设置 `--max-payload-bytes N` 检查消息文件大小；这是字节限制，不能替代接收 Provider 的真实 token 限制。

`package-spec.json` 示例，路径和版本仅示范字段，必须换成实际来源：

```json
{
  "schema_version": "evidence-package-spec/v1",
  "case_id": "example-case",
  "claim_id": "CLM-001",
  "role_contract": "config/critic-contract.txt",
  "target_ids": ["target"],
  "proof_ids": ["proof"],
  "context_ids": ["definitions", "hypotheses"],
  "review_roots": [],
  "artifacts": {
    "target": {"path": "claim.txt", "kind": "target", "dependencies": ["definitions", "hypotheses"]},
    "definitions": {"path": "definitions.txt", "kind": "definition", "dependencies": []},
    "hypotheses": {"path": "hypotheses.txt", "kind": "hypotheses", "dependencies": []},
    "lemma": {"path": "lemma.txt", "kind": "proof", "dependencies": ["definitions"]},
    "proof": {"path": "proof.lean", "kind": "proof", "dependencies": ["target", "lemma"], "locator": {"declaration": "Example.main"}},
    "objection": {"path": "debate/objection-1.txt", "kind": "objection", "dependencies": ["proof"]},
    "toolchain": {"path": "lean-toolchain", "kind": "environment", "dependencies": []},
    "policy": {"path": "verification-policy.txt", "kind": "policy", "dependencies": []},
    "old-notes": {"path": "history/notes.txt", "kind": "history", "dependencies": []}
  },
  "open_objections": [
    {"id": "OBJ-1", "status": "deferred", "scope": "CLM-001", "evidence_ids": ["objection"]}
  ],
  "environment": {
    "toolchain": {"version": "observed exact version", "binary_sha256": "observed SHA-256"},
    "libraries": {"core": "observed sysroot/library digest"},
    "artifact_ids": ["toolchain"]
  },
  "verification_policy": {"version": "observed policy version", "artifact_ids": ["policy"]},
  "resource_boundary": {"wall_time_seconds": 60, "max_heartbeats": 200000, "memory_mb": 2048},
  "attempt_strategy": {"version": "strategy-1", "method": "exact command or generation settings"},
  "dynamic": {"round": 1, "review_question": "核查 OBJ-1 的修复及其依赖"}
}
```

- `artifacts` 是完整研究材料清单，包含本轮不发送的历史版本、响应、验证原始日志、文献原件和失败记录；所有清单文件均原样归档。对照案例目录核查遗漏，不把整个工作区、凭据或无关文件自动当研究材料。原目录中的完整档案也保留。
- `context_ids` 显式列出全部必要定义和假设；若确实没有单独文件，可留空并在目标正文中写清。`dependencies` 方向为“使用者 → 前提”。循环或缺失引用报错；互递归声明可放到同一实际源文件节点，不把循环数学论证压成节点绕过审查。
- `target_ids`、`proof_ids`、`context_ids` 及本轮 `review_roots` 的闭包必须进入请求；所有未关闭异议的证据也进入请求。环境/策略材料始终归档并纳入复用绑定，请求尾部提供版本及来源哈希；本次要审查其实现时，把相应材料加入 `review_roots`，实际注入正文。全局异议过大时先保留完整台账，再按明确目标拆包，并在每个子包保留全局未关闭索引，不私自删异议。
- `locator` 保存原始 URL/DOI/提交号、定理/页码/行号、查询与访问时间，必要时记录提取稿对应原件的哈希和范围。脚本保留该对象；定位范围只用于导航，发送内容始终是所选文件的完整正文。
- 工具链记录实际版本、二进制与 sysroot 标识；库记录精确提交/锁文件/构建产物标识及导入解析环境。`artifact_ids` 必须包含策略源码、配置及相关锁文件的材料节点。未查明版本写 `null`，脚本不会为这类输入生成可比较的复用键。不能把占位示例当已观测版本。
- 必需材料须是 UTF-8 正文。原始 PDF、图片或二进制仍可归档；若选入请求则脚本报错，需要人工核对提取稿或采用支持附件的发送器，并保存原件、提取映射及实际可读附件回执。编码成 base64 不等于模型能审查它。

## 输出与核对

- `blobs/`：清单内全部文件和角色契约的原始字节，按 SHA-256 寻址；`spec.json` 为输入清单的快照。
- `manifest.json` 与 `.sha256`：全部源文件定位、内容哈希、闭包、实际选材/未选材和输出文件哈希。包状态固定为 `packaged_unverified`。哈希能检测变化，不能证明证据真实或依赖完整。
- `prefix.txt`：本轮稳定的目标/定义/假设正文部分；`messages.json`：受信任角色契约在 system 消息，所选原始正文在 user 消息，动态信息在尾部。只发送 prefix 不足以审查证明。
- `delta.json`、`changes.diff`：相对前包的新增、变化、移除、受影响依赖者和依赖边前后值，以及可解码文件的完整 unified diff。首次无基线时只列新增索引，不重复正文；请求只纳入本次选材的差异及上包已发送材料的删除片段。移出清单不代表数学上删除了该依赖；清单变动需核查。
- `reuse.json`：确定性复用绑定、缺失版本原因、失败尝试键。只生成查找键，不核发机器验证结论。

```sh
python3 /absolute/skill/scripts/package_evidence.py verify /absolute/package
```

独立复算哈希；检查最终请求里没有摘要替换、静默截断、遗漏的定义/假设或只有本地文件名的引用。若发送器添加消息/附件或改变排序，另存实际发送负载，统计以实际请求为准。包文件、既有回执及日志不可就地改写；修订另建包并绑定旧包。

项目自身的 `research-evidence/v1` 和该脚本的 `evidence-package/v1` 是不同格式。不要把后者直接传给 `render_evidence` 或写入 commander 状态。需要实际调度器集成时，检查现有接口、实现显式适配并验证端到端正文覆盖。
