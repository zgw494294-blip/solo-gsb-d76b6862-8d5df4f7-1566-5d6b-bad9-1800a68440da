"""FastAPI 入口：计算接口 + 静态页面托管。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .composite import MAX_IMAGE_BYTES, composite_preview, parse_payload_field
from .core import (
    CalibrationError,
    confirm_cycle_resolution,
    infer_opacities,
    plan_transition,
    resolve_cycle,
    review_measurement,
    solve,
    suggest_background,
)
from .extract import extract_sample_pairs
app = FastAPI(title="透明图层叠序校准台", version="1.7.0")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/solve")
async def api_solve(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = solve(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


@app.post("/api/infer-opacity")
async def api_infer_opacity(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = infer_opacities(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


@app.post("/api/suggest-background")
async def api_suggest_background(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = suggest_background(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


@app.post("/api/review-measurement")
async def api_review_measurement(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = review_measurement(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


@app.post("/api/plan-transition")
async def api_plan_transition(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = plan_transition(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


@app.post("/api/resolve-cycle")
async def api_resolve_cycle(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = resolve_cycle(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


@app.post("/api/confirm-cycle-resolution")
async def api_confirm_cycle_resolution(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = confirm_cycle_resolution(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


@app.post("/api/composite-preview")
async def api_composite_preview(request: Request) -> Response:
    """接收背景图（multipart 表单字段 image）与当前校准输入 + 完整底→顶顺序
    （multipart 表单字段 payload，JSON 文本），固定该顺序逐像素线性光合成，
    返回同尺寸 RGB PNG。任何校验失败均为 400 JSON，不改动任何校准输入。"""
    # 允许单 part 略大于 2 MiB：较新版本 Starlette 默认每 part 上限仅 1 MiB，会在我们
    # 自己的体积校验之前拦截合法图片；这里放宽到上限 +1 字节，超限仍由下方逻辑明确报错。
    # 旧版 Starlette 的 form() 不接受该关键字参数，回退到默认调用即可。
    try:
        try:
            form = await request.form(max_part_size=MAX_IMAGE_BYTES + 1)
        except TypeError:
            form = await request.form()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求必须是 multipart/form-data 表单（含 payload 与 image 字段），或图片体积超过 2 MiB 上限"}]},
        )

    upload = form.get("image")
    if upload is None or not hasattr(upload, "read"):
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "image", "message": "缺少背景图片文件：请通过 multipart 表单字段 image 上传一张 PNG 图片"}]},
        )

    # 多读一个字节用于区分「正好 2 MiB」与「超过 2 MiB」，超限文件不全量读入内存
    data = await upload.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "image", "message": f"图片体积超出 2 MiB（{MAX_IMAGE_BYTES} 字节）上限，请压缩或裁剪后重试"}]},
        )

    try:
        payload = parse_payload_field(form.get("payload"))
        png, order_ids, width, height = composite_preview(payload, data)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})

    headers = {
        "Content-Disposition": 'attachment; filename="composite-preview.png"',
        "X-Composite-Order": json.dumps(order_ids, ensure_ascii=False).encode("ascii", "backslashreplace").decode("ascii"),
        "X-Composite-Width": str(width),
        "X-Composite-Height": str(height),
    }
    return Response(content=png, media_type="image/png", headers=headers)


@app.post("/api/extract-samples")
async def api_extract_samples(request: Request) -> JSONResponse:
    """接收背景图（multipart 字段 background）、叠层实测图（字段 measured）与
    取点坐标（字段 points，JSON 数组文本，元素为 {"x": 零基整数, "y": 零基整数}，
    左上角为原点，1～4 个互异位置），按提交顺序返回每个取点的坐标及两图原始
    RGB 对应的背景 / 目标 HEX。不插值、不合成、不改动任何校准输入；
    任何校验失败均为 400 JSON。"""
    # 与 /api/composite-preview 相同：放宽单 part 上限到 2 MiB + 1 字节，
    # 超限仍由下方逻辑明确报错；旧版 Starlette 回退到默认调用。
    try:
        try:
            form = await request.form(max_part_size=MAX_IMAGE_BYTES + 1)
        except TypeError:
            form = await request.form()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求必须是 multipart/form-data 表单（含 points、background 与 measured 字段），或图片体积超过 2 MiB 上限"}]},
        )

    errors: list[dict[str, Any]] = []
    images: dict[str, bytes] = {}
    for field, scope, label in (
        ("background", "background", "背景图"),
        ("measured", "measured", "实测图"),
    ):
        upload = form.get(field)
        if upload is None or not hasattr(upload, "read"):
            errors.append(
                {"scope": scope, "message": f"缺少{label}文件：请通过 multipart 表单字段 {field} 上传一张 PNG 图片"}
            )
            continue
        # 多读一个字节用于区分「正好 2 MiB」与「超过 2 MiB」，超限文件不全量读入内存
        data = await upload.read(MAX_IMAGE_BYTES + 1)
        if len(data) > MAX_IMAGE_BYTES:
            errors.append(
                {"scope": scope, "message": f"{label}体积超出 2 MiB（{MAX_IMAGE_BYTES} 字节）上限，请压缩或裁剪后重试"}
            )
            continue
        images[field] = data

    raw_points: Any = None
    points_field = form.get("points")
    if not isinstance(points_field, str) or not points_field.strip():
        errors.append(
            {"scope": "points", "message": '缺少 points 表单字段：应为 1～4 个取点坐标的 JSON 数组文本（如 [{"x":0,"y":0}]，左上角为原点）'}
        )
    else:
        try:
            raw_points = json.loads(points_field)
        except json.JSONDecodeError:
            errors.append({"scope": "points", "message": "points 字段不是合法的 JSON"})

    if errors:
        return JSONResponse(status_code=400, content={"errors": errors})

    try:
        result = extract_sample_pairs(images["background"], images["measured"], raw_points)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
