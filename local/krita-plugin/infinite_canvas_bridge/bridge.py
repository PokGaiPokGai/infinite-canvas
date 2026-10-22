"""Loopback-only manual bridge. HTTP threads never access Krita or image APIs."""

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from krita import Extension, Krita
from PyQt5.QtCore import QByteArray, QBuffer, QCoreApplication, QEvent, QIODevice, QObject, QThread, QTimer, Qt, QUuid, pyqtSignal, pyqtSlot
from PyQt5.QtGui import QColorSpace, QImage


PROFILE = "sRGB-elle-V2-srgbtrc.icc"
GRAY_PROFILE = "Gray-D50-elle-V2-srgbtrc.icc"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
AUTO_IDLE_DELAY_MS = 2000
WATCH_KEEPALIVE_MS = 60000


class BridgeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _uuid(value, field):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise BridgeError(400, field + " 无效")


def _name(doc):
    # Document titles may be paths too; never return a KRA directory.
    return Path(doc.fileName() or doc.name() or "Untitled").name


def _color(doc):
    return (doc.colorModel(), doc.colorDepth(), doc.colorProfile())


def _require_color(doc):
    if _color(doc) != ("RGBA", "U8", PROFILE):
        raise BridgeError(422, "仅支持 RGBA/U8 和 sRGB-elle-V2-srgbtrc.icc，原文档未作修改")


class _Call:
    def __init__(self, action, payload):
        self.action, self.payload = action, payload
        self.done = threading.Event()
        self.result = None
        self.error = None


class BridgeService(QObject):
    requested = pyqtSignal(object)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.session_id = str(uuid.uuid4())
        self.documents = {}
        self.snapshots = {}
        self.acks = {}
        self._pending = set()
        self._lock = threading.Lock()
        self._watch_condition = threading.Condition(self._lock)
        self._revision = 0
        self._closing = False
        self._idle_timer = QTimer(self)
        self._idle_timer.setSingleShot(True)
        self._idle_timer.timeout.connect(self._notify_idle)
        self._held_inputs = set()
        QCoreApplication.instance().installEventFilter(self)
        self.requested.connect(self._dispatch, Qt.QueuedConnection)

    def eventFilter(self, watched, event):
        kind = event.type()
        if self._closing:
            return False
        if kind == QEvent.ApplicationDeactivate:
            was_active = bool(self._held_inputs)
            self._held_inputs.clear()
            if was_active and Krita.instance().activeDocument() is not None:
                self._idle_timer.start(AUTO_IDLE_DELAY_MS)
            return False
        presses = {QEvent.MouseButtonPress: "mouse", QEvent.MouseButtonDblClick: "mouse",
                   QEvent.TabletPress: "tablet", QEvent.TouchBegin: "touch"}
        releases = {QEvent.MouseButtonRelease: "mouse", QEvent.TabletRelease: "tablet",
                    QEvent.TouchEnd: "touch", QEvent.TouchCancel: "touch"}
        if kind not in presses and kind not in releases and kind not in (QEvent.KeyPress, QEvent.KeyRelease):
            return False
        if kind in (QEvent.KeyPress, QEvent.KeyRelease) and event.isAutoRepeat():
            return False
        if Krita.instance().activeDocument() is None:
            self._held_inputs.clear()
            self._idle_timer.stop()
            return False
        if kind in presses or kind == QEvent.KeyPress:
            self._held_inputs.add(presses.get(kind, ("key", event.key()) if kind == QEvent.KeyPress else None))
            self._idle_timer.stop()
        else:
            key = releases.get(kind, ("key", event.key()) if kind == QEvent.KeyRelease else None)
            if kind == QEvent.MouseButtonRelease and event.buttons() != Qt.NoButton:
                self._held_inputs.add("mouse")
            else:
                self._held_inputs.discard(key)
            if not self._held_inputs:
                self._idle_timer.start(AUTO_IDLE_DELAY_MS)
        return False

    @pyqtSlot()
    def _notify_idle(self):
        with self._watch_condition:
            if not self._closing and not self._held_inputs:
                self._revision += 1
                self._watch_condition.notify_all()

    def watch(self, after):
        with self._watch_condition:
            self._watch_condition.wait_for(lambda: self._closing or self._revision != after,
                                           WATCH_KEEPALIVE_MS / 1000)
            if self._closing:
                raise BridgeError(503, "Krita 正在关闭")
            return {"sessionId": self.session_id, "revision": self._revision, "changed": self._revision != after}

    def call(self, action, payload):
        """Called only by HTTP workers; completion is signalled by the GUI thread."""
        job = _Call(action, payload)
        with self._lock:
            if self._closing:
                raise BridgeError(503, "Krita 正在关闭")
            self._pending.add(job)
        self.requested.emit(job)
        job.done.wait()
        with self._lock:
            self._pending.discard(job)
        if job.error:
            raise job.error
        return job.result

    @pyqtSlot(object)
    def _dispatch(self, job):
        try:
            if self._closing:
                raise BridgeError(503, "Krita 正在关闭")
            job.result = self.execute(job.action, job.payload)
        except BridgeError as error:
            job.error = error
        except Exception:
            job.error = BridgeError(500, "Krita 无法完成操作")
        finally:
            job.done.set()

    def close(self):
        QCoreApplication.instance().removeEventFilter(self)
        self._idle_timer.stop()
        with self._watch_condition:
            self._closing = True
            for job in self._pending:
                job.error = BridgeError(503, "Krita 正在关闭")
                job.done.set()
            self._watch_condition.notify_all()

    def execute(self, action, payload):
        """GUI-thread entry point, also usable from an explicit self-test script."""
        if QThread.currentThread() != self.thread():
            raise BridgeError(500, "Krita 操作必须在界面线程执行")
        if action == "status":
            return self._status()
        if action == "snapshot":
            return self._snapshot(payload)
        if action == "layer-backup":
            return self._layer_backup(payload)
        if action == "apply":
            return self._apply(payload)
        raise BridgeError(404, "接口不存在")

    def _live_documents(self):
        current = [doc for doc in Krita.instance().documents() if doc.activeNode() is not None]
        self.documents = {key: doc for key, doc in self.documents.items() if doc in current}
        for doc in current:
            if doc not in self.documents.values():
                self.documents[str(uuid.uuid4())] = doc
        return self.documents

    def _document(self, document_id):
        doc = self._live_documents().get(document_id)
        if doc is None:
            raise BridgeError(409, "原文档已关闭，请重新读取")
        return doc

    def _status(self):
        documents = []
        for document_id, doc in self._live_documents().items():
            layers = []
            model, depth, profile = _color(doc)

            def visit(parent, ancestor_locked=False):
                for node in reversed(parent.childNodes()):
                    effective_locked = ancestor_locked or node.locked()
                    layers.append({"id": node.uniqueId().toString(QUuid.WithoutBraces), "name": node.name(), "type": node.type(),
                                   "locked": effective_locked, "alphaLocked": node.alphaLocked(), "animated": node.animated(),
                                   "colorCompatible": _color(node) == (model, depth, profile)})
                    visit(node, effective_locked)

            visit(doc.rootNode(), doc.rootNode().locked())
            documents.append({"id": document_id, "name": _name(doc), "width": doc.width(), "height": doc.height(),
                              "colorModel": model, "colorDepth": depth, "colorProfile": profile, "layers": layers})
        with self._lock:
            revision = self._revision
        return {"version": 1, "sessionId": self.session_id, "activityRevision": revision, "documents": documents}

    def _snapshot(self, payload):
        document_id = _uuid(payload.get("documentId"), "documentId")
        expected_pixel_hash = payload.get("expectedPixelSha256")
        if expected_pixel_hash is not None and (not isinstance(expected_pixel_hash, str) or len(expected_pixel_hash) != 64 or
                                                any(char not in "0123456789abcdef" for char in expected_pixel_hash)):
            raise BridgeError(400, "expectedPixelSha256 无效")
        doc = self._document(document_id)
        doc.waitForDone()
        width, height = doc.width(), doc.height()
        layer_id = payload.get("layerId")
        if layer_id is not None and not isinstance(layer_id, str):
            raise BridgeError(400, "layerId 无效")
        if layer_id:
            layer_id = _uuid(layer_id, "layerId")
            node = doc.nodeByUniqueID(QUuid(layer_id))
            if node is None:
                raise BridgeError(409, "原图层已不可用，请重新读取")
            if _color(node) != _color(doc):
                raise BridgeError(422, "原图层的色彩空间暂不支持")
            pixels = bytes(node.projectionPixelData(0, 0, width, height))
            if _color(doc) == ("GRAYA", "U8", GRAY_PROFILE):
                if len(pixels) != width * height * 2:
                    raise BridgeError(422, "快照不是有效的灰度图层像素数据")
                # Krita returns Gray, Alpha. This approximates sRGB using the shared tone curve,
                # without exact Gray-D50 to sRGB white-point conversion.
                gray, alpha = pixels[::2], pixels[1::2]
                rgba = bytearray(width * height * 4)
                rgba[0::4] = rgba[1::4] = rgba[2::4] = gray
                rgba[3::4] = alpha
                image = QImage(bytes(rgba), width, height, width * 4, QImage.Format_RGBA8888).copy()
            elif _color(doc) == ("RGBA", "U8", PROFILE):
                if len(pixels) != width * height * 4:
                    raise BridgeError(422, "快照不是有效的 RGBA/U8 图层像素数据")
                image = QImage(pixels, width, height, width * 4, QImage.Format_ARGB32).copy()
            else:
                raise BridgeError(422, "当前图层色彩空间暂不支持读取")
        else:
            image = doc.projection(0, 0, width, height)
        if image.isNull() or image.width() != width or image.height() != height:
            raise BridgeError(422, "无法读取完整尺寸的 Krita 画面")
        if image.colorSpace().isValid():
            image.convertToColorSpace(QColorSpace(QColorSpace.SRgb))
        image = image.convertToFormat(QImage.Format_ARGB32)
        image.setColorSpace(QColorSpace(QColorSpace.SRgb))
        pixel_digest = hashlib.sha256()
        pixel_digest.update(width.to_bytes(8, "big"))
        pixel_digest.update(height.to_bytes(8, "big"))
        bits = image.constBits()
        bits.setsize(image.byteCount())
        pixel_digest.update(bytes(bits))
        pixel_hash = pixel_digest.hexdigest()
        if pixel_hash == expected_pixel_hash:
            return {"unchanged": True, "sessionId": self.session_id, "documentId": document_id,
                    "layerId": layer_id, "pixelSha256": pixel_hash}
        png = QByteArray()
        buffer = QBuffer(png)
        if not buffer.open(QIODevice.WriteOnly) or not image.save(buffer, "PNG"):
            raise BridgeError(500, "无法将快照编码为 PNG")
        buffer.close()
        image_bytes = bytes(png)
        snapshot_id = str(uuid.uuid4())
        self.snapshots[snapshot_id] = {"documentId": document_id, "document": doc, "width": width, "height": height,
                                       "color": _color(doc), "layerId": layer_id}
        result = {"id": snapshot_id, "sessionId": self.session_id, "documentId": document_id, "documentName": _name(doc),
                  "width": width, "height": height, "colorModel": "RGBA", "colorDepth": "U8", "colorProfile": PROFILE,
                  "sha256": hashlib.sha256(image_bytes).hexdigest(), "pixelSha256": pixel_hash,
                  "createdAt": datetime.now(timezone.utc).isoformat(),
                  "imageBase64": base64.b64encode(image_bytes).decode("ascii")}
        if layer_id:
            result["layerId"] = layer_id
        return result

    def _bound_document(self, snapshot_id):
        snapshot = self.snapshots.get(snapshot_id)
        if snapshot is None:
            raise BridgeError(409, "快照不属于本次 Krita 会话，请重新读取")
        doc = self._document(snapshot["documentId"])
        doc.waitForDone()
        if self._document(snapshot["documentId"]) != snapshot["document"] or (doc.width(), doc.height()) != (snapshot["width"], snapshot["height"]) or _color(doc) != snapshot["color"]:
            raise BridgeError(409, "原文档的尺寸或色彩空间已改变，请重新读取")
        _require_color(doc)
        return snapshot, doc

    def _replaceable_layer(self, doc, layer_id):
        node = doc.nodeByUniqueID(QUuid(layer_id))
        if node is None:
            raise BridgeError(409, "目标图层已不可用，请重新选择")
        if node.type() != "paintlayer" or node.alphaLocked() or node.animated() or _color(node) != _color(doc):
            raise BridgeError(422, "只能覆盖未锁定、非动画且色彩空间一致的普通绘画图层")
        current = node
        while current is not None:
            if current.locked():
                raise BridgeError(422, "目标图层或其父级已锁定，未进行覆盖")
            current = current.parentNode()
        return node

    def _layer_backup(self, payload):
        snapshot_id = _uuid(payload.get("snapshotId"), "snapshotId")
        layer_id = _uuid(payload.get("layerId"), "layerId")
        snapshot, doc = self._bound_document(snapshot_id)
        node = self._replaceable_layer(doc, layer_id)
        width, height = snapshot["width"], snapshot["height"]
        pixels = node.pixelData(0, 0, width, height)
        raw = bytes(pixels)
        if len(raw) != width * height * 4:
            raise BridgeError(422, "目标图层像素无法备份，未进行覆盖")
        image = QImage(pixels.data(), width, height, width * 4, QImage.Format_ARGB32).copy()
        image.setColorSpace(QColorSpace(QColorSpace.SRgb))
        png = QByteArray()
        buffer = QBuffer(png)
        if not buffer.open(QIODevice.WriteOnly) or not image.save(buffer, "PNG"):
            raise BridgeError(500, "目标图层备份失败，未进行覆盖")
        image_bytes = bytes(png)
        buffer.close()
        return {"documentId": snapshot["documentId"], "layerId": layer_id, "width": width, "height": height,
                "imageBase64": base64.b64encode(image_bytes).decode("ascii"),
                "sha256": hashlib.sha256(image_bytes).hexdigest(), "pixelSha256": hashlib.sha256(raw).hexdigest()}

    def _apply(self, payload):
        command_id = _uuid(payload.get("commandId"), "commandId")
        snapshot_id = _uuid(payload.get("snapshotId"), "snapshotId")
        expected_hash = payload.get("sha256")
        if not isinstance(expected_hash, str) or len(expected_hash) != 64 or any(char not in "0123456789abcdef" for char in expected_hash):
            raise BridgeError(400, "PNG 的 sha256 无效")
        fit_to_canvas = payload.get("fitToCanvas", False)
        if type(fit_to_canvas) is not bool:
            raise BridgeError(400, "fitToCanvas 必须为布尔值")
        insert_above_layer_id = payload.get("insertAboveLayerId")
        if insert_above_layer_id is not None:
            insert_above_layer_id = _uuid(insert_above_layer_id, "insertAboveLayerId")
        write_mode = payload.get("writeMode", "insert")
        if write_mode not in ("insert", "replace"):
            raise BridgeError(400, "写回方式无效")
        replace_layer_id = payload.get("replaceLayerId")
        if replace_layer_id is not None:
            replace_layer_id = _uuid(replace_layer_id, "replaceLayerId")
        expected_layer_hash = payload.get("expectedLayerSha256")
        if write_mode == "insert" and (replace_layer_id is not None or expected_layer_hash is not None):
            raise BridgeError(400, "新建图层不能同时指定覆盖目标")
        if write_mode == "replace" and (insert_above_layer_id is not None or replace_layer_id is None or
                                         not isinstance(expected_layer_hash, str) or len(expected_layer_hash) != 64 or
                                         any(char not in "0123456789abcdef" for char in expected_layer_hash)):
            raise BridgeError(400, "覆盖图层必须指定目标及备份时的像素摘要")
        signature = (snapshot_id, expected_hash, fit_to_canvas, write_mode, insert_above_layer_id, replace_layer_id, expected_layer_hash)
        if command_id in self.acks:
            saved = self.acks[command_id]
            if saved["signature"] != signature:
                raise BridgeError(409, "该 commandId 的快照、图片或缩放选项已改变，请使用新的命令编号")
            return saved["ack"]
        snapshot, doc = self._bound_document(snapshot_id)
        encoded = payload.get("imageBase64")
        if not isinstance(encoded, str):
            raise BridgeError(400, "缺少 PNG 的 imageBase64")
        try:
            image_bytes = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise BridgeError(400, "PNG 的 base64 数据无效")
        actual_hash = hashlib.sha256(image_bytes).hexdigest()
        if not image_bytes.startswith(PNG_SIGNATURE) or not hmac.compare_digest(actual_hash.encode("ascii"), expected_hash.encode("utf-8")):
            raise BridgeError(400, "PNG 文件签名或 sha256 不匹配")
        image = QImage.fromData(image_bytes, "PNG")
        width, height = snapshot["width"], snapshot["height"]
        if image.isNull():
            raise BridgeError(422, "PNG 图像无法解码")
        if (image.width(), image.height()) != (width, height):
            if fit_to_canvas:
                image = image.scaled(width, height, Qt.IgnoreAspectRatio, Qt.SmoothTransformation)
            else:
                raise BridgeError(422, "PNG 尺寸必须与原快照一致")
        if image.colorSpace().isValid():
            image.convertToColorSpace(QColorSpace(QColorSpace.SRgb))
        image = image.convertToFormat(QImage.Format_ARGB32)
        bits = image.constBits()
        bits.setsize(image.byteCount())
        pixels = bytes(bits)
        if image.bytesPerLine() != width * 4 or len(pixels) != width * height * 4:
            raise BridgeError(500, "无法准备 RGBA/U8 图层像素")
        layer_name = payload.get("layerName", "无限画布结果")
        if not isinstance(layer_name, str) or not layer_name.strip():
            raise BridgeError(400, "图层名称无效")
        if write_mode == "replace":
            node = self._replaceable_layer(doc, replace_layer_id)
            original_pixels = bytes(node.pixelData(0, 0, width, height))
            if not hmac.compare_digest(hashlib.sha256(original_pixels).hexdigest(), expected_layer_hash):
                raise BridgeError(409, "目标图层在备份后发生变化，未进行覆盖；请重新提交一次新写回")
            if not node.setPixelData(QByteArray(pixels), 0, 0, width, height):
                raise BridgeError(500, "目标图层覆盖失败")
            written_hash = hashlib.sha256(bytes(node.pixelData(0, 0, width, height))).digest()
            if not hmac.compare_digest(written_hash, hashlib.sha256(pixels).digest()):
                restored = node.setPixelData(QByteArray(original_pixels), 0, 0, width, height)
                if restored:
                    restored_hash = hashlib.sha256(bytes(node.pixelData(0, 0, width, height))).digest()
                    restored = hmac.compare_digest(restored_hash, hashlib.sha256(original_pixels).digest())
                doc.refreshProjection()
                if restored:
                    raise BridgeError(500, "目标图层写入后校验失败，已恢复备份前像素；请重新检查图层")
                doc.setModified(True)
                raise BridgeError(500, "目标图层写入后校验失败且无法自动恢复，请保留本机备份并检查图层")
        else:
            root = doc.rootNode()
            parent, above = root, None
            if insert_above_layer_id:
                above = doc.nodeByUniqueID(QUuid(insert_above_layer_id))
                parent = above.parentNode() if above is not None else None
                if parent is None or above not in parent.childNodes():
                    raise BridgeError(409, "目标图层已不可用，请重新选择写入位置")
            else:
                children = root.childNodes()
                above = children[-1] if children else None
            node = doc.createNode(layer_name, "paintlayer")
            if node is None or not node.setPixelData(QByteArray(pixels), 0, 0, width, height):
                raise BridgeError(500, "无法准备新绘画图层")
            if not parent.addChildNode(node, above):
                raise BridgeError(500, "无法在目标图层上方插入新绘画图层")
        doc.setModified(True)
        ack = {"commandId": command_id, "layerId": node.uniqueId().toString(QUuid.WithoutBraces),
               "documentId": snapshot["documentId"], "layerPixelSha256": hashlib.sha256(pixels).hexdigest()}
        # Record before refreshing, so a disconnected caller can safely repeat the command.
        self.acks[command_id] = {"signature": signature, "ack": ack}
        doc.refreshProjection()
        self._idle_timer.start(AUTO_IDLE_DELAY_MS)
        return ack


def make_handler(service, token, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send_error(self, code, message=None, explain=None):
            self._reply(code, {"error": "HTTP 请求被拒绝"})

        def _reply(self, status, result):
            body = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _handle(self):
            try:
                if self.headers.get_all("Origin") is not None:
                    raise BridgeError(403, "此接口不接受浏览器直接请求")
                if self.headers.get_all("Host") != ["127.0.0.1:" + str(port)]:
                    raise BridgeError(403, "请求地址不符合要求")
                tokens = self.headers.get_all("X-Infinite-Canvas-Krita", [])
                if len(tokens) != 1 or not hmac.compare_digest(tokens[0].encode("utf-8"), token.encode("utf-8")):
                    raise BridgeError(403, "Krita 连接验证失败")
                if self.command == "GET" and self.path.startswith("/watch"):
                    match = re.fullmatch(r"/watch\?after=(0|[1-9][0-9]*)", self.path)
                    if match is None or int(match.group(1)) > 9007199254740991:
                        raise BridgeError(400, "watch 版本号无效")
                    self._reply(200, service.watch(int(match.group(1))))
                    return
                routes = {("GET", "/status"): "status", ("POST", "/snapshot"): "snapshot",
                          ("POST", "/layer-backup"): "layer-backup", ("POST", "/apply"): "apply"}
                action = routes.get((self.command, self.path))
                if action is None:
                    raise BridgeError(404, "接口不存在")
                payload = {}
                if self.command == "POST":
                    if self.headers.get_all("Transfer-Encoding") is not None or self.headers.get_content_type() != "application/json":
                        raise BridgeError(415, "请求内容必须为 JSON")
                    lengths = self.headers.get_all("Content-Length", [])
                    if len(lengths) != 1:
                        raise BridgeError(400, "缺少有效的 Content-Length")
                    try:
                        length = int(lengths[0])
                        if length < 0:
                            raise ValueError()
                        payload = json.loads(self.rfile.read(length).decode("utf-8"))
                    except (ValueError, UnicodeError):
                        raise BridgeError(400, "JSON 请求内容无效")
                    if not isinstance(payload, dict):
                        raise BridgeError(400, "请求内容必须为 JSON 对象")
                self._reply(200, service.call(action, payload))
            except BridgeError as error:
                self._reply(error.status, {"error": str(error)})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self._reply(500, {"error": "Krita 连接服务无法完成请求"})

        do_GET = _handle
        do_POST = _handle
        do_OPTIONS = _handle

    return Handler


class InfiniteCanvasExtension(Extension):
    def __init__(self, parent):
        super().__init__(parent)
        self.service = None
        self.server = None
        self.startup_error = None

    def setup(self):
        app_data = os.environ.get("APPDATA")
        if not app_data:
            return
        config_path = Path(app_data) / "krita" / "infinite_canvas_bridge.json"
        if not config_path.is_file():
            return
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            if not isinstance(config, dict) or type(config.get("version")) is not int or config["version"] != 1 or type(config.get("port")) is not int or config["port"] != 3003:
                raise ValueError()
            token = config.get("token")
            if not isinstance(token, str) or not token or not token.isascii() or any(char.isspace() or ord(char) < 32 for char in token):
                raise ValueError()
            self.service = BridgeService(self)
            self.server = ThreadingHTTPServer(("127.0.0.1", config["port"]), make_handler(self.service, token, config["port"]))
            threading.Thread(target=self.server.serve_forever, name="Infinite Canvas Krita HTTP", daemon=True).start()
            QCoreApplication.instance().aboutToQuit.connect(self.shutdown)
        except Exception:
            self.startup_error = "Krita 连接配置无效或本机端口不可用"

    def createActions(self, window):
        pass

    def shutdown(self):
        if self.service:
            self.service.close()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.server = None


def create_selftest_document(width, height):
    """Explicit GUI-console helper; never called during plugin setup or HTTP requests."""
    app = Krita.instance()
    if QThread.currentThread() != QCoreApplication.instance().thread():
        raise BridgeError(500, "请在界面线程创建测试文档")
    if type(width) is not int or type(height) is not int or width <= 0 or height <= 0:
        raise BridgeError(400, "测试文档尺寸必须为正整数")
    doc = app.createDocument(width, height, "Infinite Canvas Bridge self-test", "RGBA", "U8", PROFILE, 72.0)
    layer = doc.createNode("测试图层", "paintlayer")
    if not doc.rootNode().addChildNode(layer, None):
        raise BridgeError(500, "无法创建测试图层")
    doc.setActiveNode(layer)
    app.activeWindow().addView(doc)
    return doc
