"""Run in a separate factory-startup Blender, never in the user's editor.

blender --background --factory-startup --python-exit-code 1 --python blender-commands.test.py
"""
import base64
import hashlib
import importlib.util
import json
import sys
import tempfile
import uuid
from pathlib import Path

import bpy

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("canvas_blender_commands", Path(__file__).with_name("blender-commands.py"))
commands = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commands)

material = bpy.data.materials.new("Canvas isolated test material")
material.use_nodes = True
node = material.node_tree.nodes.new("ShaderNodeTexImage")
original = bpy.data.images.new("Canvas original test image", width=2, height=2)
original.pixels[:] = [0.25, 0.5, 0.75, 1.0] * 4
node.image = original

with tempfile.TemporaryDirectory(prefix="infinite-canvas-blender-test-") as folder:
    original.filepath_raw = str(Path(folder) / "fixture.png")
    original.file_format = "PNG"
    original.save()
    data = Path(original.filepath_raw).read_bytes()

    status = commands.run({"operation": "status"})
    target = next(item for item in status["targets"] if item["materialName"] == material.name)
    payload = {"operation": "write", "sessionId": status["sessionId"], "commandId": str(uuid.uuid4()),
               "destination": {"kind": "node", "targetId": target["id"], "expectedImageId": target["imageId"]}, "colorSpace": "sRGB",
               "imageBase64": base64.b64encode(data).decode(), "width": 2, "height": 2,
               "sha256": hashlib.sha256(data).hexdigest()}
    before_images = len(bpy.data.images)
    first = commands.run(payload)
    assert "error" not in first, first
    assert node.image != original and node.image.packed_file
    assert original.use_fake_user and original.name in bpy.data.images
    assert node.image.filepath_raw.startswith("//Canvas-")
    assert len(bpy.data.images) == before_images + 1
    assert commands.run(payload) == first
    assert len(bpy.data.images) == before_images + 1
    assert commands.run({**payload, "colorSpace": "Non-Color"})["status"] == 409
    second = commands.run({**payload, "commandId": str(uuid.uuid4())})
    assert second["status"] == 409, second
    assert len(bpy.data.images) == before_images + 1
    print("PASS: packed texture, original preserved, idempotence, changed-command rejection, changed-target rejection")

    # Verify PNG conversion leaves output format, color settings and scene/image
    # counts intact. A GUI Render Result still needs a separate integration check.
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "OPEN_EXR"
    before = (len(bpy.data.scenes), len(bpy.data.images), scene.render.image_settings.file_format, scene.view_settings.view_transform)
    encoded, size = commands.png_bytes(original, scene)
    assert size == (2, 2)
    assert encoded.startswith(b"\x89PNG\r\n\x1a\n")
    assert before == (len(bpy.data.scenes), len(bpy.data.images), scene.render.image_settings.file_format, scene.view_settings.view_transform)

    fixture = bpy.data.images.new("Incoming RGBA fixture", width=3, height=1, alpha=True)
    fixture.pixels[:] = [0.2, 0.4, 0.8, 0.5, 1, 0, 0.25, 1, 0, 0.6, 1, 0]
    fixture.file_format = "PNG"
    fixture.filepath_raw = str(Path(folder) / "incoming.png")
    fixture.save()
    incoming = Path(fixture.filepath_raw).read_bytes()
    new_payload = {**payload, "commandId": str(uuid.uuid4()), "destination": {"kind": "new", "name": "Standalone result"},
                   "imageBase64": base64.b64encode(incoming).decode(), "width": 3, "height": 1,
                   "sha256": hashlib.sha256(incoming).hexdigest()}
    created = commands.run(new_payload)
    assert "error" not in created, created
    standalone = bpy.data.images[created["imageName"]]
    assert standalone.packed_file and standalone.use_fake_user and standalone.users == 1
    assert list(standalone.size) == [3, 1]
    count = len(bpy.data.images)
    assert commands.run(new_payload) == created and len(bpy.data.images) == count
    print("PASS: standalone packed image without a material, fake user and duplicate-command protection")

    # A generated image with unsaved pixels must be selectable and previewable.
    # Two materials keep exactly the same Image ID after in-place replacement.
    shared = bpy.data.images.new("Shared generated target", width=2, height=2, alpha=True)
    shared.pixels[:] = [0.8, 0.6, 0.2, 0.4] * 4
    shared_materials = []
    for name in ("Shared material A", "Shared material B"):
        item = bpy.data.materials.new(name)
        item.use_nodes = True
        item.use_fake_user = True
        tex = item.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = shared
        shared_materials.append((item, tex))
    tiled = bpy.data.images.new("Excluded UDIM", width=2, height=2, tiled=True)
    available = commands.run({"operation": "status"})["images"]
    assert any(item["id"] == commands.image_id(shared) for item in available)
    assert all(item["id"] != commands.image_id(tiled) for item in available)
    revision = commands.image_revision(shared)
    before_pixels = list(shared.pixels)
    before_state = (len(bpy.data.images), shared.source, shared.filepath_raw, shared.is_dirty, shared.use_fake_user)
    preview = commands.run({"operation": "image-preview", "sessionId": status["sessionId"], "imageId": commands.image_id(shared)})
    assert "error" not in preview, preview
    assert preview["revision"] == revision and preview["width"] == 2 and preview["height"] == 2
    assert before_state == (len(bpy.data.images), shared.source, shared.filepath_raw, shared.is_dirty, shared.use_fake_user)
    assert list(shared.pixels) == before_pixels and commands.image_revision(shared) == revision
    direct = {**new_payload, "commandId": str(uuid.uuid4()), "destination": {"kind": "image", "imageId": commands.image_id(shared), "expectedRevision": revision}}
    uid = shared.session_uid
    shared_name = shared.name
    count = len(bpy.data.images)
    result = commands.run(direct)
    assert "error" not in result, result
    assert shared.session_uid == uid and result["imageId"] == direct["destination"]["imageId"]
    assert all(tex.image == shared for _, tex in shared_materials)
    assert list(shared.size) == [3, 1] and shared.packed_file
    assert all(abs(a - b) < 1e-6 for a, b in zip(shared.pixels, fixture.pixels))
    assert len(bpy.data.images) == count and shared.name == shared_name
    assert "backupImageName" not in result
    assert commands.run(direct) == result and len(bpy.data.images) == count
    assert commands.run({**direct, "commandId": str(uuid.uuid4())})["status"] == 409
    assert len(bpy.data.images) == count
    for _ in range(3):
        repeated = {**direct, "commandId": str(uuid.uuid4()), "destination": {**direct["destination"], "expectedRevision": commands.image_revision(shared)}}
        assert "error" not in commands.run(repeated)
        assert len(bpy.data.images) == count and shared.name == shared_name
    assert all("写回前" not in image.name for image in bpy.data.images)
    print("PASS: direct overwrite preserves image ID, name, shared references and RGBA; repeated writes create no backup images")

    # External files, including floating-point targets, remain byte-for-byte intact.
    saved_targets = []
    for color in ("sRGB", "Non-Color"):
        for floating in (False, True):
            target_image = bpy.data.images.new(f"External {color} {floating}", width=2, height=2, alpha=True, float_buffer=floating)
            target_image.pixels[:] = [0.1, 0.3, 0.6, 1] * 4
            target_image.file_format = "OPEN_EXR" if floating else "PNG"
            path = Path(folder) / (f"external-{color}-{floating}" + (".exr" if floating else ".png"))
            target_image.filepath_raw = str(path)
            target_image.save()
            if floating:
                target_image.pack()
            disk_bytes = path.read_bytes()
            # Include a local unsaved edit, which direct overwrite replaces too.
            target_image.pixels[0] = 0.7
            old_id = target_image.session_uid
            count = len(bpy.data.images)
            request = {**new_payload, "commandId": str(uuid.uuid4()), "colorSpace": color,
                       "destination": {"kind": "image", "imageId": commands.image_id(target_image), "expectedRevision": commands.image_revision(target_image)}}
            applied = commands.run(request)
            assert "error" not in applied, applied
            assert target_image.session_uid == old_id and target_image.colorspace_settings.name == color
            assert target_image.packed_file and path.read_bytes() == disk_bytes
            assert len(bpy.data.images) == count and "backupImageName" not in applied
            saved_targets.append((target_image.name, list(target_image.pixels), color, str(path), disk_bytes))
    print("PASS: external and packed targets, float targets, color/data settings, no extra images, disk files untouched")

    # A manual edit after preview, a removed image, and invalid input must not write.
    stale = {**direct, "commandId": str(uuid.uuid4()), "destination": {**direct["destination"], "expectedRevision": commands.image_revision(shared)}}
    shared.pixels[0] = 0.9
    edited = list(shared.pixels)
    count = len(bpy.data.images)
    assert commands.run(stale)["status"] == 409 and list(shared.pixels) == edited
    valid = {**stale, "destination": {**stale["destination"], "expectedRevision": commands.image_revision(shared)}}
    assert commands.run({**valid, "width": 999})["status"] == 400
    assert len(bpy.data.images) == count and list(shared.pixels) == edited
    orphan = bpy.data.images.new("Deleted target", width=2, height=2)
    removed = {**valid, "destination": {"kind": "image", "imageId": commands.image_id(orphan), "expectedRevision": commands.image_revision(orphan)}}
    bpy.data.images.remove(orphan)
    assert commands.run(removed)["status"] == 409
    print("PASS: modified/deleted targets and invalid dimensions fail without changing pixels or adding images")

    # Inject a failure AFTER buffer replacement; rollback restores generated and
    # packed images, including unsaved pixels, and removes only temporary images.
    for packed in (False, True):
        rollback = bpy.data.images.new("Rollback target", width=2, height=2, alpha=True)
        rollback.pixels[:] = [0.4, 0.2, 0.8, 1] * 4
        if packed:
            rollback.pack()
        old = (list(rollback.pixels), tuple(rollback.size), rollback.source, rollback.filepath_raw, rollback.colorspace_settings.name, rollback.use_fake_user)
        packed_bytes = bytes(rollback.packed_file.data) if rollback.packed_file else None
        count = len(bpy.data.images)
        failing = {**new_payload, "commandId": str(uuid.uuid4()), "destination": {"kind": "image", "imageId": commands.image_id(rollback), "expectedRevision": commands.image_revision(rollback)}}
        original_state = commands.state
        def fail_after_replace():
            if tuple(rollback.size) == (3, 1):
                raise RuntimeError("Injected failure after replacement")
            return original_state()
        commands.state = fail_after_replace
        try:
            try:
                commands.apply_texture(failing)
                raise AssertionError("Expected injected failure")
            except RuntimeError as error:
                assert str(error) == "Injected failure after replacement"
        finally:
            commands.state = original_state
        assert old == (list(rollback.pixels), tuple(rollback.size), rollback.source, rollback.filepath_raw, rollback.colorspace_settings.name, rollback.use_fake_user)
        assert packed_bytes == (bytes(rollback.packed_file.data) if rollback.packed_file else None)
        assert len(bpy.data.images) == count
    print("PASS: failure after image mutation restores original buffers and packed state without leaving temporary images")

    # Saving/reopening this isolated .blend validates durable packed pixels and users.
    shared.pack()
    saved_shared_pixels = list(shared.pixels)
    shared_name = shared.name
    standalone_name = standalone.name
    material_names = [item.name for item, _ in shared_materials]
    blend_path = str(Path(folder) / "roundtrip.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    bpy.ops.wm.open_mainfile(filepath=blend_path)
    for name, expected, color, path, disk_bytes in saved_targets:
        restored = bpy.data.images[name]
        assert restored.packed_file and list(restored.size) == [3, 1]
        assert restored.colorspace_settings.name == color
        assert all(abs(a - b) < 1e-6 for a, b in zip(restored.pixels, expected))
        assert Path(path).read_bytes() == disk_bytes
    restored_shared = bpy.data.images[shared_name]
    assert all(abs(a - b) < 1e-6 for a, b in zip(restored_shared.pixels, saved_shared_pixels))
    for name in material_names:
        assert next(tex for tex in bpy.data.materials[name].node_tree.nodes if tex.type == "TEX_IMAGE").image == restored_shared
    assert all("写回前" not in image.name for image in bpy.data.images)
    assert bpy.data.images[standalone_name].packed_file
    print("PASS: save/reopen retains direct overwrites, standalone images, shared references and color/data pixels without backups")

    assert commands.run(payload)["status"] == 409
    print("PASS: PNG conversion, original output settings preserved, stale-session rejection")

print(json.dumps({"result": "passed", "blenderVersion": bpy.app.version_string}))
