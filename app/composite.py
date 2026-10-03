"""背景图片合成预览 —— 把当前有效的最佳叠序应用到上传的背景图上。

- 仅接受不超过 2 MiB、宽高各不超过 512 像素的 RGB 模式 PNG
- 固定使用请求给定的完整底→顶顺序（每个图层恰好一次且满足全部先后关系），
  不重新择序、不缩放、不改写任何校准输入
- 把图片的每个像素当作不透明背景色，逐像素复用 core 中的 sRGB ↔ 线性光
  转换与线性光 "over" 合成（不透明底版：c' = 层色·α + c·(1−α)，与
  core.over 在底层 α=1 时逐通道等价），再按现有 HEX 取整规则
  （clamp 后 int(round(v))）输出同尺寸 RGB PNG
"""

from __future__ import annotations

import io
import json
from typing import Any

from PIL import Image, UnidentifiedImageError

from .core import (
    CalibrationError,
    _err,
    _parse_inputs,
    _raise_if_cycle,
    linear_to_srgb,
    srgb_to_linear,
    _clamp01,
)

MAX_IMAGE_BYTES = 2 * 1024 * 1024  # 2 MiB
MAX_IMAGE_SIDE = 512

# sRGB 8 位 → 线性光查找表（与 core.srgb_to_linear 同一函数）
_SRGB8_TO_LIN = [srgb_to_linear(i / 255.0) for i in range(256)]


class CompositeError(CalibrationError):
    """合成预览输入校验失败（errors 为可直接展示的中文错误列表）。"""


def _parse_order(
    raw_order: Any, n: int, id_set: set[str]
) -> tuple[list[str], list[dict[str, Any]]]:
    """校验「恰好包含全部图层 ID 各一次」的底→顶顺序，返回 (ID 序列, 错误)。"""
    errors: list[dict[str, Any]] = []
    if not isinstance(raw_order, list):
        errors.append(
            _err("order", "缺少 order 列表或其格式不正确：必须按底→顶顺序给出全部图层 ID")
        )
        return [], errors
    if len(raw_order) != n:
        errors.append(
            _err("order", f"order 必须恰好包含全部 {n} 个图层 ID（各一次），当前 {len(raw_order)} 个")
        )
    order_ids: list[str] = []
    seen: set[str] = set()
    for x in raw_order:
        if not isinstance(x, str) or not x.strip():
            errors.append(_err("order", f"order 中的图层 ID 非法：{x!r}（必须是已存在的图层 ID）"))
            continue
        x = x.strip()
        if x not in id_set:
            errors.append(_err("order", f"order 中的图层 ID 不存在：{x!r}"))
        elif x in seen:
            errors.append(_err("order", f"order 中图层 ID 重复：{x}，每个图层必须且只能出现一次"))
        else:
            seen.add(x)
        order_ids.append(x)
    return order_ids, errors


def _decode_image(data: bytes) -> Image.Image:
    """按页面契约解码上传图片：PNG、RGB、≤2MiB、宽高均 ≤512，否则中文报错。"""
    if not data:
        raise CompositeError([_err("image", "缺少背景图片文件：请上传一张 PNG 图片")])
    if len(data) > MAX_IMAGE_BYTES:
        raise CompositeError(
            [
                _err(
                    "image",
                    f"图片体积 {len(data)} 字节超出 2 MiB（{MAX_IMAGE_BYTES} 字节）上限，请压缩或裁剪后重试",
                )
            ]
        )
    try:
        img = Image.open(io.BytesIO(data))
        img.load()  # 强制完整解码，截断 / 损坏文件在此处暴露
    except (UnidentifiedImageError, OSError, ValueError):
        raise CompositeError(
            [_err("image", "图片已损坏或无法解码：请确认上传的是完整、未加密的 PNG 图片")]
        )
    if img.format != "PNG":
        raise CompositeError(
            [_err("image", f"图片格式必须是 PNG，实际为 {img.format or '未知格式'}（不接受 JPEG / GIF / WebP 等）")]
        )
    if img.mode != "RGB":
        raise CompositeError(
            [
                _err(
                    "image",
                    f"图片必须是 RGB 模式 PNG，实际为 {img.mode} 模式（请先转换为 RGB，不接受索引色 / RGBA / 灰度 / 黑白）",
                )
            ]
        )
    w, h = img.size
    if w > MAX_IMAGE_SIDE or h > MAX_IMAGE_SIDE:
        raise CompositeError(
            [
                _err(
                    "image",
                    f"图片尺寸 {w}×{h} 超出上限：宽、高均不得超过 {MAX_IMAGE_SIDE} 像素（服务端不会缩放，请自行裁剪）",
                )
            ]
        )
    return img


def composite_preview(payload: Any, image_data: bytes) -> tuple[bytes, list[str], int, int]:
    """按固定底→顶顺序把图层叠到背景图每个像素上，返回 (PNG 字节, 顺序 ID, 宽, 高)。

    顺序固定、不重新择序；图层 / 样本 / 关系的解析与校验完全沿用 core
    （非法参数按原 scope 报错）；输出与输入同尺寸，不缩放。
    """
    parsed, errors = _parse_inputs(payload)

    n = len(parsed.ids)
    id_set = {lid for lid in parsed.ids if lid}
    raw_order = payload.get("order") if isinstance(payload, dict) else None
    order_ids, order_errors = _parse_order(raw_order, n, id_set)
    errors.extend(order_errors)

    if errors:
        raise CompositeError(errors)
    _raise_if_cycle(parsed)

    order_idx = [parsed.seen_ids[x] for x in order_ids]

    # 顺序必须符合全部先后关系（与 infer_opacities / plan_transition 同口径）
    pos = [0] * n
    for p, idx in enumerate(order_idx):
        pos[idx] = p
    for li, ui in parsed.pairs:
        if pos[li] >= pos[ui]:
            raise CompositeError(
                [
                    _err(
                        "order",
                        f"所给顺序不符合先后关系：{parsed.ids[li]} 必须在 {parsed.ids[ui]} 下方（底 → 顶）",
                    )
                ]
            )

    img = _decode_image(image_data)
    w, h = img.size

    # ---- 解码为线性光分通道数组（查表等价于逐像素 srgb_to_linear）----
    raw = list(img.getdata())
    r_lin = [_SRGB8_TO_LIN[px[0]] for px in raw]
    g_lin = [_SRGB8_TO_LIN[px[1]] for px in raw]
    b_lin = [_SRGB8_TO_LIN[px[2]] for px in raw]
    del raw

    # ---- 固定顺序逐层 "over"：底层不透明时 out_a 恒为 1，
    # core.over 的逐通道结果即 c' = tc·α + c·(1−α)；α=0/1 走捷径 ----
    for idx in order_idx:
        a = parsed.alphas[idx]
        if a <= 0.0:
            continue
        lr, lg, lb = parsed.lins[idx]
        if a >= 1.0:
            r_lin = [lr] * len(r_lin)
            g_lin = [lg] * len(g_lin)
            b_lin = [lb] * len(b_lin)
            continue
        keep = 1.0 - a
        r_lin = [lr * a + v * keep for v in r_lin]
        g_lin = [lg * a + v * keep for v in g_lin]
        b_lin = [lb * a + v * keep for v in b_lin]

    # ---- 转回 sRGB 并按现有 HEX 取整规则（与 core._sample_details 逐位一致）----
    total = len(r_lin)
    out = bytearray(total * 3)
    k = 0
    for i in range(total):
        out[k] = max(0, min(255, int(round(_clamp01(linear_to_srgb(r_lin[i])) * 255.0))))
        out[k + 1] = max(0, min(255, int(round(_clamp01(linear_to_srgb(g_lin[i])) * 255.0))))
        out[k + 2] = max(0, min(255, int(round(_clamp01(linear_to_srgb(b_lin[i])) * 255.0))))
        k += 3

    out_img = Image.frombytes("RGB", (w, h), bytes(out))
    buf = io.BytesIO()
    out_img.save(buf, format="PNG")
    return buf.getvalue(), order_ids, w, h


def parse_payload_field(raw: Any) -> Any:
    """解析 multipart 表单中的 JSON 文本字段（当前校准输入 + 完整 order）。"""
    if not isinstance(raw, str) or not raw.strip():
        raise CompositeError(
            [_err("form", "缺少 payload 表单字段：应为包含当前校准输入与 order 的 JSON 文本")]
        )
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise CompositeError([_err("form", "payload 字段不是合法的 JSON")])
