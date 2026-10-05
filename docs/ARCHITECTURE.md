# 架构与设计图

## 系统架构
```mermaid
flowchart LR
 U[客户 / 管理员 / 审计员 / 代理] --> UI[Render 网页]
 UI --> MM[MetaMask 用户签名]
 MM --> C[Sepolia 四合约]
 UI --> API[Render Node REST API]
 API --> DB[(Postgres 持久数据库)]
 API -->|只读 RPC 与回执核验| C
 UI -.->|内置示例：无链上交易| EX[静态演示数据]
```

## 合约交互
```mermaid
flowchart TD
 E[RemittanceEscrow] -->|角色与审核检查| R[ParticipantRegistry]
 T[DemoUSD] -->|faucet 客户资格| R
 B[CorridorBook] -->|管理员权限| R
 E -->|参考汇率及费用| B
 E -->|transferFrom 存入 / transfer 退出| T
```

## 数据模型
```mermaid
erDiagram
 WALLET ||--o{ INVOICE : owns
 WALLET ||--o{ SESSION : authenticates
 WALLET ||--o{ RECEIPT : submits
 INVOICE { string id_PK string owner string recipient string memo string amount bigint created }
 SESSION { string hash_PK string address bigint expires }
 CHALLENGE { string address_PK string nonce string message bigint expires }
 RECEIPT { string id_PK string owner string tx_UNIQUE bigint chain bigint block string gas bigint created }
 REMITTANCE { uint id_PK address sender address recipient uint amount uint fee uint destination uint rate bytes32 referenceHash uint64 deadline enum status bytes32 attestation }
 INVOICE ||--o| REMITTANCE : referenceHash
```
WALLET 是逻辑实体；钱包身份和权限实际存在合约中。数据库不包含 WALLET 或 REMITTANCE 表。INVOICE 与 REMITTANCE 的关系由随机 id 的哈希关联，无 SQL 外键。

## 汇款状态流程
```mermaid
stateDiagram-v2
 [*] --> Pending: create / batchCreate 与代币托管原子完成
 Pending --> Completed: 收款人到期前 claim
 Pending --> Cancelled: 发送者 cancel
 Pending --> Refunded: 到期后发送者 refundExpired
 Pending --> Disputed: 双方之一到期前 dispute
 Disputed --> Completed: 管理员 resolve release
 Disputed --> Refunded: 管理员 resolve refund
 Completed --> [*]
 Cancelled --> [*]
 Refunded --> [*]
```
Paused 只影响 create 和 batchCreate；Attested 是 Completed 的附加记录，不改变资金状态。Disputed 不存在自动到期退款，以防两条退出路径重复支付。

## 用户界面导航
```mermaid
flowchart TB
 LOGIN[连接钱包与签名登录] --> HOME[汇款工作台：报价 / 余额 / 通道图]
 HOME --> HISTORY[交易与凭证：领取 / 退出 / 争议 / 草稿]
 HOME --> BATCH[企业批量付款：20笔上限与原子提交]
 HOME --> OPS[管理与审计：注册 / 授权 / 权限 / 通道 / 日志]
 HOME --> GUIDE[使用指南与部署地址]
 OPS --> ADMIN[管理员：审核与争议裁定]
 OPS --> AUDIT[审计员：核验回执]
 OPS --> AGENT[代理：模拟出金凭证哈希]
```

金额：amount、fee 为 6 位小数 dUSD 微单位，rate 是每测试美元对应目的地币种的 6 位小数参考汇率。destination=(amount-fee)*rate/1e6，是参考额，不是链上另一币种余额。

资金不变量：托管 token 余额 = Pending 和 Disputed 的 amount 总和 + earnedFees（正常合约操作路径；外部直接捐赠 token 会使余额更大，安全审计应检查 >= 而非在所有输入下要求相等）。费用仅在完成领取或裁定放款时记账。
