from krita import Krita

from .bridge import InfiniteCanvasExtension

extension = InfiniteCanvasExtension(Krita.instance())
Krita.instance().addExtension(extension)
