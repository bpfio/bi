---
name: pdf-extract
description: 部委公报 PDF 双栏版面抽取技能。当需要从部委公报、白皮书、统计公报类双栏排版的 PDF 中按阅读顺序抽取文本(左栏读完读右栏),或需要剥离页眉页脚、剔除页码噪声时使用。触发条件:公报/白皮书类双栏 PDF 入库前、全文检索抽文乱序(右栏句子插进左栏)时、需要把版面 JSON 转成连续正文时。
---

# pdf-extract:部委公报双栏版面抽取技能

本技能处理的是**版面几何**,不是 OCR:输入是已解析的文本块 bounding box
(`pdftotext -bbox-layout` / pdfplumber / 自有解析器产出的版面 JSON),
输出是符合人类阅读顺序的正文。配套脚本:`scripts/pdf_extract.py`。

## 一、版面假设与抽取规则

| # | 规则 | 启发式 |
|---|------|--------|
| 1 | 栏切分 | 按页宽均分 N 栏(缺省 N=2);文本块按**中心点 x** 归栏,不用块左缘(跨栏标题、通栏表格行以中心落点归栏,避免切碎) |
| 2 | 页眉剥离 | 丢弃 y1 < header_ratio×页高(缺省 0.06)的块;另剥匹配 `第X页/共Y页`、`\d+`、`\d+-\d+` 的纯页码块 |
| 3 | 页脚剥离 | 丢弃 y0 > footer_ratio×页高(缺省 0.94,即页高 94% 以下视为页脚带)的块 |
| 4 | 阅读顺序 | 逐页:先左栏后右栏;栏内按 (y0, x0) 升序;通栏块(宽度 > 栏宽×0.9,如大标题)排在双栏内容之前 |
| 5 | 栏数可配 | --columns 1/2/3;判定不准时优先调 header/footer ratio,其次才动栏数 |

## 二、抽取纪律

- 抽取结果必须保留页边界:正文里页与页之间不粘连,便于回溯原文页码。
- 跨栏元素(通栏标题、表格)强行按栏切分会把一句话劈成两半——凡块宽超栏宽
  90% 一律按通栏处理,整块进阅读序,不参与切栏。
- 抽完自查:正文首行应是标题或"〇/一、"类序号,不应是页眉残留("XX部公报"重复串)。

## 三、脚本用法(pdf_extract.py)

```bash
# 输入:版面 JSON(每页含 width/height 与 blocks[{x0,y0,x1,y1,text}]),标准库实现,零依赖
python3 scripts/pdf_extract.py 公报.json --columns 2

# 自定义页眉页脚比例(页眉带正文时调小 header_ratio)
python3 scripts/pdf_extract.py 公报.json --header-ratio 0.04 --footer-ratio 0.92

# JSON 输出(保留页码与块序,供下游管线)
python3 scripts/pdf_extract.py 公报.json --format json
```

输入 JSON 形状:`{"pages": [{"page": 1, "width": 595, "height": 842,
"blocks": [{"x0": 60, "y0": 90, "x1": 280, "y1": 120, "text": "..."}]}]}`。
退出码:0 = 成功;2 = 用法/输入不合法。
