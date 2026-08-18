# LRC Editor AI 对轴引擎

[English](./README.md)

本目录是随 [LRC Editor](https://lrc.sgmy.org) 可选本机 AI 对轴组件分发的最小固定引擎快照。

这里只包含运行时需要的 Python 包与本机服务资源，不包含训练数据、基准测试、开发输出、测试样本或原始仓库历史。

配套安装器会建立私有 Python 环境，从官方来源下载模型，并把模型与任务缓存目录放在引擎目录之外。网页不会把本机音频或歌词上传到 LRC Editor 网站。

## 许可证

MIT License，详见 [LICENSE](./LICENSE)。
