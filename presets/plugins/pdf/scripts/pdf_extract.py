#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf_extract —— 部委公报双栏版面抽取骨架(BI-18 / pdf 插件)。

输入:版面 JSON(每页 width/height + 文本块 bounding boxes)。
启发式:按页宽中线切栏(可配栏数)+ 页眉页脚剥离 + 栏内 y 序排序 → 阅读顺序正文。
纯标准库实现,零第三方依赖。

用法:
    python3 pdf_extract.py 公报.json [--columns 2] [--header-ratio 0.06]
                                     [--footer-ratio 0.94] [--format text|json]

退出码:0 = 成功;2 = 用法/输入不合法。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any, Optional

# ---------------------------------------------------------------------------
# 数据形状
# ---------------------------------------------------------------------------

# 版面块:{x0, y0, x1, y1, text};坐标原点按左上,y 向下增长(pdftotext -bbox 惯例)。
Block = dict[str, Any]

PAGE_NUMBER_PATTERNS = (
    re.compile(r"^\d+$"),
    re.compile(r"^\d+\s*[-—–]\s*\d+$"),
    re.compile(r"^第\s*\d+\s*页"),
    re.compile(r"^\d+\s*/\s*\d+$"),
)


def block_center_x(block: Block) -> float:
    return (float(block["x0"]) + float(block["x1"])) / 2.0


def block_width(block: Block) -> float:
    return float(block["x1"]) - float(block["x0"])


def block_text(block: Block) -> str:
    return str(block.get("text", "")).strip()


def is_page_number(block: Block) -> bool:
    text = block_text(block)
    return any(pattern.match(text) for pattern in PAGE_NUMBER_PATTERNS)


# ---------------------------------------------------------------------------
# 启发式三件套:页眉页脚剥离 / 切栏 / 阅读序排序
# ---------------------------------------------------------------------------

def strip_header_footer(
    blocks: list[Block],
    page_height: float,
    header_ratio: float,
    footer_ratio: float,
) -> list[Block]:
    """剥离页眉(y1 < header_ratio×页高)、页脚(y0 > footer_ratio×页高)与纯页码块。"""
    header_line = page_height * header_ratio
    footer_line = page_height * footer_ratio
    kept: list[Block] = []
    for block in blocks:
        y1 = float(block["y1"])
        y0 = float(block["y0"])
        if y1 <= header_line:
            continue  # 页眉
        if y0 >= footer_line:
            continue  # 页脚
        if is_page_number(block):
            continue  # 页码噪声(位置不在页眉页脚带内的兜底剥离)
        kept.append(block)
    return kept


def assign_column(block: Block, page_width: float, columns: int) -> int:
    """按文本块中心点 x 归栏:中心落在第几等分就是第几栏(0 基)。"""
    if columns <= 1:
        return 0
    col_width = page_width / columns
    index = int(block_center_x(block) / col_width)
    return max(0, min(index, columns - 1))


def is_spanning(block: Block, page_width: float, columns: int) -> bool:
    """通栏块判定:块宽超过单栏宽度 90%(大标题、通栏表格行),整块处理不切栏。"""
    if columns <= 1:
        return True
    return block_width(block) > (page_width / columns) * 0.9


def extract_page(
    page: dict[str, Any],
    columns: int = 2,
    header_ratio: float = 0.06,
    footer_ratio: float = 0.94,
) -> list[Block]:
    """单页抽取:剥离 → 通栏块置前 → 各栏按 (y0, x0) 升序拼接。"""
    page_width = float(page["width"])
    page_height = float(page["height"])
    blocks = strip_header_footer(
        list(page.get("blocks", [])), page_height, header_ratio, footer_ratio
    )
    if columns <= 1:
        return sorted(blocks, key=lambda b: (float(b["y0"]), float(b["x0"])))

    spanning: list[Block] = []
    columns_blocks: list[list[Block]] = [[] for _ in range(columns)]
    for block in blocks:
        if is_spanning(block, page_width, columns):
            spanning.append(block)
        else:
            columns_blocks[assign_column(block, page_width, columns)].append(block)

    for column in columns_blocks:
        column.sort(key=lambda b: (float(b["y0"]), float(b["x0"])))

    ordered: list[Block] = []
    for block in sorted(spanning, key=lambda b: (float(b["y0"]), float(b["x0"]))):
        ordered.append(block)
    for column in columns_blocks:
        ordered.extend(column)
    return ordered


def extract_document(
    document: dict[str, Any],
    columns: int,
    header_ratio: float,
    footer_ratio: float,
) -> dict[str, Any]:
    """整册抽取:逐页走 extract_page,输出阅读序文本与 JSON 两种形态共用一份块序。"""
    pages_out: list[dict[str, Any]] = []
    for page in document.get("pages", []):
        ordered = extract_page(page, columns, header_ratio, footer_ratio)
        pages_out.append(
            {
                "page": page.get("page"),
                "blocks": ordered,
                "text": "\n".join(
                    block_text(block) for block in ordered if block_text(block)
                ),
            }
        )
    return {"columns": columns, "pages": pages_out}


# ---------------------------------------------------------------------------
# CLI 入口
# ---------------------------------------------------------------------------

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pdf_extract",
        description="部委公报双栏版面抽取:中线切栏 + 页眉页脚剥离 + y 序排序(零依赖)",
    )
    parser.add_argument("file", help="版面 JSON 路径(- 读 stdin)")
    parser.add_argument("--columns", type=int, default=2, help="栏数,缺省 2")
    parser.add_argument("--header-ratio", type=float, default=0.06, help="页眉带占比,缺省 0.06")
    parser.add_argument("--footer-ratio", type=float, default=0.94, help="页脚起始占比,缺省 0.94")
    parser.add_argument("--format", choices=("text", "json"), default="text", help="输出格式")
    args = parser.parse_args(argv)

    if args.columns < 1:
        parser.error("--columns 必须 >= 1")
        return 2
    if not (0.0 <= args.header_ratio < args.footer_ratio <= 1.0):
        parser.error("要求 0 <= header-ratio < footer-ratio <= 1")

    try:
        if args.file == "-":
            document = json.load(sys.stdin)
        else:
            with open(args.file, "r", encoding="utf-8") as handle:
                document = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[pdf-extract] 输入无法解析: {exc}", file=sys.stderr)
        return 2
    if not isinstance(document, dict) or not isinstance(document.get("pages"), list):
        print('[pdf-extract] 输入形状应为 {"pages": [{"page","width","height","blocks":[...]}]}',
              file=sys.stderr)
        return 2

    result = extract_document(document, args.columns, args.header_ratio, args.footer_ratio)

    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for page in result["pages"]:
            print(f"───── 第 {page['page']} 页 ─────")
            body = page["text"]
            print(body if body else "(本页无可抽取正文)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
