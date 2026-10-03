"""从背景图与叠层实测图的对应像素提取校准样本对。

- 两张图均复用 composite 的页面契约：PNG、RGB 模式、不超过 2 MiB、宽高各
  不超过 512 像素；两图尺寸还必须完全一致
- 取点为左上角原点的零基整数坐标，1～4 个互异位置（解析规则见
  core.parse_pick_points）
- 直接读取两图对应像素的原始 8 位 RGB（不插值、不合成），按提交顺序返回
  坐标与背景 / 目标 HEX；纯查询，不改动任何校准输入
"""

from __future__ import annotations

from typing import Any

from .composite import _decode_image
from .core import CalibrationError, _err, parse_pick_points


class ExtractError(CalibrationError):
    """取点提取输入校验失败（errors 为可直接展示的中文错误列表）。"""


def _decode_upload(data: bytes, scope: str, label: str) -> Any:
    """解码一张上传图：复用 composite 的页面契约，仅把错误 scope 与措辞换成对应图片。

    composite._decode_image 的报错均以「图片」开头（空文件时为「缺少背景图片」），
    这里按已知前缀替换为「背景图」/「实测图」，其余内容原样保留。
    """
    try:
        return _decode_image(data)
    except CalibrationError as exc:
        relabelled: list[dict[str, Any]] = []
        for e in exc.errors:
            msg = e["message"]
            if msg.startswith("缺少背景图片"):
                msg = "缺少" + label + msg[len("缺少背景图片"):]
            elif msg.startswith("图片"):
                msg = label + msg[len("图片"):]
            relabelled.append({**e, "scope": scope, "message": msg})
        raise ExtractError(relabelled)


def extract_sample_pairs(
    background_data: bytes, measured_data: bytes, raw_points: Any
) -> dict[str, Any]:
    """从两张同尺寸 RGB PNG 的对应像素提取「背景 / 目标」颜色对。

    返回 {"width", "height", "pairs"}，pairs 按取点提交顺序，每项为
    {"x", "y", "background", "target"}（HEX 为两图该像素的原始 RGB，
    不插值、不合成）。任何校验失败抛 ExtractError（HTTP 400），不产生部分结果。
    """
    errors: list[dict[str, Any]] = []

    bg_img = me_img = None
    try:
        bg_img = _decode_upload(background_data, "background", "背景图")
    except ExtractError as exc:
        errors.extend(exc.errors)
    try:
        me_img = _decode_upload(measured_data, "measured", "实测图")
    except ExtractError as exc:
        errors.extend(exc.errors)

    # 两图尺寸必须完全一致；任一图片非法时无法判定边界，取点只做结构 / 重复检查
    width = height = 0
    if bg_img is not None and me_img is not None:
        bw, bh = bg_img.size
        mw, mh = me_img.size
        if (bw, bh) != (mw, mh):
            errors.append(
                _err(
                    "measured",
                    f"两张图片尺寸不一致：背景图 {bw}×{bh}，实测图 {mw}×{mh}，请使用同尺寸的两张图",
                )
            )
        else:
            width, height = bw, bh

    if width and height:
        points, point_errors = parse_pick_points(raw_points, width, height)
    else:
        points, point_errors = parse_pick_points(raw_points)
    errors.extend(point_errors)

    if errors:
        raise ExtractError(errors)

    assert bg_img is not None and me_img is not None
    pairs: list[dict[str, Any]] = []
    for x, y in points:
        br, bg_, bb = bg_img.getpixel((x, y))
        tr, tg, tb = me_img.getpixel((x, y))
        pairs.append(
            {
                "x": x,
                "y": y,
                "background": f"#{br:02x}{bg_:02x}{bb:02x}",
                "target": f"#{tr:02x}{tg:02x}{tb:02x}",
            }
        )
    return {"width": width, "height": height, "pairs": pairs}
