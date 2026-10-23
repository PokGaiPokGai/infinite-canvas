"""Fixed operations run through the existing BlenderMCP execute_code command.

No add-on, handler, timer, or network listener is installed in Blender.
"""
import base64
import hashlib
import json
import os
import tempfile
import uuid
from array import array
from pathlib import Path

import bpy


class LinkError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def state():
    # Blender clears driver_namespace when loading a file. Old bindings then fail closed.
    key = "infinite_canvas_blender_link_v1"
    if key not in bpy.app.driver_namespace:
        bpy.app.driver_namespace[key] = {"sessionId": str(uuid.uuid4()), "writes": {}}
    return bpy.app.driver_namespace[key]


def identity(kind, value):
    return str(uuid.uuid5(uuid.UUID(state()["sessionId"]), kind + ":" + str(value)))


def image_id(image):
    return identity("image", image.session_uid) if image else None


def sources():
    result = []
    for window in bpy.context.window_manager.windows:
        for index, area in enumerate(window.screen.areas):
            if area.type != "VIEW_3D":
                continue
            region = next((r for r in area.regions if r.type == "WINDOW"), None)
            if region and area.spaces.active.region_3d:
                key = identity("viewport", f"{window.as_pointer()}:{area.as_pointer()}")
                result.append(({"id": key, "kind": "viewport", "name": f"视口 · {window.scene.name} · {window.workspace.name} · {index + 1}"}, (window, area, region)))
    image = bpy.data.images.get("Render Result")
    if image:
        result.append(({"id": identity("render", bpy.context.scene.session_uid), "kind": "render", "name": "最近渲染结果"}, image))
    return result


def targets():
    result = []
    for material in bpy.data.materials:
        if not material.use_nodes or not material.is_editable or not material.node_tree.is_editable:
            continue
        for node in material.node_tree.nodes:
            if node.type == "TEX_IMAGE":
                key = identity("target", f"{material.session_uid}:{node.name}")
                result.append(({"id": key, "materialId": identity("material", material.session_uid), "materialName": material.name,
                                "nodeName": node.name, "imageName": node.image.name if node.image else None,
                                "imageId": image_id(node.image), "users": material.users}, (material, node)))
    return result


def images():
    return [(image, {"id": image_id(image), "name": image.name, "width": image.size[0], "height": image.size[1],
                     "users": image.users - int(image.use_fake_user), "colorSpace": image.colorspace_settings.name})
            for image in sorted(bpy.data.images, key=lambda item: item.name.casefold())
            if image.is_editable and image.source in {"FILE", "GENERATED"} and not image.is_multiview
            and not image.is_stereo_3d and all(image.size)]


def pixels_of(image):
    pixels = array("f", [0.0]) * len(image.pixels)
    image.pixels.foreach_get(pixels)
    return pixels


def image_revision(image):
    info = [list(image.size), image.source, image.filepath_raw, image.colorspace_settings.name, image.alpha_mode]
    digest = hashlib.sha256(json.dumps(info).encode())
    digest.update(pixels_of(image))
    return digest.hexdigest()


def copy_current_image(image):
    # Image.copy() alone does not copy unsaved pixel-buffer edits.
    copy = image.copy()
    try:
        if tuple(copy.size) != tuple(image.size):
            copy.scale(*image.size)
        copy.pixels.foreach_set(pixels_of(image))
        copy.update()
        return copy
    except Exception:
        bpy.data.images.remove(copy)
        raise


def image_preview(payload):
    image = next((image for image, info in images() if info["id"] == payload["imageId"]), None)
    if image is None:
        raise LinkError(409, "目标贴图已不可用，请刷新后重新选择。")
    revision = image_revision(image)
    copy = copy_current_image(image)
    try:
        with tempfile.TemporaryDirectory(prefix="infinite-canvas-image-") as folder:
            path = os.path.join(folder, "preview.png")
            copy.file_format = "PNG"
            copy.save(filepath=path, save_copy=True)
            data = Path(path).read_bytes()
        return {"sessionId": state()["sessionId"], "imageId": image_id(image), "revision": revision,
                "width": image.size[0], "height": image.size[1], "imageBase64": base64.b64encode(data).decode("ascii")}
    finally:
        bpy.data.images.remove(copy)


def png_bytes(image, scene):
    # save_render uses scene image settings: use a temporary copy to keep the user's
    # output format, color management, render paths, and Render Result untouched.
    copy = scene.copy()
    try:
        copy.render.image_settings.file_format = "PNG"
        copy.render.image_settings.color_mode = "RGBA"
        copy.render.image_settings.color_depth = "8"
        with tempfile.TemporaryDirectory(prefix="infinite-canvas-read-") as folder:
            path = os.path.join(folder, "snapshot.png")
            image.save_render(path, scene=copy)
            # Render Result does not reliably expose size/pixels through Image.
            # Inspect the encoded image with Blender's decoder instead.
            encoded = bpy.data.images.load(path, check_existing=False)
            try:
                return Path(path).read_bytes(), tuple(encoded.size)
            finally:
                bpy.data.images.remove(encoded)
    finally:
        bpy.data.scenes.remove(copy)


def snapshot(payload):
    entry = next((entry for entry in sources() if entry[0]["id"] == payload["sourceId"]), None)
    if not entry:
        raise LinkError(409, "所选视口或渲染结果已不可用，请刷新后重新选择。")
    info, source = entry
    if info["kind"] == "render":
        try:
            data, (width, height) = png_bytes(source, bpy.context.scene)
        except RuntimeError:
            raise LinkError(409, "最近渲染结果尚无可读取图像，请先在 Blender 中完成一次渲染。")
    else:
        import gpu
        window, area, region = source
        width, height = region.width, region.height
        image = None
        offscreen = None
        try:
            with bpy.context.temp_override(window=window, area=area, region=region):
                space = area.spaces.active
                offscreen = gpu.types.GPUOffScreen(width, height, format="RGBA16F")
                offscreen.draw_view3d(window.scene, window.view_layer, space, region,
                                     space.region_3d.view_matrix, space.region_3d.window_matrix,
                                     do_color_management=False)
                with offscreen.bind():
                    pixels = gpu.state.active_framebuffer_get().read_color(0, 0, width, height, 4, 0, "FLOAT")
                pixels.dimensions = width * height * 4
                image = bpy.data.images.new("Canvas viewport snapshot", width, height, alpha=True, float_buffer=True)
                image.pixels.foreach_set(pixels)
                data, (width, height) = png_bytes(image, window.scene)
        finally:
            if image:
                bpy.data.images.remove(image)
            if offscreen:
                offscreen.free()
    return {"sessionId": state()["sessionId"], "sourceId": info["id"], "sourceName": info["name"],
            "width": width, "height": height, "sha256": hashlib.sha256(data).hexdigest(),
            "imageBase64": base64.b64encode(data).decode("ascii")}


def apply_texture(payload):
    writes = state()["writes"]
    command_id = str(uuid.UUID(payload["commandId"]))
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if command_id in writes:
        previous = writes[command_id]
        if previous["fingerprint"] != fingerprint:
            raise LinkError(409, "同一写回指令不能更换图片或目标。")
        return previous["result"]
    destination = payload["destination"]
    kind = destination["kind"]
    target = node = None
    if kind == "image":
        target = next((image for image, info in images() if info["id"] == destination["imageId"]), None)
        if target is None or image_revision(target) != destination["expectedRevision"]:
            raise LinkError(409, "目标贴图已变化，未写入；请放弃待确认指令，刷新预览后重新写回。")
    elif kind == "node":
        entry = next((entry for entry in targets() if entry[0]["id"] == destination["targetId"]), None)
        if not entry or entry[0]["imageId"] != destination["expectedImageId"]:
            raise LinkError(409, "目标纹理节点已变化，请先检查 Blender，再刷新目标。")
        _, node = entry[1]
    elif kind != "new" or not destination.get("name", "").strip():
        raise LinkError(400, "写回方式或新图片名称无效。")
    data = base64.b64decode(payload["imageBase64"], validate=True)
    if hashlib.sha256(data).hexdigest() != payload["sha256"]:
        raise LinkError(400, "输入图片校验失败。")
    original = node.image if node else None
    previous_fake_user = original.use_fake_user if original else False
    image = None
    previous = None
    try:
        with tempfile.TemporaryDirectory(prefix="infinite-canvas-write-") as folder:
            path = os.path.join(folder, "texture.png")
            Path(path).write_bytes(data)
            image = bpy.data.images.load(path, check_existing=False)
            if list(image.size) != [payload["width"], payload["height"]]:
                raise LinkError(400, "输入图片尺寸校验失败。")
            image.colorspace_settings.name = payload["colorSpace"]
            if target:
                previous = {"size": tuple(target.size), "pixels": pixels_of(target), "source": target.source,
                            "path": target.filepath_raw, "format": target.file_format, "colorSpace": target.colorspace_settings.name,
                            "alpha": target.alpha_mode, "fakeUser": target.use_fake_user,
                            "packed": bytes(target.packed_file.data) if target.packed_file else None}
                # Reload a validated PNG into the SAME Image ID. This refreshes the
                # buffer (including dimensions/precision) without changing its users.
                if target.packed_file:
                    target.unpack(method="REMOVE")
                target.source = "FILE"
                target.filepath_raw = path
                target.colorspace_settings.name = payload["colorSpace"]
                target.alpha_mode = image.alpha_mode
                target.reload()
                if tuple(target.size) != tuple(image.size):
                    raise LinkError(500, "Blender 未能更新目标贴图。")
                target.pack()
                target.filepath_raw = previous["path"] or "//Canvas-" + command_id + ".png"
                target.use_fake_user = True
                target.update()
            else:
                image.name = destination["name"].strip() if kind == "new" else "Canvas Result " + command_id[:8]
                image.pack()
                image.filepath_raw = "//Canvas-" + command_id + ".png"
                if node:
                    if original:
                        original.use_fake_user = True
                    node.image = image
                else:
                    image.use_fake_user = True
        written = target if target else image
        result = {"commandId": command_id, "sessionId": state()["sessionId"], "destination": destination,
                  "imageId": image_id(written), "imageName": written.name, "sha256": payload["sha256"]}
        writes[command_id] = {"fingerprint": fingerprint, "result": result}
        return result
    except Exception:
        if target and previous:
            target.source = previous["source"]
            target.filepath_raw = previous["path"]
            target.colorspace_settings.name = previous["colorSpace"]
            target.alpha_mode = previous["alpha"]
            target.file_format = previous["format"]
            target.scale(*previous["size"])
            target.pixels.foreach_set(previous["pixels"])
            target.update()
            if previous["packed"]:
                target.pack(data=previous["packed"], data_len=len(previous["packed"]))
            elif target.packed_file:
                target.unpack(method="REMOVE")
            target.use_fake_user = previous["fakeUser"]
        if node:
            node.image = original
        if original:
            original.use_fake_user = previous_fake_user
        if image and not target:
            bpy.data.images.remove(image)
        raise
    finally:
        if target and image:
            bpy.data.images.remove(image)


def write_with_undo(payload):
    outcome = {}

    class CANVAS_OT_write_texture(bpy.types.Operator):
        bl_idname = "infinite_canvas.write_texture"
        bl_label = "Infinite Canvas 贴图写回"
        bl_options = {"UNDO"}

        def execute(self, context):
            try:
                outcome["result"] = apply_texture(payload)
                return {"FINISHED"}
            except Exception as error:
                outcome["error"] = error
                return {"CANCELLED"}

    bpy.utils.register_class(CANVAS_OT_write_texture)
    try:
        bpy.ops.infinite_canvas.write_texture("EXEC_DEFAULT")
        if "error" in outcome:
            raise outcome["error"]
        return outcome["result"]
    finally:
        bpy.utils.unregister_class(CANVAS_OT_write_texture)


def run(payload):
    try:
        current = state()
        if payload["operation"] == "status":
            return {"connected": True, "version": 1, "sessionId": current["sessionId"], "blenderVersion": bpy.app.version_string,
                    "fileName": os.path.basename(bpy.data.filepath) or "未保存文件", "sceneName": bpy.context.scene.name,
                    "sources": [info for info, _ in sources()], "targets": [info for info, _ in targets()],
                    "images": [info for _, info in images()]}
        if payload.get("sessionId") != current["sessionId"]:
            raise LinkError(409, "Blender 已重新打开文件或重启，请刷新后重新绑定。")
        if bpy.app.is_job_running("RENDER"):
            raise LinkError(409, "Blender 正在渲染，请完成后手动重试。")
        if payload["operation"] == "snapshot":
            return snapshot(payload)
        if payload["operation"] == "image-preview":
            return image_preview(payload)
        if payload["operation"] == "write":
            return write_with_undo(payload)
        raise LinkError(400, "不支持的画布操作。")
    except Exception as error:
        return {"error": str(error), "status": error.status if isinstance(error, LinkError) else 500}
