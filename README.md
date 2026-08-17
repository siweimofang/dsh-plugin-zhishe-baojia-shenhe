# dsh-plugin-zhishe-baojia-shenhe

知设装修报价审核插件 — 装修报价单智能审核与风险识别。

> **状态：占坑（v0.1.0）**，核心功能开发中。

## 规划功能

- **异常单价识别**：对标地区基准价，标记偏离过高的项目
- **漏项检测**：根据房型/面积/档次，检查常见漏报项目
- **工程量合理性校验**：核对工程量与面积的比例关系
- **地区价格对标**：结合城市系数给出参考价区间

## 部署平面

- **目标平面**: 会话级工具插件（形态 A）
- **对外发布服务**: 否，仅注册 DSH 工具
- **兼容版本**: `@deepseek-ai/dsh >= 0.1.0-rc.6`

## 安装

```bash
cd dsh-plugin-zhishe-baojia-shenhe
npm install
```

注册到 profile：

```bash
dsh plugin --profile <profile> add ./dsh-plugin-zhishe-baojia-shenhe
```

## License

MIT
