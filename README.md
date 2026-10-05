# BridgeRemit 跨境汇款 DApp

面向务工人员家庭汇款与中小企业工资、供应商付款的 SC6113 课程原型。支持钱包签名、链上托管、批量付款、争议处理与审计。四个合约、四种角色和超过十类链上操作。

**交付状态（2026-10-05）：** 合约与 API 本地 24 项测试通过。网页/API 已部署到 [Render](https://bridge-remit.onrender.com)，云端 Postgres 连接正常。当前公开网页为示例查看和部署助手，Sepolia 合约尚未接入，不能进行链上汇款。真实 MetaMask 验证、实际利益相关者反馈和小组贡献记录仍待完成。详见 [公开部署记录](docs/DEPLOYMENT_STATUS.md)。本项目没有真实法币入金、银行出金、真实 KYC 或跨链桥，不应处理真实资金。

## 本地启动

安装 Node.js 24 与 pnpm 11。在本文件所在目录执行：

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm demo
```

打开 http://localhost:3000 。点击“查看示例”可查看无钱包界面。链上操作须使用 MetaMask：添加 RPC `http://127.0.0.1:8545`、Chain ID `1337`、币种 ETH。启动时终端会输出五个一次性测试钱包：Admin、Sender、Recipient、Auditor、Agent。只导入这些临时钱包用于本地测试，不要给它们转入真实资产。重新启动 demo 会重置链；本地数据库中的旧草稿与回执可能仍存在。演示账户已设置角色，两个客户已审核并领取测试币；Sender 需先授权托管合约。

Windows 上若没有 corepack，可安装官方 pnpm，随后执行同样的 pnpm 命令。Ganache 的可选原生模块提示会使用 JavaScript 回退，本次测试在该回退模式通过。

## 页面与流程

1. **汇款工作台：** 通道、费用、法币参考额、个人测试余额、近期记录和通道金额图。
2. **交易与凭证：** 领取、撤销、到期退款、争议、管理员裁定；失败签名产生的草稿可以重试。同一凭证哈希只能付款一次。
3. **企业批量付款：** 每行 `钱包地址,金额,备注`；1–20 笔单笔交易提交，任何失败整批回滚。失败批次生成的数据库草稿可独立支付；它们尚未转款。
4. **管理与审计：** 注册、测试币领取、精确额度授权、权限与审核、通道和费率、暂停、费用提取、代理凭证及审计日志。
5. **使用指南：** 明确链上资金与法币参考额的区别，以及角色和争议信任边界。

## Render 部署

参见 [docs/RENDER_DEPLOYMENT.md](docs/RENDER_DEPLOYMENT.md)。仓库根目录包含 `render.yaml`，托管 Node 网页/API 和持久 Postgres；智能合约在 Sepolia 部署。必须发布本目录内容作为仓库根目录，或相应设置服务 Root Directory。

```powershell
# 仅在本地设置；绝不可提交真实私钥、助记词或 .env。
$env:RPC_URL='你的 Sepolia RPC URL'
$env:DEPLOYER_PRIVATE_KEY='仅用于测试网的部署钱包私钥'
pnpm deploy:sepolia
```

推荐在装有 MetaMask 的浏览器打开 [钱包部署助手](https://bridge-remit.onrender.com/deploy.html)，完成七次测试网交易签名后下载 `deployment.sepolia.json`。它包含公共合约地址、ABI 和交易 hash，可提交到 GitHub，不含私钥。上述命令行方式为替代选择。部署脚本和网页助手均强制 Sepolia 网络；私钥不需要上传 Render。

Render 设置 `APP_ORIGIN=https://实际服务名.onrender.com`，RPC_URL 指向同一 Sepolia 网络，DATABASE_URL 由 Blueprint 数据库注入。部署完成后验证 `/health`、钱包登录、两客户汇款领取与审核日志。Web 的“healthy”不代表钱包、合约或数据库完整流程已验收。

## 合约与链上操作

| 合约 | 作用 | 链上操作 |
|---|---|---|
| ParticipantRegistry | 管理员、客户、审计员、代理；审核状态 | register、setRole、setApproval |
| DemoUSD | 六位小数测试 ERC-20 资产 | faucet、approve、transfer、transferFrom |
| CorridorBook | 演示通道、参考汇率、平台费 | setCorridor |
| RemittanceEscrow | 资金生命周期与费用 | create、batchCreate、claim、cancel、refundExpired、dispute、resolve、attest、setPaused、withdrawFees |

共 18 个可改变链上状态的公开方法；前端直接提供 16 类方法的界面入口，transfer 与 transferFrom 分别可直接调用与由托管合约内部调用。课程演示不要将 register 的不同参数或 setApproval 的 true/false 重复计算成新的方法。

## 安全与限制

- 后端只读链并核验回执，没有交易签名私钥；签名消息绑定站点来源、钱包、Chain ID、一次性 nonce 和有效期。签名认证目前支持普通 EOA 钱包，未接入 ERC-1271 智能账户。
- 会话以哈希保存，生产 Cookie 使用 Secure、HttpOnly、SameSite=Strict；数据库操作参数化，写请求检查 Origin，入口限流、请求体限制、CSP、钱包隔离。
- 金额以整数微美元计算；报价最低到账量与最高费用阻止管理员更新报价后静默提高成本。真正支付的资产是 dUSD，参考目的地币种金额不兑现。
- 先更新资金状态再转移代币。代币为固定、不可升级的自建测试 ERC-20，无转账回调。换成任意外部资产时须重新分析重入、非标准代币和转账税。
- 重复参考哈希、重复领取、重复裁定被拒绝。批量最多 20 笔。暂停和撤销审核不阻止已存入资金的既有退出路径。
- 普通待领取汇款可被发送者取消。争议后只能由唯一管理员裁定，管理员丢失密钥会使争议资金无法退出。真实金融服务必须改为受控治理与恢复机制。
- 审计日志为用户提交并经链上验证的成功回执，不是完整自动区块索引器。链上状态是资金依据；当前网页事件仅展示本次会话已确认回执。两确认不等同最终不可逆，尚无重组回滚索引器。
- 本地限流为单实例内存计数；大规模部署需共享限流、监控、审计索引器、数据库备份和 RPC 故障切换。历史按最多 100 个 ID 的窗口分页读取，大数据需索引服务。
- API 登录与凭证具有单实例/数据库持久性。Render 免费服务的休眠和数据库寿命限制见官方文档，课程演示前唤醒服务并核对数据库是否仍可用。

## 交付资料

`docs/` 包含需求对照、架构和数据模型、Render 指南、用户手册、测试报告、10 分钟演示脚本、技术报告草稿、利益相关者验证表与个人贡献模板。报告仅陈述实际验证；公开部署信息应在部署后补充。

来源：[World Bank RPW Q3 2025](https://remittanceprices.worldbank.org/sites/default/files/2026-04/RPW_main_report_and_annex_Q325.pdf)、[Render Node](https://render.com/docs/deploy-node-express-app)、[Render 免费计划](https://render.com/docs/free)、[Ethereum 网络](https://ethereum.org/developers/docs/networks/)。世界银行全球平均费用是背景数据，不能代替所选通道或本项目的真实端到端费用证据。
