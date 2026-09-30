# 复用与观测

在判断历史证明是否可复用、准备重试或报告缓存效果时读本文件。

## 复用判定

区分三类缓存：Provider 前缀缓存影响计费/延迟；归档去重影响存储；验证复用要求历史确定性验证原始证据。前两项不能推出第三项。

`reuse_key` 以版本化的规范 JSON（UTF-8、键排序、固定分隔符、禁止非有限数值）求 SHA-256，包含：

1. 案例、目标 ID，以及目标、定义和完整假设的源文件路径与内容哈希。
2. 证明源文件和完整传递依赖的路径、内容哈希、依赖边及原始定位信息；目标到形式化声明的对应关系也纳入必需材料。
3. 工具链、库/锁文件与实际导入环境版本，包括当前验证策略要求的可信计算基边界。
4. 验证策略的明确版本及策略实现/配置的内容哈希。

任一绑定不同则历史回执不适用于当前精确目标，重新验证受影响部分。任何未知/缺失版本、未审查依赖图、无法读取或校验的历史证据都不能支持自动接受。字符串相同也必须检查它记录的确实是本次实际环境。不能只凭文件修改时间、Git 分支名或模型相似度判定。

相同键时仍核查：历史回执是否来自真正执行的验证器；原始命令、退出码、stdout/stderr、目标声明及全部输入绑定是否齐全；回执完整性与来源是否可信；当时的策略和当前策略是否一致；本次是否有影响目标语义的新异议。必要时重跑。助手不能填造成功字段。

建议输出独立记录 `reuse-assessment.json`：`candidate_key`、`historical_receipt_locator`、`checked_bindings`、`missing_or_mismatched_bindings`、`open_objections`、`decision`、`reason`。`decision` 可为 `candidate_only`、`rerun_required`、`ineligible`；只有真正的项目验证/回执接收接口才能产生其认可的复用状态。技能本地工具没有这项权限。

在 MathResearch 中，Gate K 仍决定 `machine_verified`。兼容性、传递公理、语义重述、受信任工具链、导入来源和当前核心库限制均以当前实现和项目合同为准。散列相同不能绕过 Gate K，现有策略不接受的库也不能通过旧缓存转为可接受。

## 失败记忆

`failure_key` 在精确 `reuse_key` 之外绑定 `resource_boundary` 和 `attempt_strategy`。保存：案例/目标/阶段/尝试 ID，资源限额与实际用量、Provider/模型、采样与推理参数或实际命令、随机种子（可用时）、输入/输出和日志哈希、验证策略、失败类别、停止原因。

类别可用 `syntax`、`library_api`、`resource_limit`、`semantic_mismatch`、`mathematical_gap`、`provider_unavailable`、`unknown`。类别必须有原始日志支撑，不从“未解决”反推错误类型。

相同版本、策略和资源边界的失败用于避免重复尝试；保留历史成本和未知状态。版本、证明、方法或已授权资源改变后可建立新尝试，并记录具体变化。随机生成的一次失败不表示所有同配置尝试必败。超时、预算耗尽、有限搜索未找到、证明编译失败都不构成反例或数学不可能性证明。

## 前缀与真实命中率

稳定角色契约和目标材料尽量保持字节及消息边界一致；不要把包 ID、时间或全清单哈希提前到稳定正文之前。按角色和实际 Provider/模型分别比较。前缀变化率是本地布局观测，不能替代 Provider 实测命中。

每次真实请求保存最终负载哈希、包 ID、Provider/模型、响应 ID、原始 usage 的定位及哈希；记录输入 token、缓存命中输入 token、未命中输入 token（若报告）、输出、推理 token 的计费语义、耗时。缺失写 `null`，不补零；推理 token 已含于输出时不重复计费。

读取当前适配器的 usage 字段；不要根据过期字段名猜测。MathResearch 的 `research_budget.normalize_usage` 可帮助归一化，但要保留原始 usage 并检查数值一致性。脚本 `usage` 只聚合以下已经核实的归一化 JSONL，不调用网络，也不证明记录的真实性：

```json
{"provider":"actual-provider","model":"actual-model","response_id":"actual-id","request_sha256":"actual-sha256","input_tokens":1000,"cached_input_tokens":600,"usage_source":{"path":"receipts/response.json","sha256":"actual-sha256"}}
```

```sh
python3 /absolute/skill/scripts/package_evidence.py usage /absolute/usage.jsonl
```

同一 Provider/模型/响应 ID 去重；冲突记录排除并报告，缺少 ID 或来源定位的记录不计为可观测命中。按 Provider/模型列出总请求数、有效配对 usage 的请求数和覆盖率。仅在有效的输入/命中 token 配对上计算 `sum(cached_input_tokens) / sum(input_tokens)`；分母为零或没有有效数据时结果为 `null`。这不是对缺失部分的估计。

没有真实调用时报告“尚无实际命中统计”。合成测试不能作为节省证据。有价格时按确切模型、时段、币种和价格快照核算可归属成本；缓存 token 比例不等于整个研究流程的节省比例。要声称优化效果，需报告可比目标/角色/模型、样本范围、usage 覆盖率和前后数据，保留预算内失败成本。
