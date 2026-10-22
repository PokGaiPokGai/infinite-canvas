"""Loopback-only manual bridge. HTTP threads never access Krita or image APIs."""

import base64
import binascii
import hashlib
import hmac
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from krita import Extension, Krita
from PyQt5.QtCore import QByteArray, QBuffer, QCoreApplication, QIODevice, QObject, QThread, Qt, QUuid, pyqtSignal, pyqtSlot
from PyQt5.QtGui import QColorSpace, QImage


PROFILE = "sRGB-elle-V2-srgbtrc.icc"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


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
        self._closing = False
        self.requested.connect(self._dispatch, Qt.QueuedConnection)

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
        with self._lock:
            self._closing = True
            for job in self._pending:
                job.error = BridgeError(503, "Krita 正在关闭")
                job.done.set()

    def execute(self, action, payload):
        """GUI-thread entry point, also usable from an explicit self-test script."""
        if QThread.currentThread() != self.thread():
            raise BridgeError(500, "Krita 操作必须在界面线程执行")
        if action == "status":
            return self._status()
        if action == "snapshot":
            return self._snapshot(payload)
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

            def visit(parent):
                for node in parent.childNodes():
                    layers.append({"id": node.uniqueId().toString(QUuid.WithoutBraces), "name": node.name(), "type": node.type()})
                    visit(node)

            visit(doc.rootNode())
            model, depth, profile = _color(doc)
            documents.append({"id": document_id, "name": _name(doc), "width": doc.width(), "height": doc.height(),
                              "colorModel": model, "colorDepth": depth, "colorProfile": profile, "layers": layers})
        return {"version": 1, "sessionId": self.session_id, "documents": documents}

    def _snapshot(self, payload):
        document_id = _uuid(payload.get("documentId"), "documentId")
        doc = self._document(document_id)
        _require_color(doc)
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
            pixels = node.projectionPixelData(0, 0, width, height)
        else:
            pixels = doc.pixelData(0, 0, width, height)
        if len(pixels) != width * height * 4:
            raise BridgeError(422, "快照不是有效的 RGBA/U8 像素数据")
        image = QImage(pixels.data(), width, height, width * 4, QImage.Format_ARGB32).copy()
        image.setColorSpace(QColorSpace(QColorSpace.SRgb))
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
                  "sha256": hashlib.sha256(image_bytes).hexdigest(), "createdAt": datetime.now(timezone.utc).isoformat(),
                  "imageBase64": base64.b64encode(image_bytes).decode("ascii")}
        if layer_id:
            result["layerId"] = layer_id
        return result

    def _apply(self, payload):
        command_id = _uuid(payload.get("commandId"), "commandId")
        snapshot_id = _uuid(payload.get("snapshotId"), "snapshotId")
        expected_hash = payload.get("sha256")
        if not isinstance(expected_hash, str) or len(expected_hash) != 64 or any(char not in "0123456789abcdef" for char in expected_hash):
            raise BridgeError(400, "PNG 的 sha256 无效")
        fit_to_canvas = payload.get("fitToCanvas", False)
        if type(fit_to_canvas) is not bool:
            raise BridgeError(400, "fitToCanvas 必须为布尔值")
        signature = (snapshot_id, expected_hash, fit_to_canvas)
        if command_id in self.acks:
            saved = self.acks[command_id]
            if saved["signature"] != signature:
                raise BridgeError(409, "该 commandId 的快照、图片或缩放选项已改变，请使用新的命令编号")
            return saved["ack"]
        snapshot = self.snapshots.get(snapshot_id)
        if snapshot is None:
            raise BridgeError(409, "快照不属于本次 Krita 会话，请重新读取")
        doc = self._document(snapshot["documentId"])
        if doc != snapshot["document"] or (doc.width(), doc.height()) != (snapshot["width"], snapshot["height"]) or _color(doc) != snapshot["color"]:
            raise BridgeError(409, "原文档的尺寸或色彩空间已改变，请重新读取")
        _require_color(doc)
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
        node = doc.createNode(layer_name, "paintlayer")
        if node is None or not node.setPixelData(QByteArray(pixels), 0, 0, width, height):
            raise BridgeError(500, "无法准备新绘画图层")
        root = doc.rootNode()
        children = root.childNodes()
        ack = {"commandId": command_id, "layerId": node.uniqueId().toString(QUuid.WithoutBraces), "documentId": snapshot["documentId"]}
        if not root.addChildNode(node, children[-1] if children else None):
            raise BridgeError(500, "无法插入新绘画图层")
        # Record before refreshing, so a disconnected caller can safely repeat the command.
        self.acks[command_id] = {"signature": signature, "ack": ack}
        doc.refreshProjection()
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
                routes = {("GET", "/status"): "status", ("POST", "/snapshot"): "snapshot", ("POST", "/apply"): "apply"}
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
