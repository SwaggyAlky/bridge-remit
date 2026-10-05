# Render 和 Sepolia 部署指南

## 当前状态

项目本地构建与测试完成，尚未取得公开 URL。实际检查 Render 浏览器显示登录页，需要账号登录。此文档是部署步骤，不是部署成功证明。

## 1 准备代码仓库

将 BridgeRemit 文件夹内容作为 GitHub 仓库根目录。必须包含 package.json、pnpm-lock.yaml、pnpm-workspace.yaml、render.yaml、contracts、scripts、server、public、tests。不要提交 node_modules、data、deployment.local.json、.env、日志和私钥。GitHub 的提交记录与个人贡献必须反映真实工作，不可用自动生成文件伪造历史。

## 2 部署测试网合约

准备单独的测试钱包及 Sepolia ETH。按 README 设置本地 RPC_URL 与 DEPLOYER_PRIVATE_KEY，运行 `pnpm build` 和 `pnpm deploy:sepolia`。该脚本先验证 Sepolia，部署 Registry → DemoUSD → CorridorBook → Escrow，配置三个通道。管理员是部署钱包。生成的 deployment.sepolia.json 只有公共元数据，应提交仓库。

人工替代：在 Remix 用 contracts/BridgeRemit.sol、Solidity 0.8.30、optimizer 200、viaIR、Shanghai 配置编译。先部署 ParticipantRegistry，再部署 DemoUSD(registry)、CorridorBook(registry)、RemittanceEscrow(registry,token,book)。随后 setCorridor 配置 ethers.id('SG-PH') 等通道。地址和 ABI 需写成 scripts/deploy.mjs 的输出格式。没有记录交易 hash 的配置只能证明地址配置，最终须在区块浏览器验证部署交易。

## 3 创建 Render Blueprint

登录 https://dashboard.render.com ，选择 New → Blueprint，关联 GitHub 仓库，读取 render.yaml。模板选择免费 Web 和免费 Postgres。创建前确认 Render 显示的费用；若免费计划不可用、需要升级或要求付费，先停在计划选择处，不要默认开通付费资源。

输入 APP_ORIGIN 为实际 HTTPS 服务 URL，例如 https://bridge-remit-你的后缀.onrender.com；RPC_URL 为 Sepolia RPC。可以先创建服务，获得最终 URL 后更正 APP_ORIGIN 并重新部署。DATABASE_URL 通过 Blueprint 注入；不要上传部署密钥。DEPLOYMENT_FILE 保持 deployment.sepolia.json。

构建命令为 corepack enable && pnpm install --frozen-lockfile && pnpm run build。启动命令为 node server/index.mjs。服务监听 0.0.0.0 和 PORT，/health 检查数据库。没有合约配置时网站可以展示示例，chainConfigured=false；该状态不能作为完整 DApp 上线验收。

## 4 验收与记录

| 检查 | 通过标准 | 实际证据 |
|---|---|---|
| Render | 公开 URL 使用 HTTPS，页面和 /health 返回成功 | 待填写 |
| 数据库 | 重启 Web 后草稿及核验回执仍保留 | 待填写 |
| 合约 | Sepolia 四个地址存在字节码，部署钱包是管理员 | 待填写 |
| 登录 | MetaMask 消息签名成功，切换钱包后会话隔离 | 待填写 |
| 汇款 | 客户 A 创建，客户 B 领取，余额与费用一致 | 待填写 |
| 权限 | 客户读审计接口被拒绝，审计员成功 | 待填写 |
| 批量 | 一笔非法收款地址使整批失败，无部分扣款 | 待填写 |
| 争议 | 争议后不能领取和到期退款，管理员正确裁定 | 待填写 |

部署后将 URL、四个地址、网络、部署交易 hash、验证时间、截图链接、测试钱包地址（不含私钥）和实际操作交易 hash 补入报告。

## 常见问题

Origin mismatch：APP_ORIGIN 必须和浏览器地址完全一致，包括 HTTPS、域名与端口，末尾不要加斜杠。Contracts not configured：deployment.sepolia.json 必须已经提交，并设置有效 RPC_URL。启动报无字节码：RPC 网络或地址错误。数据库报错：检查 DATABASE_URL 与数据库是否到期；生产模式禁止回退 SQLite。转账估算失败：检查客户角色、审核、余额、授权、通道状态、截止时间与重复哈希。

免费 Web 服务会休眠，免费 Postgres 有有效期与功能限制，演示前参考 https://render.com/docs/free 核对。正式长期运行需要选择适当付费方案、备份恢复和监控，实际开通由账号所有者确认。
