def classFactory(iface):
    from .plugin import VunguIntegration
    return VunguIntegration(iface)
