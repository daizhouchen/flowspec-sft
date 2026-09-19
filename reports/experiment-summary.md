# FlowSpec 实验汇总

实验前缀：`qwen3-1.7b-diverse`；Adapter：`artifacts/qwen3-1.7b-qlora-diverse`。

| 方案 | Schema | DAG | 沙箱 | 工具 F1 | 参数 F1 | 依赖边 F1 | 语义结构 | 平均延迟 ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 启发式基线 | 1.0 | 1.0 | 1.0 | 0.873 | 0.8661 | 0.775 | 0.838 | — |
| Qwen3-1.7B zero-shot | 0.668 | 0.668 | 0.5 | 0.2513 | 0.0015 | 0.0 | 0.0843 | 201.88 |
| Qwen3-1.7B few-shot | 0.852 | 0.852 | 0.852 | 0.7061 | 0.7192 | 0.5952 | 0.6735 | 2614.3 |
| Qwen3-1.7B QLoRA | 1.0 | 1.0 | 1.0 | 0.8558 | 0.8438 | 0.6795 | 0.793 | 1825.97 |
| Qwen3-1.7B QLoRA（挑战集） | 1.0 | 1.0 | 1.0 | 0.8183 | 0.8008 | 0.3759 | 0.665 | 2224.0 |

## 验收门槛

- 通过：`schema_at_least_0_95`
- 通过：`dag_at_least_0_90`
- 通过：`sandbox_at_least_0_80`
- 通过：`semantic_gain_vs_few_shot_at_least_0_08`

SFT 相对 few-shot 的沙箱通过率变化：`+0.1480`。
SFT 相对 few-shot 的语义结构得分变化：`+0.1195`。

## CPU 量化模型

- 文件：`artifacts/gguf/flowspec-qwen3-1.7b-q4_k_m.gguf`
- 大小：`1107408736` bytes
- SHA-256：`cb9ce8cde4b3f733b2c97fa43966517914a841e08a8eaffee303af74962ce0a3`

## 端到端部署验证

- CPU 单轮冒烟：`6373` ms
- FastAPI 编译：`70745.19` ms
- 工作流节点：`5`
- 校验 / 沙箱：`schema_valid_and_dag_valid` / `completed`
