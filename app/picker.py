"""从背景图与叠层实测图的对应像素提取校准样本。

- 接收两张同尺寸、RGB 模式、不超过 2 MiB、宽高各不超过 512 像素的 PNG
- 接收左上角为原点的零基整数坐标（1～4 个互异位置）
- 按提交顺序返回每个坐标在两张图上的原始像素 RGB（背景、目标）对应 HEX；
  直接读取解码后像素，不插值、不合成、不缩放
- 损坏、非 RGB、尺寸不符、坐标重复或越界等情况均按中文错误列表拒绝
"""

from __future__ import annotations

import io
import json
from typing import Any

from PIL import Image, UnidentifiedImageError

from .core import CalibrationError, _err

MAX_IMAGE_BYTES = 2 * 1024 * 1024  # 2 MiB
MAX_IMAGE_SIDE = 512
MIN_POINTS = 1
MAX_POINTS = 4


class PickerError(CalibrationError):
    """像素取点输入校验失败（errors 为可直接展示的中文错误列表）。"""


def _decode_image(data: bytes, role: str) -> Image.Image:
    """按取点契约解码图片：PNG、RGB、≤2 MiB、宽高均 ≤512，否则中文报错。

    role 为「背景图」/「目标图」，用于区分报错来源。
    """
    if not data:
        raise PickerError(
            [_err("image", f"缺少{role}文件：请通过 multipart 表单字段上传一张 PNG 图片")]
        )
    if len(data) > MAX_IMAGE_BYTES:
        raise PickerError(
            [
                _err(
                    "image",
                    f"{role}体积 {len(data)} 字节超出 2 MiB（{MAX_IMAGE_BYTES} 字节）上限，"
                    "请压缩或裁剪后重试",
                )
            ]
        )
    try:
        img = Image.open(io.BytesIO(data))
        img.load()  # 强制完整解码，截断 / 损坏文件在此处暴露
    except (UnidentifiedImageError, OSError, ValueError):
        raise PickerError(
            [_err("image", f"{role}已损坏或无法解码：请确认上传的是完整、未加密的 PNG 图片")]
        )
    if img.format != "PNG":
        raise PickerError(
            [
                _err(
                    "image",
                    f"{role}格式必须是 PNG，实际为 {img.format or '未知格式'}"
                    "（不接受 JPEG / GIF / WebP 等）",
                )
            ]
        )
    if img.mode != "RGB":
        raise PickerError(
            [
                _err(
                    "image",
                    f"{role}必须是 RGB 模式 PNG，实际为 {img.mode} 模式"
                    "（请先转换为 RGB，不接受索引色 / RGBA / 灰度 / 黑白）",
                )
            ]
        )
    w, h = img.size
    if w > MAX_IMAGE_SIDE or h > MAX_IMAGE_SIDE:
        raise PickerError(
            [
                _err(
                    "image",
                    f"{role}尺寸 {w}×{h} 超出上限：宽、高均不得超过 {MAX_IMAGE_SIDE} 像素"
                    "（服务端不会缩放，请自行裁剪）",
                )
            ]
        )
    return img


def _parse_points(raw: Any, width: int, height: int) -> list[tuple[int, int]]:
    """解析左上角为原点的零基整数坐标：1～4 个、互异、不越界。"""
    errors: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        raise PickerError(
            [_err("points", "缺少 points 列表或其格式不正确：应为 1～4 个 {x, y} 坐标对象")]
        )
    if not (MIN_POINTS <= len(raw) <= MAX_POINTS):
        errors.append(
            _err(
                "points",
                f"取点数量必须在 {MIN_POINTS}～{MAX_POINTS} 个之间，当前 {len(raw)} 个",
            )
        )

    points: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            errors.append(_err("points", "坐标格式不正确，应为包含整数 x、y 的对象", i))
            continue
        x, y = item.get("x"), item.get("y")
        # bool 是 int 的子类，须显式排除；只接受零基整数
        if isinstance(x, bool) or not isinstance(x, int) or isinstance(y, bool) or not isinstance(y, int):
            errors.append(
                _err(
                    "points",
                    f"坐标必须是左上角为原点的零基整数（x、y 均为整数），实际为 {x!r}, {y!r}",
                    i,
                )
            )
            continue
        if x < 0 or y < 0 or x >= width or y >= height:
            errors.append(
                _err(
                    "points",
                    f"坐标 ({x}, {y}) 越界：图片尺寸为 {width}×{height}，"
                    f"x、y 取值范围分别为 0～{width - 1}、0～{height - 1}",
                    i,
                )
            )
            continue
        key = (x, y)
        if key in seen:
            errors.append(_err("points", f"坐标重复：({x}, {y})，每个位置只能选择一次", i))
            continue
        seen.add(key)
        points.append(key)

    if errors:
        raise PickerError(errors)
    return points


def _hex_of(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(rgb[0], rgb[1], rgb[2])


def pick_samples(payload_text: Any, background_data: bytes, target_data: bytes) -> dict[str, Any]:
    """提取两图对应像素的背景 / 目标 HEX 颜色对。

    服务端不保存任何状态、不改动校准输入；只做解码、校验与直接取像素。
    """
    if not isinstance(payload_text, str) or not payload_text.strip():
        raise PickerError(
            [_err("form", "缺少 payload 表单字段：应为包含 points 坐标列表的 JSON 文本")]
        )
    try:
        payload = json.loads(payload_text)
    except (json.JSONDecodeError, TypeError):
        raise PickerError([_err("form", "payload 字段不是合法的 JSON")])
    if not isinstance(payload, dict):
        raise PickerError([_err("form", "payload 必须是 JSON 对象，内含 points 坐标列表")])

    bg_img = _decode_image(background_data, "背景图")
    tg_img = _decode_image(target_data, "目标图")
    width, height = bg_img.size
    if tg_img.size != (width, height):
        raise PickerError(
            [
                _err(
                    "image",
                    f"两张图片尺寸不符：背景图为 {width}×{height}，目标图为 "
                    f"{tg_img.size[0]}×{tg_img.size[1]}，必须选择两张同尺寸 PNG",
                )
            ]
        )

    points = _parse_points(payload.get("points"), width, height)

    bg_px = bg_img.load()
    tg_px = tg_img.load()
    pairs: list[dict[str, Any]] = []
    for i, (x, y) in enumerate(points):
        # 直接读取解码后的原始 8 位 RGB 像素：不插值、不合成
        br, bg, bb = bg_px[x, y]
        tr, tg, tb = tg_px[x, y]
        pairs.append(
            {
                "index": i,
                "x": x,
                "y": y,
                "backgroundRgb": [br, bg, bb],
                "targetRgb": [tr, tg, tb],
                "backgroundHex": _hex_of((br, bg, bb)),
                "targetHex": _hex_of((tr, tg, tb)),
            }
        )

    return {
        "width": width,
        "height": height,
        "pointCount": len(pairs),
        "pairs": pairs,
    }
